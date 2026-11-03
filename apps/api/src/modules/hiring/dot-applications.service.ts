import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  DotApplicationDraftFormSchema,
  DotApplicationFormSchema,
  dotApplicationProblems,
  checkDotApplication,
  employersToVerify,
  type DotApplication,
  type DotApplicationForm,
  type SaveDotApplicationInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  hiringCases,
  hiringDotApplications,
  type HiringCaseRow,
  type HiringDotApplicationRow,
} from '../../database/schema/hiring';
import { companies } from '../../database/schema/roster';
import { decrypt, encrypt, type SealedCredential } from '../admin/credential-vault';
import { ComplianceService } from '../compliance/compliance.service';
import { ConsentsService } from '../compliance/consents.service';
import { VerificationService } from '../compliance/verification.service';
import { RecruitingService } from '../hr/recruiting.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { renderDotApplicationPdf } from './dot-application-pdf';
import { HiringService } from './hiring.service';

/**
 * The DOT application behind a hiring case.
 *
 * Saving keeps the answers. Submitting is the event: it reserves the driver id the qualification
 * file will be keyed by, renders the PDF, files it as the case's `dot_application` document
 * through the same upload path a scanned CDL takes, opens the verification case, drafts one
 * previous-employer verification consent per DOT-regulated employer listed, and links the hiring
 * case to all of it. From then on the funnel's middle is derived from the file.
 *
 * Nothing in the qualification file is copied here. The row points at the document and the case;
 * the consents point at the driver id. The social security number is sealed and decrypted once,
 * to print, and the API only ever returns its last four digits.
 */
@Injectable()
export class DotApplicationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly consents: ConsentsService,
    private readonly verification: VerificationService,
    private readonly hiring: HiringService,
    private readonly drivers: DriversService,
    private readonly recruiting: RecruitingService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private toRecord(row: HiringDotApplicationRow, hiringCase: HiringCaseRow): DotApplication {
    return {
      id: row.id,
      hiringCaseId: row.hiringCaseId,
      applicantId: row.applicantId,
      // 'submitting' is the claim a submission holds while it files; to the reader it is what it
      // was before: a draft, or the driver's certified submission waiting for review.
      status: (row.status === 'submitted'
        ? 'submitted'
        : row.status === 'driver_submitted' || (row.status === 'submitting' && row.certifiedSnapshot)
          ? 'driver_submitted'
          : 'draft') as DotApplication['status'],
      // A draft may still have blanks; the submitted form passed the full contract.
      form: DotApplicationDraftFormSchema.parse(row.form) as DotApplicationForm,
      ssnLast4: row.ssnLast4,
      documentId: row.documentId,
      driverId: hiringCase.driverId,
      verificationCaseId: hiringCase.verificationCaseId,
      consentIds: Array.isArray(row.consentIds) ? (row.consentIds as string[]) : [],
      submittedAt: row.submittedAt?.toISOString() ?? null,
      submittedBy: row.submittedBy,
      submittedVia: row.submittedVia,
      certifiedAt: row.certifiedAt?.toISOString() ?? null,
      certifiedName: row.certifiedName,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy,
      returnedAt: row.returnedAt?.toISOString() ?? null,
      returnedBy: row.returnedBy,
      returnNote: row.returnNote,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async caseRow(principal: Principal, caseId: string): Promise<HiringCaseRow> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, caseId)))
      .limit(1);
    if (!row)
      throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${caseId}` });
    if (!row.applicantId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          'This case predates the funnel and has no candidate record; its application is on the paper file.',
      });
    }
    return row;
  }

  private async row(caseId: string): Promise<HiringDotApplicationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, caseId))
      .limit(1);
    return row;
  }

  /** The application for a case, or null when none has been started. */
  async get(principal: Principal, caseId: string): Promise<DotApplication | null> {
    const hiringCase = await this.caseRow(principal, caseId);
    const row = await this.row(caseId);
    return row ? this.toRecord(row, hiringCase) : null;
  }

  /**
   * Creates or updates the draft. The SSN is sealed when given; `null` clears it; leaving it out
   * keeps whatever is sealed. A submitted application is read-only: the PDF on file is what the
   * applicant signed.
   */
  async save(
    principal: Principal,
    caseId: string,
    input: SaveDotApplicationInput,
    options: { at?: Date } = {},
  ): Promise<DotApplication> {
    const hiringCase = await this.caseRow(principal, caseId);
    const existing = await this.row(caseId);
    if (existing?.status === 'submitted' || existing?.status === 'submitting' || existing?.status === 'driver_submitted') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          existing.status === 'submitted'
            ? 'The application was submitted and is on file; it can no longer be edited.'
            : existing.status === 'driver_submitted'
              ? 'The driver certified and submitted this application. Accept it, or return it to the driver to change it.'
              : 'The application is being submitted right now; refresh in a moment.',
      });
    }
    const { ssn, ...formInput } = input;
    // Drafts may be incomplete (owner, 2026-09-30); submission applies the full contract.
    const form = DotApplicationDraftFormSchema.parse(formInput);
    const at = options.at ?? new Date();
    const sealed: Partial<Pick<HiringDotApplicationRow, 'ssnSealed' | 'ssnLast4'>> =
      ssn === undefined
        ? {}
        : ssn === null
          ? { ssnSealed: null, ssnLast4: null }
          : { ssnSealed: encrypt(ssn.replace(/-/g, ''), 'pii'), ssnLast4: ssn.slice(-4) };

    if (existing) {
      await this.db
        .update(hiringDotApplications)
        .set({ form, ...sealed, updatedAt: at })
        .where(eq(hiringDotApplications.id, existing.id));
    } else {
      await this.db.insert(hiringDotApplications).values({
        id: `dot_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        hiringCaseId: caseId,
        applicantId: hiringCase.applicantId as string,
        status: 'draft',
        form,
        ssnSealed: sealed.ssnSealed ?? null,
        ssnLast4: sealed.ssnLast4 ?? null,
        createdAt: at,
        updatedAt: at,
      });
    }
    const saved = (await this.row(caseId)) as HiringDotApplicationRow;
    return this.toRecord(saved, hiringCase);
  }

  /**
   * The full contract and 49 CFR 391.21, as of `at`. Refused with the outstanding issues named,
   * each pinned to its section, so the form can point at them.
   */
  private validated(raw: unknown, at: Date): DotApplicationForm {
    const strict = DotApplicationFormSchema.safeParse(raw);
    if (!strict.success) {
      const issues = dotApplicationProblems(DotApplicationDraftFormSchema.parse(raw), at);
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `The application is not complete: ${issues.map((i) => i.detail).join('; ')}`,
        extensions: { issues },
      });
    }
    const issues = checkDotApplication(strict.data, at);
    if (issues.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `The application is not complete: ${issues.map((i) => i.detail).join('; ')}`,
        extensions: { issues },
      });
    }
    return strict.data;
  }

  /**
   * Submits the application. Refused with the outstanding issues named until the form satisfies
   * 391.21; then it files the PDF, opens the verification case and drafts the employer consents.
   */
  async submit(
    principal: Principal,
    caseId: string,
    options: { at?: Date } = {},
  ): Promise<DotApplication> {
    const hiringCase = await this.caseRow(principal, caseId);
    const existing = await this.row(caseId);
    if (!existing) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Nothing has been recorded yet.',
      });
    }
    if (existing.status === 'submitted') return this.toRecord(existing, hiringCase);
    if (existing.status === 'driver_submitted') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The driver certified and submitted this application. Accept it, or return it to the driver.',
      });
    }

    // The wall clock, like every other write: the applicant signed today, and "the last three
    // years" is counted back from the day of submission.
    const at = options.at ?? new Date();
    const form = this.validated(existing.form, at);

    /*
     * The claim. Two presses of Submit (or a retry racing the first) must file one PDF, open one
     * verification case and draft one set of consents. Only the request that moves the row from
     * draft to 'submitting' goes on; the other gets the finished filing or a conflict. A claim
     * older than five minutes is a crashed submission and may be taken over — but never one an
     * Accept of the driver's certified submission holds.
     */
    const [claimed] = await this.db
      .update(hiringDotApplications)
      .set({ status: 'submitting', updatedAt: at })
      .where(
        and(
          eq(hiringDotApplications.id, existing.id),
          or(
            eq(hiringDotApplications.status, 'draft'),
            and(
              eq(hiringDotApplications.status, 'submitting'),
              isNull(hiringDotApplications.certifiedSnapshot),
              lt(hiringDotApplications.updatedAt, new Date(at.getTime() - 5 * 60_000)),
            ),
          ),
        ),
      )
      .returning({ id: hiringDotApplications.id });
    if (!claimed) {
      const now = await this.row(caseId);
      if (now?.status === 'submitted') return this.toRecord(now, await this.caseRow(principal, caseId));
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The application is being submitted right now; refresh in a moment.',
      });
    }
    try {
      return await this.file(principal, caseId, hiringCase, existing, form, at);
    } catch (error) {
      await this.db
        .update(hiringDotApplications)
        .set({ status: 'draft' })
        .where(and(eq(hiringDotApplications.id, existing.id), eq(hiringDotApplications.status, 'submitting')));
      throw error;
    }
  }

  /**
   * The driver's Submit through the link (owner, 2026-10-07): their certification, never blocked by
   * the recruiter. The same checks as a desk submission; then the moment, the typed name and the
   * exact answers are frozen and the application waits for a recruiter. Nothing is filed: no driver
   * id, no PDF, no verification case, no consents, until a recruiter accepts it.
   */
  async driverSubmit(principal: Principal, caseId: string, options: { at?: Date } = {}): Promise<DotApplication> {
    const hiringCase = await this.caseRow(principal, caseId);
    const existing = await this.row(caseId);
    if (!existing) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Nothing has been saved yet.' });
    }
    if (existing.status === 'driver_submitted' || existing.status === 'submitted') {
      return this.toRecord(existing, hiringCase);
    }
    const at = options.at ?? new Date();
    const form = this.validated(existing.form, at);
    const [claimed] = await this.db
      .update(hiringDotApplications)
      .set({
        status: 'driver_submitted',
        form,
        submittedVia: 'driver_link',
        certifiedAt: at,
        certifiedName: form.certifiedName,
        certifiedSnapshot: form,
        updatedAt: at,
      })
      .where(and(eq(hiringDotApplications.id, existing.id), eq(hiringDotApplications.status, 'draft')))
      .returning({ id: hiringDotApplications.id });
    if (!claimed) {
      const now = await this.row(caseId);
      if (now && (now.status === 'driver_submitted' || now.status === 'submitted')) return this.toRecord(now, hiringCase);
      throw new AppError({ status: 409, title: 'Conflict', detail: 'The application changed meanwhile; refresh and try again.' });
    }
    await this.audit.write(principal, {
      action: 'dot_application_certified',
      entityType: 'applicant',
      entityId: hiringCase.applicantId as string,
      entityLabel: hiringCase.candidateName,
      summary: `${form.certifiedName} certified and submitted the DOT application through the link; waiting for a recruiter's review`,
      changes: [
        { field: 'dot_application', old: 'draft', new: 'driver_submitted' },
        { field: 'certified_at', old: null, new: at.toISOString() },
        { field: 'certified_name', old: null, new: form.certifiedName },
      ],
      at,
    });
    return this.toRecord((await this.row(caseId)) as HiringDotApplicationRow, hiringCase);
  }

  /**
   * A recruiter accepts the driver's certified submission: the frozen answers — never the live
   * draft — are filed exactly as a desk submission would be, with the driver's certification time
   * printed on the PDF and who accepted it recorded.
   */
  async accept(principal: Principal, caseId: string, options: { at?: Date } = {}): Promise<DotApplication> {
    const hiringCase = await this.caseRow(principal, caseId);
    const existing = await this.row(caseId);
    if (existing?.status === 'submitted') return this.toRecord(existing, hiringCase);
    if (!existing || existing.status !== 'driver_submitted' || !existing.certifiedSnapshot || !existing.certifiedAt) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'There is no driver submission waiting for review.',
      });
    }
    const at = options.at ?? new Date();
    // Re-read through the full contract: the snapshot passed it when the driver certified.
    const form = DotApplicationFormSchema.parse(existing.certifiedSnapshot);
    const [claimed] = await this.db
      .update(hiringDotApplications)
      .set({ status: 'submitting', updatedAt: at })
      .where(and(eq(hiringDotApplications.id, existing.id), eq(hiringDotApplications.status, 'driver_submitted')))
      .returning({ id: hiringDotApplications.id });
    if (!claimed) {
      const now = await this.row(caseId);
      if (now?.status === 'submitted') return this.toRecord(now, await this.caseRow(principal, caseId));
      throw new AppError({ status: 409, title: 'Conflict', detail: 'The application is being accepted right now; refresh in a moment.' });
    }
    try {
      return await this.file(principal, caseId, hiringCase, existing, form, at, {
        certifiedAt: existing.certifiedAt,
        certifiedName: existing.certifiedName ?? form.certifiedName,
      });
    } catch (error) {
      await this.db
        .update(hiringDotApplications)
        .set({ status: 'driver_submitted' })
        .where(and(eq(hiringDotApplications.id, existing.id), eq(hiringDotApplications.status, 'submitting')));
      throw error;
    }
  }

  /**
   * Sends the driver's submission back with a note. The certification moves into the history —
   * kept, never deleted — and the driver must certify again; the answers stay for them to fix.
   */
  async returnToDriver(principal: Principal, caseId: string, note: string, options: { at?: Date } = {}): Promise<DotApplication> {
    const hiringCase = await this.caseRow(principal, caseId);
    const existing = await this.row(caseId);
    if (!existing || existing.status !== 'driver_submitted') {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'There is no driver submission waiting for review.' });
    }
    const at = options.at ?? new Date();
    const by = principal.userName ?? principal.userId;
    const history = Array.isArray(existing.certificationHistory) ? (existing.certificationHistory as unknown[]) : [];
    const entry = {
      certifiedAt: existing.certifiedAt?.toISOString() ?? null,
      certifiedName: existing.certifiedName,
      submittedVia: existing.submittedVia,
      snapshot: existing.certifiedSnapshot,
      returnedAt: at.toISOString(),
      returnedBy: by,
      note,
    };
    const draft = DotApplicationDraftFormSchema.parse(existing.form);
    const [moved] = await this.db
      .update(hiringDotApplications)
      .set({
        status: 'draft',
        // They sign again: the typed name and date are cleared, the answers are kept.
        form: { ...draft, certifiedName: null, certifiedOn: null },
        certifiedAt: null,
        certifiedName: null,
        certifiedSnapshot: null,
        submittedVia: null,
        certificationHistory: [...history, entry],
        returnedAt: at,
        returnedBy: by,
        returnNote: note,
        updatedAt: at,
      })
      .where(and(eq(hiringDotApplications.id, existing.id), eq(hiringDotApplications.status, 'driver_submitted')))
      .returning({ id: hiringDotApplications.id });
    if (!moved) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'The application changed meanwhile; refresh and try again.' });
    }
    await this.audit.write(principal, {
      action: 'dot_application_returned',
      entityType: 'applicant',
      entityId: hiringCase.applicantId as string,
      entityLabel: hiringCase.candidateName,
      summary: `DOT application returned to the driver: ${note}`,
      reason: note,
      changes: [
        { field: 'dot_application', old: 'driver_submitted', new: 'draft' },
        { field: 'certified_at', old: entry.certifiedAt, new: null },
        { field: 'certified_name', old: entry.certifiedName, new: null },
      ],
      at,
    });
    return this.toRecord((await this.row(caseId)) as HiringDotApplicationRow, hiringCase);
  }

  /** Files the claimed application: the PDF, the verification case and the employer consents. */
  private async file(
    principal: Principal,
    caseId: string,
    hiringCase: HiringCaseRow,
    existing: HiringDotApplicationRow,
    form: DotApplicationForm,
    at: Date,
    /** Set when a recruiter accepts the driver's own certified submission (the link). */
    driver?: { certifiedAt: Date; certifiedName: string | null },
  ): Promise<DotApplication> {
    const acceptedBy = principal.userName ?? principal.userId;
    const applicant = await this.recruiting.getApplicant(
      principal,
      hiringCase.applicantId as string,
    );
    const [company] = await this.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, principal.companyId))
      .limit(1);
    const driverName = `${form.legalFirstName} ${form.legalLastName}`;

    // The file's key, reserved atomically and written onto the case. A case whose driver is
    // already known (an import) keeps that key.
    const driverId = (await this.drivers.reserveDriverIdFor(principal, caseId)).id;

    const bytes = await renderDotApplicationPdf({
      companyName: company?.name ?? principal.companyId,
      applicantNumber: applicant.applicantNumber,
      form,
      ssn: existing.ssnSealed ? decrypt(existing.ssnSealed as SealedCredential, 'pii') : null,
      generatedAt: at,
      electronic: driver
        ? { certifiedAt: driver.certifiedAt, certifiedName: driver.certifiedName, acceptedBy, acceptedAt: at }
        : undefined,
    });

    const { document } = await this.compliance.upload(principal, {
      ownerType: 'driver',
      ownerId: driverId,
      ownerLabel: driverName,
      requirementCode: 'dot_application',
      title: 'DOT employment application',
      fileName: `dot-application-${applicant.applicantNumber}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      issuedOn: form.certifiedOn,
      expiresOn: null,
      source: driver ? 'public_link' : 'staff',
      notes: driver
        ? `Certified by the driver through the link; accepted by ${acceptedBy}`
        : `Recorded from candidate ${applicant.applicantNumber}`,
      bytes,
      at,
    });

    const verificationCase = await this.verification.open(principal, { driverId, driverName, at });
    await this.hiring.linkVerificationCase(principal.companyId, caseId, {
      driverId,
      verificationCaseId: verificationCase.id,
    });

    const consentIds: string[] = [];
    for (const employer of employersToVerify(form, at)) {
      const consent = await this.consents.create(principal, {
        driverId,
        purpose: 'employment_verification',
        subject: employer.employer,
        at,
      });
      consentIds.push(consent.id);
    }

    await this.db
      .update(hiringDotApplications)
      .set({
        status: 'submitted',
        documentId: document.id,
        consentIds,
        // A driver's submission keeps the moment they certified it, and their name.
        submittedAt: driver ? driver.certifiedAt : at,
        submittedBy: driver ? `${driver.certifiedName ?? driverName} (driver link)` : acceptedBy,
        ...(driver ? { reviewedAt: at, reviewedBy: acceptedBy } : {}),
        updatedAt: at,
      })
      .where(eq(hiringDotApplications.id, existing.id));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'applicant',
      entityId: applicant.id,
      entityLabel: applicant.name,
      summary: driver
        ? `DOT application the driver certified through the link accepted by ${acceptedBy}; filed as ${document.id} under ${driverId}, ${consentIds.length} employer verification${consentIds.length === 1 ? '' : 's'} drafted`
        : `DOT application submitted; filed as ${document.id} under ${driverId}, ${consentIds.length} employer verification${consentIds.length === 1 ? '' : 's'} drafted`,
      changes: [{ field: 'dot_application', old: driver ? 'driver_submitted' : 'draft', new: 'submitted' }],
      at,
    });

    // The case's stage now comes from the file it was just given.
    await this.hiring.resync(principal.companyId, caseId);

    const [refreshed] = await this.db
      .select()
      .from(hiringCases)
      .where(eq(hiringCases.id, caseId))
      .limit(1);
    return this.toRecord(
      (await this.row(caseId)) as HiringDotApplicationRow,
      refreshed as HiringCaseRow,
    );
  }
}
