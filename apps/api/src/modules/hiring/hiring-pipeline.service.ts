import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import {
  DotApplicationFormSchema,
  OFFER_TRANSITIONS,
  SYSTEM_REQUIREMENTS,
  evaluateItem,
  isMandatoryRequirement,
  requirementsFor,
  type BookTicketRequest,
  type CreateDriverOfferRequest,
  type HireDriverRequest,
  type HireDriverResult,
  type HiringCalendarEvent,
  type DropHiringCaseRequest,
  type HiringState,
  type OfferRecord,
  type OfferStatus,
  type Orientation,
  type RecordOrientationRequest,
  type RoadTest,
  type TravelTicket,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  hiringCases,
  hiringDotApplications,
  hiringOrientations,
  hiringTickets,
  type HiringCaseRow,
  type HiringOrientationRow,
  type HiringTicketRow,
} from '../../database/schema/hiring';
import { applicants, offers, onboardingChecklists } from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { qualificationItems } from '../../database/schema/compliance';
import { companies, drivers } from '../../database/schema/roster';
import { ComplianceService } from '../compliance/compliance.service';
import { nextNumber, num, retryOnDuplicate } from '../hr/hr.util';
import { OnboardingService } from '../hr/onboarding.service';
import { RecruitingService } from '../hr/recruiting.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { CostLedgerService } from './cost-ledger.service';
import { HiringService } from './hiring.service';
import { renderRoadTestCertificatePdf } from './road-test-pdf';

/**
 * The back of the funnel: offer → ticketed → orientation → hired.
 *
 * Every move here is a recruiter's record of something that happened, appended to the case as an
 * event. The offer lives on the recruiting offers table (one kind of offer, one table); the
 * ticket and the orientation are the case's own; the road test certificate is filed in the
 * qualification file and pointed at. The hire event is the one place in the product that turns a
 * candidate into a driver: it makes the employee through the same hire the office path uses, then
 * the roster row with the id the file has been keyed by since the application.
 */
/** One write at a time per case: the key every back-of-funnel write locks on. */
const caseLock = (principal: Principal, caseId: string) =>
  `hiring-case:${principal.companyId}:${caseId}`;

@Injectable()
export class HiringPipelineService {
  constructor(
    private readonly database: DatabaseService,
    private readonly hiring: HiringService,
    private readonly recruiting: RecruitingService,
    private readonly onboarding: OnboardingService,
    private readonly compliance: ComplianceService,
    private readonly drivers: DriversService,
    private readonly audit: AuditService,
    private readonly ledger: CostLedgerService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async expect(row: HiringCaseRow, states: HiringState[], what: string): Promise<void> {
    if (!states.includes(row.state as HiringState)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${what} needs the case at ${states.join(' or ')}; ${row.candidateName} is at ${row.state}.`,
      });
    }
  }

  // ======================================================================================= offer

  private async offerRow(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.companyId, principal.companyId), eq(offers.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No offer ${id}` });
    return row;
  }

  async offer(principal: Principal, caseId: string): Promise<OfferRecord | null> {
    const row = await this.hiring.row(principal, caseId);
    if (!row.offerId) return null;
    const list = await this.recruiting.listOffers(principal, row.applicantId as string);
    return list.find((o) => o.id === row.offerId) ?? null;
  }

  /** Drafts the driver offer. The case must be at Offer, which only the safety decision reaches. */
  async createOffer(
    principal: Principal,
    caseId: string,
    input: CreateDriverOfferRequest,
    options: { at?: Date } = {},
  ): Promise<OfferRecord> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.createOfferLocked(principal, caseId, input, options),
    );
  }

  private async createOfferLocked(
    principal: Principal,
    caseId: string,
    input: CreateDriverOfferRequest,
    options: { at?: Date } = {},
  ): Promise<OfferRecord> {
    const row = await this.hiring.row(principal, caseId);
    await this.expect(row, ['offer'], 'An offer');
    if (!row.applicantId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This case has no candidate record.',
      });
    }
    const applicantId = row.applicantId;
    const existing = row.offerId ? await this.offerRow(principal, row.offerId) : null;
    if (
      existing &&
      (existing.status === 'draft' || existing.status === 'sent' || existing.status === 'accepted')
    ) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${existing.offerNumber} is ${existing.status}. Cancel it before making another.`,
      });
    }
    if (input.referralBonus !== null && !input.referringDriverId) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'A referral bonus needs the driver who referred them.',
      });
    }
    if (input.referringDriverId) {
      const [referrer] = await this.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(
          and(eq(drivers.companyId, principal.companyId), eq(drivers.id, input.referringDriverId)),
        )
        .limit(1);
      if (!referrer) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'No such driver to credit the referral to.',
        });
      }
    }
    const at = options.at ?? new Date();
    const { id, offerNumber } = await retryOnDuplicate(async () => {
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
        applicantId,
        position: 'Driver',
        department: 'dispatch',
        // An owner-operator drives under contract; a company or lease driver is employed.
        employmentType: input.driverType === 'owner_operator' ? 'contractor' : 'full_time',
        payType: null,
        payRate: null,
        startDate: input.orientationDate,
        expiresOn: input.expiresOn,
        status: 'draft',
        notes: input.notes,
        hiringCaseId: caseId,
        driverType: input.driverType,
        payPlanKind: input.payPlan.kind,
        payPlanRate: String(input.payPlan.rate),
        signOnBonus: input.signOnBonus === null ? null : String(input.signOnBonus),
        referralBonus: input.referralBonus === null ? null : String(input.referralBonus),
        referringDriverId: input.referringDriverId,
        orientationDate: input.orientationDate,
        createdAt: at,
        updatedAt: at,
      });
      return { id, offerNumber };
    });
    await this.db
      .update(hiringCases)
      .set({ offerId: id, updatedAt: at })
      .where(eq(hiringCases.id, caseId));
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'offer',
      entityId: id,
      entityLabel: `${offerNumber} · ${row.candidateName}`,
      summary: `Driver offer drafted: ${input.payPlan.rate} ${input.payPlan.kind.replace(/_/g, ' ')}, orientation ${input.orientationDate}`,
      at,
    });
    return (await this.offer(principal, caseId)) as OfferRecord;
  }

  /**
   * Sent, accepted, declined, cancelled, expired — the generic offer transitions. Declining ends
   * the case; accepting keeps it at Offer until travel is booked.
   */
  async setOfferStatus(
    principal: Principal,
    caseId: string,
    status: OfferStatus,
    options: { at?: Date } = {},
  ): Promise<OfferRecord> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.setOfferStatusLocked(principal, caseId, status, options),
    );
  }

  private async setOfferStatusLocked(
    principal: Principal,
    caseId: string,
    status: OfferStatus,
    options: { at?: Date } = {},
  ): Promise<OfferRecord> {
    const row = await this.hiring.row(principal, caseId);
    if (!row.offerId)
      throw new AppError({ status: 409, title: 'Conflict', detail: 'No offer has been made.' });
    const existing = await this.offerRow(principal, row.offerId);
    // A retry of the same change (double click, resend) is already done: answer with the offer.
    if (existing.status === status) return (await this.offer(principal, caseId)) as OfferRecord;
    const allowed = OFFER_TRANSITIONS[existing.status as OfferStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${existing.status} offer cannot become ${status}`,
      });
    }
    const at = options.at ?? new Date();
    const decided = ['accepted', 'declined', 'expired', 'cancelled'].includes(status);
    await this.db
      .update(offers)
      .set({
        status,
        sentAt: status === 'sent' ? at : existing.sentAt,
        decidedAt: decided ? at : null,
        updatedAt: at,
      })
      .where(eq(offers.id, existing.id));
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'offer',
      entityId: existing.id,
      entityLabel: `${existing.offerNumber} · ${row.candidateName}`,
      summary: `Offer ${status}`,
      changes: [{ field: 'status', old: existing.status, new: status }],
      at,
    });
    if (status === 'declined' && row.state === 'offer') {
      await this.hiring.transition(principal, row, 'declined_offer', {
        reason: 'declined_offer',
        note: `Declined ${existing.offerNumber}`,
        at,
      });
      await this.db
        .update(applicants)
        .set({ stage: 'withdrawn', closedReason: 'Offer declined', updatedAt: at })
        .where(eq(applicants.id, existing.applicantId));
    }
    return (await this.offer(principal, caseId)) as OfferRecord;
  }

  // ====================================================================================== ticket

  private toTicket(row: HiringTicketRow): TravelTicket {
    return {
      id: row.id,
      hiringCaseId: row.hiringCaseId,
      travelMode: row.travelMode as TravelTicket['travelMode'],
      carrier: row.carrier,
      bookingReference: row.bookingReference,
      departAt: row.departAt.toISOString(),
      arriveAt: row.arriveAt?.toISOString() ?? null,
      travelCost: num(row.travelCost),
      lodgingNights: row.lodgingNights,
      lodgingCost: num(row.lodgingCost),
      bookedById: row.bookedById,
      bookedByName: row.bookedByName,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async ticket(principal: Principal, caseId: string): Promise<TravelTicket | null> {
    await this.hiring.row(principal, caseId);
    const [row] = await this.db
      .select()
      .from(hiringTickets)
      .where(eq(hiringTickets.hiringCaseId, caseId))
      .limit(1);
    return row ? this.toTicket(row) : null;
  }

  /** Books travel to orientation. Needs an accepted offer; moves the case to Ticketed. */
  async bookTicket(
    principal: Principal,
    caseId: string,
    input: BookTicketRequest,
    options: { at?: Date } = {},
  ): Promise<TravelTicket> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.bookTicketLocked(principal, caseId, input, options),
    );
  }

  private async bookTicketLocked(
    principal: Principal,
    caseId: string,
    input: BookTicketRequest,
    options: { at?: Date } = {},
  ): Promise<TravelTicket> {
    const row = await this.hiring.row(principal, caseId);
    // One travel record per case: a resend of the same save returns the one already recorded.
    const recorded = await this.ticket(principal, caseId);
    if (recorded) {
      if (row.state === 'ticketed') return recorded;
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Travel is already recorded for this candidate.',
      });
    }
    await this.expect(row, ['offer'], 'A ticket');
    const offer = row.offerId ? await this.offerRow(principal, row.offerId) : null;
    if (!offer || offer.status !== 'accepted') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Travel is booked once the offer is accepted.',
      });
    }
    const at = options.at ?? new Date();
    const id = `tkt_${crypto.randomUUID()}`;
    await this.db.insert(hiringTickets).values({
      id,
      companyId: principal.companyId,
      hiringCaseId: caseId,
      travelMode: input.travelMode,
      carrier: input.carrier,
      bookingReference: input.bookingReference,
      departAt: new Date(input.departAt),
      arriveAt: input.arriveAt ? new Date(input.arriveAt) : null,
      travelCost: input.travelCost === null ? null : String(input.travelCost),
      lodgingNights: input.lodgingNights,
      lodgingCost: input.lodgingCost === null ? null : String(input.lodgingCost),
      bookedById: principal.userId,
      bookedByName: principal.userName ?? principal.userId,
      notes: input.notes,
      createdAt: at,
    });
    const [ticketRow] = await this.db
      .select()
      .from(hiringTickets)
      .where(eq(hiringTickets.id, id))
      .limit(1);
    if (ticketRow) await this.ledger.priceTicket(principal.companyId, ticketRow, principal);
    await this.hiring.transition(principal, row, 'ticketed', {
      note: `${input.travelMode.replace(/_/g, ' ')}${input.carrier ? ` · ${input.carrier}` : ''}`,
      at,
    });
    return (await this.ticket(principal, caseId)) as TravelTicket;
  }

  // ================================================================================= orientation

  private toOrientation(row: HiringOrientationRow): Orientation {
    return {
      id: row.id,
      hiringCaseId: row.hiringCaseId,
      startDate: row.startDate,
      days: row.days,
      perDayPay: num(row.perDayPay),
      attendance: row.attendance as Orientation['attendance'],
      roadTest: (row.roadTest as RoadTest | null) ?? null,
      roadTestDocumentId: row.roadTestDocumentId,
      completedOn: row.completedOn,
      notes: row.notes,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async orientation(principal: Principal, caseId: string): Promise<Orientation | null> {
    await this.hiring.row(principal, caseId);
    const [row] = await this.db
      .select()
      .from(hiringOrientations)
      .where(eq(hiringOrientations.hiringCaseId, caseId))
      .limit(1);
    return row ? this.toOrientation(row) : null;
  }

  /**
   * Records orientation: attendance, the days and the per-day pay, and the road test. Attending
   * moves the case to Orientation; a no-show ends it. A passed road test is rendered as the
   * 391.31(e) certificate and filed in the qualification file, once.
   */
  async recordOrientation(
    principal: Principal,
    caseId: string,
    input: RecordOrientationRequest,
    options: { at?: Date } = {},
  ): Promise<Orientation> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.recordOrientationLocked(principal, caseId, input, options),
    );
  }

  private async recordOrientationLocked(
    principal: Principal,
    caseId: string,
    input: RecordOrientationRequest,
    options: { at?: Date } = {},
  ): Promise<Orientation> {
    const row = await this.hiring.row(principal, caseId);
    await this.expect(row, ['ticketed', 'orientation'], 'Orientation');
    const at = options.at ?? new Date();
    const [existing] = await this.db
      .select()
      .from(hiringOrientations)
      .where(eq(hiringOrientations.hiringCaseId, caseId))
      .limit(1);

    let roadTestDocumentId = existing?.roadTestDocumentId ?? null;
    if (input.roadTest?.result === 'pass' && !roadTestDocumentId && row.driverId) {
      roadTestDocumentId = await this.fileRoadTest(principal, row, input.roadTest, at);
    }

    const values = {
      startDate: input.startDate,
      days: input.days,
      perDayPay: input.perDayPay === null ? null : String(input.perDayPay),
      attendance: input.attendance,
      roadTest: input.roadTest,
      roadTestDocumentId,
      completedOn: input.completedOn,
      notes: input.notes,
      updatedAt: at,
    };
    if (existing) {
      await this.db
        .update(hiringOrientations)
        .set(values)
        .where(eq(hiringOrientations.id, existing.id));
    } else {
      await this.db.insert(hiringOrientations).values({
        id: `ori_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        hiringCaseId: caseId,
        ...values,
        createdAt: at,
      });
    }

    const [orientationRow] = await this.db
      .select()
      .from(hiringOrientations)
      .where(eq(hiringOrientations.hiringCaseId, caseId))
      .limit(1);
    if (orientationRow) await this.ledger.priceOrientation(principal.companyId, orientationRow, principal);
    if (input.attendance === 'attended' && row.state === 'ticketed') {
      await this.hiring.transition(principal, row, 'orientation', {
        note: `${input.days}-day orientation from ${input.startDate}`,
        at,
      });
    } else if (input.attendance === 'no_show' && row.state !== 'no_show') {
      await this.hiring.transition(principal, row, 'no_show', {
        reason: 'no_show_orientation',
        note: `Did not attend orientation on ${input.startDate}`,
        at,
      });
      if (row.applicantId) {
        await this.db
          .update(applicants)
          .set({ stage: 'withdrawn', closedReason: 'No-show at orientation', updatedAt: at })
          .where(eq(applicants.id, row.applicantId));
      }
    }
    return (await this.orientation(principal, caseId)) as Orientation;
  }

  private async fileRoadTest(
    principal: Principal,
    row: HiringCaseRow,
    roadTest: RoadTest,
    at: Date,
  ): Promise<string> {
    const [company] = await this.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, principal.companyId))
      .limit(1);
    const [app] = await this.db
      .select({ form: hiringDotApplications.form })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, row.id))
      .limit(1);
    const form = app ? DotApplicationFormSchema.parse(app.form) : null;
    const bytes = await renderRoadTestCertificatePdf({
      companyName: company?.name ?? principal.companyId,
      driverName: row.candidateName,
      driverId: row.driverId as string,
      license: form?.licenses[0] ?? null,
      roadTest,
      generatedAt: at,
    });
    const { document } = await this.compliance.upload(principal, {
      ownerType: 'driver',
      ownerId: row.driverId as string,
      ownerLabel: row.candidateName,
      requirementCode: 'road_test',
      title: 'Road test certificate',
      fileName: `road-test-${row.driverId}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      issuedOn: roadTest.testedOn,
      expiresOn: null,
      source: 'staff',
      notes: `Examiner ${roadTest.examinerName}; ${roadTest.vehicleType}`,
      bytes,
      at,
    });
    // Filed for review, not verified (owner, 2026-10-02): an uploaded recruiting document is never
    // accepted by being uploaded. Safety verifies the certificate like any other file, and the hire
    // waits for it with the other mandatory checks.
    return document.id;
  }

  // ======================================================================================== hire

  /**
   * The hire event. Refused until orientation was attended and the road test passed; then the
   * employee is created through the same hire the office path uses, and the roster row with the
   * reserved id and the offer's pay plan. Everything the roster needs is read from what the funnel
   * already holds — a second copy of the CDL date would be a second chance to be wrong.
   */
  /**
   * The mandatory driver checks that are not reviewed and accepted, by name. Accepted means the
   * engine reads the item as verified (or valid where no review is required), waived, or not
   * applicable with its recorded reason; expired, missing, pending and rejected all block.
   */
  async missingMandatoryChecks(principal: Principal, driverId: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(qualificationItems)
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, driverId),
        ),
      );
    const items = new Map(rows.map((r) => [r.requirementCode, this.compliance.toItem(r)]));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const accepted = new Set(['verified', 'valid', 'waived', 'not_applicable', 'expiring']);
    return requirementsFor('driver', SYSTEM_REQUIREMENTS)
      .filter(isMandatoryRequirement)
      .flatMap((r) => {
        const v = evaluateItem(r, items.get(r.code) ?? null, { id: driverId, label: driverId }, { today });
        return accepted.has(v.status) ? [] : [`${r.name}: ${v.status.replace(/_/g, ' ')}`];
      });
  }

  async hire(
    principal: Principal,
    caseId: string,
    input: HireDriverRequest,
    options: { at?: Date } = {},
  ): Promise<HireDriverResult> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.hireLocked(principal, caseId, input, options),
    );
  }

  private async hireLocked(
    principal: Principal,
    caseId: string,
    input: HireDriverRequest,
    options: { at?: Date } = {},
  ): Promise<HireDriverResult> {
    const row = await this.hiring.row(principal, caseId);
    // A second Confirm (a double click, a retry after a dropped answer) gets the hire that already
    // happened — the same employee and the same driver — never a second one or an error.
    if ((row.state === 'hired' || row.state === 'active_driver') && row.employeeId && row.driverId) {
      const [driver] = await this.db
        .select({ id: drivers.id, number: drivers.driverNumber })
        .from(drivers)
        .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, row.driverId)))
        .limit(1);
      const [employee] = await this.db
        .select({ number: employees.employeeNumber })
        .from(employees)
        .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, row.employeeId)))
        .limit(1);
      const [checklist] = await this.db
        .select({ id: onboardingChecklists.id })
        .from(onboardingChecklists)
        .where(and(eq(onboardingChecklists.companyId, principal.companyId), eq(onboardingChecklists.employeeId, row.employeeId)))
        .limit(1);
      if (driver && employee) {
        return {
          hiringCaseId: caseId,
          employeeId: row.employeeId,
          employeeNumber: employee.number,
          driverId: driver.id,
          driverNumber: driver.number,
          onboardingChecklistId: checklist?.id ?? null,
        };
      }
    }
    await this.expect(row, ['orientation'], 'The hire');
    if (!row.applicantId || !row.driverId || !row.offerId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The case is missing its candidate, file key or offer.',
      });
    }
    const orientation = await this.orientation(principal, caseId);
    if (orientation?.attendance !== 'attended' || orientation.roadTest?.result !== 'pass') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Hiring needs orientation attended and the road test passed.',
      });
    }
    const offer = await this.offerRow(principal, row.offerId);
    const [app] = await this.db
      .select({ form: hiringDotApplications.form })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, caseId))
      .limit(1);
    const form = app ? DotApplicationFormSchema.parse(app.form) : null;
    const license = form?.licenses[0];
    const address = form?.addresses.find((a) => a.to === null) ?? form?.addresses[0];
    const items = await this.db
      .select({
        code: qualificationItems.requirementCode,
        expiresOn: qualificationItems.expiresOn,
        verifiedAt: qualificationItems.verifiedAt,
      })
      .from(qualificationItems)
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, row.driverId),
        ),
      );
    const cdl = items.find((i) => i.code === 'cdl');
    const medical = items.find((i) => i.code === 'medical_card');
    // Every applicable mandatory check reviewed and accepted (owner, 2026-10-02) — the road test
    // certificate included — or explicitly not applicable with a recorded reason. Optional items
    // (no hold effect) never block. The refusal lists exactly what is missing.
    const missing = await this.missingMandatoryChecks(principal, row.driverId);
    if (missing.length > 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `Hiring needs every mandatory check reviewed and accepted: ${missing.join('; ')}`,
        extensions: { missing },
      });
    }
    if (!license || !address) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'The DOT application has no licence or address to hire from.',
      });
    }
    if (!cdl?.expiresOn || !medical?.expiresOn) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          'The qualification file has no CDL or medical certificate expiry on record; the roster cannot be opened without them.',
      });
    }
    const at = options.at ?? new Date();
    const applicant = await this.recruiting.getApplicant(principal, row.applicantId);

    const hired = await this.recruiting.hire(principal, row.applicantId, {
      hireDate: input.hireDate,
      position: 'Driver',
      department: 'dispatch',
      employmentType: offer.employmentType as 'full_time' | 'contractor',
      managerEmployeeId: input.managerEmployeeId,
      location: `${address.city}, ${address.state}`,
      // Paid from the pay plan on the driver profile, never a second rate here.
      payType: null,
      payRate: null,
      // The plan is built below, once the roster row exists, so it can pick the driver-type
      // template and complete its file-linked items from the qualification file.
      startOnboarding: false,
      onboardingTemplateId: null,
    });

    const driver = await this.drivers.createForHire(principal, {
      reserved: { id: row.driverId, driverNumber: `D-${row.driverId.replace(/^drv_/, '')}` },
      employeeId: hired.employeeId,
      firstName: form?.legalFirstName ?? applicant.firstName,
      lastName: form?.legalLastName ?? applicant.lastName,
      phone: applicant.phone,
      email: applicant.email,
      driverType: (offer.driverType ?? 'company') as
        'company' | 'owner_operator' | 'lease_operator',
      cdlState: license.state,
      cdlClass: license.licenseClass === 'C' ? 'B' : license.licenseClass,
      cdlEndorsements: license.endorsements,
      cdlExpiresOn: cdl.expiresOn,
      medicalCardExpiresOn: medical.expiresOn,
      // The applicant's date of birth from the DOT application (owner, 2026-10-25).
      dateOfBirth: form?.dateOfBirth ?? null,
      hireDate: input.hireDate,
      dispatcherId: input.dispatcherId,
      homeCity: address.city,
      homeState: address.state,
      payPlan: {
        kind: (offer.payPlanKind ?? 'per_mile') as 'per_mile' | 'percent_of_linehaul',
        rate: num(offer.payPlanRate) ?? 0,
      },
      preferredLanguage: input.preferredLanguage,
    });

    let onboardingChecklistId: string | null = null;
    if (input.startOnboarding) {
      const checklist = await this.onboarding.createForHire(principal, {
        employeeId: hired.employeeId,
        position: 'Driver',
        department: 'dispatch',
        startDate: input.hireDate,
        templateId: null,
        ownerEmployeeId: input.managerEmployeeId,
        driverType: offer.driverType,
        driverId: driver.id,
      });
      onboardingChecklistId = checklist.id;
    }
    await this.db
      .update(hiringCases)
      .set({ employeeId: hired.employeeId, hiredAt: at, updatedAt: at })
      .where(eq(hiringCases.id, caseId));
    await this.ledger.priceHire(principal.companyId, caseId, offer, input.hireDate, principal);
    await this.hiring.transition(principal, row, 'hired', {
      note: `${hired.employeeNumber} · ${driver.driverNumber}`,
      at,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver',
      entityId: driver.id,
      entityLabel: `${driver.firstName} ${driver.lastName}`,
      summary: `Hired from candidate ${applicant.applicantNumber}; roster row opened with the file's id`,
      at,
    });

    return {
      hiringCaseId: caseId,
      employeeId: hired.employeeId,
      employeeNumber: hired.employeeNumber,
      driverId: driver.id,
      driverNumber: driver.driverNumber,
      onboardingChecklistId,
    };
  }

  // ======================================================================== drop · calendar

  /**
   * A recruiter ends a case Safety has not: the driver stopped answering, took another job, or did
   * not come. Disqualification is Safety's decision in the qualification file and is not offered
   * here; a hired driver leaves through the roster, not through hiring.
   */
  async drop(principal: Principal, caseId: string, input: DropHiringCaseRequest): Promise<void> {
    return this.hiring.withLock(caseLock(principal, caseId), () =>
      this.dropLocked(principal, caseId, input),
    );
  }

  private async dropLocked(
    principal: Principal,
    caseId: string,
    input: DropHiringCaseRequest,
  ): Promise<void> {
    const row = await this.hiring.row(principal, caseId);
    await this.expect(
      row,
      ['lead', 'prequalified', 'application', 'checks', 'safety_review', 'offer', 'ticketed', 'orientation'],
      'Dropping',
    );
    const to: HiringState = input.reason === 'no_show_orientation' ? 'no_show' : 'withdrawn';
    await this.hiring.transition(principal, row, to, { reason: input.reason, note: input.note });
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'hiring_case',
      entityId: caseId,
      entityLabel: row.candidateName,
      summary: `Dropped from hiring: ${input.reason.replace(/_/g, ' ')}${input.note ? ` — ${input.note}` : ''}`,
      changes: [{ field: 'state', old: row.state, new: to }],
    });
  }

  /** Travel, orientation and hires dated inside [from, to] (business dates), for the week view. */
  async calendar(principal: Principal, from: string, to: string): Promise<HiringCalendarEvent[]> {
    const cases = await this.db
      .select({ id: hiringCases.id, applicantId: hiringCases.applicantId, name: hiringCases.candidateName, hiredAt: hiringCases.hiredAt })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.isTest, false)));
    const byId = new Map(cases.map((c) => [c.id, c]));
    const ids = cases.map((c) => c.id);
    if (ids.length === 0) return [];
    const eastern = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const events: HiringCalendarEvent[] = [];

    const tickets = await this.db
      .select()
      .from(hiringTickets)
      .where(and(eq(hiringTickets.companyId, principal.companyId), inArray(hiringTickets.hiringCaseId, ids)));
    for (const t of tickets) {
      const date = eastern(t.departAt);
      const c = byId.get(t.hiringCaseId);
      if (!c || date < from || date > to) continue;
      events.push({
        id: `travel:${t.id}`, caseId: c.id, applicantId: c.applicantId, candidateName: c.name, kind: 'travel',
        date, at: t.departAt.toISOString(),
        detail: [t.travelMode.replace(/_/g, ' '), t.carrier, t.bookingReference].filter(Boolean).join(' · ') || null,
      });
    }

    const orientations = await this.db
      .select()
      .from(hiringOrientations)
      .where(and(
        eq(hiringOrientations.companyId, principal.companyId),
        inArray(hiringOrientations.hiringCaseId, ids),
        gte(hiringOrientations.startDate, from),
        lte(hiringOrientations.startDate, to),
      ));
    for (const o of orientations) {
      const c = byId.get(o.hiringCaseId);
      if (!c) continue;
      events.push({
        id: `orientation:${o.id}`, caseId: c.id, applicantId: c.applicantId, candidateName: c.name, kind: 'orientation',
        date: o.startDate, at: null, detail: `${o.days} day${o.days === 1 ? '' : 's'} · ${o.attendance.replace(/_/g, ' ')}`,
      });
    }

    for (const c of cases) {
      if (!c.hiredAt) continue;
      const date = eastern(c.hiredAt);
      if (date < from || date > to) continue;
      events.push({ id: `hired:${c.id}`, caseId: c.id, applicantId: c.applicantId, candidateName: c.name, kind: 'hired', date, at: c.hiredAt.toISOString(), detail: null });
    }
    return events.sort((a, b) => (a.date + (a.at ?? '')).localeCompare(b.date + (b.at ?? '')));
  }
}
