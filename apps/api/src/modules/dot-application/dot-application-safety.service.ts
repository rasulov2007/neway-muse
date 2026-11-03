import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  DOT_APP_EMPLOYER_SIGNATURES,
  DOT_APP_IN_PERSON_DRIVER_SIGNATURES,
  DOT_APP_STEP_IDS,
  DOT_APP_STEP_TITLES,
  dotAppSignaturesFor,
  dotAppSphEmployers,
  isDotAppContractor,
  type DotAppAnswers,
  type DotAppEmployerItem,
  type DotAppHireInput,
  type DotAppSafetyDetail,
  type DotAppSignInput,
  type DotAppStatus,
  type DotAppStepId,
  type DotAppSummary,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { complianceDocuments } from '../../database/schema/compliance';
import {
  dotApplicationChangeRequests,
  dotApplicationFiles,
  dotApplicationLinks,
  dotApplicationSessions,
  dotApplicationSignatures,
  dotDriverApplications,
  emailMessages,
  type DotDriverApplicationRow,
} from '../../database/schema/dot-application';
import { hiringCases } from '../../database/schema/hiring';
import { companies, drivers } from '../../database/schema/roster';
import { decrypt, type SealedCredential } from '../admin/credential-vault';
import { CLOCK, type Clock } from '../dashboard/clock';
import { EmailService } from '../email/email.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { easternToday } from '../roster/driver-archive.data';
import { conflict, DotApplicationService } from './dot-application.service';
import { changesEmail } from './emails';
import { applicationPdf } from './dot-application-pdf';
import { sha256, DotAppTemplatesService, toTemplate } from './templates.service';

/** Safety decides (the same code as the Safety desk); Admin holds every code. */
export const SAFETY_REVIEW_PERMISSION = 'compliance.manage';
/** The full SSN is shown only to holders of the restricted qualification records code (audited). */
export const SSN_PERMISSION = 'compliance_sensitive.view';

const QUEUE: DotAppStatus[] = ['submitted', 'under_review', 'changes_requested', 'approved', 'rejected', 'hired'];

function notFound(): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail: 'No such application.' });
}
function unprocessable(detail: string, extensions?: Record<string, unknown>): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', detail, extensions });
}

/**
 * Safety's side of the application (owner brief 2026-10-27 §5–6): the per-company queue, the
 * employer-only forms (never shown to the driver), request changes, approve / reject, onboarding,
 * and Hire — one database transaction into Fleet → Drivers under the reserved id, idempotent.
 * "Driver submitted" and "Safety approved" are separate states.
 */
@Injectable()
export class DotApplicationSafetyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly apps: DotApplicationService,
    private readonly templates: DotAppTemplatesService,
    private readonly driversService: DriversService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly storage: DocumentStorageService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  private assertReview(principal: Principal): void {
    if (!principal.permissions.has(SAFETY_REVIEW_PERMISSION)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Reviewing driver applications needs the Safety (compliance manage) permission.' });
    }
  }

  private async row(principal: Principal, id: string): Promise<DotDriverApplicationRow> {
    const [row] = await this.db
      .select()
      .from(dotDriverApplications)
      .where(and(eq(dotDriverApplications.companyId, principal.companyId), eq(dotDriverApplications.id, id)))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  async queue(principal: Principal): Promise<DotAppSummary[]> {
    this.assertReview(principal);
    const rows = await this.db
      .select()
      .from(dotDriverApplications)
      .where(and(eq(dotDriverApplications.companyId, principal.companyId), inArray(dotDriverApplications.status, QUEUE)))
      .orderBy(desc(dotDriverApplications.submittedAt));
    return Promise.all(rows.map((r) => this.apps.summary(r)));
  }

  employerChecklist(app: DotDriverApplicationRow, sigs: Set<string>, approved: Set<string>): DotAppEmployerItem[] {
    const e = (app.employerForms ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const answers = app.answers as DotAppAnswers;
    const sph = dotAppSphEmployers(answers, easternToday(this.clock()));
    const sphForms = (e.sph ?? {}) as Record<string, { method?: string } | undefined>;
    const items: DotAppEmployerItem[] = [
      { key: 'annual', title: 'Annual Review of Driving Record', done: Boolean(e.annual?.finding && e.annual?.reviewedBy && sigs.has('emp_annual')) },
      { key: 'cov', title: 'Certification of Violations — Date of Employment & Home Terminal', done: Boolean(e.cov?.home && e.cov?.doe) },
    ];
    if (approved.has('da_receipt')) items.push({ key: 'da', title: 'Alcohol & Drug Certified Receipt — Authorized Employer Representative', done: sigs.has('emp_da') });
    items.push({ key: 'prevda', title: 'Previous Employment A&D Statement — Company Representative', done: Boolean(e.prevda?.name && sigs.has('emp_prevda')) });
    items.push({ key: 'onduty', title: 'Other Compensated Work — Company Representative', done: sigs.has('emp_onduty') });
    if (sph.length) items.push({ key: 'sph', title: `Safety Performance History — Section 5a for ${sph.length} employer(s)`, done: sph.every((x) => Boolean(sphForms[x.id]?.method)) });
    if (isDotAppContractor(answers) && approved.has('occ_accident')) {
      items.push({ key: 'oa', title: 'Occupational Accident — effective date & Motor Carrier Representative', done: Boolean(e.oa?.effective && sigs.has('emp_oa')) });
    }
    return items;
  }

  onboardingChecklist(app: DotDriverApplicationRow, sigs: Set<string>, approved: Set<string>): DotAppEmployerItem[] {
    const o = (app.onboarding ?? {}) as Record<string, unknown>;
    const items: DotAppEmployerItem[] = [];
    if (approved.has('safety_training')) {
      items.push({ key: 'training', title: 'Driver Safety Training — date, instructor and instructor signature (in person)', done: Boolean(o.trainingDate && o.instructor && sigs.has('emp_training')) });
      items.push({ key: 'training_driver', title: 'Driver Safety Training — driver signature (in person)', done: sigs.has('emp_training_driver') });
    }
    items.push({ key: 'ch', title: 'Clearinghouse query result recorded', done: Boolean(o.ch) });
    items.push({ key: 'mvrpsp', title: 'MVR and PSP reviewed', done: Boolean(o.mvrpsp) });
    items.push({ key: 'dot', title: 'DOT verification (initial)', done: Boolean(o.dot) });
    return items;
  }

  async detail(principal: Principal, id: string): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    let app = await this.row(principal, id);
    // Opening a submitted application starts the review (a separate state from "driver submitted").
    if (app.status === 'submitted') {
      const now = this.clock();
      [app] = await this.db
        .update(dotDriverApplications)
        .set({ status: 'under_review', reviewStartedAt: now, reviewStartedByName: principal.userName ?? principal.userId, updatedAt: now })
        .where(and(eq(dotDriverApplications.id, app.id), eq(dotDriverApplications.status, 'submitted')))
        .returning() as [DotDriverApplicationRow];
      app ??= await this.row(principal, id);
      await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Safety review started' });
    }
    return this.detailOf(principal, app);
  }

  private async detailOf(principal: Principal, app: DotDriverApplicationRow): Promise<DotAppSafetyDetail> {
    const [summary, sigs, files, links, frozen, company, requests, activity, mails] = await Promise.all([
      this.apps.summary(app),
      this.apps.currentSignatures(app.id),
      this.apps.currentFiles(app.id),
      this.apps.consentLinks(app),
      this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>),
      this.apps.brand(app.companyId),
      this.db.select().from(dotApplicationChangeRequests).where(eq(dotApplicationChangeRequests.applicationId, app.id)).orderBy(desc(dotApplicationChangeRequests.requestedAt)),
      this.audit.forEntity(principal, 'dot_application', app.id),
      this.db
        .select()
        .from(emailMessages)
        .where(and(eq(emailMessages.companyId, app.companyId), eq(emailMessages.entityType, 'dot_application'), eq(emailMessages.entityId, app.id)))
        .orderBy(desc(emailMessages.createdAt)),
    ]);
    const sigKeys = new Set(sigs.map((s) => s.docKey));
    const approved = new Set(frozen.keys());
    return {
      ...summary,
      version: app.version,
      answers: app.answers as DotAppAnswers,
      ssnLast4: app.ssnLast4,
      bankLast4: app.bankSealed ? app.bankLast4 : null,
      templates: [...frozen.values()].map(toTemplate),
      templateVersions: app.templateVersions as Record<string, string>,
      signatures: sigs.map((s) => this.apps.signatureView(s)),
      uploads: files.map((f) => this.apps.uploadView(f)),
      employerForms: (app.employerForms ?? {}) as Record<string, unknown>,
      onboarding: (app.onboarding ?? {}) as Record<string, unknown>,
      employerChecklist: this.employerChecklist(app, sigKeys, approved),
      onboardingChecklist: this.onboardingChecklist(app, sigKeys, approved),
      changeRequests: requests.map((r) => ({
        id: r.id,
        sections: r.sections as DotAppStepId[],
        message: r.message,
        requestedAt: r.requestedAt.toISOString(),
        requestedByName: r.requestedByName,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      })),
      consentLinks: links,
      missing: await this.apps.missingFor(app),
      internalNote: app.internalNote,
      rejectedReason: app.rejectedReason,
      rosterDriverId: app.rosterDriverId,
      company,
      activity: activity.map((a) => ({ at: a.at.toISOString(), actor: a.actorName ?? 'System', action: a.action, detail: a.summary })),
      emails: mails.map((m) => ({ id: m.id, kind: m.kind, to: m.toAddress, status: m.status, at: m.createdAt.toISOString(), error: m.lastError })),
      permissions: { canReview: true, canHire: principal.permissions.has(SAFETY_REVIEW_PERMISSION) },
    };
  }

  private assertOpen(app: DotDriverApplicationRow): void {
    if (!['submitted', 'under_review', 'approved'].includes(app.status)) {
      throw conflict(`The application is ${app.status.replace('_', ' ')}; this cannot be changed now.`);
    }
  }

  /** The carrier-only sections. Version-checked; never returned to the driver. */
  async saveEmployerForms(principal: Principal, id: string, version: number, forms: Record<string, unknown>, field: 'employerForms' | 'onboarding'): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    if (field === 'employerForms') this.assertOpen(app);
    else if (!['approved', 'hired'].includes(app.status)) throw conflict('Onboarding opens after Safety approves the application.');
    if (JSON.stringify(forms).length > 128 * 1024) throw unprocessable('Too much data.');
    // The prospective employer's confidential fax number (SPH request) belongs to the company, not to
    // this application: it is kept on the company and shown on every later driver's SPH request.
    const confFax = field === 'employerForms' && typeof forms.sphConfFax === 'string' ? forms.sphConfFax.trim().slice(0, 40) : null;
    if (confFax !== null) {
      const [co] = await this.db.select({ fax: companies.sphConfidentialFax }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
      if ((co?.fax ?? '') !== confFax) {
        await this.db.update(companies).set({ sphConfidentialFax: confFax || null }).where(eq(companies.id, app.companyId));
        await this.audit.write(principal, {
          action: 'update',
          entityType: 'company',
          entityId: app.companyId,
          entityLabel: 'SPH confidential fax number',
          summary: 'Prospective employer’s confidential fax number (Safety Performance History requests) changed',
          changes: [{ field: 'sph_confidential_fax', old: co?.fax ?? null, new: confFax || null }],
        });
      }
    }
    const now = this.clock();
    const [updated] = await this.db
      .update(dotDriverApplications)
      .set({ [field]: forms, version: app.version + 1, updatedAt: now })
      .where(and(eq(dotDriverApplications.id, app.id), eq(dotDriverApplications.version, version)))
      .returning();
    if (!updated) throw conflict('Someone else saved this application meanwhile. Reload to see their changes.', { code: 'stale' });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'dot_application',
      entityId: app.id,
      entityLabel: app.candidateName,
      summary: field === 'employerForms' ? 'Employer forms saved' : 'Onboarding checklist saved',
      changes: [{ field, old: JSON.stringify(app[field]).slice(0, 4000), new: JSON.stringify(forms).slice(0, 4000) }],
    });
    return this.detailOf(principal, updated);
  }

  /** A carrier signature (emp_*): the reviewer signs on the Safety screen. */
  async employerSign(principal: Principal, id: string, input: DotAppSignInput, meta: { ip: string; userAgent: string | null }) {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    if (!(DOT_APP_EMPLOYER_SIGNATURES as readonly string[]).includes(input.key)) throw unprocessable('Not a carrier signature.');
    const onboarding = input.key === 'emp_training' || input.key === 'emp_training_driver';
    if (onboarding ? !['approved', 'hired'].includes(app.status) : !['submitted', 'under_review', 'approved'].includes(app.status)) {
      throw conflict('This signature cannot be given at this stage.');
    }
    const frozen = await this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>);
    // The driver's own signature on Driver Safety Training is drawn by the driver in person on this
    // screen: the signer is the driver (by name), witnessed by the signed-in Safety user.
    const inPerson = DOT_APP_IN_PERSON_DRIVER_SIGNATURES.includes(input.key);
    const answers = app.answers as DotAppAnswers;
    const driverName = [answers.personal?.firstName, answers.personal?.middleName, answers.personal?.lastName].filter(Boolean).join(' ').trim() || app.candidateName;
    const witness = principal.userName ?? principal.userId;
    const view = await this.apps.storeSignature(app, input, frozen, {
      role: inPerson ? 'driver' : 'employer',
      name: inPerson ? driverName : witness,
      userId: principal.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      title: inPerson ? `Driver, in person (witnessed by ${witness})` : (input.title ?? null),
    });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'dot_application',
      entityId: app.id,
      entityLabel: app.candidateName,
      summary: inPerson ? `Driver signed in person: ${input.key} (witnessed by ${witness})` : `Carrier signature: ${input.key}`,
    });
    return view;
  }

  /**
   * Request changes: the chosen sections reopen, their driver signatures are superseded (to be
   * signed again), and the driver is emailed a fresh link with the message.
   */
  async requestChanges(principal: Principal, id: string, sections: string[], message: string): Promise<DotAppSafetyDetail & { email: { status: string; error: string | null } }> {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    this.assertOpen(app);
    if (app.status === 'approved') throw conflict('The application is approved; changes are no longer requested from the driver.');
    const steps = sections.filter((s): s is DotAppStepId => (DOT_APP_STEP_IDS as readonly string[]).includes(s) && s !== 'review');
    if (steps.length === 0) throw unprocessable('Choose at least one section.');
    const now = this.clock();
    const answers = app.answers as DotAppAnswers;
    const frozen = await this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>);
    const links = await this.apps.consentLinks(app);
    const ctx = { approvedDocs: new Set(frozen.keys()), consentLinks: new Set(links.map((l) => l.link)), today: easternToday(now) };
    const reSign = new Set<string>(['app_signature']);
    for (const s of steps) for (const k of dotAppSignaturesFor(s, answers, ctx)) reSign.add(k);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.max(now.getTime() + 7 * 86_400_000, now.getTime()));
    const email = app.candidateEmail ?? '';
    await this.db.transaction(async (tx) => {
      await tx.insert(dotApplicationChangeRequests).values({
        id: `dcr_${crypto.randomUUID()}`,
        companyId: app.companyId,
        applicationId: app.id,
        sections: steps,
        message,
        requestedByUserId: principal.userId,
        requestedByName: principal.userName ?? principal.userId,
      });
      await tx
        .update(dotApplicationSignatures)
        .set({ supersededAt: now, supersededReason: 'Changes requested by Safety' })
        .where(and(eq(dotApplicationSignatures.applicationId, app.id), inArray(dotApplicationSignatures.docKey, [...reSign]), isNull(dotApplicationSignatures.supersededAt), eq(dotApplicationSignatures.signerRole, 'driver')));
      await tx.update(dotDriverApplications).set({ status: 'changes_requested', version: app.version + 1, updatedAt: now }).where(eq(dotDriverApplications.id, app.id));
      const old = await tx
        .update(dotApplicationLinks)
        .set({ revokedAt: now, revokedByName: principal.userName ?? principal.userId, revokedReason: 'Replaced (changes requested)' })
        .where(and(eq(dotApplicationLinks.applicationId, app.id), isNull(dotApplicationLinks.revokedAt)))
        .returning({ id: dotApplicationLinks.id });
      for (const l of old) await tx.update(dotApplicationSessions).set({ endedAt: now }).where(eq(dotApplicationSessions.linkId, l.id));
      await tx.insert(dotApplicationLinks).values({
        id: `dal_${crypto.randomUUID()}`,
        companyId: app.companyId,
        applicationId: app.id,
        tokenHash: sha256(token),
        email,
        expiresAt,
        createdByUserId: principal.userId,
        createdByName: principal.userName ?? principal.userId,
      });
    });
    const url = `${env.PUBLIC_APP_BASE_URL.replace(/\/+$/, '')}/application/#token=${token}`;
    const company = await this.apps.brand(app.companyId);
    const msg = changesEmail({
      firstName: answers.personal?.firstName ?? app.candidateName.split(/\s+/)[0] ?? '',
      company: company.name,
      url,
      message,
      sections: steps.map((s) => DOT_APP_STEP_TITLES[s]),
      expiresAt,
      zone: 'America/New_York',
    });
    const sent = email
      ? await this.email.send({ companyId: app.companyId, kind: 'application_changes', sender: 'recruiting', to: email, subject: msg.subject, text: msg.text, html: msg.html, entityType: 'dot_application', entityId: app.id, actorName: principal.userName })
      : { status: 'skipped' as const, error: 'No email on file', id: '', messageId: null };
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'dot_application',
      entityId: app.id,
      entityLabel: app.candidateName,
      summary: `Changes requested (${steps.map((s) => DOT_APP_STEP_TITLES[s]).join(', ')}); ${reSign.size} signature(s) to sign again; email ${sent.status}`,
      reason: message,
    });
    return { ...(await this.detailOf(principal, await this.row(principal, id))), email: { status: sent.status, error: sent.error } };
  }

  async approve(principal: Principal, id: string, note?: string): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    if (!['submitted', 'under_review'].includes(app.status)) throw conflict('Only a submitted application under review can be approved.');
    const [sigs, frozen] = await Promise.all([this.apps.currentSignatures(app.id), this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>)]);
    const open = this.employerChecklist(app, new Set(sigs.map((s) => s.docKey)), new Set(frozen.keys())).filter((x) => !x.done);
    if (open.length) throw conflict(`Complete the employer forms first: ${open.map((x) => x.title).join(' · ')}.`, { code: 'employer_forms', open });
    const missing = await this.apps.missingFor(app);
    if (missing.length) throw conflict(`The application is not complete (${missing.length} item(s)); request changes from the driver.`, { code: 'incomplete' });
    const now = this.clock();
    const [updated] = await this.db
      .update(dotDriverApplications)
      .set({ status: 'approved', approvedAt: now, approvedByUserId: principal.userId, approvedByName: principal.userName ?? principal.userId, internalNote: note ?? app.internalNote, version: app.version + 1, updatedAt: now })
      .where(and(eq(dotDriverApplications.id, app.id), eq(dotDriverApplications.version, app.version)))
      .returning();
    if (!updated) throw conflict('Someone else changed this application meanwhile. Reload and try again.', { code: 'stale' });
    await this.audit.write(principal, { action: 'approve', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Safety approved the application', reason: note ?? null });
    return this.detailOf(principal, updated);
  }

  async reject(principal: Principal, id: string, reason: string): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    if (['hired', 'rejected'].includes(app.status)) throw conflict(`The application is already ${app.status}.`);
    const now = this.clock();
    const [updated] = await this.db
      .update(dotDriverApplications)
      .set({ status: 'rejected', rejectedAt: now, rejectedByName: principal.userName ?? principal.userId, rejectedReason: reason, version: app.version + 1, updatedAt: now })
      .where(eq(dotDriverApplications.id, app.id))
      .returning();
    await this.db
      .update(dotApplicationLinks)
      .set({ revokedAt: now, revokedByName: principal.userName ?? principal.userId, revokedReason: 'Application rejected' })
      .where(and(eq(dotApplicationLinks.applicationId, app.id), isNull(dotApplicationLinks.revokedAt)));
    await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Safety rejected the application', reason });
    return this.detailOf(principal, updated!);
  }

  /**
   * Hire: one transaction. Reuses the reserved driver id; creates (or activates) the Fleet → Drivers
   * row — not an HR employee — and files the CDL, medical card and the signed application PDF into
   * the driver's qualification file. Idempotent: a second Hire returns the same driver.
   */
  async hire(principal: Principal, id: string, input: DotAppHireInput): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    let app = await this.row(principal, id);
    if (app.status === 'hired' && app.rosterDriverId) return this.detailOf(principal, app);
    if (app.status !== 'approved') throw conflict('Hire comes after Safety approves the application.');
    const [sigs, frozen] = await Promise.all([this.apps.currentSignatures(app.id), this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>)]);
    const open = this.onboardingChecklist(app, new Set(sigs.map((s) => s.docKey)), new Set(frozen.keys())).filter((x) => !x.done);
    if (open.length) throw conflict(`Complete onboarding first: ${open.map((x) => x.title).join(' · ')}.`, { code: 'onboarding', open });
    if (!app.driverId && app.hiringCaseId) {
      const reserved = await this.driversService.reserveDriverIdFor(principal, app.hiringCaseId);
      await this.db.update(dotDriverApplications).set({ driverId: reserved.id }).where(eq(dotDriverApplications.id, app.id));
      app = await this.row(principal, id);
    }
    const driverId = app.driverId;
    if (!driverId) throw conflict('No reserved driver id on this application.');
    const answers = app.answers as DotAppAnswers;
    const lic = (answers.licenses ?? []).find((l) => l.current === 'Yes') ?? answers.licenses?.[0] ?? {};
    const files = await this.apps.currentFiles(app.id);
    // The signed application as a PDF, stored before the transaction (bytes are not transactional;
    // an unused file is harmless, a missing one would not be).
    const company = await this.apps.brand(app.companyId);
    const pdf = await applicationPdf({ app, company, signatures: sigs, templates: frozen, storage: this.storage });
    const pdfKey = `dot-application/${app.companyId}/${app.id}/application-${app.version}.pdf`;
    await this.storage.put(pdfKey, pdf);
    const now = this.clock();
    const at = easternToday(now);
    const driverNumber = `D-${driverId.replace(/^drv_/, '')}`;
    const name = { first: answers.personal?.firstName?.trim() || app.candidateName.split(/\s+/)[0] || 'Driver', last: answers.personal?.lastName?.trim() || app.candidateName.split(/\s+/).slice(1).join(' ') || '-' };
    const done = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(dotDriverApplications).where(eq(dotDriverApplications.id, app.id)).for('update');
      if (!locked) throw notFound();
      if (locked.status === 'hired' && locked.rosterDriverId) return locked;
      if (locked.status !== 'approved') throw conflict('Hire comes after Safety approves the application.');
      const [existing] = await tx.select().from(drivers).where(eq(drivers.id, driverId)).for('update');
      if (existing && existing.companyId !== app.companyId) throw conflict('The reserved driver id belongs to another company.');
      if (existing) {
        // Activate the existing profile (e.g. a board-only row made before the file).
        await tx.update(drivers).set({ status: existing.status === 'terminated' ? 'off_duty' : existing.status, updatedAt: now }).where(eq(drivers.id, driverId));
      } else {
        const email = (answers.personal?.email ?? app.candidateEmail ?? '').trim().toLowerCase();
        await tx.insert(drivers).values({
          id: driverId,
          companyId: app.companyId,
          driverNumber,
          employeeId: null,
          firstName: name.first,
          lastName: name.last,
          phone: (answers.personal?.phone ?? '').trim(),
          email,
          driverType: input.driverType,
          cdlState: (lic.authority ?? '').trim().toUpperCase().slice(0, 2) || 'NA',
          cdlClass: /\bB\b|Class B/i.test(lic.cls ?? '') ? 'B' : 'A',
          cdlEndorsements: [],
          cdlExpiresOn: lic.exp && /^\d{4}-\d{2}-\d{2}$/.test(lic.exp) ? lic.exp : at,
          cdlStatus: 'verified',
          medicalCardExpiresOn: lic.med && /^\d{4}-\d{2}-\d{2}$/.test(lic.med) ? lic.med : null,
          medicalCardStatus: lic.med ? 'verified' : 'missing',
          dateOfBirth: answers.personal?.dob && /^\d{4}-\d{2}-\d{2}$/.test(answers.personal.dob) ? answers.personal.dob : null,
          hireDate: input.hireDate,
          status: 'off_duty',
          dispatcherId: input.dispatcherId,
          dispatcherName: 'Unassigned',
          currentTruckId: null,
          currentTrailerId: null,
          homeCity: (answers.personal?.address?.city ?? '').trim() || 'Unknown',
          homeState: (answers.personal?.address?.state ?? '').trim().toUpperCase().slice(0, 2) || 'NA',
          safetyScore: '100',
          safetyEvents30d: 0,
          payPlanKind: input.payPlanKind,
          payPlanRate: String(input.payPlanRate),
          preferredLanguage: input.preferredLanguage,
        });
      }
      // The qualification file: the driver's documents, pending Safety's own verification there.
      const label = `${name.first} ${name.last}`;
      const code: Record<string, string> = { cdl_front: 'cdl', cdl_back: 'cdl_back', med_card: 'medical_card' };
      const docs = files
        .filter((f) => code[f.slot])
        .map((f) => ({
          id: `cdoc_${crypto.randomUUID()}`,
          companyId: app.companyId,
          ownerType: 'driver',
          ownerId: driverId,
          ownerLabel: label,
          requirementCode: code[f.slot]!,
          title: `${f.slot === 'med_card' ? 'DOT medical card' : f.slot === 'cdl_back' ? 'CDL — back' : 'CDL — front'} (DOT application)`,
          fileName: f.fileName,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          storageKey: f.storageKey,
          expiresOn: f.slot === 'med_card' ? (lic.med ?? null) : lic.exp ?? null,
          status: 'pending_review',
          source: 'public_link',
          uploadedBy: 'Driver (DOT application)',
          containsPii: true,
          sourceSystem: 'dot_application_v2',
          externalId: f.id,
        }));
      docs.push({
        id: `cdoc_${crypto.randomUUID()}`,
        companyId: app.companyId,
        ownerType: 'driver',
        ownerId: driverId,
        ownerLabel: label,
        requirementCode: 'dot_application',
        title: 'DOT driver application (signed)',
        fileName: `DOT-application-${driverNumber}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: pdf.length,
        storageKey: pdfKey,
        expiresOn: null,
        status: 'verified',
        source: 'public_link',
        uploadedBy: principal.userName ?? principal.userId,
        containsPii: true,
        sourceSystem: 'dot_application_v2',
        externalId: app.id,
      });
      // Re-running never files twice (the external id identifies each file).
      const already = await tx
        .select({ externalId: complianceDocuments.externalId })
        .from(complianceDocuments)
        .where(and(eq(complianceDocuments.companyId, app.companyId), eq(complianceDocuments.sourceSystem, 'dot_application_v2'), eq(complianceDocuments.ownerId, driverId)));
      const seen = new Set(already.map((r) => r.externalId));
      const fresh = docs.filter((d) => !seen.has(d.externalId));
      if (fresh.length) await tx.insert(complianceDocuments).values(fresh);
      const [row] = await tx
        .update(dotDriverApplications)
        .set({ status: 'hired', hiredAt: now, hiredByName: principal.userName ?? principal.userId, rosterDriverId: driverId, version: locked.version + 1, updatedAt: now })
        .where(eq(dotDriverApplications.id, app.id))
        .returning();
      if (app.hiringCaseId) {
        await tx.update(hiringCases).set({ driverId, hiredAt: now, updatedAt: now }).where(and(eq(hiringCases.companyId, app.companyId), eq(hiringCases.id, app.hiringCaseId)));
      }
      return row!;
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver',
      entityId: driverId,
      entityLabel: `${name.first} ${name.last}`,
      summary: `Hired from the DOT application: Fleet → Drivers ${driverNumber} under the reserved id; CDL, medical card and the signed application filed`,
    });
    await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: `Hired as ${driverNumber}` });
    return this.detailOf(principal, done);
  }

  async saveNote(principal: Principal, id: string, note: string): Promise<DotAppSafetyDetail> {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    const [updated] = await this.db.update(dotDriverApplications).set({ internalNote: note, updatedAt: this.clock() }).where(eq(dotDriverApplications.id, app.id)).returning();
    await this.audit.write(principal, { action: 'update', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Safety review note saved' });
    return this.detailOf(principal, updated!);
  }

  async fileBytes(principal: Principal, id: string, fileId: string) {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    const [f] = await this.db.select().from(dotApplicationFiles).where(and(eq(dotApplicationFiles.applicationId, app.id), eq(dotApplicationFiles.id, fileId))).limit(1);
    if (!f) throw notFound();
    await this.audit.write(principal, { action: 'view', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: `Opened upload ${f.slot} (${f.fileName})` });
    return { bytes: await this.storage.get(f.storageKey), contentType: f.contentType, fileName: f.fileName };
  }

  async signatureImage(principal: Principal, id: string, key: string) {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    const [s] = await this.db
      .select()
      .from(dotApplicationSignatures)
      .where(and(eq(dotApplicationSignatures.applicationId, app.id), eq(dotApplicationSignatures.docKey, key), isNull(dotApplicationSignatures.supersededAt)))
      .limit(1);
    if (!s) throw notFound();
    return { bytes: await this.storage.get(s.imageStorageKey), contentType: 'image/png', fileName: `${key}.png` };
  }

  async pdf(principal: Principal, id: string) {
    this.assertReview(principal);
    const app = await this.row(principal, id);
    const [sigs, frozen, company] = await Promise.all([this.apps.currentSignatures(app.id), this.templates.frozen(app.companyId, app.templateVersions as Record<string, string>), this.apps.brand(app.companyId)]);
    const bytes = await applicationPdf({ app, company, signatures: sigs, templates: frozen, storage: this.storage });
    await this.audit.write(principal, { action: 'export', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Application PDF downloaded' });
    return { bytes, contentType: 'application/pdf', fileName: `DOT-application-${app.candidateName.replace(/[^\w-]+/g, '_')}.pdf` };
  }

  /** The ACH debit routing + account numbers: restricted code, audited (like the SSN). */
  async revealBank(principal: Principal, id: string): Promise<{ routing: string; account: string }> {
    if (!principal.permissions.has(SSN_PERMISSION)) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Seeing bank numbers needs the restricted qualification records permission.' });
    const app = await this.row(principal, id);
    if (!app.bankSealed) throw notFound();
    const bank = JSON.parse(decrypt(app.bankSealed as SealedCredential, 'pii')) as { routing: string; account: string };
    await this.audit.write(principal, { action: 'view', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'ACH bank numbers shown' });
    return { routing: bank.routing, account: bank.account };
  }

  async revealSsn(principal: Principal, id: string): Promise<{ ssn: string }> {
    if (!principal.permissions.has(SSN_PERMISSION)) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Seeing the full SSN needs the restricted qualification records permission.' });
    const app = await this.row(principal, id);
    if (!app.ssnSealed) throw notFound();
    const digits = decrypt(app.ssnSealed as SealedCredential, 'pii');
    await this.audit.write(principal, { action: 'view', entityType: 'dot_application', entityId: app.id, entityLabel: app.candidateName, summary: 'Full SSN shown' });
    return { ssn: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` };
  }
}
