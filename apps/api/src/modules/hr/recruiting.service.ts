import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, not, or, sql } from 'drizzle-orm';
import {
  ACTIVE_APPLICANT_STAGES,
  JOB_OPENING_TRANSITIONS,
  OFFER_TRANSITIONS,
  TERMINAL_APPLICANT_STAGES,
  type ApplicantRecord,
  type ApplicantStage,
  type CreateApplicantRequest,
  type CreateInterviewRequest,
  type CreateJobOpeningRequest,
  type CreateOfferRequest,
  type HireApplicantRequest,
  type HireResult,
  type InterviewRecord,
  type JobOpeningRecord,
  type JobOpeningStatus,
  type MoveApplicantStageRequest,
  type OfferRecord,
  type OfferStatus,
  type RecruitingQuery,
  type RecruitingSummary,
  type UpdateApplicantRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { hiringCases } from '../../database/schema/hiring';
import { applicants, interviews, jobOpenings, offers } from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';
import { EmployeesService } from '../people/employees.service';
import { OnboardingService } from './onboarding.service';
import { nextNumber, num, retryOnDuplicate, today, assertCompanyRefs, employeeRef } from './hr.util';

/** A driver case still in the running for a seat: from the first call up to orientation. */
const DRIVER_CASE_ACTIVE_STATES = [
  'lead',
  'prequalified',
  'application',
  'checks',
  'safety_review',
  'offer',
  'ticketed',
  'orientation',
] as const;

/**
 * Recruiting.
 *
 * The one operation here that matters more than the rest is `hire`. It is the only place in this
 * system that turns a candidate into a person, and it does so by creating an employee and storing
 * that employee's id on the applicant — inside one transaction, guarded so it can only ever happen
 * once. Every other route to "we hired them" would leave two records of one human being.
 */
@Injectable()
export class RecruitingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly onboarding: OnboardingService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------ job openings

  async listJobOpenings(principal: Principal, status?: string): Promise<JobOpeningRecord[]> {
    const where = status
      ? and(eq(jobOpenings.companyId, principal.companyId), eq(jobOpenings.status, status))
      : eq(jobOpenings.companyId, principal.companyId);

    const rows = await this.db
      .select({
        job: jobOpenings,
        managerFirst: employees.firstName,
        managerLast: employees.lastName,
        // A driver candidate is moved by their hiring case, not by the office stages, so the
        // case's state decides whether they are still in the running or were hired.
        active: sql<number>`(
          select count(*)::int from ${applicants} a
          left join ${hiringCases} hc on hc.applicant_id = a.id and hc.company_id = a.company_id
          where a.job_opening_id = ${jobOpenings.id}
            and (
              (hc.id is null and a.stage = any(${sql.raw(`ARRAY[${ACTIVE_APPLICANT_STAGES.map((s) => `'${s}'`).join(',')}]`)}))
              or hc.state = any(${sql.raw(`ARRAY[${DRIVER_CASE_ACTIVE_STATES.map((s) => `'${s}'`).join(',')}]`)})
            )
        )`,
        hired: sql<number>`(
          select count(*)::int from ${applicants} a
          left join ${hiringCases} hc on hc.applicant_id = a.id and hc.company_id = a.company_id
          where a.job_opening_id = ${jobOpenings.id}
            and ((hc.id is null and a.stage = 'hired') or hc.state in ('hired', 'active_driver'))
        )`,
      })
      .from(jobOpenings)
      .leftJoin(employees, and(eq(jobOpenings.hiringManagerEmployeeId, employees.id), eq(employees.companyId, jobOpenings.companyId)))
      .where(where)
      .orderBy(desc(jobOpenings.openDate));

    return rows.map((row) => ({
      id: row.job.id,
      jobNumber: row.job.jobNumber,
      title: row.job.title,
      department: row.job.department as JobOpeningRecord['department'],
      location: row.job.location,
      employmentType: row.job.employmentType as JobOpeningRecord['employmentType'],
      hiringManagerEmployeeId: row.job.hiringManagerEmployeeId,
      hiringManagerName: row.managerFirst
        ? `${row.managerFirst} ${row.managerLast ?? ''}`.trim()
        : null,
      openDate: row.job.openDate,
      targetHireDate: row.job.targetHireDate,
      positionsCount: row.job.positionsCount,
      status: row.job.status as JobOpeningStatus,
      notes: row.job.notes,
      activeCandidates: row.active,
      hiredCount: row.hired,
      createdAt: row.job.createdAt.toISOString(),
    }));
  }

  async createJobOpening(
    principal: Principal,
    input: CreateJobOpeningRequest,
  ): Promise<JobOpeningRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.hiringManagerEmployeeId, 'hiring manager')]);
    const jobNumber = await nextNumber(
      this.db,
      jobOpenings,
      jobOpenings.jobNumber,
      jobOpenings.companyId,
      principal.companyId,
      'JOB',
      1000,
    );
    // Globally unique: the number is per company, and two companies' numbers must not share an id.
    const id = `job_${crypto.randomUUID()}`;

    await this.db.insert(jobOpenings).values({
      id,
      companyId: principal.companyId,
      jobNumber,
      title: input.title,
      department: input.department,
      location: input.location,
      employmentType: input.employmentType,
      hiringManagerEmployeeId: input.hiringManagerEmployeeId,
      openDate: input.openDate,
      targetHireDate: input.targetHireDate,
      positionsCount: input.positionsCount,
      // A new opening starts open: a draft nobody publishes helps nobody fill a seat.
      status: 'open',
      notes: input.notes,
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'job_opening',
      entityId: id,
      entityLabel: `${jobNumber} ${input.title}`,
      summary: `Opened ${input.positionsCount} position${input.positionsCount === 1 ? '' : 's'} for ${input.title}`,
    });

    const [record] = await this.listJobOpenings(principal).then((all) =>
      all.filter((j) => j.id === id),
    );
    if (!record) throw new AppError({ status: 500, title: 'Internal Server Error' });
    return record;
  }

  async setJobOpeningStatus(
    principal: Principal,
    id: string,
    status: JobOpeningStatus,
  ): Promise<JobOpeningRecord> {
    const [existing] = await this.db
      .select()
      .from(jobOpenings)
      .where(and(eq(jobOpenings.companyId, principal.companyId), eq(jobOpenings.id, id)))
      .limit(1);
    if (!existing) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No job opening ${id}` });
    }
    const allowed = JOB_OPENING_TRANSITIONS[existing.status as JobOpeningStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${existing.status.replace(/_/g, ' ')} opening cannot become ${status.replace(/_/g, ' ')}`,
      });
    }
    await this.db
      .update(jobOpenings)
      .set({ status, updatedAt: new Date() })
      .where(eq(jobOpenings.id, id));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'job_opening',
      entityId: id,
      entityLabel: `${existing.jobNumber} ${existing.title}`,
      summary: `Opening: ${existing.status} → ${status}`,
      changes: [{ field: 'status', old: existing.status, new: status }],
    });

    const all = await this.listJobOpenings(principal);
    const found = all.find((j) => j.id === id);
    if (!found) throw new AppError({ status: 500, title: 'Internal Server Error' });
    return found;
  }

  // -------------------------------------------------------------------------------- applicants

  private applicantSelect() {
    return {
      applicant: applicants,
      jobTitle: jobOpenings.title,
      recruiterFirst: employees.firstName,
      recruiterLast: employees.lastName,
      interviewCount: sql<number>`(
        select count(*)::int from ${interviews} i where i.applicant_id = ${applicants.id}
      )`,
      nextInterviewAt: sql<string | null>`(
        select min(i.scheduled_at)::text from ${interviews} i
        where i.applicant_id = ${applicants.id} and i.status = 'scheduled'
      )`,
      lastActivityAt: sql<
        string | null
      >`greatest(${applicants.updatedAt}, ${applicants.createdAt})::text`,
      hiringCaseId: sql<string | null>`(
        select hc.id from ${hiringCases} hc
        where hc.applicant_id = ${applicants.id} and hc.company_id = ${applicants.companyId}
        order by hc.opened_at desc limit 1
      )`,
      hiringState: sql<string | null>`(
        select hc.state from ${hiringCases} hc
        where hc.applicant_id = ${applicants.id} and hc.company_id = ${applicants.companyId}
        order by hc.opened_at desc limit 1
      )`,
    };
  }

  /** The candidate has a driver hiring case: the driver track. */
  private driverTrack() {
    return sql`exists (select 1 from ${hiringCases} hc where hc.applicant_id = ${applicants.id} and hc.company_id = ${applicants.companyId})`;
  }

  /**
   * Refuses an office-track action on a driver candidate. A driver's stages, offer and hire run
   * through their hiring case, where Safety's approval gates the offer; the office routes must
   * not become a way around that.
   */
  async assertOfficeTrack(principal: Principal, applicantId: string, what: string): Promise<void> {
    const applicant = await this.getApplicant(principal, applicantId);
    if (applicant.hiringCaseId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${what} is for office staff. ${applicant.name} is a driver candidate: use their hiring case (Offer & onboarding), which waits for Safety approval.`,
      });
    }
  }

  /** The office offer routes never move a driver offer; that one belongs to the hiring case. */
  async assertOfficeOffer(principal: Principal, offerId: string): Promise<void> {
    const [row] = await this.db
      .select({ hiringCaseId: offers.hiringCaseId })
      .from(offers)
      .where(and(eq(offers.companyId, principal.companyId), eq(offers.id, offerId)))
      .limit(1);
    if (row?.hiringCaseId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This is a driver offer; change it from the candidate’s Offer & onboarding tab.',
      });
    }
  }

  /** An opening a candidate may be put on: this company's, and still taking people. */
  private async assertAssignableOpening(principal: Principal, jobOpeningId: string): Promise<void> {
    const [job] = await this.db
      .select({ status: jobOpenings.status, number: jobOpenings.jobNumber })
      .from(jobOpenings)
      .where(and(eq(jobOpenings.companyId, principal.companyId), eq(jobOpenings.id, jobOpeningId)))
      .limit(1);
    if (!job) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'No such opening in this company.',
        extensions: { errors: [{ path: 'jobOpeningId', message: 'No such opening', code: 'custom' }] },
      });
    }
    if (job.status !== 'open' && job.status !== 'on_hold') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${job.number} is ${job.status.replace(/_/g, ' ')}; reopen it before assigning candidates.`,
        extensions: {
          errors: [{ path: 'jobOpeningId', message: `Opening is ${job.status.replace(/_/g, ' ')}`, code: 'custom' }],
        },
      });
    }
  }

  private toApplicant(row: {
    applicant: typeof applicants.$inferSelect;
    jobTitle: string | null;
    recruiterFirst: string | null;
    recruiterLast: string | null;
    interviewCount: number;
    nextInterviewAt: string | null;
    lastActivityAt: string | null;
    hiringCaseId: string | null;
    hiringState: string | null;
  }): ApplicantRecord {
    const a = row.applicant;
    return {
      id: a.id,
      applicantNumber: a.applicantNumber,
      jobOpeningId: a.jobOpeningId,
      jobTitle: row.jobTitle,
      firstName: a.firstName,
      lastName: a.lastName,
      name: `${a.firstName} ${a.lastName}`.trim(),
      email: a.email,
      phone: a.phone,
      position: a.position,
      department: a.department as ApplicantRecord['department'],
      location: a.location,
      source: a.source,
      stage: a.stage as ApplicantStage,
      closedReason: a.closedReason,
      assignedRecruiterEmployeeId: a.assignedRecruiterEmployeeId,
      recruiterName: row.recruiterFirst
        ? `${row.recruiterFirst} ${row.recruiterLast ?? ''}`.trim()
        : null,
      driverType: a.driverType,
      appliedOn: a.appliedOn,
      hiredEmployeeId: a.hiredEmployeeId,
      hiredOn: a.hiredOn,
      notes: a.notes,
      lastActivityAt: row.lastActivityAt,
      interviewCount: row.interviewCount,
      nextInterviewAt: row.nextInterviewAt,
      hiringCaseId: row.hiringCaseId,
      hiringState: row.hiringState,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async listApplicants(
    principal: Principal,
    query: RecruitingQuery,
  ): Promise<{ data: ApplicantRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(applicants.companyId, principal.companyId)];
    if (query.stage) parts.push(eq(applicants.stage, query.stage));
    else if (!query.includeClosed) {
      parts.push(not(inArray(applicants.stage, [...TERMINAL_APPLICANT_STAGES])));
    }
    if (query.department) parts.push(eq(applicants.department, query.department));
    if (query.jobOpeningId) parts.push(eq(applicants.jobOpeningId, query.jobOpeningId));
    // Drivers and office staff are separate tracks: a converted driver lead is an applicant row
    // too (department "dispatch"), so the track is read from the hiring case, not the department.
    if (query.track === 'office') parts.push(not(this.driverTrack()));
    if (query.track === 'driver') parts.push(this.driverTrack());
    if (query.recruiterEmployeeId) {
      parts.push(eq(applicants.assignedRecruiterEmployeeId, query.recruiterEmployeeId));
    }
    if (query.source) parts.push(eq(applicants.source, query.source));
    if (query.appliedFrom) parts.push(gte(applicants.appliedOn, query.appliedFrom));
    if (query.appliedTo) parts.push(lte(applicants.appliedOn, query.appliedTo));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(applicants.firstName, term),
        ilike(applicants.lastName, term),
        ilike(applicants.email, term),
        ilike(applicants.phone, term),
        ilike(applicants.applicantNumber, term),
        ilike(applicants.position, term),
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db.select({ value: count() }).from(applicants).where(where);
    const column = {
      name: applicants.lastName,
      appliedOn: applicants.appliedOn,
      stage: applicants.stage,
      position: applicants.position,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select(this.applicantSelect())
      .from(applicants)
      .leftJoin(jobOpenings, and(eq(applicants.jobOpeningId, jobOpenings.id), eq(jobOpenings.companyId, applicants.companyId)))
      .leftJoin(employees, and(eq(applicants.assignedRecruiterEmployeeId, employees.id), eq(employees.companyId, applicants.companyId)))
      .where(where)
      .orderBy(direction(column))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toApplicant(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getApplicant(principal: Principal, id: string): Promise<ApplicantRecord> {
    const [row] = await this.db
      .select(this.applicantSelect())
      .from(applicants)
      .leftJoin(jobOpenings, and(eq(applicants.jobOpeningId, jobOpenings.id), eq(jobOpenings.companyId, applicants.companyId)))
      .leftJoin(employees, and(eq(applicants.assignedRecruiterEmployeeId, employees.id), eq(employees.companyId, applicants.companyId)))
      .where(
        and(
          eq(applicants.companyId, principal.companyId),
          or(eq(applicants.id, id), eq(applicants.applicantNumber, id)),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No candidate ${id}` });
    }
    return this.toApplicant(row);
  }

  async createApplicant(
    principal: Principal,
    input: CreateApplicantRequest,
  ): Promise<ApplicantRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.assignedRecruiterEmployeeId, 'recruiter'), { table: jobOpenings, idColumn: jobOpenings.id, companyColumn: jobOpenings.companyId, id: input.jobOpeningId, label: 'job opening' }]);
    const email = input.email.trim().toLowerCase();
    if (input.jobOpeningId) await this.assertAssignableOpening(principal, input.jobOpeningId);
    const [clash] = await this.db
      .select({ id: applicants.id, number: applicants.applicantNumber })
      .from(applicants)
      .where(
        and(
          eq(applicants.companyId, principal.companyId),
          sql`lower(${applicants.email}) = ${email}`,
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${email} is already on file as candidate ${clash.number}`,
      });
    }

    const { id } = await retryOnDuplicate(async () => {
      const applicantNumber = await nextNumber(
        this.db,
        applicants,
        applicants.applicantNumber,
        applicants.companyId,
        principal.companyId,
        'CAND',
        1000,
      );
      // Globally unique: the number is per company, and two companies' numbers must not share an id.
      const id = `apl_${crypto.randomUUID()}`;
      await this.db.insert(applicants).values({
        id,
        companyId: principal.companyId,
        applicantNumber,
        jobOpeningId: input.jobOpeningId,
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        phone: input.phone,
        position: input.position,
        department: input.department,
        location: input.location,
        source: input.source,
        stage: 'applied',
        assignedRecruiterEmployeeId: input.assignedRecruiterEmployeeId,
        driverType: input.driverType,
        appliedOn: input.appliedOn,
        notes: input.notes,
      });
      return { id };
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'applicant',
      entityId: id,
      entityLabel: `${input.firstName} ${input.lastName}`,
      summary: `Candidate added for ${input.position}`,
    });

    return this.getApplicant(principal, id);
  }

  async updateApplicant(
    principal: Principal,
    id: string,
    patch: UpdateApplicantRequest,
  ): Promise<ApplicantRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(patch.assignedRecruiterEmployeeId, 'recruiter'), { table: jobOpenings, idColumn: jobOpenings.id, companyColumn: jobOpenings.companyId, id: patch.jobOpeningId, label: 'job opening' }]);
    const before = await this.getApplicant(principal, id);
    if (patch.jobOpeningId && patch.jobOpeningId !== before.jobOpeningId) {
      await this.assertAssignableOpening(principal, patch.jobOpeningId);
    }
    await this.db
      .update(applicants)
      .set({
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
        ...(patch.department !== undefined ? { department: patch.department } : {}),
        ...(patch.jobOpeningId !== undefined ? { jobOpeningId: patch.jobOpeningId } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        ...(patch.assignedRecruiterEmployeeId !== undefined
          ? { assignedRecruiterEmployeeId: patch.assignedRecruiterEmployeeId }
          : {}),
        ...(patch.driverType !== undefined ? { driverType: patch.driverType } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, before.id)));

    const openingMoved =
      patch.jobOpeningId !== undefined && (patch.jobOpeningId ?? null) !== before.jobOpeningId;
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'applicant',
      entityId: before.id,
      entityLabel: before.name,
      summary: openingMoved
        ? patch.jobOpeningId
          ? 'Candidate assigned to an opening'
          : 'Candidate removed from their opening'
        : `Candidate record updated`,
      changes: openingMoved
        ? [{ field: 'jobOpeningId', old: before.jobOpeningId, new: patch.jobOpeningId ?? null }]
        : undefined,
    });
    return this.getApplicant(principal, before.id);
  }

  async moveStage(
    principal: Principal,
    id: string,
    input: MoveApplicantStageRequest,
  ): Promise<ApplicantRecord> {
    const before = await this.getApplicant(principal, id);
    if (before.stage === 'hired') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${before.name} has already been hired as an employee. Their record cannot be moved back into the pipeline.`,
      });
    }
    if (input.stage === 'hired') {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          'Hiring creates an employee, so it goes through the hire action rather than a stage move.',
      });
    }
    if (before.stage === input.stage) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `Already at ${input.stage.replace(/_/g, ' ')}`,
      });
    }
    const closing = TERMINAL_APPLICANT_STAGES.includes(input.stage);
    if (closing && !input.reason) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A reason is required to mark a candidate ${input.stage}`,
      });
    }

    await this.db
      .update(applicants)
      .set({
        stage: input.stage,
        closedReason: closing ? input.reason : null,
        updatedAt: new Date(),
      })
      .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, before.id)));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'applicant',
      entityId: before.id,
      entityLabel: before.name,
      summary: `Stage: ${before.stage} → ${input.stage}`,
      changes: [{ field: 'stage', old: before.stage, new: input.stage }],
      reason: input.reason,
    });

    return this.getApplicant(principal, before.id);
  }

  /**
   * Turn a candidate into an employee.
   *
   * Three guards, in order: this candidate has not already been hired; nobody with their email is
   * already an employee; and the whole thing is one transaction, so a failure part-way cannot leave
   * an employee with no candidate pointing at them or a candidate marked hired with no employee.
   */
  async hire(principal: Principal, id: string, input: HireApplicantRequest): Promise<HireResult> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.managerEmployeeId, 'manager')]);
    const applicant = await this.getApplicant(principal, id);

    if (applicant.hiredEmployeeId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${applicant.name} was already hired and is employee ${applicant.hiredEmployeeId}.`,
      });
    }

    const [existingEmployee] = await this.db
      .select({ id: employees.id, number: employees.employeeNumber })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          sql`lower(${employees.workEmail}) = ${applicant.email.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (existingEmployee) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${applicant.email} is already the work email of employee ${existingEmployee.number}. Link that record instead of creating a second one.`,
      });
    }

    const employee = await this.employees.create(principal, {
      firstName: applicant.firstName,
      middleName: null,
      lastName: applicant.lastName,
      preferredName: null,
      workEmail: applicant.email,
      personalEmail: null,
      phone: applicant.phone,
      secondaryPhone: null,
      department: input.department ?? applicant.department,
      position: input.position ?? applicant.position,
      managerEmployeeId: input.managerEmployeeId,
      location: input.location ?? applicant.location,
      hireDate: input.hireDate,
      employmentType: input.employmentType,
      payType: input.payType,
      payRate: input.payRate,
      timezone: 'America/New_York',
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelationship: null,
      notes: `Hired from candidate ${applicant.applicantNumber}.`,
    });

    await this.db
      .update(applicants)
      .set({
        stage: 'hired',
        hiredEmployeeId: employee.id,
        hiredOn: input.hireDate,
        closedReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, applicant.id)));

    let checklistId: string | null = null;
    if (input.startOnboarding) {
      const checklist = await this.onboarding.createForHire(principal, {
        employeeId: employee.id,
        position: employee.position,
        department: employee.department,
        startDate: input.hireDate,
        templateId: input.onboardingTemplateId,
        ownerEmployeeId: input.managerEmployeeId,
      });
      checklistId = checklist.id;
    }

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'applicant',
      entityId: applicant.id,
      entityLabel: applicant.name,
      summary: `Hired as ${employee.employeeNumber} (${employee.position})`,
      changes: [
        { field: 'stage', old: applicant.stage, new: 'hired' },
        { field: 'hiredEmployeeId', old: null, new: employee.id },
      ],
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'employee',
      entityId: employee.id,
      entityLabel: employee.name,
      summary: `Hired from candidate ${applicant.applicantNumber}`,
    });

    return {
      applicant: await this.getApplicant(principal, applicant.id),
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      onboardingChecklistId: checklistId,
    };
  }

  // -------------------------------------------------------------------------------- interviews

  async listInterviews(principal: Principal, applicantId: string): Promise<InterviewRecord[]> {
    const rows = await this.db
      .select({ row: interviews, first: employees.firstName, last: employees.lastName })
      .from(interviews)
      .leftJoin(employees, and(eq(interviews.interviewerEmployeeId, employees.id), eq(employees.companyId, interviews.companyId)))
      .where(
        and(eq(interviews.companyId, principal.companyId), eq(interviews.applicantId, applicantId)),
      )
      .orderBy(desc(interviews.scheduledAt));
    return rows.map(({ row, first, last }) => ({
      id: row.id,
      applicantId: row.applicantId,
      kind: row.kind as InterviewRecord['kind'],
      scheduledAt: row.scheduledAt.toISOString(),
      interviewerEmployeeId: row.interviewerEmployeeId,
      interviewerName: first ? `${first} ${last ?? ''}`.trim() : null,
      location: row.location,
      status: row.status as InterviewRecord['status'],
      score: row.score,
      recommendation: row.recommendation as InterviewRecord['recommendation'],
      notes: row.notes,
    }));
  }

  async scheduleInterview(
    principal: Principal,
    applicantId: string,
    input: CreateInterviewRequest,
  ): Promise<InterviewRecord[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.interviewerEmployeeId, 'interviewer')]);
    const applicant = await this.getApplicant(principal, applicantId);
    if (TERMINAL_APPLICANT_STAGES.includes(applicant.stage)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${applicant.name} is ${applicant.stage} and is no longer in the pipeline.`,
      });
    }
    const id = `itv_${crypto.randomUUID()}`;
    await this.db.insert(interviews).values({
      id,
      companyId: principal.companyId,
      applicantId: applicant.id,
      kind: input.kind,
      scheduledAt: new Date(input.scheduledAt),
      interviewerEmployeeId: input.interviewerEmployeeId,
      location: input.location,
      status: 'scheduled',
      notes: input.notes,
    });

    // Scheduling an interview means they are being interviewed; the stage follows the fact.
    if (applicant.stage === 'applied' || applicant.stage === 'screening') {
      await this.db
        .update(applicants)
        .set({ stage: 'interview', updatedAt: new Date() })
        .where(eq(applicants.id, applicant.id));
    }

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'applicant',
      entityId: applicant.id,
      entityLabel: applicant.name,
      summary: `${input.kind.replace(/_/g, ' ')} interview scheduled for ${new Date(input.scheduledAt).toISOString()}`,
    });

    return this.listInterviews(principal, applicant.id);
  }

  async recordInterviewOutcome(
    principal: Principal,
    interviewId: string,
    input: {
      status: string;
      score: number | null;
      recommendation: string | null;
      notes: string | null;
    },
  ): Promise<InterviewRecord[]> {
    const [existing] = await this.db
      .select()
      .from(interviews)
      .where(and(eq(interviews.companyId, principal.companyId), eq(interviews.id, interviewId)))
      .limit(1);
    if (!existing) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such interview' });
    }
    await this.db
      .update(interviews)
      .set({
        status: input.status,
        score: input.score,
        recommendation: input.recommendation,
        notes: input.notes,
        updatedAt: new Date(),
      })
      .where(eq(interviews.id, interviewId));

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'applicant',
      entityId: existing.applicantId,
      entityLabel: existing.applicantId,
      summary: `Interview ${input.status}${input.recommendation ? `, recommendation: ${input.recommendation}` : ''}`,
    });
    return this.listInterviews(principal, existing.applicantId);
  }

  // ------------------------------------------------------------------------------------ offers

  async listOffers(principal: Principal, applicantId: string): Promise<OfferRecord[]> {
    const rows = await this.db
      .select({ row: offers, referrerFirst: drivers.firstName, referrerLast: drivers.lastName })
      .from(offers)
      .leftJoin(drivers, and(eq(drivers.id, offers.referringDriverId), eq(drivers.companyId, offers.companyId)))
      .where(and(eq(offers.companyId, principal.companyId), eq(offers.applicantId, applicantId)))
      .orderBy(desc(offers.createdAt));
    return rows.map(({ row, referrerFirst, referrerLast }) => ({
      id: row.id,
      offerNumber: row.offerNumber,
      applicantId: row.applicantId,
      position: row.position,
      department: row.department as OfferRecord['department'],
      employmentType: row.employmentType as OfferRecord['employmentType'],
      payType: row.payType as OfferRecord['payType'],
      payRate: num(row.payRate),
      startDate: row.startDate,
      expiresOn: row.expiresOn,
      status: row.status as OfferStatus,
      notes: row.notes,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      hiringCaseId: row.hiringCaseId,
      driverType: row.driverType,
      payPlanKind: row.payPlanKind,
      payPlanRate: num(row.payPlanRate),
      signOnBonus: num(row.signOnBonus),
      referralBonus: num(row.referralBonus),
      referringDriverId: row.referringDriverId,
      referringDriverName: referrerFirst ? `${referrerFirst} ${referrerLast ?? ''}`.trim() : null,
      orientationDate: row.orientationDate,
      sentAt: row.sentAt?.toISOString() ?? null,
    }));
  }

  async createOffer(
    principal: Principal,
    applicantId: string,
    input: CreateOfferRequest,
  ): Promise<OfferRecord[]> {
    const applicant = await this.getApplicant(principal, applicantId);
    if (TERMINAL_APPLICANT_STAGES.includes(applicant.stage)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${applicant.name} is ${applicant.stage}; an offer cannot be made.`,
      });
    }
    const open = (await this.listOffers(principal, applicant.id)).find(
      (o) => o.status === 'draft' || o.status === 'sent',
    );
    if (open) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${open.offerNumber} is still ${open.status}. Withdraw it before making another.`,
      });
    }

    const offerNumber = await nextNumber(
      this.db,
      offers,
      offers.offerNumber,
      offers.companyId,
      principal.companyId,
      'OFR',
      1000,
    );
    // Globally unique: the number is per company, and two companies' numbers must not share an id.
    const id = `ofr_${crypto.randomUUID()}`;
    await this.db.insert(offers).values({
      id,
      companyId: principal.companyId,
      offerNumber,
      applicantId: applicant.id,
      position: input.position,
      department: input.department,
      employmentType: input.employmentType,
      payType: input.payType,
      payRate: input.payRate === null ? null : String(input.payRate),
      startDate: input.startDate,
      expiresOn: input.expiresOn,
      status: 'draft',
      notes: input.notes,
    });

    if (applicant.stage !== 'offer') {
      await this.db
        .update(applicants)
        .set({ stage: 'offer', updatedAt: new Date() })
        .where(eq(applicants.id, applicant.id));
    }

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'applicant',
      entityId: applicant.id,
      entityLabel: applicant.name,
      summary: `Offer ${offerNumber} drafted for ${input.position}`,
    });
    return this.listOffers(principal, applicant.id);
  }

  async setOfferStatus(
    principal: Principal,
    offerId: string,
    status: OfferStatus,
  ): Promise<OfferRecord[]> {
    const [existing] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.companyId, principal.companyId), eq(offers.id, offerId)))
      .limit(1);
    if (!existing) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such offer' });
    }
    const allowed = OFFER_TRANSITIONS[existing.status as OfferStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${existing.status} offer cannot become ${status}`,
      });
    }
    await this.db
      .update(offers)
      .set({
        status,
        decidedAt: ['accepted', 'declined', 'expired', 'cancelled'].includes(status)
          ? new Date()
          : null,
        updatedAt: new Date(),
      })
      .where(eq(offers.id, offerId));

    // A declined offer takes the candidate out of the pipeline; accepting does not hire them —
    // hiring creates a person and is a deliberate, separate act.
    if (status === 'declined') {
      await this.db
        .update(applicants)
        .set({ stage: 'withdrawn', closedReason: 'Offer declined', updatedAt: new Date() })
        .where(eq(applicants.id, existing.applicantId));
    }

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'applicant',
      entityId: existing.applicantId,
      entityLabel: existing.offerNumber,
      summary: `Offer ${existing.offerNumber}: ${existing.status} → ${status}`,
      changes: [{ field: 'offerStatus', old: existing.status, new: status }],
    });
    return this.listOffers(principal, existing.applicantId);
  }

  // ----------------------------------------------------------------------------------- summary

  async summary(principal: Principal): Promise<RecruitingSummary> {
    const scope = eq(applicants.companyId, principal.companyId);
    const monthStart = `${today().slice(0, 7)}-01`;

    const [byStage, [openings], [interviewsScheduled], [offersOut], [hired], [avg]] =
      await Promise.all([
        this.db
          .select({ stage: applicants.stage, value: count() })
          .from(applicants)
          .where(scope)
          .groupBy(applicants.stage),
        this.db
          .select({ value: count() })
          .from(jobOpenings)
          .where(
            and(eq(jobOpenings.companyId, principal.companyId), eq(jobOpenings.status, 'open')),
          ),
        this.db
          .select({ value: count() })
          .from(interviews)
          .where(
            and(eq(interviews.companyId, principal.companyId), eq(interviews.status, 'scheduled')),
          ),
        this.db
          .select({ value: count() })
          .from(offers)
          .where(and(eq(offers.companyId, principal.companyId), eq(offers.status, 'sent'))),
        this.db
          .select({ value: count() })
          .from(applicants)
          .where(and(scope, eq(applicants.stage, 'hired'), gte(applicants.hiredOn, monthStart))),
        this.db
          .select({
            value: sql<
              number | null
            >`avg(${applicants.hiredOn}::date - ${applicants.appliedOn}::date)`,
          })
          .from(applicants)
          .where(and(scope, eq(applicants.stage, 'hired'))),
      ]);

    const stageCounts = byStage.map((r) => ({ stage: r.stage as ApplicantStage, count: r.value }));
    const active = stageCounts
      .filter((s) => ACTIVE_APPLICANT_STAGES.includes(s.stage))
      .reduce((sum, s) => sum + s.count, 0);

    return {
      openPositions: openings?.value ?? 0,
      activeCandidates: active,
      interviewsScheduled: interviewsScheduled?.value ?? 0,
      offersOutstanding: offersOut?.value ?? 0,
      hiredThisMonth: hired?.value ?? 0,
      rejected: stageCounts.find((s) => s.stage === 'rejected')?.count ?? 0,
      byStage: stageCounts,
      // Null, not zero: nobody hired yet is not "hired in zero days".
      averageDaysToHire:
        avg?.value === null || avg?.value === undefined ? null : Math.round(Number(avg.value)),
    };
  }
}
