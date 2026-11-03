import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ExternalApplicationSchema,
  MAX_DOCUMENT_BYTES,
  type ExternalApplication,
  type ExternalApplicationPrefill,
  type ExternalApplicationReceipt,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import {
  hiringDotApplications,
  hiringDotLinkFiles,
  hiringDotLinks,
  hiringExternalApplications,
} from '../../database/schema/hiring';
import { encrypt } from '../admin/credential-vault';
import { cleanFileName, sniff } from '../driver-relations/receipts';
import { AuditService } from '../people/audit.service';
import { DotLinksService, type DotLinkRequestMeta, type Resolved } from './dot-links.service';

/** The provider name stored on every submission from the external driver application. */
export const EXTERNAL_PROVIDER = 'external_driver_application';

const pipe = new ZodValidationPipe(ExternalApplicationSchema);
const EXTENSION: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const FILE_CODES = { cdlFront: 'cdl', cdlBack: 'cdl_back', medicalCard: 'medical_card' } as const;

export interface ExternalRequestMeta extends DotLinkRequestMeta {
  origin: string | null;
  secret: string | null;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function gone(): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail: 'This application link does not work any more.' });
}

/**
 * The intake adapter for the external driver application (owner, 2026-10-08).
 *
 * The external page (external-driver-application) today posts to its own backend and nowhere else,
 * so nothing reaches the TMS from it. This is the TMS half, ready for when its owner points it
 * here: the candidate's private link token (the same 256-bit token, digest-only, that the TMS's
 * own /dot/<token> application uses) resolves server-side to one company and one candidate — the
 * caller never names a company or a person.
 *
 *   - Off unless the company is on EXTERNAL_APPLICATION_COMPANIES.
 *   - Browser calls only from EXTERNAL_APPLICATION_ORIGINS; a call with no Origin (server-to-
 *     server) must carry EXTERNAL_APPLICATION_SECRET when one is configured.
 *   - Idempotent on (company, provider, submissionKey): a retry gets the same reference.
 *   - One submission per link (replay protection): a different submission on a used link is refused.
 *   - HTTPS-only in production and the dead-token allowance, exactly as the /dot/<token> routes.
 *   - The SSN is sealed on arrival; files are staged privately against the case for review.
 */
@Injectable()
export class ExternalApplicationService {
  private readonly logger = new Logger(ExternalApplicationService.name);
  private readonly submitLimiter = new RateLimiter(20, 10 * 60_000);

  constructor(
    private readonly database: DatabaseService,
    private readonly links: DotLinksService,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Whether the adapter is switched on for a company. */
  enabledFor(companyId: string): boolean {
    return list(env.EXTERNAL_APPLICATION_COMPANIES).includes(companyId);
  }

  /** The address to send a candidate when the external application is the intake for their company. */
  candidateUrl(companyId: string, token: string): string | null {
    if (!this.enabledFor(companyId) || !env.EXTERNAL_APPLICATION_BASE_URL) return null;
    const url = new URL(env.EXTERNAL_APPLICATION_BASE_URL);
    url.searchParams.set('t', token);
    return url.toString();
  }

  /** The CORS answer for an Origin: echoed only when allowlisted. */
  allowedOrigin(origin: string | null): string | null {
    if (!origin) return null;
    return list(env.EXTERNAL_APPLICATION_ORIGINS).includes(origin) ? origin : null;
  }

  private checkCaller(meta: ExternalRequestMeta): void {
    if (meta.origin) {
      if (!this.allowedOrigin(meta.origin)) {
        throw new AppError({ status: 403, title: 'Forbidden', detail: 'This origin may not send applications here.' });
      }
      return;
    }
    const expected = env.EXTERNAL_APPLICATION_SECRET;
    if (expected) {
      const a = createHash('sha256').update(meta.secret ?? '').digest();
      const b = createHash('sha256').update(expected).digest();
      if (!timingSafeEqual(a, b)) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Missing or wrong intake secret.' });
    }
  }

  private async resolve(token: string, meta: ExternalRequestMeta): Promise<Resolved> {
    this.links.gate(meta);
    const r = await this.links.resolve(token, meta);
    // A company that has not switched the adapter on looks exactly like a dead link.
    if (!this.enabledFor(r.principal.companyId)) throw gone();
    return r;
  }

  async prefill(token: string, meta: ExternalRequestMeta): Promise<ExternalApplicationPrefill> {
    this.checkCaller(meta);
    const r = await this.resolve(token, meta);
    const [done] = await this.db
      .select({ id: hiringExternalApplications.id })
      .from(hiringExternalApplications)
      .where(eq(hiringExternalApplications.dotLinkId, r.link.id))
      .limit(1);
    return {
      firstName: r.firstName,
      lastName: r.lastName,
      phone: null,
      email: null,
      companyName: r.companyName,
      alreadySubmitted: Boolean(done),
    };
  }

  private ipHash(ip: string): string {
    return createHmac('sha256', env.APP_SECRET).update(`external-apply:${ip}`).digest('hex').slice(0, 32);
  }

  async submit(token: string, raw: unknown, meta: ExternalRequestMeta): Promise<ExternalApplicationReceipt> {
    this.checkCaller(meta);
    this.submitLimiter.hit(`ext-submit:${meta.ip}`);
    const r = await this.resolve(token, meta);
    const body: ExternalApplication = pipe.transform(raw);
    const companyId = r.principal.companyId;
    if (!body.consent) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The applicant must agree to the consent statement.' });
    }

    // A retry of a submission already received answers with the same reference, before anything else.
    const replay = await this.bySubmissionKey(companyId, body.submissionKey);
    if (replay) return this.replayed(replay, r.link.id);

    const [used] = await this.db
      .select({ id: hiringExternalApplications.id })
      .from(hiringExternalApplications)
      .where(eq(hiringExternalApplications.dotLinkId, r.link.id))
      .limit(1);
    if (used) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'An application was already received through this link. Ask the recruiter for a new link to send another.',
      });
    }
    const [dot] = await this.db
      .select({ status: hiringDotApplications.status })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, r.hiringCase.id))
      .limit(1);
    if (dot?.status === 'submitted') {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This application is already on file with the recruiter.' });
    }

    const at = new Date();
    const id = `xapp_${crypto.randomUUID()}`;
    const reference = `APP-${id.slice(5, 13).toUpperCase()}`;
    const staged = await this.stageFiles(r, body, at);
    // The answers as given, without the SSN (sealed below), the files (staged) or the key.
    const { ssn, authorizations, ...rest } = body;
    const answers: Record<string, unknown> = { ...rest };
    delete answers.files;
    delete answers.submissionKey;
    const auths = Object.fromEntries(
      Object.entries(authorizations).map(([k, v]) => [k, { ...v, drawing: v.drawing ? 'captured' : null }]),
    );

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(hiringExternalApplications).values({
          id,
          companyId,
          hiringCaseId: r.hiringCase.id,
          dotLinkId: r.link.id,
          provider: EXTERNAL_PROVIDER,
          submissionKey: body.submissionKey,
          reference,
          answers,
          authorizations: auths,
          ssnSealed: ssn ? encrypt(ssn.replace(/-/g, ''), 'pii') : null,
          ssnLast4: ssn ? ssn.replace(/-/g, '').slice(-4) : null,
          fileIds: staged.map((f) => f.id),
          origin: meta.origin,
          ipHash: this.ipHash(meta.ip),
          receivedAt: at,
        });
        await tx
          .update(hiringDotLinks)
          .set({ submittedAt: at, lastSavedAt: at })
          .where(and(eq(hiringDotLinks.id, r.link.id), isNull(hiringDotLinks.submittedAt)));
      });
    } catch (error) {
      // Two identical submissions raced: the second finds the first and answers the same.
      const again = await this.bySubmissionKey(companyId, body.submissionKey);
      if (again) return this.replayed(again, r.link.id);
      this.logger.error(`external application: save failed on link ${r.link.id}: ${(error as { code?: string }).code ?? 'error'}`);
      throw new AppError({ status: 409, title: 'Conflict', detail: 'An application was already received through this link.' });
    }

    await this.audit.write(r.principal, {
      action: 'external_application_received',
      actorType: 'system',
      actor: this.links.actor(r),
      entityType: 'applicant',
      entityId: r.hiringCase.applicantId as string,
      entityLabel: r.hiringCase.candidateName,
      summary: `Application received from the external driver application (${reference}); waiting for the recruiter's review`,
      changes: [
        { field: 'external_application', old: null, new: id },
        ...staged.map((f) => ({ field: f.code, old: null, new: f.id })),
      ],
      at,
    });
    return { status: 'received', reference, duplicate: false };
  }

  /** A retry answers with its own receipt; a key already used on another candidate's link is refused. */
  private replayed(row: { reference: string; dotLinkId: string }, linkId: string): ExternalApplicationReceipt {
    if (row.dotLinkId !== linkId) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This submission key was already used for another application.' });
    }
    return { status: 'received', reference: row.reference, duplicate: true };
  }

  private async bySubmissionKey(companyId: string, key: string) {
    const [row] = await this.db
      .select({ reference: hiringExternalApplications.reference, dotLinkId: hiringExternalApplications.dotLinkId })
      .from(hiringExternalApplications)
      .where(
        and(
          eq(hiringExternalApplications.companyId, companyId),
          eq(hiringExternalApplications.provider, EXTERNAL_PROVIDER),
          eq(hiringExternalApplications.submissionKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** CDL and medical card files, checked by their bytes and kept privately against the case. */
  private async stageFiles(r: Resolved, body: ExternalApplication, at: Date) {
    const out: { id: string; code: string }[] = [];
    for (const [field, code] of Object.entries(FILE_CODES) as [keyof typeof FILE_CODES, string][]) {
      const file = body.files[field];
      if (!file) continue;
      const content = file.content.startsWith('data:') ? file.content.slice(file.content.indexOf(',') + 1) : file.content;
      if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${field}: the file could not be read.` });
      }
      const bytes = Buffer.from(content, 'base64');
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new AppError({ status: 413, title: 'Payload Too Large', detail: `${field}: a file can be up to ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB.` });
      }
      const type = sniff(bytes);
      if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'application/pdf') {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${field}: send a JPG, PNG or PDF.` });
      }
      const id = `dlf_${crypto.randomUUID()}`;
      const stored = await this.storage.put(`dot-link/${r.principal.companyId}/${id}${EXTENSION[type]}`, bytes);
      await this.db.transaction(async (tx) => {
        await tx
          .update(hiringDotLinkFiles)
          .set({ supersededAt: at })
          .where(
            and(
              eq(hiringDotLinkFiles.hiringCaseId, r.hiringCase.id),
              eq(hiringDotLinkFiles.code, code),
              isNull(hiringDotLinkFiles.supersededAt),
              isNull(hiringDotLinkFiles.filedAt),
            ),
          );
        await tx.insert(hiringDotLinkFiles).values({
          id,
          companyId: r.principal.companyId,
          hiringCaseId: r.hiringCase.id,
          linkId: r.link.id,
          code,
          fileName: cleanFileName(file.name),
          contentType: type,
          sizeBytes: stored.sizeBytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storageKey: stored.key,
          expiresOn: code === 'cdl' ? body.cdlExpiration : code === 'medical_card' ? body.medicalExpiration : null,
          uploadedAt: at,
        });
      });
      out.push({ id, code });
    }
    return out;
  }
}
