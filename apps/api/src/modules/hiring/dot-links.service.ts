import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  DOT_LINK_DOCUMENT_LABELS,
  DOT_LINK_GONE_MESSAGE,
  DOT_LINK_MAX_SAVE_BYTES,
  DOT_LINK_MISSES_ALLOWED,
  DOT_LINK_MISS_WINDOW_MS,
  DOT_LINK_TOKEN_PATTERN,
  DOT_LINK_TTL_DAYS,
  DOT_SECTIONS,
  DOT_SECTION_LABELS,
  DotApplicationDraftFormSchema,
  DotLinkDocumentUploadSchema,
  MAX_DOCUMENT_BYTES,
  SaveDotApplicationDraftSchema,
  cdlExpiryFromForm,
  dotSectionStates,
  type DotApplication,
  type DotLinkCreated,
  type DotLinkDocumentCode,
  type DotLinkStagedFile,
  type DotLinkStatus,
  type PublicDotApplication,
  type SaveDotApplicationInput,
} from '@neway/shared';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import { complianceDocuments } from '../../database/schema/compliance';
import {
  hiringCases,
  hiringDotApplications,
  hiringDotLinkFiles,
  hiringDotLinks,
  type HiringCaseRow,
  type HiringDotLinkFileRow,
  type HiringDotLinkRow,
} from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { ComplianceService } from '../compliance/compliance.service';
import { cleanFileName, sniff } from '../driver-relations/receipts';
import { RecruitingService } from '../hr/recruiting.service';
import { AuditService } from '../people/audit.service';
import { DotApplicationsService } from './dot-applications.service';

export interface DotLinkRequestMeta {
  ip: string;
  /** True when the request reached the edge over TLS (X-Forwarded-Proto through trusted proxies). */
  secure: boolean;
}

const DAY = 86_400_000;
const savePipe = new ZodValidationPipe(SaveDotApplicationDraftSchema);
const uploadPipe = new ZodValidationPipe(DotLinkDocumentUploadSchema);
const EXTENSION: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function gone(): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail: DOT_LINK_GONE_MESSAGE });
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** On unless switched off; off by default outside production (local dev and tests are plain http). */
function httpsRequired(): boolean {
  const flag = env.PUBLIC_LINKS_REQUIRE_HTTPS;
  return flag === undefined ? env.NODE_ENV === 'production' : flag === 'true';
}

export interface Resolved {
  link: HiringDotLinkRow;
  hiringCase: HiringCaseRow;
  principal: Principal;
  companyName: string;
  firstName: string;
  lastName: string;
}

/**
 * The DOT application sent to the driver (owner, 2026-10-07).
 *
 * A recruiter makes a private link for one hiring case. The driver opens it on a phone, fills the
 * application in and certifies it; the certification is frozen and waits for a recruiter, who
 * accepts it into the qualification file or returns it with a note (the review gate). The CDL the
 * driver sends before acceptance is kept privately against the case and filed on Accept.
 *
 * The token is the only key. It is shown to the recruiter once and only its SHA-256 digest is
 * stored; an unknown, expired or turned-off token — or, in production, a request that did not
 * arrive over HTTPS — gets one identical answer, and an address that keeps missing is refused
 * outright for a while. Nothing outside the link's own case and company is read or written.
 */
@Injectable()
export class DotLinksService {
  private readonly readLimiter = new RateLimiter(120, 60_000);
  private readonly writeLimiter = new RateLimiter(60, 10 * 60_000);
  private readonly uploadLimiter = new RateLimiter(12, 10 * 60_000);
  /** Failed token lookups per address: past the allowance every link route answers 429. */
  private readonly missLimiter = new RateLimiter(DOT_LINK_MISSES_ALLOWED, DOT_LINK_MISS_WINDOW_MS);

  constructor(
    private readonly database: DatabaseService,
    private readonly applications: DotApplicationsService,
    private readonly compliance: ComplianceService,
    private readonly recruiting: RecruitingService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorageService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ======================================================================== the recruiter's side

  private async toStatus(row: HiringDotLinkRow, now: Date): Promise<DotLinkStatus> {
    const [app] = await this.db
      .select()
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, row.hiringCaseId))
      .limit(1);
    const appStatus = !app
      ? null
      : app.status === 'submitted'
        ? 'submitted'
        : app.status === 'driver_submitted' || (app.status === 'submitting' && app.certifiedSnapshot)
          ? 'driver_submitted'
          : 'draft';
    return {
      id: row.id,
      state: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'live',
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdByName,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      revokedBy: row.revokedBy,
      firstOpenedAt: iso(row.firstOpenedAt),
      lastOpenedAt: iso(row.lastOpenedAt),
      lastSavedAt: iso(row.lastSavedAt),
      submittedAt: iso(row.submittedAt),
      cdlUploadedAt: iso(row.cdlUploadedAt),
      applicationStatus: appStatus,
      certifiedAt: iso(app?.certifiedAt ?? null),
      acceptedAt: iso(app?.reviewedAt ?? null),
      acceptedBy: app?.reviewedBy ?? null,
      returnedAt: iso(app?.returnedAt ?? null),
      returnedBy: app?.returnedBy ?? null,
    };
  }

  private async caseOf(principal: Principal, caseId: string): Promise<HiringCaseRow> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, caseId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${caseId}` });
    if (!row.applicantId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This case predates the funnel and has no candidate record; its application is on the paper file.',
      });
    }
    return row;
  }

  private async latest(companyId: string, caseId: string): Promise<HiringDotLinkRow | undefined> {
    const [row] = await this.db
      .select()
      .from(hiringDotLinks)
      .where(and(eq(hiringDotLinks.companyId, companyId), eq(hiringDotLinks.hiringCaseId, caseId)))
      .orderBy(desc(hiringDotLinks.createdAt))
      .limit(1);
    return row;
  }

  private async applicationStatus(caseId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: hiringDotApplications.status })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, caseId))
      .limit(1);
    return row?.status ?? null;
  }

  /** The driver's own CDL files on the case that are still current (not superseded). */
  private async staged(companyId: string, caseId: string): Promise<HiringDotLinkFileRow[]> {
    return this.db
      .select()
      .from(hiringDotLinkFiles)
      .where(
        and(
          eq(hiringDotLinkFiles.companyId, companyId),
          eq(hiringDotLinkFiles.hiringCaseId, caseId),
          isNull(hiringDotLinkFiles.supersededAt),
        ),
      )
      .orderBy(desc(hiringDotLinkFiles.uploadedAt));
  }

  /** Which CDL sides are in: on the driver's file (any path), or sent through the link. */
  private async cdlIn(companyId: string, caseId: string, driverId: string | null): Promise<{ front: boolean; back: boolean }> {
    const staged = await this.staged(companyId, caseId);
    let onFile: string[] = [];
    if (driverId) {
      onFile = (
        await this.db
          .select({ code: complianceDocuments.requirementCode })
          .from(complianceDocuments)
          .where(
            and(
              eq(complianceDocuments.companyId, companyId),
              eq(complianceDocuments.ownerId, driverId),
              inArray(complianceDocuments.requirementCode, ['cdl', 'cdl_back']),
              ne(complianceDocuments.status, 'expired'),
            ),
          )
      ).map((r) => r.code);
    }
    const has = (code: string) => onFile.includes(code) || staged.some((f) => f.code === code);
    return { front: has('cdl'), back: has('cdl_back') };
  }

  async status(principal: Principal, caseId: string): Promise<{ link: DotLinkStatus | null }> {
    await this.caseOf(principal, caseId);
    const row = await this.latest(principal.companyId, caseId);
    return { link: row ? await this.toStatus(row, new Date()) : null };
  }

  /**
   * Makes a new link and returns its address, once. A live link on the case is turned off first.
   * Refused only when there is nothing left for the driver to do: the application is filed and
   * the CDL is in.
   */
  async create(principal: Principal, caseId: string): Promise<DotLinkCreated> {
    const hiringCase = await this.caseOf(principal, caseId);
    const status = await this.applicationStatus(caseId);
    const done = status === 'submitted' || status === 'driver_submitted';
    if (done && (await this.cdlIn(principal.companyId, caseId, hiringCase.driverId)).front) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The application is submitted and the CDL is in; there is nothing left for the driver to send.',
      });
    }
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const by = principal.userName ?? principal.userId;
    const id = `dotl_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + DOT_LINK_TTL_DAYS * DAY);
    const previous = await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(hiringDotLinks)
        .set({ revokedAt: now, revokedBy: by })
        .where(
          and(
            eq(hiringDotLinks.companyId, principal.companyId),
            eq(hiringDotLinks.hiringCaseId, caseId),
            isNull(hiringDotLinks.revokedAt),
          ),
        )
        .returning({ id: hiringDotLinks.id });
      await tx.insert(hiringDotLinks).values({
        id,
        companyId: principal.companyId,
        hiringCaseId: caseId,
        tokenHash: digest(token),
        createdByUserId: principal.userId,
        createdByName: by,
        createdAt: now,
        expiresAt,
      });
      return revoked;
    });

    const label = hiringCase.candidateName;
    for (const old of previous) {
      await this.audit.write(principal, {
        action: 'dot_link_revoked',
        entityType: 'applicant',
        entityId: hiringCase.applicantId as string,
        entityLabel: label,
        summary: 'DOT application link turned off: a new link was made',
        changes: [{ field: 'dot_link', old: old.id, new: 'revoked' }],
        at: now,
      });
    }
    await this.audit.write(principal, {
      action: 'dot_link_created',
      entityType: 'applicant',
      entityId: hiringCase.applicantId as string,
      entityLabel: label,
      summary: `DOT application link made for the driver; works until ${expiresAt.toISOString().slice(0, 10)}`,
      changes: [{ field: 'dot_link', old: previous[0]?.id ?? null, new: id }],
      at: now,
    });

    const [row] = await this.db.select().from(hiringDotLinks).where(eq(hiringDotLinks.id, id)).limit(1);
    return {
      url: `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/dot/${token}`,
      expiresAt: expiresAt.toISOString(),
      link: await this.toStatus(row as HiringDotLinkRow, now),
    };
  }

  /** Turns the live link off. Kept, never deleted; the driver's page then says it was turned off. */
  async revoke(principal: Principal, caseId: string): Promise<{ link: DotLinkStatus | null }> {
    const hiringCase = await this.caseOf(principal, caseId);
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const revoked = await this.db
      .update(hiringDotLinks)
      .set({ revokedAt: now, revokedBy: by })
      .where(
        and(
          eq(hiringDotLinks.companyId, principal.companyId),
          eq(hiringDotLinks.hiringCaseId, caseId),
          isNull(hiringDotLinks.revokedAt),
        ),
      )
      .returning({ id: hiringDotLinks.id });
    for (const old of revoked) {
      await this.audit.write(principal, {
        action: 'dot_link_revoked',
        entityType: 'applicant',
        entityId: hiringCase.applicantId as string,
        entityLabel: hiringCase.candidateName,
        summary: 'DOT application link turned off',
        changes: [{ field: 'dot_link', old: old.id, new: 'revoked' }],
        at: now,
      });
    }
    return this.status(principal, caseId);
  }

  // ===================================================================== the review gate (staff)

  private toStagedFile(row: HiringDotLinkFileRow): DotLinkStagedFile {
    const code = row.code as DotLinkDocumentCode;
    return {
      id: row.id,
      code,
      label: DOT_LINK_DOCUMENT_LABELS[code] ?? code,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      expiresOn: row.expiresOn,
      uploadedAt: row.uploadedAt.toISOString(),
      filedAt: iso(row.filedAt),
      filedDocumentId: row.filedDocumentId,
    };
  }

  /** The CDL files the driver sent through the link, filed or waiting for Accept. */
  async stagedFiles(principal: Principal, caseId: string): Promise<DotLinkStagedFile[]> {
    await this.caseOf(principal, caseId);
    return (await this.staged(principal.companyId, caseId)).map((r) => this.toStagedFile(r));
  }

  /** One of the case's own staged files, for preview; never another case's. */
  async stagedFile(principal: Principal, caseId: string, fileId: string) {
    await this.caseOf(principal, caseId);
    const [row] = await this.db
      .select()
      .from(hiringDotLinkFiles)
      .where(
        and(
          eq(hiringDotLinkFiles.companyId, principal.companyId),
          eq(hiringDotLinkFiles.hiringCaseId, caseId),
          eq(hiringDotLinkFiles.id, fileId),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No file ${fileId} on this candidate` });
    return { fileName: row.fileName, contentType: row.contentType, bytes: await this.storage.get(row.storageKey) };
  }

  /**
   * Accept: the frozen submission is filed (driver id, PDF, verification case, consents), then the
   * CDL files the driver sent are filed into the candidate's documents as "pending review". Safe to
   * repeat: an accepted application only files whatever staged file is still unfiled.
   */
  async accept(principal: Principal, caseId: string): Promise<DotApplication> {
    await this.caseOf(principal, caseId);
    const application = await this.applications.accept(principal, caseId);
    await this.fileStaged(principal, caseId);
    return application;
  }

  async returnToDriver(principal: Principal, caseId: string, note: string): Promise<DotApplication> {
    await this.caseOf(principal, caseId);
    return this.applications.returnToDriver(principal, caseId, note);
  }

  private async fileStaged(principal: Principal, caseId: string): Promise<void> {
    const [hiringCase] = await this.db.select().from(hiringCases).where(eq(hiringCases.id, caseId)).limit(1);
    if (!hiringCase?.driverId) return;
    const pending = (await this.staged(principal.companyId, caseId)).filter((f) => !f.filedAt);
    // Oldest first, so a later version supersedes an earlier one in the qualification file too.
    for (const file of pending.reverse()) {
      const at = new Date();
      const { document } = await this.compliance.upload(principal, {
        ownerType: 'driver',
        ownerId: hiringCase.driverId,
        ownerLabel: hiringCase.candidateName,
        requirementCode: file.code,
        title: DOT_LINK_DOCUMENT_LABELS[file.code as DotLinkDocumentCode] ?? file.code,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        issuedOn: null,
        expiresOn: file.code === 'cdl' ? file.expiresOn : null,
        source: 'public_link',
        notes: `Sent by the driver through the DOT application link ${file.uploadedAt.toISOString()}; filed on acceptance`,
        bytes: await this.storage.get(file.storageKey),
        at,
      });
      await this.db
        .update(hiringDotLinkFiles)
        .set({ filedAt: at, filedDocumentId: document.id })
        .where(and(eq(hiringDotLinkFiles.id, file.id), isNull(hiringDotLinkFiles.filedAt)));
    }
  }

  // =========================================================================== the driver's side

  /** Before anything else on a public route: HTTPS (in production), and the miss allowance. */
  gate(meta: DotLinkRequestMeta): void {
    this.missLimiter.check(
      `dot-miss:${meta.ip}`,
      'Too many attempts with links that do not work. Please wait a few minutes and try again.',
    );
    if (httpsRequired() && !meta.secure) throw gone();
  }

  private miss(meta: DotLinkRequestMeta): AppError {
    this.missLimiter.hit(
      `dot-miss:${meta.ip}`,
      'Too many attempts with links that do not work. Please wait a few minutes and try again.',
    );
    return gone();
  }

  /** The link behind a token, or the one "gone" answer for unknown, expired and turned-off alike. */
  async resolve(token: string, meta: DotLinkRequestMeta): Promise<Resolved> {
    if (!DOT_LINK_TOKEN_PATTERN.test(token)) throw this.miss(meta);
    const [row] = await this.db
      .select({
        link: hiringDotLinks,
        hiringCase: hiringCases,
        companyName: companies.name,
        timezone: companies.timezone,
        weekStart: companies.weekStart,
      })
      .from(hiringDotLinks)
      .innerJoin(
        hiringCases,
        and(eq(hiringCases.id, hiringDotLinks.hiringCaseId), eq(hiringCases.companyId, hiringDotLinks.companyId)),
      )
      .innerJoin(companies, eq(companies.id, hiringDotLinks.companyId))
      .where(eq(hiringDotLinks.tokenHash, digest(token)))
      .limit(1);
    if (!row || row.link.revokedAt || row.link.expiresAt.getTime() <= Date.now() || !row.hiringCase.applicantId) {
      throw this.miss(meta);
    }
    const base: Principal = {
      userId: 'system:driver-link',
      userName: 'Driver link',
      companyId: row.link.companyId,
      companyTimezone: row.timezone,
      weekStart: weekStartIndex(row.weekStart),
      roles: [],
      permissions: new Set(),
    };
    const applicant = await this.recruiting.getApplicant(base, row.hiringCase.applicantId);
    return {
      link: row.link,
      hiringCase: row.hiringCase,
      companyName: row.companyName,
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      principal: { ...base, userName: `${applicant.firstName} ${applicant.lastName} (driver link)`.trim() },
    };
  }

  actor(r: Resolved) {
    return { id: `dot_link:${r.link.id}`, name: `${r.firstName} ${r.lastName} (driver link)`.trim() };
  }

  private async view(r: Resolved, application: DotApplication | null): Promise<PublicDotApplication> {
    const applicant = await this.recruiting.getApplicant(r.principal, r.hiringCase.applicantId as string);
    const [fresh] = await this.db.select().from(hiringCases).where(eq(hiringCases.id, r.hiringCase.id)).limit(1);
    const cdl = await this.cdlIn(r.principal.companyId, r.hiringCase.id, fresh?.driverId ?? null);
    const form = application ? DotApplicationDraftFormSchema.parse(application.form) : null;
    const states = form ? dotSectionStates(form, new Date()) : null;
    const email = applicant.email && !applicant.email.endsWith('.lead') ? applicant.email : null;
    const status = application?.status ?? 'draft';
    return {
      companyName: r.companyName,
      firstName: r.firstName,
      lastName: r.lastName,
      form,
      hasSsn: Boolean(application?.ssnLast4),
      ssnLast4: application?.ssnLast4 ?? null,
      contact: { email, phone: applicant.phone || null, location: applicant.location ?? null },
      sections: DOT_SECTIONS.map((section) => ({
        section,
        label: DOT_SECTION_LABELS[section],
        state: states?.[section] ?? 'not_started',
      })),
      status,
      certifiedAt: application?.certifiedAt ?? null,
      // The note matters while the driver is fixing things; once they certify again it is history.
      returnNote: status === 'draft' ? (application?.returnNote ?? null) : null,
      returnedAt: status === 'draft' ? (application?.returnedAt ?? null) : null,
      updatedAt: application?.updatedAt ?? null,
      cdlUploaded: cdl.front,
      cdlBackUploaded: cdl.back,
      cdlExpiresOn: cdlExpiryFromForm(form),
      expiresAt: r.link.expiresAt.toISOString(),
    };
  }

  async publicGet(token: string, meta: DotLinkRequestMeta): Promise<PublicDotApplication> {
    this.gate(meta);
    this.readLimiter.hit(`dot-read:${meta.ip}`);
    const r = await this.resolve(token, meta);
    const now = new Date();
    await this.db
      .update(hiringDotLinks)
      .set({ firstOpenedAt: r.link.firstOpenedAt ?? now, lastOpenedAt: now })
      .where(eq(hiringDotLinks.id, r.link.id));
    return this.view(r, await this.applications.get(r.principal, r.hiringCase.id));
  }

  async publicSave(token: string, raw: unknown, meta: DotLinkRequestMeta): Promise<PublicDotApplication> {
    this.gate(meta);
    this.writeLimiter.hit(`dot-write:${meta.ip}`);
    if (JSON.stringify(raw ?? null).length > DOT_LINK_MAX_SAVE_BYTES) {
      throw new AppError({ status: 413, title: 'Payload Too Large', detail: 'The application is too large to save.' });
    }
    const r = await this.resolve(token, meta);
    const body = savePipe.transform(raw) as SaveDotApplicationInput;
    const saved = await this.applications.save(r.principal, r.hiringCase.id, body);
    await this.db
      .update(hiringDotLinks)
      .set({ lastSavedAt: new Date(saved.updatedAt) })
      .where(eq(hiringDotLinks.id, r.link.id));
    return this.view(r, saved);
  }

  /**
   * The driver certifies. Same checks as the desk; then the submission is frozen and waits for a
   * recruiter — nothing is filed. The recruiters are told in the app.
   */
  async publicSubmit(token: string, meta: DotLinkRequestMeta): Promise<PublicDotApplication> {
    this.gate(meta);
    this.writeLimiter.hit(`dot-write:${meta.ip}`);
    const r = await this.resolve(token, meta);
    const before = await this.applications.get(r.principal, r.hiringCase.id);
    const submitted = await this.applications.driverSubmit(r.principal, r.hiringCase.id);
    if (before?.status === 'draft' && submitted.status === 'driver_submitted') {
      const at = submitted.certifiedAt ? new Date(submitted.certifiedAt) : new Date();
      await this.db.update(hiringDotLinks).set({ submittedAt: at }).where(eq(hiringDotLinks.id, r.link.id));
      await this.audit.write(r.principal, {
        action: 'dot_application_submitted_by_driver',
        actorType: 'system',
        actor: this.actor(r),
        entityType: 'applicant',
        entityId: r.hiringCase.applicantId as string,
        entityLabel: r.hiringCase.candidateName,
        summary: 'The driver submitted the DOT application through the link sent by recruiting; it waits for a recruiter to accept it',
        changes: [{ field: 'dot_application', old: 'draft', new: 'driver_submitted' }],
        at,
      });
      await this.notifyRecruiters(r, submitted);
    }
    return this.view(r, submitted);
  }

  /**
   * "New DOT application from <name> — needs review", in the app, to the case's own recruiter when
   * one is assigned and has an account, otherwise to everyone who can manage recruiting.
   */
  private async notifyRecruiters(r: Resolved, application: DotApplication): Promise<void> {
    const companyId = r.principal.companyId;
    let recipients: string[] = [];
    if (r.hiringCase.recruiterId) {
      recipients = (
        await this.db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.companyId, companyId),
              eq(memberships.status, 'active'),
              eq(memberships.employeeId, r.hiringCase.recruiterId),
            ),
          )
      ).map((x) => x.userId);
    }
    if (recipients.length === 0) {
      recipients = (
        await this.db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
          .leftJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
          .where(
            and(
              eq(memberships.companyId, companyId),
              eq(memberships.status, 'active'),
              or(eq(rolePermissions.permissionCode, 'recruiting.manage'), eq(memberships.isOwner, true)),
            ),
          )
      ).map((x) => x.userId);
    }
    if (recipients.length === 0) return;
    const name = `${r.firstName} ${r.lastName}`.trim();
    await this.db
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          id: `ntf_${crypto.randomUUID()}`,
          companyId,
          recipientUserId: userId,
          severity: 'warning',
          title: `New DOT application from ${name} — needs review`,
          body: `${name} certified and submitted the DOT application through the link. Accept it into the qualification file or return it with a note.`,
          entityType: 'applicant',
          entityId: r.hiringCase.applicantId as string,
          source: 'system',
          // One per recipient per certification.
          dedupeKey: `dot_submitted:${application.id}:${application.certifiedAt ?? ''}:${userId}`,
        })),
      )
      .onConflictDoNothing();
  }

  async publicUpload(
    token: string,
    raw: unknown,
    meta: DotLinkRequestMeta,
  ): Promise<{ file: { id: string; code: string; status: 'waiting_for_review' | 'pending_review' }; application: PublicDotApplication }> {
    this.gate(meta);
    this.uploadLimiter.hit(`dot-upload:${meta.ip}`);
    const r = await this.resolve(token, meta);
    const body = uploadPipe.transform(raw);
    const application = await this.applications.get(r.principal, r.hiringCase.id);
    if (!application || application.status === 'draft') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Submit your application first, then upload your CDL.',
      });
    }

    const content = body.content.startsWith('data:') ? body.content.slice(body.content.indexOf(',') + 1) : body.content;
    if (!/^[A-Za-z0-9+/=\s]*$/.test(content)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That file could not be read. Choose it again.' });
    }
    const bytes = Buffer.from(content, 'base64');
    if (bytes.byteLength === 0) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That file is empty.' });
    }
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new AppError({
        status: 413,
        title: 'Payload Too Large',
        detail: `A file can be up to ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB.`,
      });
    }
    const type = sniff(bytes);
    if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'application/pdf') {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          type === 'image/heic'
            ? 'This photo is in HEIC format, which we cannot open. Send a JPG photo, a screenshot of it, or a PDF.'
            : 'Send a photo (JPG or PNG) or a PDF.',
      });
    }

    let expiresOn: string | null = null;
    if (body.code === 'cdl') {
      expiresOn = cdlExpiryFromForm(application.form) ?? body.expiresOn ?? null;
      if (!expiresOn) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'Enter the expiry date printed on your CDL.',
          extensions: { errors: [{ path: 'expiresOn', message: 'Enter the expiry date printed on your CDL.', code: 'custom' }] },
        });
      }
    }

    const at = new Date();
    const label = DOT_LINK_DOCUMENT_LABELS[body.code];
    const fileName = cleanFileName(body.fileName);
    const [fresh] = await this.db.select().from(hiringCases).where(eq(hiringCases.id, r.hiringCase.id)).limit(1);
    let result: { id: string; code: string; status: 'waiting_for_review' | 'pending_review' };

    if (application.status === 'submitted' && fresh?.driverId) {
      // Already accepted: the driver file exists, so the CDL goes straight to Safety's review.
      const { document } = await this.compliance.upload(r.principal, {
        ownerType: 'driver',
        ownerId: fresh.driverId,
        ownerLabel: fresh.candidateName,
        requirementCode: body.code,
        title: label,
        fileName,
        contentType: type,
        sizeBytes: bytes.byteLength,
        issuedOn: null,
        expiresOn,
        source: 'public_link',
        notes: 'Uploaded by the driver through the DOT application link',
        bytes,
        at,
      });
      result = { id: document.id, code: body.code, status: 'pending_review' };
    } else {
      // Waiting for review: kept privately against the case, filed when a recruiter accepts.
      const id = `dlf_${crypto.randomUUID()}`;
      const stored = await this.storage.put(`dot-link/${r.principal.companyId}/${id}${EXTENSION[type]}`, bytes);
      await this.db.transaction(async (tx) => {
        await tx
          .update(hiringDotLinkFiles)
          .set({ supersededAt: at })
          .where(
            and(
              eq(hiringDotLinkFiles.hiringCaseId, r.hiringCase.id),
              eq(hiringDotLinkFiles.code, body.code),
              isNull(hiringDotLinkFiles.supersededAt),
              isNull(hiringDotLinkFiles.filedAt),
            ),
          );
        await tx.insert(hiringDotLinkFiles).values({
          id,
          companyId: r.principal.companyId,
          hiringCaseId: r.hiringCase.id,
          linkId: r.link.id,
          code: body.code,
          fileName,
          contentType: type,
          sizeBytes: stored.sizeBytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          storageKey: stored.key,
          expiresOn,
          uploadedAt: at,
        });
      });
      result = { id, code: body.code, status: 'waiting_for_review' };
    }
    if (body.code === 'cdl') {
      await this.db.update(hiringDotLinks).set({ cdlUploadedAt: at }).where(eq(hiringDotLinks.id, r.link.id));
    }
    await this.audit.write(r.principal, {
      action: 'document_uploaded_by_driver',
      actorType: 'system',
      actor: this.actor(r),
      entityType: 'applicant',
      entityId: r.hiringCase.applicantId as string,
      entityLabel: r.hiringCase.candidateName,
      summary:
        result.status === 'pending_review'
          ? `The driver uploaded ${label} through the DOT application link; waiting for Safety's review`
          : `The driver uploaded ${label} through the DOT application link; filed when a recruiter accepts the application`,
      changes: [{ field: body.code, old: null, new: result.id }],
      at,
    });
    return { file: result, application: await this.view(r, application) };
  }
}
