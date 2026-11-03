import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { notifyRecruiters } from './recruiting-notify';
import { and, desc, eq, gt, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  CANDIDATE_CONSENT_TTL_DAYS,
  CONSENT_CONFIRMATION_STATEMENT,
  CONSENT_DOCUMENT_LABELS,
  CONSENT_DOCUMENT_TYPES,
  CONSENT_MAX_FILE_BYTES,
  CONSENT_MAX_SIGNATURE_BYTES,
  ConsentSubmitFieldsSchema,
  DOT_LINK_MISSES_ALLOWED,
  DOT_LINK_MISS_WINDOW_MS,
  DOT_LINK_TOKEN_PATTERN,
  type CandidateConsentView,
  type ConsentAck,
  type ConsentDocumentType,
  type ConsentFormContext,
  type ConsentLinkIssued,
  type ConsentSessionView,
  type ConsentSubmissionView,
  readSafetyAnswers,
  type SafetyScreeningAnswer,
} from '@neway/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { multipartBoundary, parseMultipart } from '../../common/http/multipart';
import { RateLimiter } from '../../common/http/rate-limiter';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import {
  hiringCases,
  hiringConsentDocuments,
  hiringConsentFiles,
  hiringConsentSessions,
  hiringConsents,
  hiringDriverApplications,
  hiringLeads,
  hiringStageEvents,
  type HiringCaseRow,
  type HiringConsentRow,
  type HiringConsentSessionRow,
} from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { EmailTransport } from '../accounting/email.transport';
import { decrypt, encrypt, type SealedCredential } from '../admin/credential-vault';
import { ComplianceService } from '../compliance/compliance.service';
import { cleanFileName, sniff } from '../driver-relations/receipts';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { SettingsService } from '../admin/settings.service';
import { CONSENT_DISCLOSURE_TITLES, currentDisclosures, sha256Text, signedText, validUntil } from './consent-disclosures';
import { Writer } from './dot-application-pdf';
import { DriverApplicationService, type ApplicationSubject } from './driver-application.service';
import { HiringService } from './hiring.service';
import { LeadsService } from './leads.service';
import { NOT_SENT, PENDING_SEND } from './link-pending';

const DAY = 86_400_000;

const EXTENSION: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const LINK_INVALID = 'This consent link is not valid. Please ask your recruiter for a new link.';
const LINK_GONE = 'This consent link has expired. Please ask your recruiter for a new link.';
const SAVE_FAILED = 'We could not save your consent. Nothing was submitted; please try again in a moment.';

function fail(status: number, detail: string): AppError {
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
  return new AppError({ status, title: titles[status] ?? 'Error', detail });
}

/** PNG signature, IHDR with sane dimensions, IEND at the end; width/height or null. */
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

const eastern = (d: Date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
    .format(d)
    .replace(/[\u202f\u00a0]/g, ' ');

// eslint-disable-next-line no-control-regex
const pdfSafe = (v: string | null | undefined) => (v ?? '').replace(/[^\u0000-ÿ‘’“”–—•]/g, '?');

export interface ConsentRequestMeta {
  ip: string;
  secure: boolean;
  userAgent: string | null;
  /** The browser's own random key (x-neway-device): a link opens on its first device only. */
  device?: string | null;
  /** The company of a signed-in staff member opening the link: a preview, never a binding. */
  staffCompanyId?: string | null;
}

interface Resolved {
  session: HiringConsentSessionRow;
  principal: Principal;
  companyName: string;
}

/**
 * The candidate consent (owner brief, 2026-10-11): step 2 sends it, step 3 receives it.
 *
 * Staff side: Send consent makes one private link per person (token shown once, digest kept,
 * 14 days; a new link turns the old one off and both stay on record). Copying, emailing (only
 * when the TMS can really send mail), marking as sent by hand, the driver opening the page and
 * the driver completing it are recorded separately — an opened page is not a read disclosure.
 *
 * Driver side: first and last name, phone, email, the CDL front, each disclosure (MVR, PSP and —
 * once the company supplies its wording — Clearinghouse) in its own section, one confirmation, and
 * a typed or drawn signature. Validated in memory, then under a per-session lock the lead becomes a
 * candidate, the driver id is reserved, the files are written to private storage and the consent,
 * each disclosure as signed and the session's completion commit in one transaction. Only then does
 * the page hear "saved", with a reference. The IP the server saw is sealed and shown to staff with
 * the restricted-records permission only; it never appears on the page or the driver's PDF.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);
  private readonly submitLimiter = new RateLimiter(20, 10 * 60_000);
  private readonly missLimiter = new RateLimiter(DOT_LINK_MISSES_ALLOWED, DOT_LINK_MISS_WINDOW_MS);

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly leads: LeadsService,
    private readonly drivers: DriversService,
    private readonly compliance: ComplianceService,
    private readonly email: EmailTransport,
    private readonly settings: SettingsService,
    driverApps: DriverApplicationService,
  ) {
    // The application files the consent's CDL front when it brings the expiry (no import cycle:
    // the application service only holds this callback).
    driverApps.consentFiling = (consent) => this.fileOutstanding(consent);
  }

  private get db() {
    return this.database.db;
  }

  // ============================================================================ the staff side

  linkFor(token: string): string {
    return `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/consent/#token=${token}`;
  }

  /** The employer the Clearinghouse consent names: the registered name setting, else the company name. */
  async employerName(companyId: string): Promise<string> {
    const set = (await this.settings.valuesFor(companyId, ['hiring.clearinghouse_employer_name']))['hiring.clearinghouse_employer_name'];
    if (typeof set === 'string' && set.trim()) return set.trim();
    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    return company?.name ?? companyId;
  }

  emailAvailable(): boolean {
    const kind = this.email.describe().kind;
    return kind === 'smtp' || kind === 'graph';
  }

  private sessionView(row: HiringConsentSessionRow, now: Date): ConsentSessionView {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: row.id,
      state: row.submittedAt ? 'submitted' : row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'live',
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdByName,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      revokeReason: row.revokeReason,
      linkCopiedAt: iso(row.linkCopiedAt),
      emailedAt: iso(row.emailedAt),
      emailedTo: row.emailedTo,
      markedSentAt: iso(row.markedSentAt),
      markedSentBy: row.markedSentBy,
      markedSentChannel: row.markedSentChannel,
      firstOpenedAt: iso(row.firstOpenedAt),
      lastOpenedAt: iso(row.lastOpenedAt),
      openCount: row.openCount,
      submittedAt: iso(row.submittedAt),
    };
  }

  private async latestSession(subject: ApplicationSubject): Promise<HiringConsentSessionRow | null> {
    const parts = [eq(hiringConsentSessions.subjectKey, subject.subjectKey)];
    if (subject.caseId) parts.push(eq(hiringConsentSessions.hiringCaseId, subject.caseId));
    if (subject.leadId) parts.push(eq(hiringConsentSessions.leadId, subject.leadId));
    const [row] = await this.db
      .select()
      .from(hiringConsentSessions)
      .where(
        and(
          eq(hiringConsentSessions.companyId, subject.companyId),
          or(...parts),
          // A link whose message never went out was never the driver's: it is not "the" link.
          or(isNull(hiringConsentSessions.revokedBy), notInArray(hiringConsentSessions.revokedBy, [PENDING_SEND, NOT_SENT])),
        ),
      )
      .orderBy(sql`(${hiringConsentSessions.revokedAt} IS NULL) DESC`, desc(hiringConsentSessions.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The person's signed consent, by their case or their lead. */
  async consentFor(companyId: string, ids: { caseId: string | null; leadId: string | null }): Promise<HiringConsentRow | null> {
    const parts = [];
    if (ids.caseId) parts.push(eq(hiringConsents.hiringCaseId, ids.caseId));
    if (ids.leadId) parts.push(eq(hiringConsents.leadId, ids.leadId));
    if (parts.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, companyId), or(...parts)))
      .orderBy(desc(hiringConsents.receivedAt))
      .limit(1);
    return row ?? null;
  }

  /** Consent state per person for the list, in two queries: received, or a live link out. */
  async states(companyId: string, leadIds: string[], caseIds: string[]): Promise<{ received: Set<string>; live: Set<string> }> {
    const received = new Set<string>();
    const live = new Set<string>();
    if (leadIds.length === 0 && caseIds.length === 0) return { received, live };
    const rows = await this.db
      .select({ leadId: hiringConsents.leadId, caseId: hiringConsents.hiringCaseId })
      .from(hiringConsents)
      .where(eq(hiringConsents.companyId, companyId));
    for (const r of rows) {
      if (r.leadId) received.add(r.leadId);
      received.add(r.caseId);
    }
    const now = Date.now();
    const sessions = await this.db
      .select({ leadId: hiringConsentSessions.leadId, caseId: hiringConsentSessions.hiringCaseId, expiresAt: hiringConsentSessions.expiresAt })
      .from(hiringConsentSessions)
      .where(and(eq(hiringConsentSessions.companyId, companyId), isNull(hiringConsentSessions.revokedAt), isNull(hiringConsentSessions.submittedAt)));
    for (const s of sessions) {
      if (s.expiresAt.getTime() <= now) continue;
      if (s.leadId) live.add(s.leadId);
      if (s.caseId) live.add(s.caseId);
    }
    return { received, live };
  }

  /** True when the case was brought back from disqualified after the given time (a Recruiting reopen). */
  async reopenedSince(companyId: string, caseId: string, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ id: hiringStageEvents.id })
      .from(hiringStageEvents)
      .where(and(eq(hiringStageEvents.companyId, companyId), eq(hiringStageEvents.caseId, caseId), eq(hiringStageEvents.fromState, 'disqualified'), gt(hiringStageEvents.at, since)))
      .limit(1);
    return Boolean(row);
  }

  async view(principal: Principal, subject: ApplicationSubject): Promise<CandidateConsentView> {
    const now = new Date();
    const session = await this.latestSession(subject);
    const consent = await this.consentFor(subject.companyId, { caseId: subject.caseId, leadId: subject.leadId });
    if (consent) await this.fileOutstanding(consent).catch(() => undefined);
    return {
      session: session ? this.sessionView(session, now) : null,
      submission: consent ? await this.submissionView(principal, consent) : null,
      clearinghouseAvailable: !currentDisclosures().pending.includes('clearinghouse'),
      emailAvailable: this.emailAvailable(),
    };
  }

  private async submissionView(principal: Principal, row: HiringConsentRow): Promise<ConsentSubmissionView> {
    const docs = await this.db
      .select()
      .from(hiringConsentDocuments)
      .where(and(eq(hiringConsentDocuments.companyId, row.companyId), eq(hiringConsentDocuments.consentId, row.id)));
    const files = await this.db
      .select()
      .from(hiringConsentFiles)
      .where(and(eq(hiringConsentFiles.companyId, row.companyId), eq(hiringConsentFiles.consentId, row.id)));
    const ipVisible = hasPermission(principal, 'compliance_sensitive.view');
    let ipAddress: string | null = null;
    if (ipVisible && row.ipSealed) {
      try {
        ipAddress = decrypt(row.ipSealed as SealedCredential, 'pii');
      } catch {
        ipAddress = null;
      }
    }
    return {
      id: row.id,
      reference: row.reference,
      receivedAt: row.receivedAt.toISOString(),
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      email: row.email,
      signatureMethod: row.signatureMethod as 'typed' | 'drawn',
      signatureText: row.signatureText,
      hasSignatureImage: Boolean(row.signatureStorageKey),
      safetyAnswers: Array.isArray(row.safetyAnswers) ? (row.safetyAnswers as SafetyScreeningAnswer[]) : null,
      // A Recruiting reopen after the consent lifts its automatic hold (owner, 2026-10-16).
      safetyDisqualified: row.safetyDisqualified && !(await this.reopenedSince(row.companyId, row.hiringCaseId, row.receivedAt)),
      confirmedAt: row.confirmedAt.toISOString(),
      documents: CONSENT_DOCUMENT_TYPES.flatMap((type) => {
        const d = docs.find((x) => x.documentType === type);
        return d
          ? [
              {
                id: d.id,
                type,
                label: CONSENT_DOCUMENT_LABELS[type],
                signedAt: d.signedAt.toISOString(),
                disclosureVersion: d.disclosureVersion,
                scope: d.scope,
                validUntil: d.validUntil?.toISOString() ?? null,
              },
            ]
          : [];
      }),
      files: files.map((f) => ({
        id: f.id,
        code: (f.code === 'cdl_back' ? 'cdl_back' : 'cdl_front') as 'cdl_front' | 'cdl_back',
        label: f.code === 'cdl_back' ? 'CDL (back)' : 'CDL (front)',
        fileName: f.fileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        uploadedAt: f.uploadedAt.toISOString(),
        documentId: f.filedDocumentId,
      })),
      audit: { clientSignedAt: row.clientSignedAt, userAgent: row.userAgent, ipAddress, ipVisible },
    };
  }

  private entity(subject: ApplicationSubject) {
    return subject.leadId
      ? { entityType: 'hiring_lead', entityId: subject.leadId }
      : { entityType: 'hiring_case', entityId: subject.caseId as string };
  }

  /**
   * Send consent: a new private link; the old one is turned off and kept on record. `deferred`: the
   * link is made for a message the TMS is about to send and does not work — nor turn the current
   * link off — until `activate` (the provider accepted it); `discard` when it did not.
   */
  async issue(principal: Principal, subject: ApplicationSubject, opts: { deferred?: boolean } = {}): Promise<ConsentLinkIssued> {
    if (subject.leadStatus === 'dead') throw fail(409, 'This lead was disqualified; reopen it before sending a consent.');
    if (subject.caseState && ['dropped', 'disqualified', 'withdrawn', 'no_show', 'declined_offer', 'hired', 'active_driver'].includes(subject.caseState)) {
      throw fail(409, 'This candidate is no longer in the hiring pipeline.');
    }
    if (await this.consentFor(subject.companyId, { caseId: subject.caseId, leadId: subject.leadId })) {
      throw fail(409, 'The consent has already been signed and received.');
    }
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const by = principal.userName ?? principal.userId;
    const id = `cns_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + CANDIDATE_CONSENT_TTL_DAYS * DAY);
    const { entityType, entityId } = this.entity(subject);
    if (opts.deferred) {
      await this.db.insert(hiringConsentSessions).values({
        id,
        companyId: subject.companyId,
        leadId: subject.leadId,
        hiringCaseId: subject.caseId,
        subjectKey: subject.subjectKey,
        tokenHash: sha256Text(token),
        createdByUserId: principal.userId,
        createdByName: by,
        createdAt: now,
        expiresAt,
        revokedAt: now,
        revokedBy: PENDING_SEND,
        revokeReason: 'Waiting for the provider to accept the message',
      });
      const [row] = await this.db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.id, id)).limit(1);
      return { url: this.linkFor(token), expiresAt: expiresAt.toISOString(), session: this.sessionView(row as HiringConsentSessionRow, now) };
    }
    const events = await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(hiringConsentSessions)
        .set({ revokedAt: now, revokedBy: by, revokeReason: 'A new link was made', updatedAt: now })
        .where(
          and(
            eq(hiringConsentSessions.companyId, subject.companyId),
            eq(hiringConsentSessions.subjectKey, subject.subjectKey),
            isNull(hiringConsentSessions.revokedAt),
            isNull(hiringConsentSessions.submittedAt),
          ),
        )
        .returning({ id: hiringConsentSessions.id });
      await tx.insert(hiringConsentSessions).values({
        id,
        companyId: subject.companyId,
        leadId: subject.leadId,
        hiringCaseId: subject.caseId,
        subjectKey: subject.subjectKey,
        tokenHash: sha256Text(token),
        createdByUserId: principal.userId,
        createdByName: by,
        createdAt: now,
        expiresAt,
      });
      const out = [];
      for (const old of revoked) {
        out.push(
          await this.audit.writeIn(tx, principal, {
            action: 'consent_link_revoked',
            entityType,
            entityId,
            entityLabel: subject.name,
            summary: 'Consent link turned off: a new link was made',
            changes: [{ field: 'consent_session', old: old.id, new: 'revoked' }],
            at: now,
          }),
        );
      }
      out.push(
        await this.audit.writeIn(tx, principal, {
          action: 'consent_link_created',
          entityType,
          entityId,
          entityLabel: subject.name,
          summary: `Consent link made; works until ${expiresAt.toISOString().slice(0, 10)}. Nothing was sent yet.`,
          changes: [{ field: 'consent_session', old: revoked[0]?.id ?? null, new: id }],
          at: now,
        }),
      );
      return out;
    });
    await this.audit.publish(...events);
    const [row] = await this.db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.id, id)).limit(1);
    return { url: this.linkFor(token), expiresAt: expiresAt.toISOString(), session: this.sessionView(row as HiringConsentSessionRow, now) };
  }

  /** The provider accepted the message: its link becomes the live one and the previous one stops. */
  async activate(principal: Principal, subject: ApplicationSubject, sessionId: string, via: string): Promise<void> {
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const { entityType, entityId } = this.entity(subject);
    const events = await this.db.transaction(async (tx) => {
      const revoked = await tx
        .update(hiringConsentSessions)
        .set({ revokedAt: now, revokedBy: by, revokeReason: `A new link was sent by ${via}`, updatedAt: now })
        .where(
          and(
            eq(hiringConsentSessions.companyId, subject.companyId),
            eq(hiringConsentSessions.subjectKey, subject.subjectKey),
            ne(hiringConsentSessions.id, sessionId),
            isNull(hiringConsentSessions.revokedAt),
            isNull(hiringConsentSessions.submittedAt),
          ),
        )
        .returning({ id: hiringConsentSessions.id });
      const [live] = await tx
        .update(hiringConsentSessions)
        .set({ revokedAt: null, revokedBy: null, revokeReason: null, updatedAt: now })
        .where(and(eq(hiringConsentSessions.companyId, subject.companyId), eq(hiringConsentSessions.id, sessionId), eq(hiringConsentSessions.revokedBy, PENDING_SEND)))
        .returning({ id: hiringConsentSessions.id, expiresAt: hiringConsentSessions.expiresAt });
      if (!live) throw fail(409, 'This link is no longer waiting to be sent.');
      const out = [];
      for (const old of revoked) {
        out.push(
          await this.audit.writeIn(tx, principal, {
            action: 'consent_link_revoked',
            entityType,
            entityId,
            entityLabel: subject.name,
            summary: `Consent link turned off: a new link was sent by ${via}`,
            changes: [{ field: 'consent_session', old: old.id, new: 'revoked' }],
            at: now,
          }),
        );
      }
      out.push(
        await this.audit.writeIn(tx, principal, {
          action: 'consent_link_created',
          entityType,
          entityId,
          entityLabel: subject.name,
          summary: `Consent link made and sent by ${via}; works until ${live.expiresAt.toISOString().slice(0, 10)}.`,
          changes: [{ field: 'consent_session', old: revoked[0]?.id ?? null, new: sessionId }],
          at: now,
        }),
      );
      return out;
    });
    await this.audit.publish(...events);
  }

  /** The message was not accepted: its link never works, and the current link stays as it was. */
  async discard(companyId: string, sessionId: string, reason: string): Promise<void> {
    await this.db
      .update(hiringConsentSessions)
      .set({ revokedBy: NOT_SENT, revokeReason: reason.slice(0, 300), updatedAt: new Date() })
      .where(and(eq(hiringConsentSessions.companyId, companyId), eq(hiringConsentSessions.id, sessionId), eq(hiringConsentSessions.revokedBy, PENDING_SEND)));
  }

  private async liveSession(subject: ApplicationSubject): Promise<HiringConsentSessionRow> {
    const row = await this.latestSession(subject);
    if (!row || row.revokedAt || row.submittedAt) throw fail(409, 'There is no open consent link for this candidate. Make one first.');
    return row;
  }

  private async stamp(
    principal: Principal,
    subject: ApplicationSubject,
    patch: Partial<typeof hiringConsentSessions.$inferInsert>,
    audit: { action: string; summary: string },
  ): Promise<ConsentSessionView> {
    const row = await this.liveSession(subject);
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringConsentSessions)
        .set({ ...patch, version: row.version + 1, updatedAt: at })
        .where(and(eq(hiringConsentSessions.companyId, subject.companyId), eq(hiringConsentSessions.id, row.id)));
      return this.audit.writeIn(tx, principal, { ...audit, ...this.entity(subject), entityLabel: subject.name, at });
    });
    await this.audit.publish(event);
    const [fresh] = await this.db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.id, row.id)).limit(1);
    return this.sessionView(fresh as HiringConsentSessionRow, at);
  }

  /** Copying is not sending: only the copy is recorded. */
  async markCopied(principal: Principal, subject: ApplicationSubject): Promise<ConsentSessionView> {
    const by = principal.userName ?? principal.userId;
    return this.stamp(principal, subject, { linkCopiedAt: new Date(), linkCopiedBy: by }, { action: 'consent_link_copied', summary: 'Consent link copied (not sent by the TMS)' });
  }

  /** The recruiter says they sent it themselves, on a channel the TMS does not send through. */
  async markSent(principal: Principal, subject: ApplicationSubject, channel: string | null): Promise<ConsentSessionView> {
    const by = principal.userName ?? principal.userId;
    return this.stamp(
      principal,
      subject,
      { markedSentAt: new Date(), markedSentBy: by, markedSentChannel: channel },
      { action: 'consent_link_marked_sent', summary: `Consent link marked as sent by ${by}${channel ? ` (${channel})` : ''}` },
    );
  }

  /**
   * Email the link: a new link is made (the address cannot be read back), then sent through the
   * TMS's own email. Refused when the TMS cannot send mail — nothing claims a message went out.
   */
  async emailLink(principal: Principal, subject: ApplicationSubject, to: string): Promise<ConsentSessionView> {
    if (!this.emailAvailable()) throw fail(409, 'Email is not set up on this TMS. Copy the link and send it yourself.');
    const issued = await this.issue(principal, subject);
    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, subject.companyId)).limit(1);
    const companyName = company?.name ?? 'Recruiting';
    try {
      await this.email.send({
        to,
        subject: `${companyName}: please review and sign your driver consents`,
        text: `Hello ${subject.name.split(' ')[0] ?? ''},\n\nPlease review and sign the required consents to continue with your driver application:\n\n${issued.url}\n\nThe link works until ${issued.expiresAt.slice(0, 10)}.\n\n${companyName} recruiting`,
        attachments: [],
      });
    } catch (error) {
      this.logger.warn(`consent email not sent: ${(error as Error).name}`);
      throw fail(503, 'The email could not be sent. The link was made; copy it and send it yourself.');
    }
    const by = principal.userName ?? principal.userId;
    return this.stamp(principal, subject, { emailedAt: new Date(), emailedTo: to, emailedBy: by }, { action: 'consent_link_emailed', summary: `Consent link emailed to ${to} by the TMS` });
  }

  async revoke(principal: Principal, subject: ApplicationSubject, reason: string | null): Promise<CandidateConsentView> {
    const row = await this.latestSession(subject);
    if (row && !row.revokedAt && !row.submittedAt) {
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      const event = await this.db.transaction(async (tx) => {
        await tx
          .update(hiringConsentSessions)
          .set({ revokedAt: at, revokedBy: by, revokeReason: reason ?? 'Turned off by recruiting', version: row.version + 1, updatedAt: at })
          .where(and(eq(hiringConsentSessions.companyId, subject.companyId), eq(hiringConsentSessions.id, row.id)));
        return this.audit.writeIn(tx, principal, {
          action: 'consent_link_revoked',
          ...this.entity(subject),
          entityLabel: subject.name,
          summary: `Consent link turned off${reason ? `: ${reason}` : ''}`,
          at,
        });
      });
      await this.audit.publish(event);
    }
    return this.view(principal, subject);
  }

  private async ownConsent(principal: Principal, subject: ApplicationSubject): Promise<HiringConsentRow> {
    const row = await this.consentFor(subject.companyId, { caseId: subject.caseId, leadId: subject.leadId });
    if (!row || row.companyId !== principal.companyId) throw fail(404, 'No signed consent on this candidate.');
    return row;
  }

  /** The CDL front exactly as uploaded. */
  async fileBytes(principal: Principal, subject: ApplicationSubject, fileId: string) {
    const consent = await this.ownConsent(principal, subject);
    const [row] = await this.db
      .select()
      .from(hiringConsentFiles)
      .where(and(eq(hiringConsentFiles.companyId, principal.companyId), eq(hiringConsentFiles.consentId, consent.id), eq(hiringConsentFiles.id, fileId)))
      .limit(1);
    if (!row) throw fail(404, 'No such file on this consent.');
    return { fileName: row.fileName, contentType: row.contentType, bytes: await this.storage.get(row.storageKey) };
  }

  async signatureImage(principal: Principal, subject: ApplicationSubject) {
    const consent = await this.ownConsent(principal, subject);
    if (!consent.signatureStorageKey) throw fail(404, 'This consent was signed by typing the name.');
    return { fileName: `consent-${consent.reference}-signature.png`, contentType: 'image/png', bytes: await this.storage.get(consent.signatureStorageKey) };
  }

  /**
   * One signed disclosure as its own PDF: the text exactly as signed, the signer, the method and the
   * signing time. The signer's IP is printed for staff with the restricted-records permission
   * (owner, 2026-10-13); anyone else gets the document without it, as the page shows them.
   */
  async documentPdf(principal: Principal, subject: ApplicationSubject, documentId: string) {
    const consent = await this.ownConsent(principal, subject);
    const [d] = await this.db
      .select()
      .from(hiringConsentDocuments)
      .where(and(eq(hiringConsentDocuments.companyId, principal.companyId), eq(hiringConsentDocuments.consentId, consent.id), eq(hiringConsentDocuments.id, documentId)))
      .limit(1);
    if (!d) throw fail(404, 'No such document on this consent.');
    let ip: string | null = null;
    if (hasPermission(principal, 'compliance_sensitive.view') && consent.ipSealed) {
      try {
        ip = decrypt(consent.ipSealed as SealedCredential, 'pii');
      } catch {
        ip = null;
      }
    }
    return this.renderPdf(principal.companyId, consent, d, ip);
  }

  /** The bytes of one signed disclosure, for filing and for the driver profile later. */
  async renderPdf(companyId: string, consent: HiringConsentRow, d: typeof hiringConsentDocuments.$inferSelect, ip: string | null = null) {
    const type = d.documentType as ConsentDocumentType;
    const [company] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const companyName = company?.name ?? companyId;
    const name = `${consent.firstName} ${consent.lastName}`.trim();
    const doc = await PDFDocument.create();
    doc.setTitle(`${CONSENT_DOCUMENT_LABELS[type]} — ${name}`);
    doc.setProducer('NeWay TMS');
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const w = new Writer(doc, font, bold, `${companyName} · ${CONSENT_DOCUMENT_LABELS[type]} · ${consent.reference}`);
    w.title(CONSENT_DISCLOSURE_TITLES[type], `${companyName} · signed electronically · reference ${consent.reference}`);
    for (const para of d.disclosureText.split('\n')) {
      if (para.trim()) w.paragraph(pdfSafe(para));
      else w.space(0.4);
    }
    w.space();
    w.heading('Signature');
    w.field('Name', pdfSafe(name));
    w.field('Signed', eastern(d.signedAt));
    w.field('Method', consent.signatureMethod === 'drawn' ? 'Drawn electronic signature' : 'Typed electronic signature');
    if (ip) w.field('IP address', pdfSafe(ip));
    if (consent.signatureMethod === 'typed' && consent.signatureText) {
      w.field('Signature', `${pdfSafe(consent.signatureText)} (typed)`);
      w.signature(pdfSafe(consent.signatureText), await doc.embedFont(StandardFonts.TimesRomanBoldItalic));
    }
    if (consent.signatureStorageKey) {
      const png = await doc.embedPng(await this.storage.get(consent.signatureStorageKey));
      w.image(png, 260);
    }
    // Long: wrapped as a paragraph so it never runs off the page.
    w.paragraph(`Confirmation: ${pdfSafe(CONSENT_CONFIRMATION_STATEMENT)}`);
    w.field('Text version', pdfSafe(`${d.disclosureVersion} · sha256 ${d.disclosureSha256.slice(0, 16)}`));
    if (d.scope) w.field('Scope', pdfSafe(d.scope));
    if (d.validUntil) w.field('Valid until', eastern(d.validUntil));
    return {
      fileName: `${type}-consent-${consent.reference}.pdf`,
      contentType: 'application/pdf',
      bytes: Buffer.from(await doc.save()),
    };
  }

  // =========================================================================== the driver side

  private ipHash(ip: string): string {
    return createHmac('sha256', env.APP_SECRET).update(`candidate-consent:${ip}`).digest('hex').slice(0, 32);
  }

  private miss(ip: string): AppError {
    try {
      this.missLimiter.hit(`consent-miss:${ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    } catch (error) {
      return error as AppError;
    }
    return fail(401, LINK_INVALID);
  }

  private async resolve(token: string, meta: ConsentRequestMeta): Promise<Resolved> {
    this.missLimiter.check(`consent-miss:${meta.ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    if (!DOT_LINK_TOKEN_PATTERN.test(token)) throw this.miss(meta.ip);
    const [row] = await this.db
      .select({ session: hiringConsentSessions, companyName: companies.name, timezone: companies.timezone, weekStart: companies.weekStart })
      .from(hiringConsentSessions)
      .innerJoin(companies, eq(companies.id, hiringConsentSessions.companyId))
      .where(eq(hiringConsentSessions.tokenHash, sha256Text(token)))
      .limit(1);
    if (!row) throw this.miss(meta.ip);
    return {
      session: row.session,
      companyName: row.companyName,
      principal: {
        userId: 'system:candidate-consent',
        userName: 'Candidate consent link',
        companyId: row.session.companyId,
        companyTimezone: row.timezone,
        weekStart: weekStartIndex(row.weekStart),
        roles: [],
        permissions: new Set(),
      },
    };
  }

  /**
   * One link, one device (owner, 2026-10-12): the first browser to open it keeps it; another
   * phone or computer is refused. A page without a device key (an old copy) is let through until
   * the link is bound, so nothing already sent breaks.
   */
  private async bindDevice(session: HiringConsentSessionRow, device: string | null | undefined): Promise<void> {
    if (session.submittedAt) return;
    const key = typeof device === 'string' && /^[A-Za-z0-9-]{16,100}$/.test(device) ? sha256Text(device) : null;
    if (session.boundDeviceHash) {
      if (key !== session.boundDeviceHash) throw fail(403, 'This link was already opened on another phone or computer. Ask your recruiter for a new link.');
      return;
    }
    if (!key) return;
    const [claimed] = await this.db
      .update(hiringConsentSessions)
      .set({ boundDeviceHash: key, boundAt: new Date() })
      .where(and(eq(hiringConsentSessions.id, session.id), isNull(hiringConsentSessions.boundDeviceHash)))
      .returning({ id: hiringConsentSessions.id });
    if (!claimed) {
      const [again] = await this.db.select({ bound: hiringConsentSessions.boundDeviceHash }).from(hiringConsentSessions).where(eq(hiringConsentSessions.id, session.id)).limit(1);
      if (again?.bound !== key) throw fail(403, 'This link was already opened on another phone or computer. Ask your recruiter for a new link.');
    }
  }

  /** What the consent page shows: who it is for, and every disclosure in full. Records the opening. */
  async context(token: string, meta: ConsentRequestMeta): Promise<ConsentFormContext> {
    const { session, companyName } = await this.resolve(token, meta);
    if (!session.submittedAt && (session.revokedAt || session.expiresAt.getTime() <= Date.now())) throw fail(410, LINK_GONE);
    // A recruiter checking the link before sending it must not use it up (owner, 2026-10-14: a
    // link opened in the office was refused on the driver's phone).
    const preview = Boolean(meta.staffCompanyId) && meta.staffCompanyId === session.companyId;
    if (!preview) await this.bindDevice(session, meta.device);
    let first = '';
    let last = '';
    let phone = '';
    let email = '';
    if (session.leadId) {
      const [lead] = await this.db.select().from(hiringLeads).where(and(eq(hiringLeads.companyId, session.companyId), eq(hiringLeads.id, session.leadId))).limit(1);
      if (lead?.status === 'dead') throw fail(410, LINK_GONE);
      first = lead?.firstName ?? '';
      last = lead?.lastName ?? '';
      phone = lead?.phone ?? '';
      email = lead?.email && !lead.email.endsWith('.lead') ? lead.email : '';
    } else if (session.hiringCaseId) {
      const [c] = await this.db.select().from(hiringCases).where(and(eq(hiringCases.companyId, session.companyId), eq(hiringCases.id, session.hiringCaseId))).limit(1);
      const parts = (c?.candidateName ?? '').split(' ');
      first = parts[0] ?? '';
      last = parts.slice(1).join(' ');
    }
    if (!session.submittedAt && !preview) {
      const at = new Date();
      await this.db
        .update(hiringConsentSessions)
        .set({ firstOpenedAt: session.firstOpenedAt ?? at, lastOpenedAt: at, openCount: session.openCount + 1, updatedAt: at })
        .where(eq(hiringConsentSessions.id, session.id));
    }
    const { published, pending } = currentDisclosures(await this.employerName(session.companyId));
    return {
      ...(preview ? { preview: true } : {}),
      companyName,
      firstName: first,
      lastName: last,
      phone,
      email,
      expiresAt: session.expiresAt.toISOString(),
      alreadySubmitted: Boolean(session.submittedAt),
      confirmationStatement: CONSENT_CONFIRMATION_STATEMENT,
      disclosures: published.map((p) => ({ ...p, label: CONSENT_DOCUMENT_LABELS[p.type], title: CONSENT_DISCLOSURE_TITLES[p.type] })),
      pending: pending.map((type) => ({ type, label: CONSENT_DOCUMENT_LABELS[type] })),
    };
  }

  /** The consent page's submit (multipart). Acknowledged only once everything is committed. */
  async submit(raw: unknown, contentType: string | undefined, meta: ConsentRequestMeta): Promise<{ status: number; body: ConsentAck }> {
    if (env.NODE_ENV === 'production' && env.PUBLIC_LINKS_REQUIRE_HTTPS === 'true' && !meta.secure) {
      throw fail(403, 'Please open your consent link over a secure (https) connection.');
    }
    this.missLimiter.check(`consent-miss:${meta.ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    this.submitLimiter.hit(`consent-submit:${meta.ip}`, 'Too many attempts. Please wait a few minutes and try again.');
    const boundary = multipartBoundary(contentType);
    if (!boundary || !Buffer.isBuffer(raw)) throw fail(415, 'Send the consent from the consent page.');
    const body = parseMultipart(raw, boundary, {
      maxParts: 20,
      maxFieldBytes: 8 * 1024,
      fieldBytes: { signatureDrawing: 800 * 1024 },
      maxFileBytes: CONSENT_MAX_FILE_BYTES,
      maxHeaderBytes: 4 * 1024,
    });
    const input: Record<string, string> = {};
    for (const [name, values] of body.fields) {
      if (values.length > 1) throw fail(422, 'The form was sent twice in one request. Please try again.');
      input[name] = values[0] as string;
    }
    for (const name of body.files.keys()) if (name !== 'cdlFront' && name !== 'cdlBack') throw fail(422, 'The form has an unexpected file.');

    const resolved = await this.resolve(input.token ?? '', meta);
    if (resolved.session.submittedAt) return this.replay(resolved.session, input.submissionKey);
    if (resolved.session.revokedAt || resolved.session.expiresAt.getTime() <= Date.now()) throw fail(410, LINK_GONE);
    await this.bindDevice(resolved.session, meta.device);

    const parsed = ConsentSubmitFieldsSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.code === 'unrecognized_keys') throw fail(422, 'The form has an unexpected field. Please reload the page and try again.');
      throw fail(422, issue?.message && !/expected/i.test(issue.message) ? issue.message : `Check ${issue?.path.join('.') || 'the form'}.`);
    }
    const fields = parsed.data;

    // The CDL front is required; the back is no longer asked for (owner, 2026-10-13) but is
    // still accepted when sent. Each a real JPEG/PNG/PDF by its bytes, up to 8 MB.
    const side = (field: 'cdlFront' | 'cdlBack', words: string) => {
      const list = body.files.get(field) ?? [];
      if (list.length !== 1 || !list[0]) throw fail(422, `Upload a picture of the ${words} of your CDL.`);
      const f = list[0];
      if (f.bytes.length === 0) throw fail(422, `The CDL ${words} picture is empty. Choose it again.`);
      if (f.bytes.length > CONSENT_MAX_FILE_BYTES) throw fail(413, `The CDL ${words} picture must be 8 MB or smaller.`);
      const type = sniff(f.bytes);
      if (!type || !ALLOWED_TYPES.has(type)) throw fail(422, `Use a JPG, PNG or PDF file for the CDL ${words}.`);
      return { fileName: f.fileName, declaredType: f.declaredType, bytes: f.bytes, contentType: type };
    };
    const file = side('cdlFront', 'front');
    const backFile = (body.files.get('cdlBack') ?? []).length > 0 ? side('cdlBack', 'back') : null;

    // The safety questions (owner, 2026-10-13): every one answered, Yes or No.
    const safetyAnswers = readSafetyAnswers(fields.safetyAnswers);
    if (!safetyAnswers) throw fail(422, 'Answer every safety question with Yes or No.');

    // The signature: typed (the name as typed) or drawn (a real PNG).
    let png: { bytes: Buffer; sha256: string; width: number; height: number } | null = null;
    if (fields.signatureMethod === 'typed') {
      if (!fields.signatureText || fields.signatureText.length < 2) throw fail(422, 'Type your full name to sign.');
    } else {
      const drawing = fields.signatureDrawing ?? '';
      const b64 = drawing.startsWith('data:image/png;base64,') ? drawing.slice('data:image/png;base64,'.length) : '';
      if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw fail(422, 'Draw your signature, or choose Type.');
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > CONSENT_MAX_SIGNATURE_BYTES) throw fail(413, 'The signature is too large. Clear it and sign again.');
      const dims = pngDimensions(bytes);
      if (!dims) throw fail(422, 'The signature could not be read. Clear it and sign again.');
      png = { bytes, sha256: sha256Text(bytes), ...dims };
    }

    // Every published disclosure, exactly as this server holds it, and nothing else.
    let signed: { type: string; version: string; sha256: string }[];
    try {
      signed = JSON.parse(fields.documents) as { type: string; version: string; sha256: string }[];
    } catch {
      throw fail(422, 'The consents could not be read. Please reload the page and sign again.');
    }
    if (!Array.isArray(signed)) throw fail(422, 'The consents could not be read. Please reload the page and sign again.');
    const { published } = currentDisclosures();
    for (const p of published) {
      const s = signed.find((x) => x?.type === p.type);
      if (!s || s.version !== p.version || s.sha256 !== p.sha256) {
        throw fail(422, `The ${CONSENT_DOCUMENT_LABELS[p.type]} text is out of date. Please reload the page and sign again.`);
      }
    }
    if (signed.some((s) => !published.find((p) => p.type === s?.type))) {
      throw fail(422, 'A consent that is not available was sent. Please reload the page.');
    }

    return this.hiring.withLock(`candidate-consent:${resolved.session.id}`, () =>
      this.accept(resolved, fields, file, backFile, png, meta, safetyAnswers),
    );
  }

  private async replay(session: HiringConsentSessionRow, submissionKey: string | undefined): Promise<{ status: number; body: ConsentAck }> {
    const [row] = await this.db.select().from(hiringConsents).where(and(eq(hiringConsents.companyId, session.companyId), eq(hiringConsents.sessionId, session.id))).limit(1);
    if (!row) throw fail(503, SAVE_FAILED);
    if (submissionKey && row.submissionKey === submissionKey) return { status: 200, body: { saved: true, reference: row.reference } };
    throw fail(409, `Your consent was already received (reference ${row.reference}). To change it, please contact recruiting.`);
  }

  private async accept(
    resolved: Resolved,
    fields: ReturnType<typeof ConsentSubmitFieldsSchema.parse>,
    file: { fileName: string; declaredType: string | null; bytes: Buffer; contentType: string },
    backFile: { fileName: string; declaredType: string | null; bytes: Buffer; contentType: string } | null,
    png: { bytes: Buffer; sha256: string; width: number; height: number } | null,
    meta: ConsentRequestMeta,
    safetyAnswers: SafetyScreeningAnswer[],
  ): Promise<{ status: number; body: ConsentAck }> {
    const { principal } = resolved;
    const safetyYes = safetyAnswers.filter((a) => a.answer);
    const companyId = principal.companyId;
    const [session] = await this.db
      .select()
      .from(hiringConsentSessions)
      .where(and(eq(hiringConsentSessions.companyId, companyId), eq(hiringConsentSessions.id, resolved.session.id)))
      .limit(1);
    if (!session) throw fail(401, LINK_INVALID);
    if (session.submittedAt) return this.replay(session, fields.submissionKey);
    if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw fail(410, LINK_GONE);
    const [keyUsed] = await this.db
      .select({ id: hiringConsents.id })
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, companyId), eq(hiringConsents.submissionKey, fields.submissionKey)))
      .limit(1);
    if (keyUsed) throw fail(409, 'This submission was already used. Please reload the page and try again.');

    for (const key of Array.isArray(session.stagingKeys) ? (session.stagingKeys as string[]) : []) await this.storage.remove(key).catch(() => undefined);

    // The candidate: the session's case, or the lead's (converting it now; recruiter unchanged).
    let hiringCase: HiringCaseRow | null = null;
    let leadId = session.leadId;
    try {
      let caseId = session.hiringCaseId;
      if (session.leadId) {
        const [lead] = await this.db.select().from(hiringLeads).where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, session.leadId))).limit(1);
        if (!lead || lead.status === 'dead') throw fail(410, LINK_GONE);
        // A lead with no email gets the one the driver gave, so the candidate has a real address.
        if (!lead.email && !lead.hiringCaseId) {
          await this.db.update(hiringLeads).set({ email: fields.email.toLowerCase(), updatedAt: new Date() }).where(eq(hiringLeads.id, lead.id));
        }
        caseId = lead.hiringCaseId ?? (await this.leads.convert(principal, lead.id, { byApplication: true })).hiringCaseId;
      } else {
        const [lead] = await this.db.select({ id: hiringLeads.id }).from(hiringLeads).where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.hiringCaseId, caseId ?? '-'))).limit(1);
        leadId = lead?.id ?? null;
      }
      if (caseId) {
        [hiringCase = null] = await this.db.select().from(hiringCases).where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.id, caseId))).limit(1);
      }
    } catch (error) {
      if (error instanceof AppError && (error.status === 410 || error.status === 401)) throw error;
      // The reason goes to the log (never to the driver): what failed, so it can be fixed.
      const why = error instanceof AppError ? `${error.status} ${(error as { detail?: string }).detail ?? error.message}` : ((error as { code?: string }).code ?? (error as Error).name);
      this.logger.error(`consent: candidate step failed on session ${session.id}: ${why}`);
      throw fail(503, SAVE_FAILED);
    }
    if (!hiringCase?.applicantId) throw fail(503, SAVE_FAILED);
    const caseRow = hiringCase;
    const driverId = (await this.drivers.reserveDriverIdFor(principal, caseRow.id)).id;

    const at = new Date();
    const consentId = `cnst_${crypto.randomUUID()}`;
    const reference = `CNS-${randomBytes(6).toString('base64url').replace(/[-_]/g, 'X').toUpperCase().slice(0, 8)}`;
    const prefix = `candidate-consent/${companyId}/${session.id}/${consentId}`;
    const fileKey = `${prefix}/cdl_front${EXTENSION[file.contentType]}`;
    const backKey = backFile ? `${prefix}/cdl_back${EXTENSION[backFile.contentType]}` : null;
    const sigKey = png ? `${prefix}/signature.png` : null;
    const keys = [fileKey, ...(backKey ? [backKey] : []), ...(sigKey ? [sigKey] : [])];
    await this.db.update(hiringConsentSessions).set({ stagingKeys: keys, updatedAt: at }).where(eq(hiringConsentSessions.id, session.id));
    const employer = await this.employerName(companyId);
    const { published } = currentDisclosures(employer);
    const name = `${fields.firstName} ${fields.lastName}`.trim();
    try {
      await this.storage.put(fileKey, file.bytes);
      if (backKey && backFile) await this.storage.put(backKey, backFile.bytes);
      if (sigKey && png) await this.storage.put(sigKey, png.bytes);
      const event = await this.db.transaction(async (tx) => {
        await tx.insert(hiringConsents).values({
          id: consentId,
          companyId,
          sessionId: session.id,
          leadId,
          hiringCaseId: caseRow.id,
          driverId,
          reference,
          submissionKey: fields.submissionKey,
          firstName: fields.firstName,
          lastName: fields.lastName,
          phone: fields.phone,
          email: fields.email.toLowerCase(),
          confirmationStatement: CONSENT_CONFIRMATION_STATEMENT,
          confirmedAt: at,
          signatureMethod: fields.signatureMethod,
          signatureText: fields.signatureMethod === 'typed' ? fields.signatureText : null,
          signatureStorageKey: sigKey,
          signatureSha256: png?.sha256 ?? null,
          signatureBytes: png?.bytes.length ?? null,
          signatureWidth: png?.width ?? null,
          signatureHeight: png?.height ?? null,
          clientSignedAt: fields.clientSignedAt,
          receivedAt: at,
          ipSealed: meta.ip ? encrypt(meta.ip, 'pii') : null,
          ipHash: meta.ip ? this.ipHash(meta.ip) : null,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
          safetyAnswers,
          safetyDisqualified: safetyYes.length > 0,
        });
        for (const p of published) {
          // The text exactly as signed: the employer and the signer's name filled in, kept forever.
          const text = signedText(p.type, employer, name);
          await tx.insert(hiringConsentDocuments).values({
            id: `cnsd_${crypto.randomUUID()}`,
            companyId,
            consentId,
            hiringCaseId: caseRow.id,
            documentType: p.type,
            disclosureVersion: p.version,
            disclosureSha256: sha256Text(text),
            disclosureText: text,
            signedAt: at,
            scope: p.scope,
            validUntil: validUntil(p.type, at),
          });
        }
        await tx.insert(hiringConsentFiles).values({
          id: `cnsf_${crypto.randomUUID()}`,
          companyId,
          consentId,
          hiringCaseId: caseRow.id,
          code: 'cdl_front',
          fileName: cleanFileName(file.fileName || `cdl-front${EXTENSION[file.contentType]}`),
          contentType: file.contentType,
          declaredType: file.declaredType,
          sizeBytes: file.bytes.length,
          sha256: sha256Text(file.bytes),
          storageKey: fileKey,
          uploadedAt: at,
        });
        if (backFile && backKey) {
          await tx.insert(hiringConsentFiles).values({
            id: `cnsf_${crypto.randomUUID()}`,
            companyId,
            consentId,
            hiringCaseId: caseRow.id,
            code: 'cdl_back',
            fileName: cleanFileName(backFile.fileName || `cdl-back${EXTENSION[backFile.contentType]}`),
            contentType: backFile.contentType,
            declaredType: backFile.declaredType,
            sizeBytes: backFile.bytes.length,
            sha256: sha256Text(backFile.bytes),
            storageKey: backKey,
            uploadedAt: at,
          });
        }
        const [claimed] = await tx
          .update(hiringConsentSessions)
          .set({ submittedAt: at, consentId, stagingKeys: [], version: session.version + 1, updatedAt: at })
          .where(and(eq(hiringConsentSessions.id, session.id), isNull(hiringConsentSessions.submittedAt), isNull(hiringConsentSessions.revokedAt)))
          .returning({ id: hiringConsentSessions.id });
        if (!claimed) throw fail(410, LINK_GONE);
        return this.audit.writeIn(tx, principal, {
          action: 'consent_received',
          actorType: 'system',
          actor: { id: `consent_session:${session.id}`, name: `${name} (consent link)` },
          entityType: 'applicant',
          entityId: caseRow.applicantId as string,
          entityLabel: caseRow.candidateName,
          summary: `Consent ${reference} signed (${fields.signatureMethod}): ${published.map((p) => p.type.toUpperCase()).join(', ')}; CDL front${backFile ? ' and back' : ''} received; safety questions: ${safetyYes.length > 0 ? `Yes to ${safetyYes.map((a) => a.key).join(', ')}` : 'all No'}`,
          changes: [{ field: 'consent', old: null, new: consentId }],
          at,
        });
      });
      await this.audit.publish(event);
      await notifyRecruiters(this.db, { companyId, caseId: caseRow.id, leadId, applicantId: caseRow.applicantId, key: `consent_received:${consentId}`, title: `Consent received — ${name}`, body: `${name} signed the consent (${reference}). Send them to Safety from the candidate page.` });
    } catch (error) {
      for (const key of keys) await this.storage.remove(key).catch(() => undefined);
      await this.db.update(hiringConsentSessions).set({ stagingKeys: [] }).where(eq(hiringConsentSessions.id, session.id)).catch(() => undefined);
      if (error instanceof AppError && error.status === 410) throw error;
      const [again] = await this.db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.id, session.id)).limit(1);
      if (again?.submittedAt) return this.replay(again, fields.submissionKey);
      this.logger.error(`consent: save failed on session ${session.id}: ${(error as { code?: string }).code ?? (error as Error).name}`);
      throw fail(503, SAVE_FAILED);
    }
    // Any Yes is an automatic disqualification under the company's policy (owner, 2026-10-13):
    // the candidate closes with the reason and the answers, and Recruiting is told. A failure here
    // never undoes the signed consent; it is logged and Recruiting still sees the answers.
    if (safetyYes.length > 0) {
      try {
        const [fresh] = await this.db.select().from(hiringCases).where(eq(hiringCases.id, caseRow.id)).limit(1);
        if (fresh && fresh.state !== 'disqualified') {
          await this.hiring.transition(principal, fresh, 'disqualified', {
            reason: 'failed_safety_screening',
            note: `Answered Yes on the consent's safety questions: ${safetyYes.map((a) => a.label).join('; ')}`,
            at: new Date(),
          });
        }
        await notifyRecruiters(this.db, { companyId, caseId: caseRow.id, leadId, applicantId: caseRow.applicantId, key: `safety_screening:${consentId}`, title: `Disqualified — ${name}`, body: `${name} answered Yes to a safety question (${safetyYes.map((a) => a.label).join('; ')}). Disqualified under the company's hiring policy.` });
      } catch (e) {
        this.logger.error(`consent: safety-question disqualification failed for ${consentId}: ${(e as Error).message}`);
      }
    }
    const [consent] = await this.db.select().from(hiringConsents).where(eq(hiringConsents.id, consentId)).limit(1);
    if (consent) await this.fileOutstanding(consent).catch((e: Error) => this.logger.warn(`consent: filing deferred for ${consentId}: ${e.name}`));
    return { status: 201, body: { saved: true, reference } };
  }

  /**
   * Files the CDL front into the reserved driver's qualification file, pending Safety's review —
   * the record the application inherits and Hire reuses. Idempotent; retried on the next read.
   */
  async fileOutstanding(consent: HiringConsentRow): Promise<void> {
    const pending = await this.db
      .select()
      .from(hiringConsentFiles)
      .where(and(eq(hiringConsentFiles.companyId, consent.companyId), eq(hiringConsentFiles.consentId, consent.id), isNull(hiringConsentFiles.filedDocumentId)));
    if (pending.length === 0) return;
    // The CDL's expiry comes with the application; until it arrives the front waits here (the
    // qualification file does not take a CDL without its expiry date).
    const [app] = await this.db
      .select({ answers: hiringDriverApplications.answers })
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, consent.companyId), eq(hiringDriverApplications.hiringCaseId, consent.hiringCaseId)))
      .orderBy(desc(hiringDriverApplications.receivedAt))
      .limit(1);
    const cdlExpiration = (app?.answers as { cdlExpiration?: string | null } | undefined)?.cdlExpiration ?? null;
    if (!cdlExpiration) return;
    await this.hiring.withLock(`candidate-consent-filing:${consent.id}`, async () => {
      const [company] = await this.db.select().from(companies).where(eq(companies.id, consent.companyId)).limit(1);
      if (!company) return;
      const principal: Principal = {
        userId: 'system:candidate-consent',
        userName: 'Candidate consent link',
        companyId: consent.companyId,
        companyTimezone: company.timezone,
        weekStart: weekStartIndex(company.weekStart),
        roles: [],
        permissions: new Set(),
      };
      for (const f of pending) {
        const [fresh] = await this.db.select({ filed: hiringConsentFiles.filedDocumentId }).from(hiringConsentFiles).where(eq(hiringConsentFiles.id, f.id)).limit(1);
        if (fresh?.filed) continue;
        const at = new Date();
        const { document } = await this.compliance.upload(principal, {
          ownerType: 'driver',
          ownerId: consent.driverId,
          ownerLabel: `${consent.firstName} ${consent.lastName}`.trim(),
          requirementCode: f.code === 'cdl_back' ? 'cdl_back' : 'cdl',
          title: f.code === 'cdl_back' ? 'CDL (back)' : 'CDL (front)',
          fileName: f.fileName,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          issuedOn: null,
          expiresOn: f.code === 'cdl_back' ? null : cdlExpiration,
          source: 'public_link',
          notes: `Sent by the driver with consent ${consent.reference}; expiry from the application; waiting for Safety's review`,
          bytes: await this.storage.get(f.storageKey),
          at,
        });
        await this.db
          .update(hiringConsentFiles)
          .set({ filedDocumentId: document.id, filedAt: at })
          .where(and(eq(hiringConsentFiles.id, f.id), isNull(hiringConsentFiles.filedDocumentId)));
      }
    });
  }
}
