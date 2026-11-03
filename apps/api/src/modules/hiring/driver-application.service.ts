import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { notifyRecruiters } from './recruiting-notify';
import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { NOT_SENT, PENDING_SEND } from './link-pending';
import {
  DOT_LINK_MISSES_ALLOWED,
  DOT_LINK_MISS_WINDOW_MS,
  DOT_LINK_TOKEN_PATTERN,
  DRIVER_APPLICATION_ANSWER_LABELS,
  DRIVER_APPLICATION_FILE_CODES,
  DRIVER_APPLICATION_FILE_FIELDS,
  DRIVER_APPLICATION_FILE_LABELS,
  DRIVER_APPLICATION_MAX_FILE_BYTES,
  DRIVER_APPLICATION_MAX_SIGNATURE_BYTES,
  DRIVER_APPLICATION_SCHEMA_VERSION,
  DRIVER_APPLICATION_TTL_DAYS,
  DRIVER_AUTHORIZATION_LABELS,
  DRIVER_AUTHORIZATION_TYPES,
  DriverApplicationFieldsSchema,
  DriverAuthorizationsSchema,
  type DriverApplicationAck,
  type DriverApplicationFields,
  type DriverApplicationFileField,
  type DriverApplicationLinkIssued,
  type DriverApplicationSessionView,
  type DriverApplicationSubmissionView,
  type DriverApplicationView,
  type DriverAuthorizationType,
  type DriverAuthorizations,
  type DriverAuthorizationView,
} from '@neway/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { multipartBoundary, parseMultipart, type MultipartFile } from '../../common/http/multipart';
import { RateLimiter } from '../../common/http/rate-limiter';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import { complianceDocuments } from '../../database/schema/compliance';
import {
  hiringApplicationSessions,
  hiringCases,
  hiringConsentFiles,
  hiringConsents,
  type HiringConsentRow,
  hiringDriverApplicationFiles,
  hiringDriverApplications,
  hiringDriverAuthorizations,
  hiringLeads,
  type HiringApplicationSessionRow,
  type HiringCaseRow,
  type HiringDriverApplicationRow,
} from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { decrypt, encrypt, type SealedCredential } from '../admin/credential-vault';
import { ComplianceService } from '../compliance/compliance.service';
import { sniff, cleanFileName } from '../driver-relations/receipts';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { Writer } from './dot-application-pdf';
import { DRIVER_DISCLOSURES, DRIVER_DISCLOSURE_VERSION } from './driver-disclosures';
import { HiringService } from './hiring.service';
import { LeadsService } from './leads.service';

const DAY = 86_400_000;
const EXTENSION: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
/** The confirmation the page asks the driver to tick, as the page words it. */
export const DRIVER_APPLICATION_CONSENT_STATEMENT =
  'I confirm the information is accurate and agree that NORTHWIND FREIGHT recruiting may contact me about this application and review the documents and SSN I submit for employment processing.';
const FORWARD_WINDOW_SECONDS = 300;

/** The disclosure texts the server accepts, by version (only the current one today). */
const DISCLOSURES: Record<string, Readonly<Record<DriverAuthorizationType, string>>> = {
  [DRIVER_DISCLOSURE_VERSION]: DRIVER_DISCLOSURES,
};

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The person a session belongs to, as the staff side resolved it (company-scoped already). */
export interface ApplicationSubject {
  companyId: string;
  leadId: string | null;
  caseId: string | null;
  /** One live session per subject: the lead id, or the case id for a candidate without a lead. */
  subjectKey: string;
  name: string;
  applicantId: string | null;
  leadStatus: string | null;
  caseState: string | null;
  /** The route key the candidate page uses. */
  key: string;
}

export interface PublicRequestMeta {
  ip: string;
  secure: boolean;
  origin: string | null;
  via: 'same_origin' | 'forwarder';
  /** The browser's own random key (x-neway-device): a link opens on its first device only. */
  device?: string | null;
}

export type PublicResult = { status: number; body: DriverApplicationAck | { error: string } };

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** On unless switched off; off by default outside production (local dev and tests are plain http). */
function httpsRequired(): boolean {
  const flag = env.PUBLIC_LINKS_REQUIRE_HTTPS;
  return flag === undefined ? env.NODE_ENV === 'production' : flag === 'true';
}

function fail(status: number, error: string): AppError {
  const titles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  };
  return new AppError({ status, title: titles[status] ?? 'Error', detail: error });
}

const LINK_INVALID = 'This application link is not valid. Please request your personal application link from recruiting.';
const LINK_GONE = 'This application link has expired. Please request a new link.';
const SAVE_FAILED = 'We could not save your application. Nothing was submitted; please try again in a moment.';

/** PNG signature, then IHDR with sane dimensions, then IEND at the very end. Width/height or null. */
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 57) return null;
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  if (bytes.subarray(bytes.length - 8, bytes.length - 4).toString('latin1') !== 'IEND') return null;
  return { width, height };
}

interface ValidatedFile {
  field: DriverApplicationFileField;
  code: 'cdl' | 'cdl_back' | 'medical_card';
  fileName: string;
  declaredType: string | null;
  contentType: string;
  bytes: Buffer;
  sha256: string;
}

interface ValidatedAuthorization {
  type: DriverAuthorizationType;
  decision: 'signed' | 'declined';
  signerName: string | null;
  printedSignature: string | null;
  disclosureOpened: boolean | null;
  clientSignedAt: string | null;
  disclosureVersion: string | null;
  disclosureText: string | null;
  disclosureSha256: string | null;
  png: { bytes: Buffer; sha256: string; width: number; height: number } | null;
}

interface Validated {
  fields: DriverApplicationFields;
  files: ValidatedFile[];
  authorizations: ValidatedAuthorization[];
}

interface ResolvedSession {
  session: HiringApplicationSessionRow;
  principal: Principal;
  companyName: string;
}

/**
 * The personal driver application (owner brief, 2026-10-08).
 *
 * Staff side: Send application issues one private link per lead or candidate (token shown once,
 * SHA-256 kept, 14 days, a new link revokes the old), records Link copied and Mark as sent
 * separately, and shows what arrived: answers (SSN masked), documents and each authorization.
 *
 * Driver side: the approved page posts multipart to /api/applications (nginx → this). The token
 * alone resolves the company and the person. Everything is validated in memory first; then, under
 * a per-session lock, the lead becomes a candidate (existing conversion, recruiter unchanged, no
 * rotation turn), the driver id is reserved, the files and signature images are written to
 * private storage (journalled on the session so a crash leaves nothing unaccounted for), and the
 * application, its file rows, its authorization rows and the session's "submitted" stamp commit in
 * one transaction. Only then is `{ tmsSaved: true, reference }` returned. A retry with the same
 * submission key gets the same reference; a second, different submission on a used link is refused.
 */
@Injectable()
export class DriverApplicationService {
  private readonly logger = new Logger(DriverApplicationService.name);
  private readonly submitLimiter = new RateLimiter(20, 10 * 60_000);
  private readonly missLimiter = new RateLimiter(DOT_LINK_MISSES_ALLOWED, DOT_LINK_MISS_WINDOW_MS);
  /** Forwarded-request signatures seen inside the replay window (per process). */
  private readonly seenSignatures = new Map<string, number>();
  /** Set by the consent service at start-up: files a consent's CDL front once the expiry is known. */
  consentFiling: ((consent: HiringConsentRow) => Promise<void>) | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly leads: LeadsService,
    private readonly drivers: DriversService,
    private readonly compliance: ComplianceService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // =========================================================================== the staff side

  /** Where the personal link points: the TMS-hosted page unless configured otherwise. */
  linkFor(token: string): string {
    const base = env.DRIVER_APPLICATION_LINK_BASE_URL ?? `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/application/`;
    return `${base.split('#')[0]}#token=${token}`;
  }

  private sessionView(row: HiringApplicationSessionRow, now: Date): DriverApplicationSessionView {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: row.id,
      state: row.submittedAt ? 'submitted' : row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'live',
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdByName,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      revokedBy: row.revokedBy,
      linkCopiedAt: iso(row.linkCopiedAt),
      linkCopiedBy: row.linkCopiedBy,
      markedSentAt: iso(row.markedSentAt),
      markedSentBy: row.markedSentBy,
      markedSentChannel: row.markedSentChannel,
      submittedAt: iso(row.submittedAt),
    };
  }

  private async latestSession(subject: ApplicationSubject): Promise<HiringApplicationSessionRow | null> {
    const parts = [eq(hiringApplicationSessions.subjectKey, subject.subjectKey)];
    if (subject.caseId) parts.push(eq(hiringApplicationSessions.hiringCaseId, subject.caseId));
    if (subject.leadId) parts.push(eq(hiringApplicationSessions.leadId, subject.leadId));
    const [row] = await this.db
      .select()
      .from(hiringApplicationSessions)
      .where(
        and(
          eq(hiringApplicationSessions.companyId, subject.companyId),
          or(...parts),
          // A link whose message never went out was never the driver's: it is not "the" link.
          or(isNull(hiringApplicationSessions.revokedBy), notInArray(hiringApplicationSessions.revokedBy, [PENDING_SEND, NOT_SENT])),
        ),
      )
      .orderBy(sql`(${hiringApplicationSessions.revokedAt} IS NULL) DESC`, desc(hiringApplicationSessions.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async submissionFor(subject: ApplicationSubject): Promise<HiringDriverApplicationRow | null> {
    const parts = [];
    if (subject.caseId) parts.push(eq(hiringDriverApplications.hiringCaseId, subject.caseId));
    if (subject.leadId) parts.push(eq(hiringDriverApplications.leadId, subject.leadId));
    if (parts.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, subject.companyId), or(...parts)))
      .orderBy(desc(hiringDriverApplications.receivedAt))
      .limit(1);
    return row ?? null;
  }

  /** Which cases have a received personal application (for progress), in one query. */
  async receivedCaseIds(companyId: string, caseIds: string[]): Promise<Set<string>> {
    if (caseIds.length === 0) return new Set();
    const rows = await this.db
      .select({ caseId: hiringDriverApplications.hiringCaseId })
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, companyId), inArray(hiringDriverApplications.hiringCaseId, caseIds)));
    return new Set(rows.map((r) => r.caseId));
  }

  /** Which leads have a live, unused personal link (for "Send reminder"). */
  async liveLeadIds(companyId: string, leadIds: string[]): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();
    const rows = await this.db
      .select({ leadId: hiringApplicationSessions.leadId, expiresAt: hiringApplicationSessions.expiresAt })
      .from(hiringApplicationSessions)
      .where(
        and(
          eq(hiringApplicationSessions.companyId, companyId),
          inArray(hiringApplicationSessions.leadId, leadIds),
          isNull(hiringApplicationSessions.revokedAt),
          isNull(hiringApplicationSessions.submittedAt),
        ),
      );
    const now = Date.now();
    return new Set(rows.filter((r) => r.expiresAt.getTime() > now && r.leadId).map((r) => r.leadId as string));
  }

  async view(principal: Principal, subject: ApplicationSubject): Promise<DriverApplicationView> {
    const now = new Date();
    const session = await this.latestSession(subject);
    const submission = await this.submissionFor(subject);
    if (submission) await this.fileOutstanding(submission).catch(() => undefined);
    return {
      session: session ? this.sessionView(session, now) : null,
      submission: submission ? await this.submissionView(principal, submission) : null,
    };
  }

  private async submissionView(principal: Principal, row: HiringDriverApplicationRow): Promise<DriverApplicationSubmissionView> {
    const answers = (row.answers ?? {}) as Record<string, unknown>;
    const files = await this.db
      .select()
      .from(hiringDriverApplicationFiles)
      .where(and(eq(hiringDriverApplicationFiles.companyId, principal.companyId), eq(hiringDriverApplicationFiles.applicationId, row.id)));
    const docIds = files.map((f) => f.filedDocumentId).filter((v): v is string => !!v);
    const docs = docIds.length
      ? await this.db
          .select({ id: complianceDocuments.id, status: complianceDocuments.status })
          .from(complianceDocuments)
          .where(and(eq(complianceDocuments.companyId, principal.companyId), inArray(complianceDocuments.id, docIds)))
      : [];
    const auths = await this.db
      .select()
      .from(hiringDriverAuthorizations)
      .where(and(eq(hiringDriverAuthorizations.companyId, principal.companyId), eq(hiringDriverAuthorizations.applicationId, row.id)));
    const order = ['cdl', 'cdl_back', 'medical_card'];
    return {
      id: row.id,
      reference: row.reference,
      receivedAt: row.receivedAt.toISOString(),
      via: row.via as 'same_origin' | 'forwarder',
      schemaVersion: row.schemaVersion,
      answers: DRIVER_APPLICATION_ANSWER_LABELS.map(([key, label]) => ({
        key,
        label,
        value: answers[key] === null || answers[key] === undefined ? '' : String(answers[key]),
      })).filter((a) => a.value !== ''),
      ssnMasked: `•••-••-${row.ssnLast4}`,
      files: files
        .sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))
        .map((f) => ({
          id: f.id,
          code: f.code as 'cdl' | 'cdl_back' | 'medical_card',
          label: DRIVER_APPLICATION_FILE_LABELS[f.code] ?? f.code,
          fileName: f.fileName,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          uploadedAt: f.uploadedAt.toISOString(),
          documentId: f.filedDocumentId,
          documentStatus: docs.find((d) => d.id === f.filedDocumentId)?.status ?? null,
        })),
      authorizations: DRIVER_AUTHORIZATION_TYPES.map((type): DriverAuthorizationView => {
        const a = auths.find((x) => x.documentType === type);
        if (!a) {
          return {
            type,
            label: DRIVER_AUTHORIZATION_LABELS[type],
            decision: 'not_provided',
            id: null,
            signerName: null,
            clientSignedAt: null,
            receivedAt: null,
            disclosureVersion: null,
            disclosureSha256: null,
            disclosureOpenedClaim: null,
            hasSignatureImage: false,
          };
        }
        return {
          type,
          label: DRIVER_AUTHORIZATION_LABELS[type],
          decision: a.decision as 'signed' | 'declined',
          id: a.id,
          signerName: a.signerName,
          clientSignedAt: a.clientSignedAt,
          receivedAt: a.receivedAt.toISOString(),
          disclosureVersion: a.disclosureVersion,
          disclosureSha256: a.disclosureSha256,
          disclosureOpenedClaim: a.disclosureOpenedClaim,
          hasSignatureImage: Boolean(a.signatureStorageKey),
        };
      }),
    };
  }

  private entity(subject: ApplicationSubject) {
    return subject.leadId
      ? { entityType: 'hiring_lead', entityId: subject.leadId }
      : { entityType: 'hiring_case', entityId: subject.caseId as string };
  }

  /**
   * Send application: a new personal link for this person. The address is returned once; only its
   * digest is kept, so "retrieving" a link later means seeing its state, or issuing a new one (which
   * turns the old one off). Refused once an application has arrived: there is no amendment session.
   */
  async issue(principal: Principal, subject: ApplicationSubject, opts: { deferred?: boolean } = {}): Promise<DriverApplicationLinkIssued> {
    if (subject.leadStatus === 'dead') {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This lead was disqualified; reopen it before sending an application.' });
    }
    if (subject.caseState && ['dropped', 'disqualified', 'withdrawn', 'hired', 'active_driver'].includes(subject.caseState)) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This candidate is no longer in the hiring pipeline.' });
    }
    if (!subject.leadId && !subject.applicantId) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This case predates the funnel and has no candidate record.' });
    }
    if (await this.submissionFor(subject)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The application has already been received. A second application needs an amendment, which is not available yet.',
      });
    }
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const by = principal.userName ?? principal.userId;
    const id = `aps_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + DRIVER_APPLICATION_TTL_DAYS * DAY);
    const { entityType, entityId } = this.entity(subject);
    if (opts.deferred) {
      // Made for a message about to be sent: it works, and turns the current link off, only once
      // the provider accepted the message (activate); otherwise it is discarded.
      await this.db.insert(hiringApplicationSessions).values({
        id,
        companyId: subject.companyId,
        leadId: subject.leadId,
        hiringCaseId: subject.caseId,
        subjectKey: subject.subjectKey,
        tokenHash: sha256(token),
        schemaVersion: DRIVER_APPLICATION_SCHEMA_VERSION,
        createdByUserId: principal.userId,
        createdByName: by,
        createdAt: now,
        expiresAt,
        revokedAt: now,
        revokedBy: PENDING_SEND,
      });
      const [row] = await this.db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, id)).limit(1);
      return { url: this.linkFor(token), expiresAt: expiresAt.toISOString(), key: subject.key, session: this.sessionView(row as HiringApplicationSessionRow, now) };
    }
    const events = await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(hiringApplicationSessions)
        .set({ revokedAt: now, revokedBy: by, updatedAt: now })
        .where(
          and(
            eq(hiringApplicationSessions.companyId, subject.companyId),
            eq(hiringApplicationSessions.subjectKey, subject.subjectKey),
            isNull(hiringApplicationSessions.revokedAt),
            isNull(hiringApplicationSessions.submittedAt),
          ),
        )
        .returning({ id: hiringApplicationSessions.id });
      await tx.insert(hiringApplicationSessions).values({
        id,
        companyId: subject.companyId,
        leadId: subject.leadId,
        hiringCaseId: subject.caseId,
        subjectKey: subject.subjectKey,
        tokenHash: sha256(token),
        schemaVersion: DRIVER_APPLICATION_SCHEMA_VERSION,
        createdByUserId: principal.userId,
        createdByName: by,
        createdAt: now,
        expiresAt,
      });
      const out = [];
      for (const old of revoked) {
        out.push(
          await this.audit.writeIn(tx, principal, {
            action: 'driver_application_link_revoked',
            entityType,
            entityId,
            entityLabel: subject.name,
            summary: 'Personal application link turned off: a new link was made',
            changes: [{ field: 'application_session', old: old.id, new: 'revoked' }],
            at: now,
          }),
        );
      }
      out.push(
        await this.audit.writeIn(tx, principal, {
          action: 'driver_application_link_created',
          entityType,
          entityId,
          entityLabel: subject.name,
          summary: `Personal application link made; works until ${expiresAt.toISOString().slice(0, 10)}. Nothing was sent.`,
          changes: [{ field: 'application_session', old: revoked[0]?.id ?? null, new: id }],
          at: now,
        }),
      );
      return out;
    });
    await this.audit.publish(...events);
    const [row] = await this.db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, id)).limit(1);
    return { url: this.linkFor(token), expiresAt: expiresAt.toISOString(), key: subject.key, session: this.sessionView(row as HiringApplicationSessionRow, now) };
  }

  /** The provider accepted the message: its link becomes the live one and the previous one stops. */
  async activate(principal: Principal, subject: ApplicationSubject, sessionId: string, via: string): Promise<void> {
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const { entityType, entityId } = this.entity(subject);
    const events = await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(hiringApplicationSessions)
        .set({ revokedAt: now, revokedBy: by, updatedAt: now })
        .where(
          and(
            eq(hiringApplicationSessions.companyId, subject.companyId),
            eq(hiringApplicationSessions.subjectKey, subject.subjectKey),
            ne(hiringApplicationSessions.id, sessionId),
            isNull(hiringApplicationSessions.revokedAt),
            isNull(hiringApplicationSessions.submittedAt),
          ),
        )
        .returning({ id: hiringApplicationSessions.id });
      const [live] = await tx
        .update(hiringApplicationSessions)
        .set({ revokedAt: null, revokedBy: null, updatedAt: now })
        .where(and(eq(hiringApplicationSessions.companyId, subject.companyId), eq(hiringApplicationSessions.id, sessionId), eq(hiringApplicationSessions.revokedBy, PENDING_SEND)))
        .returning({ id: hiringApplicationSessions.id, expiresAt: hiringApplicationSessions.expiresAt });
      if (!live) throw new AppError({ status: 409, title: 'Conflict', detail: 'This link is no longer waiting to be sent.' });
      const out = [];
      for (const old of revoked) {
        out.push(
          await this.audit.writeIn(tx, principal, {
            action: 'driver_application_link_revoked',
            entityType,
            entityId,
            entityLabel: subject.name,
            summary: `Personal application link turned off: a new link was sent by ${via}`,
            changes: [{ field: 'application_session', old: old.id, new: 'revoked' }],
            at: now,
          }),
        );
      }
      out.push(
        await this.audit.writeIn(tx, principal, {
          action: 'driver_application_link_created',
          entityType,
          entityId,
          entityLabel: subject.name,
          summary: `Personal application link made and sent by ${via}; works until ${live.expiresAt.toISOString().slice(0, 10)}.`,
          changes: [{ field: 'application_session', old: revoked[0]?.id ?? null, new: sessionId }],
          at: now,
        }),
      );
      return out;
    });
    await this.audit.publish(...events);
  }

  /** The message was not accepted: its link never works, and the current link stays as it was. */
  async discard(companyId: string, sessionId: string): Promise<void> {
    await this.db
      .update(hiringApplicationSessions)
      .set({ revokedBy: NOT_SENT, updatedAt: new Date() })
      .where(and(eq(hiringApplicationSessions.companyId, companyId), eq(hiringApplicationSessions.id, sessionId), eq(hiringApplicationSessions.revokedBy, PENDING_SEND)));
  }

  private async liveSession(subject: ApplicationSubject): Promise<HiringApplicationSessionRow> {
    const row = await this.latestSession(subject);
    if (!row || row.revokedAt) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'There is no application link for this candidate. Make one first.' });
    }
    return row;
  }

  /** "Link copied": the recruiter copied it. Copying is not sending; this records only the copy. */
  async markCopied(principal: Principal, subject: ApplicationSubject): Promise<DriverApplicationSessionView> {
    const row = await this.liveSession(subject);
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringApplicationSessions)
        .set({ linkCopiedAt: at, linkCopiedBy: by, version: row.version + 1, updatedAt: at })
        .where(and(eq(hiringApplicationSessions.companyId, subject.companyId), eq(hiringApplicationSessions.id, row.id)));
      return this.audit.writeIn(tx, principal, {
        action: 'driver_application_link_copied',
        ...this.entity(subject),
        entityLabel: subject.name,
        summary: 'Personal application link copied (copying is not sending)',
        changes: [{ field: 'link_copied_at', old: row.linkCopiedAt?.toISOString() ?? null, new: at.toISOString() }],
        at,
      });
    });
    await this.audit.publish(event);
    return this.sessionView({ ...row, linkCopiedAt: at, linkCopiedBy: by }, at);
  }

  /** "Mark as sent": the recruiter says they sent the link by hand. Nothing is sent from here. */
  async markSent(principal: Principal, subject: ApplicationSubject, channel: string | null): Promise<DriverApplicationSessionView> {
    const row = await this.liveSession(subject);
    if (row.submittedAt) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'The application has already been received through this link.' });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This link has expired. Make a new one first.' });
    }
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringApplicationSessions)
        .set({ markedSentAt: at, markedSentBy: by, markedSentChannel: channel, version: row.version + 1, updatedAt: at })
        .where(and(eq(hiringApplicationSessions.companyId, subject.companyId), eq(hiringApplicationSessions.id, row.id)));
      return this.audit.writeIn(tx, principal, {
        action: 'driver_application_link_marked_sent',
        ...this.entity(subject),
        entityLabel: subject.name,
        summary: `Recruiter recorded sending the personal application link by hand${channel ? ` (${channel})` : ''}`,
        changes: [{ field: 'marked_sent_at', old: row.markedSentAt?.toISOString() ?? null, new: at.toISOString() }],
        at,
      });
    });
    await this.audit.publish(event);
    return this.sessionView({ ...row, markedSentAt: at, markedSentBy: by, markedSentChannel: channel }, at);
  }

  async revoke(principal: Principal, subject: ApplicationSubject): Promise<DriverApplicationView> {
    const row = await this.latestSession(subject);
    if (row && !row.revokedAt && !row.submittedAt) {
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      const event = await this.db.transaction(async (tx) => {
        await tx
          .update(hiringApplicationSessions)
          .set({ revokedAt: at, revokedBy: by, version: row.version + 1, updatedAt: at })
          .where(and(eq(hiringApplicationSessions.companyId, subject.companyId), eq(hiringApplicationSessions.id, row.id), isNull(hiringApplicationSessions.revokedAt)));
        return this.audit.writeIn(tx, principal, {
          action: 'driver_application_link_revoked',
          ...this.entity(subject),
          entityLabel: subject.name,
          summary: 'Personal application link turned off',
          changes: [{ field: 'application_session', old: row.id, new: 'revoked' }],
          at,
        });
      });
      await this.audit.publish(event);
    }
    return this.view(principal, subject);
  }

  private async ownSubmission(principal: Principal, subject: ApplicationSubject): Promise<HiringDriverApplicationRow> {
    const row = await this.submissionFor(subject);
    if (!row || row.companyId !== principal.companyId) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No application on this candidate.' });
    }
    return row;
  }

  /** One of this candidate's own uploaded documents, for preview; never another person's. */
  async fileBytes(principal: Principal, subject: ApplicationSubject, fileId: string) {
    const app = await this.ownSubmission(principal, subject);
    const [row] = await this.db
      .select()
      .from(hiringDriverApplicationFiles)
      .where(
        and(
          eq(hiringDriverApplicationFiles.companyId, principal.companyId),
          eq(hiringDriverApplicationFiles.applicationId, app.id),
          eq(hiringDriverApplicationFiles.id, fileId),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such document on this candidate.' });
    return { fileName: row.fileName, contentType: row.contentType, bytes: await this.storage.get(row.storageKey) };
  }

  private async ownAuthorization(principal: Principal, subject: ApplicationSubject, authId: string) {
    const app = await this.ownSubmission(principal, subject);
    const [row] = await this.db
      .select()
      .from(hiringDriverAuthorizations)
      .where(
        and(
          eq(hiringDriverAuthorizations.companyId, principal.companyId),
          eq(hiringDriverAuthorizations.applicationId, app.id),
          eq(hiringDriverAuthorizations.id, authId),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such authorization on this candidate.' });
    return { app, row };
  }

  /** The drawn signature exactly as received (PNG). */
  async signatureImage(principal: Principal, subject: ApplicationSubject, authId: string) {
    const { row } = await this.ownAuthorization(principal, subject, authId);
    if (!row.signatureStorageKey) throw new AppError({ status: 404, title: 'Not Found', detail: 'This authorization was not signed.' });
    return { fileName: `${row.documentType}-signature.png`, contentType: 'image/png', bytes: await this.storage.get(row.signatureStorageKey) };
  }

  /** One authorization as its own document: the disclosure as signed, the evidence, the signature. */
  async authorizationPdf(principal: Principal, subject: ApplicationSubject, authId: string) {
    const { app, row } = await this.ownAuthorization(principal, subject, authId);
    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    const companyName = company?.name ?? principal.companyId;
    const label = DRIVER_AUTHORIZATION_LABELS[row.documentType as DriverAuthorizationType] ?? row.documentType;
    const doc = await PDFDocument.create();
    doc.setTitle(`${label} — ${row.signerName ?? subject.name}`);
    doc.setProducer('NeWay TMS');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const w = new Writer(doc, font, bold, `${companyName} · ${label} · application ${app.reference} · contains personal information`);
    const eastern = (d: Date) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
        .format(d)
        .replace(/[\u202f\u00a0]/g, ' ');
    w.title(label, `${companyName} · electronic authorization received with application ${app.reference}`);
    w.field('Decision', row.decision === 'signed' ? 'Authorized (signed)' : 'Not authorized (declined)');
    w.field('Name (printed)', row.signerName);
    w.field('Signature method', row.decision === 'signed' ? 'Drawn electronic signature' : null);
    w.field('Device-reported time', row.clientSignedAt ? `${row.clientSignedAt} (as claimed by the device)` : null);
    w.field('Received by the TMS', eastern(row.receivedAt));
    w.field('Disclosure version', row.disclosureVersion);
    w.field('Disclosure SHA-256', row.disclosureSha256);
    w.field('Disclosure opened (claim)', row.disclosureOpenedClaim === null ? null : row.disclosureOpenedClaim ? 'Yes' : 'No');
    w.space();
    if (row.disclosureText) {
      w.heading('Disclosure and authorization as signed');
      for (const para of row.disclosureText.split('\n')) {
        // eslint-disable-next-line no-control-regex
        if (para.trim()) w.paragraph(para.replace(/[^\u0000-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u2022]/g, '?'));
        else w.space(0.4);
      }
    }
    if (row.signatureStorageKey) {
      w.heading('Signature');
      const png = await doc.embedPng(await this.storage.get(row.signatureStorageKey));
      w.image(png, 300);
      w.field('Signed by', row.signerName);
    }
    return { fileName: `${row.documentType}-authorization-${app.reference}.pdf`, contentType: 'application/pdf', bytes: Buffer.from(await doc.save()) };
  }

  /** The received application as one printable document: the answers (SSN masked), documents, authorizations. */
  async applicationPdf(principal: Principal, subject: ApplicationSubject) {
    const app = await this.ownSubmission(principal, subject);
    const view = await this.submissionView(principal, app);
    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    const companyName = company?.name ?? principal.companyId;
    const doc = await PDFDocument.create();
    doc.setTitle(`Driver application ${view.reference} — ${subject.name}`);
    doc.setProducer('NeWay TMS');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    // eslint-disable-next-line no-control-regex
    const safe = (v: string | null | undefined) => (v ?? '').replace(/[^\u0000-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u2022]/g, '?');
    const w = new Writer(doc, font, bold, `${companyName} · Driver application ${view.reference} · contains personal information`);
    w.title('Driver application', `${companyName} · reference ${view.reference} · received ${view.receivedAt.slice(0, 10)}`);
    const sections: [string, string[]][] = [
      ['Personal information', ['firstName', 'lastName', 'phone', 'email', 'address', 'city', 'stateZip']],
      ['CDL & experience', ['cdlClass', 'cdlState', 'cdlExpiration', 'medicalExpiration', 'experience', 'endorsements', 'position', 'preference', 'startDate', 'routes']],
      ['Driving history', ['employer', 'employmentStart', 'employmentEnd', 'leavingReason', 'accidents', 'violations', 'suspended', 'source', 'details']],
    ];
    for (const [heading, keys] of sections) {
      w.heading(heading);
      for (const key of keys) {
        const a = view.answers.find((x) => x.key === key);
        if (a) w.field(a.label, safe(a.value));
      }
      if (heading === 'Personal information') w.field('SSN', safe(view.ssnMasked));
    }
    w.heading('Documents');
    if (view.files.length === 0) w.paragraph('None attached (optional on this application).');
    for (const f of view.files) w.field(f.label, safe(`${f.fileName} · ${f.documentStatus === 'verified' ? 'approved by Safety' : f.documentStatus === 'rejected' ? 'rejected by Safety' : 'pending review'}`));
    w.heading('Authorizations');
    for (const a of view.authorizations) {
      w.field(a.label, safe(a.decision === 'signed' ? `Signed by ${a.signerName ?? ''}` : a.decision === 'declined' ? 'Declined' : 'Not provided'));
    }
    w.space();
    w.paragraph(`Confirmed by the driver: ${DRIVER_APPLICATION_CONSENT_STATEMENT}`);
    w.paragraph('This is the initial recruiting application. It does not replace the DOT employment application.');
    return { fileName: `driver-application-${view.reference}.pdf`, contentType: 'application/pdf', bytes: Buffer.from(await doc.save()) };
  }

  /** The full SSN, for staff allowed to see restricted records; every reveal is audited. */
  async revealSsn(principal: Principal, subject: ApplicationSubject): Promise<{ ssn: string }> {
    if (!hasPermission(principal, 'compliance_sensitive.view')) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Revealing the SSN needs the restricted-records permission.' });
    }
    const app = await this.ownSubmission(principal, subject);
    const digits = decrypt(app.ssnSealed as SealedCredential, 'pii');
    await this.audit.write(principal, {
      action: 'ssn_revealed',
      ...this.entity(subject),
      entityLabel: subject.name,
      summary: `SSN revealed on application ${app.reference}`,
      changes: [],
    });
    return { ssn: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` };
  }

  // =========================================================================== the driver side

  /** The origins a browser may post from: the TMS itself and the configured link base. */
  private originAllowed(origin: string | null): boolean {
    if (!origin) return true;
    const allowed = new Set<string>([new URL(env.PUBLIC_APP_BASE_URL).origin, ...list(env.DRIVER_APPLICATION_ORIGINS)]);
    if (env.DRIVER_APPLICATION_LINK_BASE_URL) allowed.add(new URL(env.DRIVER_APPLICATION_LINK_BASE_URL).origin);
    if (allowed.has(origin)) return true;
    return env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  private ipHash(ip: string): string {
    return createHmac('sha256', env.APP_SECRET).update(`driver-application:${ip}`).digest('hex').slice(0, 32);
  }

  private miss(ip: string): AppError {
    try {
      this.missLimiter.hit(`app-miss:${ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    } catch (error) {
      return error as AppError;
    }
    return fail(401, LINK_INVALID);
  }

  /** The browser path (`/api/applications`): same origin, no credentials, the token in the body. */
  async submitPublic(raw: unknown, contentType: string | undefined, meta: PublicRequestMeta): Promise<PublicResult> {
    if (httpsRequired() && !meta.secure) throw fail(403, 'Please open your application link over a secure (https) connection.');
    if (!this.originAllowed(meta.origin)) throw fail(403, 'Applications can only be sent from the NORTHWIND FREIGHT application page.');
    return this.submit(raw, contentType, meta);
  }

  /**
   * The server-to-server path for a separately hosted copy of the page: the forwarder relays the
   * browser's multipart body unchanged and signs it with the shared secret (HMAC-SHA256 over
   * `<unix seconds>.<sha256 of the body>`). A stale or repeated signature is refused; a repeated
   * submission is still answered from the database with the same reference.
   */
  async submitForwarded(
    raw: unknown,
    contentType: string | undefined,
    headers: { timestamp: string | null; signature: string | null; clientIp: string | null },
    meta: PublicRequestMeta,
  ): Promise<PublicResult> {
    const secret = env.EXTERNAL_APPLICATION_SECRET;
    if (!secret) throw fail(404, 'Not found.');
    if (httpsRequired() && !meta.secure) throw fail(403, 'Forwarding must use https.');
    if (!Buffer.isBuffer(raw)) throw fail(415, 'Send the application as multipart/form-data.');
    const ts = Number(headers.timestamp);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(ts) || Math.abs(now - ts) > FORWARD_WINDOW_SECONDS) throw fail(401, 'The forwarded request is stale or unsigned.');
    const expected = `v1=${createHmac('sha256', secret).update(`${ts}.${sha256(raw)}`).digest('hex')}`;
    const given = headers.signature ?? '';
    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(given).digest();
    if (!timingSafeEqual(a, b)) throw fail(401, 'The forwarded request is not signed correctly.');
    for (const [sig, at] of this.seenSignatures) if (at < now - FORWARD_WINDOW_SECONDS) this.seenSignatures.delete(sig);
    if (this.seenSignatures.has(given)) throw fail(409, 'This forwarded request was already received.');
    this.seenSignatures.set(given, ts);
    const ip = headers.clientIp && /^[0-9a-fA-F:.]{3,45}$/.test(headers.clientIp) ? headers.clientIp : meta.ip;
    return this.submit(raw, contentType, { ...meta, ip, via: 'forwarder' });
  }

  private async resolveToken(token: string, meta: PublicRequestMeta): Promise<ResolvedSession> {
    if (!DOT_LINK_TOKEN_PATTERN.test(token)) throw this.miss(meta.ip);
    const [row] = await this.db
      .select({ session: hiringApplicationSessions, companyName: companies.name, timezone: companies.timezone, weekStart: companies.weekStart })
      .from(hiringApplicationSessions)
      .innerJoin(companies, eq(companies.id, hiringApplicationSessions.companyId))
      .where(eq(hiringApplicationSessions.tokenHash, sha256(token)))
      .limit(1);
    if (!row) throw this.miss(meta.ip);
    if (meta.via === 'forwarder' && !list(env.EXTERNAL_APPLICATION_COMPANIES).includes(row.session.companyId)) {
      throw fail(403, 'This company does not accept forwarded applications.');
    }
    return {
      session: row.session,
      companyName: row.companyName,
      principal: {
        userId: 'system:driver-application',
        userName: 'Driver application link',
        companyId: row.session.companyId,
        companyTimezone: row.timezone,
        weekStart: weekStartIndex(row.weekStart),
        roles: [],
        permissions: new Set(),
      },
    };
  }

  /** The signed consent behind a session's person, when there is one (journey v2). */
  private async consentOf(session: HiringApplicationSessionRow): Promise<HiringConsentRow | null> {
    const parts = [];
    if (session.hiringCaseId) parts.push(eq(hiringConsents.hiringCaseId, session.hiringCaseId));
    if (session.leadId) parts.push(eq(hiringConsents.leadId, session.leadId));
    if (parts.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, session.companyId), or(...parts)))
      .orderBy(desc(hiringConsents.receivedAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * What the application page needs before the driver types (journey v2): whether the details and
   * the CDL front come from the signed consent, and those details to show (not to re-enter).
   */
  async context(token: string, meta: PublicRequestMeta): Promise<{
    companyName: string;
    inherited: boolean;
    /** The CDL back came with the consent too (since 2026-10-12): the application does not ask again. */
    cdlBackReceived: boolean;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    alreadySubmitted: boolean;
  }> {
    const resolved = await this.resolveToken(token, meta);
    const { session } = resolved;
    if (!session.submittedAt && (session.revokedAt || session.expiresAt.getTime() <= Date.now())) throw fail(410, LINK_GONE);
    await this.bindDevice(session, meta.device);
    const consent = await this.consentOf(session);
    return {
      companyName: resolved.companyName,
      inherited: Boolean(consent),
      cdlBackReceived: consent ? await this.consentHasBack(consent) : false,
      firstName: consent?.firstName ?? null,
      lastName: consent?.lastName ?? null,
      phone: consent?.phone ?? null,
      email: consent?.email ?? null,
      alreadySubmitted: Boolean(session.submittedAt),
    };
  }

  private async consentHasBack(consent: HiringConsentRow): Promise<boolean> {
    const [row] = await this.db
      .select({ id: hiringConsentFiles.id })
      .from(hiringConsentFiles)
      .where(and(eq(hiringConsentFiles.companyId, consent.companyId), eq(hiringConsentFiles.consentId, consent.id), eq(hiringConsentFiles.code, 'cdl_back')))
      .limit(1);
    return Boolean(row);
  }

  /** One link, one device (owner, 2026-10-12); see the consent link's rule. */
  private async bindDevice(session: { id: string; submittedAt: Date | null; boundDeviceHash: string | null }, device: string | null | undefined): Promise<void> {
    if (session.submittedAt) return;
    const key = typeof device === 'string' && /^[A-Za-z0-9-]{16,100}$/.test(device) ? createHash('sha256').update(device).digest('hex') : null;
    if (session.boundDeviceHash) {
      if (key !== session.boundDeviceHash) throw fail(403, 'This link was already opened on another phone or computer. Ask your recruiter for a new link.');
      return;
    }
    if (!key) return;
    const [claimed] = await this.db
      .update(hiringApplicationSessions)
      .set({ boundDeviceHash: key, boundAt: new Date() })
      .where(and(eq(hiringApplicationSessions.id, session.id), isNull(hiringApplicationSessions.boundDeviceHash)))
      .returning({ id: hiringApplicationSessions.id });
    if (!claimed) {
      const [again] = await this.db.select({ bound: hiringApplicationSessions.boundDeviceHash }).from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, session.id)).limit(1);
      if (again?.bound !== key) throw fail(403, 'This link was already opened on another phone or computer. Ask your recruiter for a new link.');
    }
  }

  private one(fields: Map<string, string[]>, name: string): string | undefined {
    const values = fields.get(name);
    if (!values) return undefined;
    if (values.length > 1) throw fail(422, 'The form was sent twice in one request. Please try again.');
    return values[0];
  }

  /** Every check that needs no database: fields, files by their bytes, each authorization. */
  private validate(fieldsMap: Map<string, string[]>, filesMap: Map<string, MultipartFile[]>, inherited: HiringConsentRow | null = null, backInherited = false): Validated {
    const input: Record<string, string> = {};
    for (const [name] of fieldsMap) {
      const v = this.one(fieldsMap, name);
      if (v !== undefined) input[name] = v;
    }
    for (const name of filesMap.keys()) {
      if (!(DRIVER_APPLICATION_FILE_FIELDS as readonly string[]).includes(name)) throw fail(422, 'The form has an unexpected file.');
    }
    const parsed = DriverApplicationFieldsSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.') ?? '';
      // The field name and the rule only: never a submitted value.
      if (issue?.code === 'unrecognized_keys') throw fail(422, 'The form has an unexpected field. Please reload the page and try again.');
      const label = DRIVER_APPLICATION_ANSWER_LABELS.find(([k]) => k === path)?.[1] ?? (path === 'ssn' ? 'Social Security number' : path);
      throw fail(422, `${label}: ${issue?.message ?? 'check this field'}.`);
    }
    const fields = parsed.data;

    // Files: one each, real JPEG/PNG/PDF by their bytes, up to 8 MiB. After a signed consent
    // (owner brief, 2026-10-11) the CDL front is the consent's own and the back and the medical
    // card are required; before it, every file stays optional as it was.
    if (inherited) {
      for (const [field, label] of [['cdlBack', 'the back of your CDL'], ['medicalCard', 'your medical card']] as const) {
        if (field === 'cdlBack' && backInherited) continue;
        if ((filesMap.get(field) ?? []).length === 0) throw fail(422, `Upload ${label}.`);
      }
    }
    const files: ValidatedFile[] = [];
    for (const field of DRIVER_APPLICATION_FILE_FIELDS) {
      if (inherited && field === 'cdlFront') continue;
      if (backInherited && field === 'cdlBack') continue;
      const list = filesMap.get(field) ?? [];
      if (list.length > 1) throw fail(422, 'Attach one file per document.');
      const file = list[0];
      if (!file) continue;
      if (file.bytes.length === 0) throw fail(422, 'One of the files is empty. Choose it again.');
      if (file.bytes.length > DRIVER_APPLICATION_MAX_FILE_BYTES) throw fail(413, 'Each file must be 8 MB or smaller.');
      const type = sniff(file.bytes);
      if (!type || !ALLOWED_TYPES.has(type)) throw fail(422, 'Use a JPG, PNG or PDF file.');
      files.push({
        field,
        code: DRIVER_APPLICATION_FILE_CODES[field],
        fileName: cleanFileName(file.fileName || `${field}${EXTENSION[type]}`),
        declaredType: file.declaredType,
        contentType: type,
        bytes: file.bytes,
        sha256: sha256(file.bytes),
      });
    }

    // Authorizations: each one separate; signed ones must carry the drawn image, the exact name
    // on the application and the very disclosure text this server holds.
    let rawAuth: unknown;
    try {
      rawAuth = JSON.parse(fields.authorizations || '{}');
    } catch {
      throw fail(422, 'The authorizations could not be read. Please reload the page and sign again.');
    }
    const authParsed = DriverAuthorizationsSchema.safeParse(rawAuth);
    if (!authParsed.success) throw fail(422, 'An authorization is incomplete. Please sign it again or choose Do not authorize.');
    const auths: DriverAuthorizations = authParsed.data;
    const fullName = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim();
    const authorizations: ValidatedAuthorization[] = [];
    // The MVR and PSP were signed on the consent; the application does not ask again.
    if (inherited) return { fields, files, authorizations };
    for (const type of DRIVER_AUTHORIZATION_TYPES) {
      const a = auths[type];
      // The MVR and PSP are signed on the consent form, not here (owner, 2026-10-12): the application
      // page no longer asks. One sent by an older copy of the page is still checked and kept.
      if (!a || !a.authorized) continue;
      if (a.documentType !== type) throw fail(422, `The ${type.toUpperCase()} authorization is not valid. Please sign it again.`);
      if (a.name !== fullName || a.signature !== a.name) {
        throw fail(422, `Your name changed. Please sign the ${type.toUpperCase()} authorization again.`);
      }
      const canonical = DISCLOSURES[a.disclosureVersion]?.[type];
      if (!canonical || a.disclosureText !== canonical || a.disclosureSha256 !== sha256(canonical)) {
        throw fail(422, `The ${type.toUpperCase()} authorization text is out of date. Please reload the page and sign again.`);
      }
      const b64 = a.drawing.slice('data:image/png;base64,'.length);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw fail(422, `The ${type.toUpperCase()} signature could not be read. Please sign again.`);
      const png = Buffer.from(b64, 'base64');
      if (png.length > DRIVER_APPLICATION_MAX_SIGNATURE_BYTES) throw fail(413, `The ${type.toUpperCase()} signature is too large. Please clear it and sign again.`);
      const dims = pngDimensions(png);
      if (!dims) throw fail(422, `The ${type.toUpperCase()} signature could not be read. Please sign again.`);
      authorizations.push({
        type,
        decision: 'signed',
        signerName: a.name,
        printedSignature: a.signature,
        disclosureOpened: a.disclosureOpened,
        clientSignedAt: a.signedAt,
        disclosureVersion: a.disclosureVersion,
        disclosureText: canonical,
        disclosureSha256: sha256(canonical),
        png: { bytes: png, sha256: sha256(png), ...dims },
      });
    }
    return { fields, files, authorizations };
  }

  private ack(reference: string): DriverApplicationAck {
    return { tmsSaved: true, reference };
  }

  /** The answer to a session that has already been used. */
  private async replay(session: HiringApplicationSessionRow, submissionKey: string | undefined): Promise<PublicResult> {
    const [app] = await this.db
      .select()
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, session.companyId), eq(hiringDriverApplications.sessionId, session.id)))
      .limit(1);
    if (!app) throw fail(503, SAVE_FAILED);
    if (submissionKey && app.submissionKey === submissionKey) {
      await this.fileOutstanding(app).catch(() => undefined);
      return { status: 200, body: this.ack(app.reference) };
    }
    throw fail(409, `Your application was already received (reference ${app.reference}). To change it, please contact recruiting.`);
  }

  private async submit(raw: unknown, contentType: string | undefined, meta: PublicRequestMeta): Promise<PublicResult> {
    this.missLimiter.check(`app-miss:${meta.ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    this.submitLimiter.hit(`app-submit:${meta.ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    const boundary = multipartBoundary(contentType);
    if (!boundary || !Buffer.isBuffer(raw)) throw fail(415, 'Send the application from the application page.');
    const body = parseMultipart(raw, boundary, {
      maxParts: 40,
      maxFieldBytes: 16 * 1024,
      fieldBytes: { authorizations: 3 * 1024 * 1024 },
      maxFileBytes: DRIVER_APPLICATION_MAX_FILE_BYTES,
      maxHeaderBytes: 4 * 1024,
    });

    // The token first: an unknown or dead link learns nothing about the rest.
    const token = this.one(body.fields, 'applicationToken') ?? '';
    if (!token) throw this.miss(meta.ip);
    const resolved = await this.resolveToken(token, meta);
    const submissionKey = this.one(body.fields, 'submissionKey');
    if (resolved.session.submittedAt) return this.replay(resolved.session, submissionKey);
    if (resolved.session.revokedAt || resolved.session.expiresAt.getTime() <= Date.now()) throw fail(410, LINK_GONE);
    await this.bindDevice(resolved.session, meta.device);

    const inherited = await this.consentOf(resolved.session);
    const validated = this.validate(body.fields, body.files, inherited, inherited ? await this.consentHasBack(inherited) : false);
    // Name, phone and email come from the signed consent the server holds, not from the page.
    if (inherited) {
      validated.fields = { ...validated.fields, firstName: inherited.firstName, lastName: inherited.lastName, phone: inherited.phone, email: inherited.email };
    }
    return this.hiring.withLock(`driver-application:${resolved.session.id}`, () => this.accept(resolved, validated, meta));
  }

  /** Under the session lock: convert, reserve, stage, commit, then acknowledge. */
  private async accept(resolved: ResolvedSession, v: Validated, meta: PublicRequestMeta): Promise<PublicResult> {
    const { principal } = resolved;
    const companyId = principal.companyId;
    const [session] = await this.db
      .select()
      .from(hiringApplicationSessions)
      .where(and(eq(hiringApplicationSessions.companyId, companyId), eq(hiringApplicationSessions.id, resolved.session.id)))
      .limit(1);
    if (!session) throw fail(401, LINK_INVALID);
    if (session.submittedAt) return this.replay(session, v.fields.submissionKey);
    if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw fail(410, LINK_GONE);

    // A submission key already used for another session is not this driver's retry.
    const [keyUsed] = await this.db
      .select({ id: hiringDriverApplications.id })
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, companyId), eq(hiringDriverApplications.submissionKey, v.fields.submissionKey)))
      .limit(1);
    if (keyUsed) throw fail(409, 'This submission was already used. Please reload the page and try again.');

    await this.cleanupStaging(session);

    // The candidate: the session's case, or the lead's (converting it now, recruiter unchanged).
    let hiringCase: HiringCaseRow | null = null;
    let leadId = session.leadId;
    try {
      let caseId = session.hiringCaseId;
      if (session.leadId) {
        const [lead] = await this.db
          .select()
          .from(hiringLeads)
          .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, session.leadId)))
          .limit(1);
        if (!lead) throw fail(410, LINK_GONE);
        if (lead.status === 'dead') throw fail(410, LINK_GONE);
        caseId = lead.hiringCaseId ?? (await this.leads.convert(principal, lead.id, { byApplication: true })).hiringCaseId;
      } else {
        const [lead] = await this.db
          .select({ id: hiringLeads.id })
          .from(hiringLeads)
          .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.hiringCaseId, caseId ?? '-')))
          .limit(1);
        leadId = lead?.id ?? null;
      }
      if (caseId) {
        [hiringCase = null] = await this.db
          .select()
          .from(hiringCases)
          .where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.id, caseId)))
          .limit(1);
      }
    } catch (error) {
      if (error instanceof AppError && (error.status === 410 || error.status === 401)) throw error;
      this.logger.error(`driver application: candidate step failed on session ${session.id}: ${(error as { code?: string }).code ?? (error as Error).name}`);
      throw fail(503, SAVE_FAILED);
    }
    if (!hiringCase?.applicantId) throw fail(503, SAVE_FAILED);
    const caseRow = hiringCase;
    const driverId = (await this.drivers.reserveDriverIdFor(principal, caseRow.id)).id;

    // Stage the bytes under this attempt, journalled on the session first.
    const at = new Date();
    const appId = `dapp_${crypto.randomUUID()}`;
    const reference = `APP-${randomBytes(6).toString('base64url').replace(/[-_]/g, 'X').toUpperCase().slice(0, 8)}`;
    const prefix = `driver-application/${companyId}/${session.id}/${appId}`;
    const fileRows = v.files.map((f) => ({
      id: `dapf_${crypto.randomUUID()}`,
      key: `${prefix}/${f.code}${EXTENSION[f.contentType]}`,
      f,
    }));
    const authRows = v.authorizations.map((a) => ({
      id: `dauth_${crypto.randomUUID()}`,
      key: a.png ? `${prefix}/${a.type}-signature.png` : null,
      a,
    }));
    const keys = [...fileRows.map((r) => r.key), ...authRows.map((r) => r.key).filter((k): k is string => !!k)];
    await this.db
      .update(hiringApplicationSessions)
      .set({ stagingKeys: keys, updatedAt: at })
      .where(and(eq(hiringApplicationSessions.companyId, companyId), eq(hiringApplicationSessions.id, session.id)));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { ssn, consent: _consent, submissionKey, applicationToken: _token, schemaVersion, authorizations: _a, ...answers } = v.fields;
    const digits = ssn.replace(/\D/g, '');
    const name = `${v.fields.firstName} ${v.fields.lastName}`.trim();
    try {
      for (const r of fileRows) await this.storage.put(r.key, r.f.bytes);
      for (const r of authRows) if (r.key && r.a.png) await this.storage.put(r.key, r.a.png.bytes);

      const event = await this.db.transaction(async (tx) => {
        await tx.insert(hiringDriverApplications).values({
          id: appId,
          companyId,
          sessionId: session.id,
          hiringCaseId: caseRow.id,
          leadId,
          applicantId: caseRow.applicantId,
          driverId,
          reference,
          submissionKey,
          schemaVersion,
          answers,
          ssnSealed: encrypt(digits, 'pii'),
          ssnLast4: digits.slice(-4),
          consentStatement: DRIVER_APPLICATION_CONSENT_STATEMENT,
          via: meta.via,
          ipHash: this.ipHash(meta.ip),
          receivedAt: at,
        });
        for (const r of fileRows) {
          await tx.insert(hiringDriverApplicationFiles).values({
            id: r.id,
            companyId,
            applicationId: appId,
            hiringCaseId: caseRow.id,
            code: r.f.code,
            fileName: r.f.fileName,
            contentType: r.f.contentType,
            declaredType: r.f.declaredType,
            sizeBytes: r.f.bytes.length,
            sha256: r.f.sha256,
            storageKey: r.key,
            uploadedAt: at,
          });
        }
        for (const r of authRows) {
          await tx.insert(hiringDriverAuthorizations).values({
            id: r.id,
            companyId,
            applicationId: appId,
            sessionId: session.id,
            hiringCaseId: caseRow.id,
            documentType: r.a.type,
            decision: r.a.decision,
            signerName: r.a.signerName,
            printedSignature: r.a.printedSignature,
            signatureMethod: r.a.png ? 'drawn' : null,
            electronicSignature: r.a.png ? true : null,
            disclosureOpenedClaim: r.a.disclosureOpened,
            clientSignedAt: r.a.clientSignedAt,
            receivedAt: at,
            disclosureVersion: r.a.disclosureVersion,
            disclosureSha256: r.a.disclosureSha256,
            disclosureText: r.a.disclosureText,
            signatureStorageKey: r.key,
            signatureSha256: r.a.png?.sha256 ?? null,
            signatureBytes: r.a.png?.bytes.length ?? null,
            signatureWidth: r.a.png?.width ?? null,
            signatureHeight: r.a.png?.height ?? null,
          });
        }
        const [claimed] = await tx
          .update(hiringApplicationSessions)
          .set({ submittedAt: at, submissionId: appId, stagingKeys: [], version: session.version + 1, updatedAt: at })
          .where(
            and(
              eq(hiringApplicationSessions.companyId, companyId),
              eq(hiringApplicationSessions.id, session.id),
              isNull(hiringApplicationSessions.submittedAt),
              isNull(hiringApplicationSessions.revokedAt),
            ),
          )
          .returning({ id: hiringApplicationSessions.id });
        if (!claimed) throw fail(410, LINK_GONE);
        const signed = authRows.filter((r) => r.a.decision === 'signed').map((r) => r.a.type.toUpperCase());
        const declined = authRows.filter((r) => r.a.decision === 'declined').map((r) => r.a.type.toUpperCase());
        return this.audit.writeIn(tx, principal, {
          action: 'driver_application_received',
          actorType: 'system',
          actor: { id: `application_session:${session.id}`, name: `${name} (personal application link)` },
          entityType: 'applicant',
          entityId: caseRow.applicantId as string,
          entityLabel: caseRow.candidateName,
          summary: `Application ${reference} received through the personal link: ${fileRows.length} document${fileRows.length === 1 ? '' : 's'}; signed ${signed.join(', ') || 'none'}; declined ${declined.join(', ') || 'none'}`,
          changes: [
            { field: 'driver_application', old: null, new: appId },
            ...fileRows.map((r) => ({ field: r.f.code, old: null, new: r.id })),
            ...authRows.map((r) => ({ field: `authorization_${r.a.type}`, old: null, new: `${r.a.decision}:${r.id}` })),
          ],
          at,
        });
      });
      await this.audit.publish(event);
      await notifyRecruiters(this.db, { companyId, caseId: caseRow.id, leadId: null, applicantId: caseRow.applicantId, key: `application_received:${appId}`, title: `Application received — ${caseRow.candidateName}`, body: `${caseRow.candidateName} sent the application (${reference}). Review it on the candidate page.` });
    } catch (error) {
      // Nothing committed: remove what this attempt wrote, then clear the journal.
      for (const key of keys) await this.storage.remove(key).catch(() => undefined);
      await this.db
        .update(hiringApplicationSessions)
        .set({ stagingKeys: [] })
        .where(and(eq(hiringApplicationSessions.companyId, companyId), eq(hiringApplicationSessions.id, session.id)))
        .catch(() => undefined);
      if (error instanceof AppError && error.status === 410) throw error;
      // Two deliveries raced past the lock (another instance): the first one's answer stands.
      const [again] = await this.db.select().from(hiringApplicationSessions).where(eq(hiringApplicationSessions.id, session.id)).limit(1);
      if (again?.submittedAt) return this.replay(again, submissionKey);
      this.logger.error(`driver application: save failed on session ${session.id}: ${(error as { code?: string }).code ?? (error as Error).name}`);
      throw fail(503, SAVE_FAILED);
    }

    // Durable. What follows never undoes the acknowledgement; anything left is redone on the next read.
    const [app] = await this.db.select().from(hiringDriverApplications).where(eq(hiringDriverApplications.id, appId)).limit(1);
    if (app) await this.fileOutstanding(app).catch((e: Error) => this.logger.warn(`driver application: filing deferred for ${appId}: ${e.name}`));
    // The consent's CDL front waited for this application's CDL expiry; file it now (journey v2).
    const consent = await this.consentOf(session);
    if (consent) await this.consentFiling?.(consent).catch((e: Error) => this.logger.warn(`driver application: consent filing deferred for ${consent.id}: ${e.name}`));
    await this.notifyRecruiter(principal, caseRow, appId, reference, name).catch(() => undefined);
    return { status: 201, body: this.ack(reference) };
  }

  /** Storage keys a crashed attempt journalled but never committed are removed before a new one. */
  private async cleanupStaging(session: HiringApplicationSessionRow): Promise<void> {
    const keys = Array.isArray(session.stagingKeys) ? (session.stagingKeys as string[]) : [];
    if (keys.length === 0) return;
    for (const key of keys) await this.storage.remove(key).catch(() => undefined);
    await this.db
      .update(hiringApplicationSessions)
      .set({ stagingKeys: [] })
      .where(and(eq(hiringApplicationSessions.companyId, session.companyId), eq(hiringApplicationSessions.id, session.id)));
  }

  /**
   * Files the documents into the reserved driver's qualification file, pending Safety's review —
   * the same records Safety reviews and Hire reuses, so nothing is uploaded twice. Idempotent: a
   * file already filed is skipped; one that fails is tried again on the next read.
   */
  async fileOutstanding(app: HiringDriverApplicationRow): Promise<void> {
    const pending = await this.db
      .select()
      .from(hiringDriverApplicationFiles)
      .where(
        and(
          eq(hiringDriverApplicationFiles.companyId, app.companyId),
          eq(hiringDriverApplicationFiles.applicationId, app.id),
          isNull(hiringDriverApplicationFiles.filedDocumentId),
        ),
      );
    if (pending.length === 0) return;
    await this.hiring.withLock(`driver-application-filing:${app.id}`, async () => {
      const [company] = await this.db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
      const [hiringCase] = await this.db.select().from(hiringCases).where(and(eq(hiringCases.companyId, app.companyId), eq(hiringCases.id, app.hiringCaseId))).limit(1);
      if (!company || !hiringCase) return;
      const principal: Principal = {
        userId: 'system:driver-application',
        userName: 'Driver application link',
        companyId: app.companyId,
        companyTimezone: company.timezone,
        weekStart: weekStartIndex(company.weekStart),
        roles: [],
        permissions: new Set(),
      };
      const answers = app.answers as Record<string, string | null>;
      for (const f of pending) {
        const [fresh] = await this.db.select({ filed: hiringDriverApplicationFiles.filedDocumentId }).from(hiringDriverApplicationFiles).where(eq(hiringDriverApplicationFiles.id, f.id)).limit(1);
        if (fresh?.filed) continue;
        const at = new Date();
        const { document } = await this.compliance.upload(principal, {
          ownerType: 'driver',
          ownerId: app.driverId,
          ownerLabel: hiringCase.candidateName,
          requirementCode: f.code,
          title: DRIVER_APPLICATION_FILE_LABELS[f.code] ?? f.code,
          fileName: f.fileName,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          issuedOn: null,
          expiresOn: f.code === 'cdl' ? (answers.cdlExpiration ?? null) : f.code === 'medical_card' ? (answers.medicalExpiration ?? null) : null,
          source: 'public_link',
          notes: `Sent by the driver with application ${app.reference} (personal link); waiting for Safety's review`,
          bytes: await this.storage.get(f.storageKey),
          at,
        });
        await this.db
          .update(hiringDriverApplicationFiles)
          .set({ filedDocumentId: document.id, filedAt: at })
          .where(and(eq(hiringDriverApplicationFiles.id, f.id), isNull(hiringDriverApplicationFiles.filedDocumentId)));
      }
    });
  }

  /**
   * "Application submitted — <name>", in the app, to the candidate's own recruiter when they have
   * an account, otherwise to everyone who manages recruiting. Once per application per person.
   */
  private async notifyRecruiter(principal: Principal, c: HiringCaseRow, appId: string, reference: string, name: string): Promise<void> {
    const companyId = principal.companyId;
    let recipients: string[] = [];
    if (c.recruiterId) {
      recipients = (
        await this.db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active'), eq(memberships.employeeId, c.recruiterId)))
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
    await this.db
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          id: `ntf_${crypto.randomUUID()}`,
          companyId,
          recipientUserId: userId,
          severity: 'info',
          title: `Application submitted — ${name}`,
          body: `${name} submitted the driver application through their personal link (reference ${reference}). Review it on the candidate page.`,
          entityType: 'applicant',
          entityId: c.applicantId as string,
          source: 'system',
          dedupeKey: `driver_application:${appId}:${userId}`,
        })),
      )
      .onConflictDoNothing();
  }
}
