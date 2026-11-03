import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  DOT_APP_CODE_MAX_FAILURES,
  DOT_APP_CODE_RESEND_SECONDS,
  DOT_APP_CODE_TTL_MINUTES,
  DOT_APP_DOCUMENTS,
  DOT_APP_EDITABLE,
  DOT_APP_IN_PERSON_DRIVER_SIGNATURES,
  DOT_APP_LINK_GONE,
  DOT_APP_MAX_SIGNATURE_BYTES,
  DOT_APP_MAX_UPLOAD_BYTES,
  DOT_APP_UPLOAD_SLOTS,
  DOT_APP_STATUS_LABELS,
  dotAppMissing,
  dotAppSphEmployers,
  dotAppVisibleSteps,
  dotAppSignaturesFor,
  signatureDocKey,
  type DotAppAnswers,
  type DotAppCompanyBrand,
  type DotAppConsentLink,
  type DotAppDriverState,
  type DotAppIssued,
  type DotAppIssueInput,
  type DotAppLinkView,
  type DotAppPublicGate,
  type DotAppRecruiterView,
  type DotAppSignatureView,
  type DotAppSignInput,
  type DotAppStatus,
  type DotAppSummary,
  type DotAppUploadSlot,
  type DotAppUploadView,
  type SaveDotAppInput,
} from '@neway/shared';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { companyProfiles } from '../../database/schema/company-profile';
import {
  dotApplicationChangeRequests,
  dotApplicationFiles,
  dotApplicationLinks,
  dotApplicationSessions,
  dotApplicationSignatures,
  dotDriverApplications,
  emailMessages,
  type DotApplicationFileRow,
  type DotApplicationLinkRow,
  type DotApplicationSignatureRow,
  type DotDriverApplicationRow,
} from '../../database/schema/dot-application';
import { hiringCases, hiringConsentDocuments, hiringConsentFiles, hiringConsents } from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { encrypt } from '../admin/credential-vault';
import { CLOCK, type Clock } from '../dashboard/clock';
import { cleanFileName, sniff } from '../driver-relations/receipts';
import { EmailService } from '../email/email.service';
import { RecruitService } from '../hiring/recruit.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { easternToday } from '../roster/driver-archive.data';
import { sha256, stableJson, DotAppTemplatesService, toTemplate } from './templates.service';
import { applicationLinkEmail, codeEmail } from './emails';

export interface PublicMeta {
  ip: string;
  userAgent: string | null;
  /** The x-dot-app-session header (after the code). */
  session: string | null;
}

const DAY = 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;
const CONSENT_LINK_TITLES: Record<DotAppConsentLink, string> = {
  psp: 'PSP Disclosure and Authorization',
  mvr: 'MVR authorization',
  clearinghouse: 'Clearinghouse limited query consent',
};
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'application/pdf': '.pdf' };

export function gone(): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail: DOT_APP_LINK_GONE });
}
export function conflict(detail: string, extensions?: Record<string, unknown>): AppError {
  return new AppError({ status: 409, title: 'Conflict', detail, extensions });
}
function unprocessable(detail: string, extensions?: Record<string, unknown>): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', detail, extensions });
}
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** b•••@example.com */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
}

/** The code is stored as an HMAC (keyed by APP_SECRET), never in the clear. */
function codeDigest(linkId: string, code: string): string {
  return createHmac('sha256', `dot-app-code:${env.APP_SECRET}`).update(`${linkId}:${code}`).digest('hex');
}

/**
 * The DOT driver application v2 (owner brief 2026-10-27): the recruiter's link, the driver's
 * 6-digit code and session, autosave with a version check, uploads, one signature per document,
 * and Submit. Every read and write is scoped by the application's own company; the public routes
 * know the company only from the token's row.
 */
@Injectable()
export class DotApplicationService {
  private readonly readLimiter = new RateLimiter(240, 60_000);
  private readonly writeLimiter = new RateLimiter(600, 10 * 60_000);
  private readonly uploadLimiter = new RateLimiter(40, 10 * 60_000);
  private readonly codeLimiter = new RateLimiter(12, 60 * 60_000);
  private readonly missLimiter = new RateLimiter(30, 10 * 60_000);

  constructor(
    private readonly database: DatabaseService,
    private readonly templates: DotAppTemplatesService,
    private readonly recruit: RecruitService,
    private readonly drivers: DriversService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorageService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  private now(): Date {
    return this.clock();
  }

  // ======================================================================== shared readers

  async brand(companyId: string): Promise<DotAppCompanyBrand> {
    const [row] = await this.db
      .select({ name: companies.name, record: companyProfiles.record, sphFax: companies.sphConfidentialFax })
      .from(companies)
      .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row) throw gone();
    const rec = (row.record ?? {}) as { legalName?: string; phone?: string; physicalAddress?: string; trailerYards?: { name?: string; address?: string }[] };
    const legalName = rec.legalName?.trim() || row.name;
    const yards = (rec.trailerYards ?? []).map((y) => [y.name, y.address].filter(Boolean).join(' — ')).filter(Boolean);
    const main = rec.physicalAddress?.trim();
    return {
      name: legalName,
      legalName,
      phone: rec.phone?.trim() || null,
      address: main || null,
      locations: [...(main ? [`${main} (Main terminal)`] : []), ...yards, 'Remote / Any location'],
      sphConfidentialFax: row.sphFax?.trim() || null,
    };
  }

  /** The Consent Form documents on file for the application's case (signed, Safety-reviewed). */
  async consentLinks(app: DotDriverApplicationRow): Promise<{ link: DotAppConsentLink; title: string; signedAt: string; version: string }[]> {
    if (!app.hiringCaseId) return [];
    const docs = await this.db
      .select()
      .from(hiringConsentDocuments)
      .where(and(eq(hiringConsentDocuments.companyId, app.companyId), eq(hiringConsentDocuments.hiringCaseId, app.hiringCaseId)));
    const out: { link: DotAppConsentLink; title: string; signedAt: string; version: string }[] = [];
    for (const d of docs) {
      const link = d.documentType as DotAppConsentLink;
      if (!['psp', 'mvr', 'clearinghouse'].includes(link) || out.some((x) => x.link === link)) continue;
      out.push({ link, title: CONSENT_LINK_TITLES[link], signedAt: d.signedAt.toISOString(), version: d.disclosureVersion });
    }
    return out;
  }

  async currentSignatures(appId: string): Promise<DotApplicationSignatureRow[]> {
    return this.db
      .select()
      .from(dotApplicationSignatures)
      .where(and(eq(dotApplicationSignatures.applicationId, appId), isNull(dotApplicationSignatures.supersededAt)));
  }

  async currentFiles(appId: string): Promise<DotApplicationFileRow[]> {
    return this.db
      .select()
      .from(dotApplicationFiles)
      .where(and(eq(dotApplicationFiles.applicationId, appId), isNull(dotApplicationFiles.removedAt)));
  }

  signatureView(s: DotApplicationSignatureRow): DotAppSignatureView {
    return {
      key: s.docKey,
      docKey: signatureDocKey(s.docKey),
      docVersion: s.docVersion,
      signerName: s.signerName,
      typedName: s.typedName,
      signedAt: s.signedAt.toISOString(),
      evidenceId: s.evidenceSha256.slice(0, 10).toUpperCase(),
      signerRole: s.signerRole as 'driver' | 'employer',
      signerTitle: s.signerTitle,
    };
  }

  uploadView(f: DotApplicationFileRow): DotAppUploadView {
    return {
      id: f.id,
      slot: f.slot as DotAppUploadSlot,
      fileName: f.fileName,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      uploadedAt: f.uploadedAt.toISOString(),
      source: f.source as DotAppUploadView['source'],
    };
  }

  /** The missing list for an application, from what is on file. */
  async missingFor(app: DotDriverApplicationRow) {
    const [sigs, files, links] = await Promise.all([this.currentSignatures(app.id), this.currentFiles(app.id), this.consentLinks(app)]);
    const frozen = await this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>);
    return dotAppMissing(app.answers as DotAppAnswers, {
      today: easternToday(this.now()),
      signatures: new Set(sigs.filter((s) => s.signerRole === 'driver').map((s) => s.docKey)),
      uploads: new Set(files.map((f) => f.slot)),
      approvedDocs: new Set(frozen.keys()),
      consentLinks: new Set(links.map((l) => l.link)),
      ssnOnFile: Boolean(app.ssnSealed),
      bankOnFile: Boolean(app.bankSealed),
      templateContent: (key) => frozen.get(key)?.content as Record<string, unknown> | undefined,
    });
  }

  linkView(l: DotApplicationLinkRow, emailStatus: string | null): DotAppLinkView {
    const now = this.now().getTime();
    return {
      id: l.id,
      state: l.revokedAt ? 'revoked' : l.expiresAt.getTime() <= now ? 'expired' : l.pausedAt ? 'paused' : 'live',
      email: l.email,
      createdAt: l.createdAt.toISOString(),
      createdByName: l.createdByName,
      expiresAt: l.expiresAt.toISOString(),
      emailedAt: iso(l.emailedAt),
      copiedAt: iso(l.copiedAt),
      firstOpenedAt: iso(l.firstOpenedAt),
      lastOpenedAt: iso(l.lastOpenedAt),
      verifiedAt: iso(l.verifiedAt),
      pausedAt: iso(l.pausedAt),
      revokedAt: iso(l.revokedAt),
      revokedByName: l.revokedByName,
      emailStatus,
    };
  }

  async summary(app: DotDriverApplicationRow): Promise<DotAppSummary> {
    const [link] = await this.db
      .select()
      .from(dotApplicationLinks)
      .where(eq(dotApplicationLinks.applicationId, app.id))
      .orderBy(desc(dotApplicationLinks.createdAt))
      .limit(1);
    const [mail] = await this.db
      .select({ status: emailMessages.status })
      .from(emailMessages)
      .where(and(eq(emailMessages.companyId, app.companyId), eq(emailMessages.entityType, 'dot_application'), eq(emailMessages.entityId, app.id), eq(emailMessages.kind, 'application_link')))
      .orderBy(desc(emailMessages.createdAt))
      .limit(1);
    const answers = app.answers as DotAppAnswers;
    const steps = dotAppVisibleSteps(answers).filter((s) => s !== 'review');
    const missing = await this.missingFor(app);
    const incomplete = new Set(missing.map((m) => m.step));
    return {
      id: app.id,
      companyId: app.companyId,
      subjectKey: app.subjectKey,
      candidateName: app.candidateName,
      driverId: app.driverId,
      position: answers.company?.position ?? null,
      status: app.status as DotAppStatus,
      createdAt: app.createdAt.toISOString(),
      submittedAt: iso(app.submittedAt),
      approvedAt: iso(app.approvedAt),
      hiredAt: iso(app.hiredAt),
      sectionsComplete: steps.filter((s) => !incomplete.has(s)).length,
      sectionsTotal: steps.length,
      link: link ? this.linkView(link, mail?.status ?? null) : null,
    };
  }

  private async appBySubject(companyId: string, subjectKey: string): Promise<DotDriverApplicationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(dotDriverApplications)
      .where(and(eq(dotDriverApplications.companyId, companyId), eq(dotDriverApplications.subjectKey, subjectKey)))
      .limit(1);
    return row;
  }

  // ======================================================================== recruiter (Recruiting step 5)

  private assertManage(principal: Principal): void {
    if (!principal.permissions.has('recruiting.manage')) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'This needs the recruiting manage permission.' });
    }
  }

  async recruiterView(principal: Principal, key: string): Promise<DotAppRecruiterView> {
    const s = await this.recruit.dotAppSubject(principal, key);
    const awaiting = await this.templates.awaiting(principal.companyId);
    const app = await this.appBySubject(principal.companyId, s.subject.subjectKey);
    const company = await this.brand(principal.companyId);
    return {
      available: awaiting.length === 0,
      blockedReason:
        awaiting.length > 0
          ? `Awaiting ${company.name} approved documents (${awaiting.length}). Upload and approve them in Admin → Document templates.`
          : s.blockedReason,
      awaitingDocs: awaiting,
      application: app ? await this.summary(app) : null,
    };
  }

  /**
   * Create (or reuse) the candidate's application for their own company and send a fresh one-time
   * link: by email through Resend when asked, and always returned once for Copy link. The previous
   * live link stops working. Never a second application for the same candidate and company.
   */
  async issue(principal: Principal, key: string, input: DotAppIssueInput): Promise<DotAppIssued> {
    this.assertManage(principal);
    const s = await this.recruit.dotAppSubject(principal, key);
    if (s.blockedReason) throw conflict(s.blockedReason, { code: 'safety_first' });
    const company = await this.brand(principal.companyId);
    const awaiting = await this.templates.awaiting(principal.companyId);
    if (awaiting.length > 0) {
      throw conflict(`Awaiting ${company.name} approved documents: ${awaiting.map((a) => a.title).join(' · ')}.`, { code: 'templates_awaiting', awaiting });
    }
    const email = (input.email ?? s.email ?? '').trim().toLowerCase();
    if (!email) throw unprocessable('The candidate has no email address on file. Add one before sending the application (the 6-digit code goes there).');
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + input.expiresInDays * DAY);
    let driverId = s.driverId;
    if (!driverId && s.subject.caseId) driverId = (await this.drivers.reserveDriverIdFor(principal, s.subject.caseId)).id;

    const result = await this.db.transaction(async (tx) => {
      let [app] = await tx
        .select()
        .from(dotDriverApplications)
        .where(and(eq(dotDriverApplications.companyId, principal.companyId), eq(dotDriverApplications.subjectKey, s.subject.subjectKey)))
        .for('update');
      if (app && !DOT_APP_EDITABLE.includes(app.status as DotAppStatus)) {
        throw conflict(`The application is ${DOT_APP_STATUS_LABELS[app.status as DotAppStatus].toLowerCase()}; a new link is not needed.`);
      }
      if (!app) {
        const approved = await this.templates.approved(principal.companyId);
        const versions = Object.fromEntries([...approved.entries()].map(([k, r]) => [k, r.version]));
        const prefill = await this.prefillFor(principal.companyId, s.subject.caseId, s.subject.leadId);
        [app] = await tx
          .insert(dotDriverApplications)
          .values({
            id: `dap_${crypto.randomUUID()}`,
            companyId: principal.companyId,
            subjectKey: s.subject.subjectKey,
            leadId: s.subject.leadId,
            hiringCaseId: s.subject.caseId,
            driverId,
            candidateName: s.subject.name,
            candidateEmail: email,
            status: 'sent',
            templateVersions: versions,
            answers: prefill.answers,
            prefill: { paths: prefill.paths, consentId: prefill.consentId },
            createdByUserId: principal.userId,
            createdByName: principal.userName ?? principal.userId,
          })
          .returning();
        if (prefill.files.length) await tx.insert(dotApplicationFiles).values(prefill.files.map((f) => ({ ...f, applicationId: app!.id })));
      } else if (!app.driverId && driverId) {
        await tx.update(dotDriverApplications).set({ driverId }).where(eq(dotDriverApplications.id, app.id));
      }
      await tx
        .update(dotApplicationLinks)
        .set({ revokedAt: now, revokedByName: principal.userName ?? principal.userId, revokedReason: 'Replaced by a new link' })
        .where(and(eq(dotApplicationLinks.applicationId, app!.id), isNull(dotApplicationLinks.revokedAt)));
      const [link] = await tx
        .insert(dotApplicationLinks)
        .values({
          id: `dal_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          applicationId: app!.id,
          tokenHash: sha256(token),
          email,
          expiresAt,
          createdByUserId: principal.userId,
          createdByName: principal.userName ?? principal.userId,
        })
        .returning();
      // Any session of an older link ends with it.
      return { app: app!, link: link! };
    });
    const url = `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/application/#token=${token}`;
    let mail: DotAppIssued['email'] = { status: 'skipped', error: null, messageId: null };
    if (input.sendEmail) {
      const first = s.subject.name.split(/\s+/)[0] ?? '';
      const msg = applicationLinkEmail({ firstName: first, company: company.name, url, expiresAt, zone: 'America/New_York' });
      const sent = await this.email.send({
        companyId: principal.companyId,
        kind: 'application_link',
        sender: 'recruiting',
        to: email,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        entityType: 'dot_application',
        entityId: result.app.id,
        actorName: principal.userName ?? principal.userId,
      });
      mail = { status: sent.status, error: sent.error, messageId: sent.messageId };
      if (sent.status === 'sent') await this.db.update(dotApplicationLinks).set({ emailedAt: new Date() }).where(eq(dotApplicationLinks.id, result.link.id));
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'dot_application',
      entityId: result.app.id,
      entityLabel: s.subject.name,
      summary: `DOT application link ${mail.status === 'sent' ? `emailed to ${maskEmail(email)}` : 'made'} (expires ${expiresAt.toISOString().slice(0, 10)})${mail.status === 'failed' ? ` — email failed: ${mail.error}` : ''}`,
    });
    const fresh = (await this.appBySubject(principal.companyId, s.subject.subjectKey))!;
    return { application: await this.summary(fresh), url, expiresAt: expiresAt.toISOString(), email: mail };
  }

  async markCopied(principal: Principal, key: string): Promise<DotAppSummary> {
    this.assertManage(principal);
    const s = await this.recruit.dotAppSubject(principal, key);
    const app = await this.appBySubject(principal.companyId, s.subject.subjectKey);
    if (!app) throw new AppError({ status: 404, title: 'Not Found', detail: 'No application yet.' });
    await this.db
      .update(dotApplicationLinks)
      .set({ copiedAt: new Date() })
      .where(and(eq(dotApplicationLinks.applicationId, app.id), isNull(dotApplicationLinks.revokedAt)));
    await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Application link copied (to send by Telegram / WhatsApp)' });
    return this.summary(app);
  }

  async revoke(principal: Principal, key: string): Promise<DotAppSummary> {
    this.assertManage(principal);
    const s = await this.recruit.dotAppSubject(principal, key);
    const app = await this.appBySubject(principal.companyId, s.subject.subjectKey);
    if (!app) throw new AppError({ status: 404, title: 'Not Found', detail: 'No application yet.' });
    const now = new Date();
    const links = await this.db
      .update(dotApplicationLinks)
      .set({ revokedAt: now, revokedByName: principal.userName ?? principal.userId, revokedReason: 'Revoked by recruiting' })
      .where(and(eq(dotApplicationLinks.applicationId, app.id), isNull(dotApplicationLinks.revokedAt)))
      .returning({ id: dotApplicationLinks.id });
    for (const l of links) await this.db.update(dotApplicationSessions).set({ endedAt: now }).where(and(eq(dotApplicationSessions.linkId, l.id), isNull(dotApplicationSessions.endedAt)));
    await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Application link revoked; the old link no longer works' });
    return this.summary(app);
  }

  /** What the signed Consent Form gives the application: name, phone, email, the CDL images. */
  private async prefillFor(companyId: string, caseId: string | null, leadId: string | null) {
    const answers: DotAppAnswers = { licenses: [{ country: 'United States', current: 'Yes', cdl: 'Yes' }], personal: { address: { country: 'United States' } } };
    const paths: string[] = [];
    const files: (typeof dotApplicationFiles.$inferInsert)[] = [];
    if (!caseId) return { answers, paths, files, consentId: null };
    const [consent] = await this.db
      .select()
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, companyId), eq(hiringConsents.hiringCaseId, caseId)))
      .orderBy(desc(hiringConsents.receivedAt))
      .limit(1);
    if (!consent) return { answers, paths, files, consentId: null };
    answers.personal = { ...answers.personal, firstName: consent.firstName, lastName: consent.lastName, phone: consent.phone, email: consent.email };
    paths.push('personal.firstName', 'personal.lastName', 'personal.phone', 'personal.email');
    const cf = await this.db
      .select()
      .from(hiringConsentFiles)
      .where(and(eq(hiringConsentFiles.companyId, companyId), eq(hiringConsentFiles.consentId, consent.id)));
    for (const f of cf) {
      const slot = /back/i.test(f.code) ? 'cdl_back' : /front|^cdl$/i.test(f.code) ? 'cdl_front' : null;
      if (!slot || files.some((x) => x.slot === slot)) continue;
      files.push({
        id: `daf_${crypto.randomUUID()}`,
        companyId,
        applicationId: '',
        slot,
        fileName: f.fileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        storageKey: f.storageKey,
        sha256: f.sha256,
        source: 'consent',
        uploadedByName: 'Consent Form',
        uploadedAt: f.uploadedAt,
      });
    }
    void leadId;
    return { answers, paths, files, consentId: consent.id };
  }

  // ======================================================================== the driver (public)

  private async resolve(token: string, ip: string): Promise<{ link: DotApplicationLinkRow; app: DotDriverApplicationRow }> {
    this.missLimiter.check(ip);
    if (!TOKEN.test(token)) {
      this.missLimiter.hit(ip);
      throw gone();
    }
    const [row] = await this.db
      .select({ link: dotApplicationLinks, app: dotDriverApplications })
      .from(dotApplicationLinks)
      .innerJoin(dotDriverApplications, eq(dotDriverApplications.id, dotApplicationLinks.applicationId))
      .where(eq(dotApplicationLinks.tokenHash, sha256(token)))
      .limit(1);
    if (!row || row.link.companyId !== row.app.companyId) {
      this.missLimiter.hit(ip);
      throw gone();
    }
    if (row.link.revokedAt || row.link.expiresAt.getTime() <= this.now().getTime()) throw gone();
    return row;
  }

  private systemPrincipal(companyId: string, name: string): Principal {
    return { userId: 'system:dot-application', userName: name, companyId, companyTimezone: 'America/New_York', weekStart: weekStartIndex('monday'), roles: [], permissions: new Set() };
  }

  private async sessionOk(link: DotApplicationLinkRow, session: string | null): Promise<boolean> {
    if (!session || session.length < 30 || session.length > 80) return false;
    const [row] = await this.db
      .select()
      .from(dotApplicationSessions)
      .where(and(eq(dotApplicationSessions.sessionHash, sha256(session)), eq(dotApplicationSessions.linkId, link.id), isNull(dotApplicationSessions.endedAt)))
      .limit(1);
    if (!row || row.expiresAt.getTime() <= this.now().getTime()) return false;
    await this.db.update(dotApplicationSessions).set({ lastSeenAt: new Date() }).where(eq(dotApplicationSessions.id, row.id));
    return true;
  }

  private async authed(token: string, meta: PublicMeta): Promise<{ link: DotApplicationLinkRow; app: DotDriverApplicationRow }> {
    const r = await this.resolve(token, meta.ip);
    if (r.link.pausedAt) throw new AppError({ status: 423, title: 'Locked', detail: 'This link is paused. Please contact recruiting.' });
    if (!(await this.sessionOk(r.link, meta.session))) throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Enter the 6-digit code to continue.', extensions: { code: 'code_required' } });
    return r;
  }

  async gate(token: string, meta: PublicMeta): Promise<DotAppPublicGate> {
    this.readLimiter.hit(meta.ip);
    const { link, app } = await this.resolve(token, meta.ip);
    const now = this.now();
    await this.db
      .update(dotApplicationLinks)
      .set({ lastOpenedAt: now, ...(link.firstOpenedAt ? {} : { firstOpenedAt: now }) })
      .where(eq(dotApplicationLinks.id, link.id));
    if (app.status === 'sent') {
      await this.db.update(dotDriverApplications).set({ status: 'opened', firstOpenedAt: app.firstOpenedAt ?? now, updatedAt: now }).where(eq(dotDriverApplications.id, app.id));
      await this.audit.write(this.systemPrincipal(app.companyId, 'Driver'), { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Driver opened the application link' });
    }
    const verified = !link.pausedAt && (await this.sessionOk(link, meta.session));
    const resendIn = link.codeSentAt ? Math.max(0, DOT_APP_CODE_RESEND_SECONDS - Math.floor((now.getTime() - link.codeSentAt.getTime()) / 1000)) : 0;
    return {
      state: link.pausedAt ? 'paused' : verified ? 'verified' : 'code_required',
      company: await this.brand(app.companyId),
      maskedEmail: maskEmail(link.email),
      codeSentAt: iso(link.codeSentAt),
      resendInSeconds: resendIn,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /** Email a fresh 6-digit code (10 minutes, single use). At most once a minute. */
  async sendCode(token: string, meta: PublicMeta): Promise<{ sent: boolean; resendInSeconds: number; maskedEmail: string }> {
    const { link, app } = await this.resolve(token, meta.ip);
    if (link.pausedAt) throw new AppError({ status: 423, title: 'Locked', detail: 'This link is paused. Please contact recruiting.' });
    const now = this.now();
    if (link.codeSentAt && now.getTime() - link.codeSentAt.getTime() < DOT_APP_CODE_RESEND_SECONDS * 1000) {
      const wait = DOT_APP_CODE_RESEND_SECONDS - Math.floor((now.getTime() - link.codeSentAt.getTime()) / 1000);
      throw new AppError({ status: 429, title: 'Too Many Requests', detail: `You can ask for a new code in ${wait} seconds.`, extensions: { retryAfter: wait } });
    }
    this.codeLimiter.hit(`${link.id}`, 'Too many codes were asked for. Please contact recruiting.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db
      .update(dotApplicationLinks)
      .set({ codeHash: codeDigest(link.id, code), codeExpiresAt: new Date(now.getTime() + DOT_APP_CODE_TTL_MINUTES * 60_000), codeSentAt: now })
      .where(eq(dotApplicationLinks.id, link.id));
    const company = await this.brand(app.companyId);
    const msg = codeEmail({ code, company: company.name, minutes: DOT_APP_CODE_TTL_MINUTES });
    const sent = await this.email.send({
      companyId: app.companyId,
      kind: 'application_code',
      sender: 'recruiting',
      to: link.email,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      entityType: 'dot_application',
      entityId: app.id,
      actorName: 'Driver application',
    });
    if (sent.status !== 'sent') throw new AppError({ status: 502, title: 'Bad Gateway', detail: 'The code could not be emailed. Please try again in a minute or contact recruiting.' });
    return { sent: true, resendInSeconds: DOT_APP_CODE_RESEND_SECONDS, maskedEmail: maskEmail(link.email) };
  }

  /** Check the code; five wrong codes pause the link (logged). The session lasts as long as the link. */
  async verify(token: string, code: string, meta: PublicMeta): Promise<{ session: string }> {
    const { link, app } = await this.resolve(token, meta.ip);
    if (link.pausedAt) throw new AppError({ status: 423, title: 'Locked', detail: 'Too many wrong codes. For your security this link is paused. Please contact recruiting.' });
    const now = this.now();
    const valid =
      link.codeHash !== null &&
      link.codeExpiresAt !== null &&
      link.codeExpiresAt.getTime() > now.getTime() &&
      timingSafeEqual(Buffer.from(link.codeHash, 'hex'), Buffer.from(codeDigest(link.id, code), 'hex'));
    if (!valid) {
      const failures = link.codeFailures + 1;
      const pause = failures >= DOT_APP_CODE_MAX_FAILURES;
      await this.db
        .update(dotApplicationLinks)
        .set({ codeFailures: failures, ...(pause ? { pausedAt: now, codeHash: null } : {}) })
        .where(eq(dotApplicationLinks.id, link.id));
      if (pause) {
        await this.audit.write(this.systemPrincipal(app.companyId, 'Driver application'), {
          action: 'update',
          entityType: 'dot_application',
          entityId: app.id,
          entityLabel: app.candidateName,
          summary: `Link paused after ${failures} wrong codes (from ${meta.ip})`,
        });
        throw new AppError({ status: 423, title: 'Locked', detail: 'Too many wrong codes. For your security this link is paused. Please contact recruiting.' });
      }
      throw unprocessable(
        link.codeExpiresAt && link.codeExpiresAt.getTime() <= now.getTime() ? 'That code has expired. Ask for a new code.' : `That code is not right. ${DOT_APP_CODE_MAX_FAILURES - failures} tries left.`,
        { code: 'bad_code', triesLeft: DOT_APP_CODE_MAX_FAILURES - failures },
      );
    }
    const session = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await tx.update(dotApplicationLinks).set({ codeHash: null, codeExpiresAt: null, codeFailures: 0, verifiedAt: link.verifiedAt ?? now }).where(eq(dotApplicationLinks.id, link.id));
      await tx.insert(dotApplicationSessions).values({
        id: `das_${crypto.randomUUID()}`,
        companyId: app.companyId,
        linkId: link.id,
        applicationId: app.id,
        sessionHash: sha256(session),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 400) ?? null,
        expiresAt: link.expiresAt,
      });
    });
    await this.audit.write(this.systemPrincipal(app.companyId, 'Driver'), { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Driver confirmed the 6-digit code' });
    return { session };
  }

  async driverState(token: string, meta: PublicMeta): Promise<DotAppDriverState> {
    this.readLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    return this.stateOf(app);
  }

  private async stateOf(app: DotDriverApplicationRow): Promise<DotAppDriverState> {
    const [sigs, files, links, frozen, company] = await Promise.all([
      this.currentSignatures(app.id),
      this.currentFiles(app.id),
      this.consentLinks(app),
      this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>),
      this.brand(app.companyId),
    ]);
    const [open] = await this.db
      .select()
      .from(dotApplicationChangeRequests)
      .where(and(eq(dotApplicationChangeRequests.applicationId, app.id), isNull(dotApplicationChangeRequests.resolvedAt)))
      .orderBy(desc(dotApplicationChangeRequests.requestedAt))
      .limit(1);
    const answers = app.answers as DotAppAnswers;
    return {
      applicationId: app.id,
      status: app.status as DotAppStatus,
      version: app.version,
      company,
      answers,
      prefilledPaths: ((app.prefill as { paths?: string[] }).paths ?? []) as string[],
      ssnOnFile: Boolean(app.ssnSealed),
      ssnLast4: app.ssnLast4,
      bankOnFile: Boolean(app.bankSealed),
      bankLast4: app.bankLast4,
      templates: [...frozen.values()].map(toTemplate),
      awaitingDocs: DOT_APP_DOCUMENTS.filter((d) => d.signer !== 'employer' && !frozen.has(d.key)).map((d) => d.key),
      consentLinks: links,
      // The driver sees only their own signatures, never the carrier's (nor the ones given in person at onboarding).
      signatures: sigs.filter((s) => s.signerRole === 'driver' && !DOT_APP_IN_PERSON_DRIVER_SIGNATURES.includes(s.docKey)).map((s) => this.signatureView(s)),
      uploads: files.map((f) => this.uploadView(f)),
      missing: await this.missingFor(app),
      today: easternToday(this.now()),
      openChangeRequest: open
        ? { id: open.id, sections: open.sections as never, message: open.message, requestedAt: open.requestedAt.toISOString(), requestedByName: 'Safety', resolvedAt: null }
        : null,
      submittedAt: iso(app.submittedAt),
      reference: app.driverId ? `D-${app.driverId.replace(/^drv_/, '')}` : null,
      lastSavedAt: iso(app.lastSavedAt),
    };
  }

  private assertEditable(app: DotDriverApplicationRow): void {
    if (!DOT_APP_EDITABLE.includes(app.status as DotAppStatus)) {
      throw conflict('This application was submitted and can no longer be changed here.', { code: 'submitted' });
    }
  }

  /** Autosave. A save with a stale version is refused with 409 and the newer copy is not overwritten. */
  async save(
    token: string,
    input: SaveDotAppInput,
    meta: PublicMeta,
  ): Promise<{ version: number; lastSavedAt: string; ssnOnFile: boolean; ssnLast4: string | null; bankOnFile: boolean; bankLast4: string | null; missing: DotAppDriverState['missing'] }> {
    this.writeLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    this.assertEditable(app);
    const answers = this.normalise(input.answers);
    const now = this.now();
    const ssn = input.ssn?.replace(/\D/g, '');
    // Bank numbers (ACH debit authorization): sealed like the SSN, never in the answers, never echoed.
    const bank = input.bank ? { routing: input.bank.routing.trim(), account: input.bank.account.trim() } : null;
    const [updated] = await this.db
      .update(dotDriverApplications)
      .set({
        answers,
        version: app.version + 1,
        lastSavedAt: now,
        updatedAt: now,
        status: app.status === 'sent' || app.status === 'opened' ? 'in_progress' : app.status,
        ...(ssn ? { ssnSealed: encrypt(ssn, 'pii'), ssnLast4: ssn.slice(-4) } : {}),
        ...(bank ? { bankSealed: encrypt(JSON.stringify(bank), 'pii'), bankLast4: bank.account.slice(-4) } : {}),
      })
      .where(and(eq(dotDriverApplications.id, app.id), eq(dotDriverApplications.version, input.version)))
      .returning();
    if (!updated) throw conflict('A newer version was saved from another device. Reload to continue.', { code: 'stale', currentVersion: app.version });
    if (bank) {
      await this.audit.write(this.systemPrincipal(app.companyId, 'Driver'), {
        action: 'update',
        entityType: 'dot_application',
        entityId: app.id,
        entityLabel: app.candidateName,
        summary: `Driver ${app.bankSealed ? 'changed' : 'entered'} the ACH bank numbers (account ending ${bank.account.slice(-4)}); sealed`,
      });
    }
    if (app.status === 'sent' || app.status === 'opened') {
      await this.audit.write(this.systemPrincipal(app.companyId, 'Driver'), { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Driver started the application' });
    }
    return {
      version: updated.version,
      lastSavedAt: now.toISOString(),
      ssnOnFile: Boolean(updated.ssnSealed),
      ssnLast4: updated.ssnLast4,
      bankOnFile: Boolean(updated.bankSealed),
      bankLast4: updated.bankLast4,
      missing: await this.missingFor(updated),
    };
  }

  /**
   * Employers and trucking schools get a stable id (the SPH request, the 391.23 consent and the
   * FCRA pair are signed per entity); bank numbers are dropped wherever the page put them.
   */
  private normalise(a: DotAppAnswers): DotAppAnswers {
    const out = { ...a };
    if (Array.isArray(out.employers)) out.employers = out.employers.map((e) => (e && typeof e === 'object' && !e.id ? { ...e, id: randomBytes(5).toString('hex') } : e));
    if (Array.isArray(out.schools)) out.schools = out.schools.map((s) => (s && typeof s === 'object' && !s.id ? { ...s, id: randomBytes(5).toString('hex') } : s));
    if (out.ach && typeof out.ach === 'object') {
      const { routing: _r, account: _a, accountNumber: _n, routingNumber: _m, ...rest } = out.ach as Record<string, unknown>;
      void _r;
      void _a;
      void _n;
      void _m;
      out.ach = rest as DotAppAnswers['ach'];
    }
    if ('bank' in (out as Record<string, unknown>)) delete (out as Record<string, unknown>).bank;
    // The SSN is never kept in the answers, whatever the page sent.
    if (out.personal && 'ssn' in (out.personal as Record<string, unknown>)) {
      const { ssn: _drop, ...rest } = out.personal as Record<string, unknown>;
      void _drop;
      out.personal = rest as DotAppAnswers['personal'];
    }
    return out;
  }

  /** One upload, sent as raw bytes. Type and size are checked here, by content, not by name. */
  async upload(token: string, slot: string, bytes: Buffer, fileName: string, meta: PublicMeta): Promise<DotAppUploadView> {
    this.uploadLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    this.assertEditable(app);
    if (!(DOT_APP_UPLOAD_SLOTS as readonly string[]).includes(slot)) throw unprocessable('Unknown document slot.');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw unprocessable('The file is empty.');
    if (bytes.length > DOT_APP_MAX_UPLOAD_BYTES) throw new AppError({ status: 413, title: 'Payload Too Large', detail: 'The file is larger than 15 MB.' });
    const type = sniff(bytes);
    if (!type) throw unprocessable('Use a photo (JPG, PNG, HEIC) or a PDF.');
    return this.storeFile(app, slot, bytes, type, cleanFileName(fileName || `${slot}${EXT[type] ?? ''}`), 'driver', 'Driver');
  }

  async storeFile(app: DotDriverApplicationRow, slot: string, bytes: Buffer, type: string, fileName: string, source: 'driver' | 'employer', by: string): Promise<DotAppUploadView> {
    const id = `daf_${crypto.randomUUID()}`;
    const key = `dot-application/${app.companyId}/${app.id}/${slot}/${id}${EXT[type] ?? ''}`;
    await this.storage.put(key, bytes);
    const now = new Date();
    const row = await this.db.transaction(async (tx) => {
      await tx
        .update(dotApplicationFiles)
        .set({ removedAt: now, removedReason: 'Replaced' })
        .where(and(eq(dotApplicationFiles.applicationId, app.id), eq(dotApplicationFiles.slot, slot), isNull(dotApplicationFiles.removedAt)));
      const [inserted] = await tx
        .insert(dotApplicationFiles)
        .values({ id, companyId: app.companyId, applicationId: app.id, slot, fileName, contentType: type, sizeBytes: bytes.length, storageKey: key, sha256: createHash('sha256').update(bytes).digest('hex'), source, uploadedByName: by })
        .returning();
      return inserted!;
    });
    return this.uploadView(row);
  }

  async removeUpload(token: string, fileId: string, meta: PublicMeta): Promise<{ removed: true }> {
    this.writeLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    this.assertEditable(app);
    const [row] = await this.db
      .update(dotApplicationFiles)
      .set({ removedAt: new Date(), removedReason: 'Removed by the driver' })
      .where(and(eq(dotApplicationFiles.applicationId, app.id), eq(dotApplicationFiles.id, fileId), isNull(dotApplicationFiles.removedAt)))
      .returning();
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    return { removed: true };
  }

  /** The driver's own upload, to show it back to them (thumbnail / open). */
  async driverFile(token: string, fileId: string, meta: PublicMeta): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    this.readLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    const [row] = await this.db
      .select()
      .from(dotApplicationFiles)
      .where(and(eq(dotApplicationFiles.applicationId, app.id), eq(dotApplicationFiles.id, fileId), isNull(dotApplicationFiles.removedAt)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    return { bytes: await this.storage.get(row.storageKey), contentType: row.contentType, fileName: row.fileName };
  }

  /** The driver's own current signature image (to show it again after a reload). Never the carrier's. */
  async driverSignatureImage(token: string, key: string, meta: PublicMeta): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    this.readLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    if (!/^[a-z0-9_]{2,80}$/i.test(key) || DOT_APP_IN_PERSON_DRIVER_SIGNATURES.includes(key)) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such signature.' });
    const [row] = await this.db
      .select()
      .from(dotApplicationSignatures)
      .where(
        and(
          eq(dotApplicationSignatures.applicationId, app.id),
          eq(dotApplicationSignatures.docKey, key),
          eq(dotApplicationSignatures.signerRole, 'driver'),
          isNull(dotApplicationSignatures.supersededAt),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such signature.' });
    return { bytes: await this.storage.get(row.imageStorageKey), contentType: 'image/png', fileName: `${key}.png` };
  }

  /** The signature keys a driver may sign on this application right now. */
  private driverSignable(app: DotDriverApplicationRow, links: Set<DotAppConsentLink>, approved: Set<string>): Set<string> {
    const answers = app.answers as DotAppAnswers;
    const ctx = { approvedDocs: approved, consentLinks: links, today: easternToday(this.now()) };
    const keys = new Set<string>();
    for (const step of dotAppVisibleSteps(answers)) for (const k of dotAppSignaturesFor(step, answers, ctx)) keys.add(k);
    for (const e of dotAppSphEmployers(answers, ctx.today)) keys.add(`sph_${e.id}`);
    return keys;
  }

  /**
   * One signature, on one document: drawn image + typed full name + e-sign consent, against the
   * exact approved version shown. Evidence: document key and version, content digest, signer, time,
   * IP, user agent, image digest — hashed together. A re-sign supersedes the earlier one (kept).
   */
  async sign(token: string, input: DotAppSignInput, meta: PublicMeta): Promise<DotAppSignatureView> {
    this.writeLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    this.assertEditable(app);
    const [links, frozen] = await Promise.all([this.consentLinks(app), this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>)]);
    const allowed = this.driverSignable(app, new Set(links.map((l) => l.link)), new Set(frozen.keys()));
    if (!allowed.has(input.key)) throw unprocessable('This document is not signed here (it is covered by your Consent Form or is not part of your application).');
    const answers = app.answers as DotAppAnswers;
    const signer = [answers.personal?.firstName, answers.personal?.middleName, answers.personal?.lastName].filter(Boolean).join(' ').trim() || app.candidateName;
    return this.storeSignature(app, input, frozen, { role: 'driver', name: signer, userId: null, ip: meta.ip, userAgent: meta.userAgent });
  }

  async storeSignature(
    app: DotDriverApplicationRow,
    input: DotAppSignInput,
    frozen: Map<string, { version: string; contentSha256: string }>,
    who: { role: 'driver' | 'employer'; name: string; userId: string | null; ip: string | null; userAgent: string | null; title?: string | null },
  ): Promise<DotAppSignatureView> {
    const docKey = signatureDocKey(input.key);
    const template = frozen.get(docKey);
    if (!template) throw conflict('This document has no approved version for this company, so it cannot be signed.', { code: 'template_awaiting' });
    if (template.version !== input.docVersion) throw conflict('The document changed since this page was opened. Reload and sign the current version.', { code: 'template_changed' });
    const png = Buffer.from(input.image.slice('data:image/png;base64,'.length), 'base64');
    if (png.length === 0 || png.length > DOT_APP_MAX_SIGNATURE_BYTES || sniff(png) !== 'image/png') throw unprocessable('Draw your signature again.');
    const id = `dsg_${crypto.randomUUID()}`;
    const imageKey = `dot-application/${app.companyId}/${app.id}/signatures/${id}.png`;
    await this.storage.put(imageKey, png);
    const at = new Date();
    const imageSha = createHash('sha256').update(png).digest('hex');
    const evidence = sha256(
      stableJson({ app: app.id, company: app.companyId, key: input.key, docKey, version: template.version, content: template.contentSha256, signer: who.name, typed: input.typedName, role: who.role, at: at.toISOString(), ip: who.ip, ua: who.userAgent, image: imageSha }),
    );
    const row = await this.db.transaction(async (tx) => {
      await tx
        .update(dotApplicationSignatures)
        .set({ supersededAt: at, supersededReason: 'Signed again' })
        .where(and(eq(dotApplicationSignatures.applicationId, app.id), eq(dotApplicationSignatures.docKey, input.key), isNull(dotApplicationSignatures.supersededAt)));
      const [inserted] = await tx
        .insert(dotApplicationSignatures)
        .values({
          id,
          companyId: app.companyId,
          applicationId: app.id,
          docKey: input.key,
          docVersion: template.version,
          signerRole: who.role,
          signerName: who.name,
          signerUserId: who.userId,
          signerTitle: who.title ?? input.title ?? null,
          typedName: input.typedName,
          esignConsent: true,
          imageStorageKey: imageKey,
          imageSha256: imageSha,
          evidenceSha256: evidence,
          contentSha256: template.contentSha256,
          ip: who.ip,
          userAgent: who.userAgent?.slice(0, 400) ?? null,
          signedAt: at,
        })
        .returning();
      return inserted!;
    });
    return this.signatureView(row);
  }

  /** Submit: once, only complete, only the version the page holds. */
  async submit(token: string, version: number, meta: PublicMeta): Promise<DotAppDriverState> {
    this.writeLimiter.hit(meta.ip);
    const { app } = await this.authed(token, meta);
    this.assertEditable(app);
    if (app.version !== version) throw conflict('A newer version was saved from another device. Reload before submitting.', { code: 'stale' });
    const missing = await this.missingFor(app);
    if (missing.length > 0) throw unprocessable(`Still needed: ${missing.length} item(s).`, { code: 'incomplete', missing });
    const now = this.now();
    const done = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(dotDriverApplications).where(eq(dotDriverApplications.id, app.id)).for('update');
      if (!locked || locked.version !== version || !DOT_APP_EDITABLE.includes(locked.status as DotAppStatus)) return null;
      const [row] = await tx
        .update(dotDriverApplications)
        .set({ status: 'submitted', submittedAt: now, submitCount: locked.submitCount + 1, version: locked.version + 1, updatedAt: now })
        .where(eq(dotDriverApplications.id, app.id))
        .returning();
      await tx
        .update(dotApplicationChangeRequests)
        .set({ resolvedAt: now })
        .where(and(eq(dotApplicationChangeRequests.applicationId, app.id), isNull(dotApplicationChangeRequests.resolvedAt)));
      return row!;
    });
    if (!done) throw conflict('This application was already submitted.', { code: 'submitted' });
    if (done.hiringCaseId) {
      await this.db.update(hiringCases).set({ updatedAt: now }).where(and(eq(hiringCases.companyId, app.companyId), eq(hiringCases.id, done.hiringCaseId)));
    }
    await this.audit.write(this.systemPrincipal(app.companyId, 'Driver'), {
      action: 'update',
      entityType: 'dot_application',
      entityId: app.id,
      entityLabel: app.candidateName,
      summary: `Driver submitted the application${done.submitCount > 1 ? ` (resubmission ${done.submitCount})` : ''}; it is in the Safety queue`,
    });
    return this.stateOf(done);
  }
}
