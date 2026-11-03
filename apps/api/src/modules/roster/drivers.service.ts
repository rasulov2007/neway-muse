import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { and, asc, eq, ilike, inArray, isNull, ne, not, or, sql } from 'drizzle-orm';
import {
  INACTIVE_DRIVER_STATUSES,
  dateOfBirthIssue,
  normalizeName,
  type CreateDriverRequest,
  type DriverRecord,
  type RosterPage,
  type RosterQuery,
  type UpdateDriverRequest,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { hiringCases } from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { driverVacations, drivers, trucks } from '../../database/schema/roster';
import { dispatchRoster } from '../../database/schema/dispatch-ops';
import { audit as dispatchAuditEntry } from '../dispatch-board/ops.helpers';
import { ComplianceService } from '../compliance/compliance.service';
import { AuditService } from '../people/audit.service';
import { EmployeesService } from '../people/employees.service';
import { OnboardingService } from '../hr/onboarding.service';
import { AssignmentsService } from './assignments.service';
import { easternToday, restoreArchivedDriver } from './driver-archive.data';
import { toDriverRecord } from './roster.mapper';

/**
 * Drivers.
 *
 * A newly hired driver starts `off_duty` with both credentials `missing`. That is not pessimism:
 * a date typed into a hiring form is a claim, and the compliance engine treats an unverified claim
 * as an open requirement. Starting them `available` with `valid` credentials would put an
 * undocumented driver on a load, which is the one outcome this system exists to prevent.
 */
/** A blank second number is no number; a label without a number means nothing. */
function secondaryPhoneColumns(input: {
  secondaryPhone?: string | null;
  secondaryPhoneLabel?: CreateDriverRequest['secondaryPhoneLabel'];
}): { secondaryPhone: string | null; secondaryPhoneLabel: string | null } {
  const phone = input.secondaryPhone?.trim() || null;
  return {
    secondaryPhone: phone,
    secondaryPhoneLabel: phone ? (input.secondaryPhoneLabel ?? null) : null,
  };
}

/**
 * A date of birth the roster may hold: a real day, not after today's Eastern date, age 18–100.
 * Null clears it. The same words as the form, from the same shared rule.
 */
function checkedDateOfBirth(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const issue = dateOfBirthIssue(value, easternToday(now));
  if (issue) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: issue });
  return value;
}

/** The fields a driver edit is audited by, old against new, as text. */
const AUDITED_FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['phone', 'Phone'],
  ['secondaryPhone', 'Secondary phone'],
  ['secondaryPhoneLabel', 'Secondary phone label'],
  ['email', 'Email'],
  ['driverType', 'Driver type'],
  ['cdlState', 'CDL state'],
  ['cdlClass', 'CDL class'],
  ['cdlEndorsements', 'Endorsements'],
  ['cdlExpiresOn', 'CDL expires'],
  ['medicalCardExpiresOn', 'Medical card expires'],
  ['dateOfBirth', 'Date of birth'],
  ['hireDate', 'Hire date'],
  ['dispatcherId', 'Dispatcher'],
  ['homeCity', 'Home city'],
  ['homeState', 'Home state'],
  ['payPlan', 'Pay plan'],
  ['preferredLanguage', 'Preferred language'],
] as const satisfies ReadonlyArray<readonly [keyof DriverRecord, string]>;

function auditText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.join(', ') || null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

@Injectable()
export class DriversService {
  constructor(
    private readonly database: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly onboarding: OnboardingService,
    private readonly logger: PinoLogger,
    private readonly assignments: AssignmentsService,
  ) {
    this.logger.setContext(DriversService.name);
  }

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal, query: RosterQuery): Promise<RosterPage<DriverRecord>> {
    const filters = [eq(drivers.companyId, principal.companyId)];
    if (!query.includeInactive && INACTIVE_DRIVER_STATUSES.length > 0) {
      filters.push(not(inArray(drivers.status, [...INACTIVE_DRIVER_STATUSES])));
    }
    // Archived drivers (owner, 2026-10-02) are hidden from every list and picker unless asked for.
    if (!query.includeArchived) filters.push(isNull(drivers.archivedAt));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(drivers.firstName, term),
        // "DAVID MCKAY": the whole name, spaces collapsed (owner, 2026-10-26).
        sql`(${drivers.firstName} || ' ' || ${drivers.lastName}) ilike ${`%${query.search.trim().replace(/\s+/g, ' ')}%`}`,
        ilike(drivers.lastName, term),
        ilike(drivers.driverNumber, term),
        ilike(drivers.email, term),
        ilike(drivers.phone, term),
      );
      if (match) filters.push(match);
    }
    const where = and(...filters);

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(drivers)
      .where(where);
    const total = counted?.count ?? 0;

    const rows = await this.db
      .select({ driver: drivers, unitNumber: trucks.unitNumber })
      .from(drivers)
      .leftJoin(trucks, eq(drivers.currentTruckId, trucks.id))
      .where(where)
      .orderBy(asc(drivers.lastName), asc(drivers.firstName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((row) => toDriverRecord(row.driver, row.unitNumber ?? null)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async find(principal: Principal, idOrNumber: string): Promise<DriverRecord | null> {
    const [row] = await this.db
      .select({ driver: drivers, unitNumber: trucks.unitNumber })
      .from(drivers)
      .leftJoin(trucks, eq(drivers.currentTruckId, trucks.id))
      .where(
        and(
          eq(drivers.companyId, principal.companyId),
          or(eq(drivers.id, idOrNumber), eq(drivers.driverNumber, idOrNumber)),
        ),
      )
      .limit(1);
    return row ? toDriverRecord(row.driver, row.unitNumber ?? null) : null;
  }

  async get(principal: Principal, idOrNumber: string): Promise<DriverRecord> {
    const driver = await this.find(principal, idOrNumber);
    if (!driver) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `No driver ${idOrNumber} on this roster`,
      });
    }
    return driver;
  }

  /**
   * The hire event's half of the person: the roster row, created with the id the qualification
   * file was keyed by at application time and linked to the employee the hire just made. The
   * qualification file is not opened here — it has existed since the application — so unlike
   * `create` this seeds no items.
   */
  async createForHire(
    principal: Principal,
    input: CreateDriverRequest & {
      reserved: { id: string; driverNumber: string };
      employeeId: string;
    },
  ): Promise<DriverRecord> {
    const email = input.email.trim().toLowerCase();
    const [taken] = await this.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.id, input.reserved.id))
      .limit(1);
    if (taken) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `Driver ${input.reserved.driverNumber} already exists on the roster`,
      });
    }
    const dispatcherName = input.dispatcherId ? await this.dispatcherName(input.dispatcherId) : null;
    const [inserted] = await this.db
      .insert(drivers)
      .values({
        id: input.reserved.id,
        companyId: principal.companyId,
        driverNumber: input.reserved.driverNumber,
        employeeId: input.employeeId,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone.trim(),
        ...secondaryPhoneColumns(input),
        email,
        driverType: input.driverType,
        cdlState: input.cdlState.trim().toUpperCase(),
        cdlClass: input.cdlClass,
        cdlEndorsements: input.cdlEndorsements,
        cdlExpiresOn: input.cdlExpiresOn,
        // The file already holds the verified documents; the roster mirrors what it knows.
        cdlStatus: 'verified',
        medicalCardExpiresOn: input.medicalCardExpiresOn ?? null,
        medicalCardStatus: input.medicalCardExpiresOn ? 'verified' : 'missing',
        // From the DOT application when it has one; a date the rule refuses never stops a hire,
        // it is simply not carried (the profile can record it afterwards).
        dateOfBirth:
          input.dateOfBirth && !dateOfBirthIssue(input.dateOfBirth, easternToday(new Date()))
            ? input.dateOfBirth
            : null,
        hireDate: input.hireDate,
        status: 'off_duty',
        dispatcherId: input.dispatcherId,
        dispatcherName: dispatcherName ?? 'Unassigned',
        currentTruckId: null,
        currentTrailerId: null,
        homeCity: input.homeCity.trim(),
        homeState: input.homeState.trim().toUpperCase(),
        safetyScore: '100',
        safetyEvents30d: 0,
        payPlanKind: input.payPlan.kind,
        payPlanRate: String(input.payPlan.rate),
        preferredLanguage: input.preferredLanguage,
      })
      .returning();
    if (!inserted) {
      throw new AppError({ status: 500, title: 'Internal Server Error', detail: 'Insert failed' });
    }
    return toDriverRecord(inserted, null);
  }

  async create(principal: Principal, input: CreateDriverRequest): Promise<DriverRecord> {
    const email = input.email.trim().toLowerCase();
    const dateOfBirth = checkedDateOfBirth(input.dateOfBirth, new Date());
    const [clash] = await this.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(
        and(eq(drivers.companyId, principal.companyId), sql`lower(${drivers.email}) = ${email}`),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A driver with the email ${email} is already on the roster`,
      });
    }

    const dispatcherName = input.dispatcherId
      ? await this.dispatcherName(input.dispatcherId)
      : null;

    // A board row named by the form must be this company's and still without a driver file.
    const boardRowId = input.boardRowId?.trim() || null;
    if (boardRowId) {
      const [row] = await this.db
        .select({ id: dispatchRoster.id, driverId: dispatchRoster.driverId })
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.id, boardRowId)))
        .limit(1);
      if (!row) {
        throw new AppError({ status: 404, title: 'Not Found', detail: 'That board row is not in this company' });
      }
      if (row.driverId) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'That board row already has a driver file. Reload the board and try again.',
        });
      }
    }

    // The next number is read and the row written under the same company-wide lock the hiring
    // funnel takes, so two people adding drivers at the same moment cannot be handed one number.
    // The unique index on (company, driver number) is the backstop, not the mechanism.
    const [inserted] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${principal.companyId}))`);
      const { id, driverNumber } = await this.nextDriverId(principal, tx);
      const written = await tx
        .insert(drivers)
        .values({
          id,
          companyId: principal.companyId,
          driverNumber,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          phone: input.phone.trim(),
          ...secondaryPhoneColumns(input),
          email,
          driverType: input.driverType,
          cdlState: input.cdlState.trim().toUpperCase(),
          cdlClass: input.cdlClass,
          cdlEndorsements: input.cdlEndorsements,
          cdlExpiresOn: input.cdlExpiresOn,
          // Missing, not verified: the date is a claim until the document is on file and checked.
          cdlStatus: 'missing',
          medicalCardExpiresOn: input.medicalCardExpiresOn ?? null,
          medicalCardStatus: 'missing',
          dateOfBirth,
          hireDate: input.hireDate,
          // Hired, not cleared: onboarding says why they cannot be dispatched, where off duty
          // would have said they simply were not working today.
          status: 'onboarding',
          dispatcherId: input.dispatcherId,
          dispatcherName: dispatcherName ?? 'Unassigned',
          currentTruckId: null,
          currentTrailerId: null,
          homeCity: input.homeCity.trim(),
          homeState: input.homeState.trim().toUpperCase(),
          safetyScore: '100',
          safetyEvents30d: 0,
          payPlanKind: input.payPlan.kind,
          payPlanRate: String(input.payPlan.rate),
          preferredLanguage: input.preferredLanguage,
        })
        .returning();
      // In the same transaction, so the board never makes a second row for the new file.
      if (written[0]) await this.linkBoardRow(principal, tx, written[0], boardRowId);
      return written;
    });

    if (!inserted) {
      throw new AppError({ status: 500, title: 'Internal Server Error', detail: 'Insert failed' });
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver',
      entityId: inserted.id,
      entityLabel: `${inserted.firstName} ${inserted.lastName}`,
      summary: `Driver ${inserted.driverNumber} added to the roster`,
      changes: [
        { field: 'driverNumber', old: null, new: inserted.driverNumber },
        { field: 'email', old: null, new: inserted.email },
        { field: 'hireDate', old: null, new: inserted.hireDate },
        ...(inserted.dateOfBirth ? [{ field: 'dateOfBirth', old: null, new: inserted.dateOfBirth }] : []),
      ],
    });
    // The qualification file opens with the driver: two claimed dates, nothing verified yet.
    await this.compliance.openItemsForNewDriver(principal, {
      id: inserted.id,
      name: `${inserted.firstName} ${inserted.lastName}`,
      cdlExpiresOn: input.cdlExpiresOn,
      medicalCardExpiresOn: input.medicalCardExpiresOn ?? null,
    });

    /*
     * And the onboarding plan opens with them too.
     *
     * A driver added from the roster used to get a qualification file and nothing else, while the
     * Onboarding board reads plans — which are keyed to an *employee*. So a driver hired through
     * recruiting appeared on the board and a driver typed into the roster never did: the person
     * who most needs chasing was the one nobody could see.
     *
     * The person comes first (a driver is an employee who drives), then the plan, then the link
     * back. A failure in any of it does not lose the driver that has already been written: the
     * roster row stands and the gap is reported rather than swallowed.
     */
    const employeeId = await this.openOnboarding(principal, inserted, input);
    // Hired for a unit: pair them now rather than sending somebody to a second screen.
    if (input.truckId) {
      const paired = await this.assignTruck(principal, inserted.id, input.truckId);
      return employeeId ? { ...paired, employeeId } : paired;
    }
    // Read back rather than patched: linking the employee moved updatedAt, the version an edit quotes.
    return this.get(principal, inserted.id);
  }

  /**
   * Links the new driver file to the Daily board row it was made for (owner, 2026-10-26).
   *
   * The board's quick "Create new driver" adds a row with no driver file, and loads can only be
   * assigned to a driver file - so the board showed a driver nobody could give a load. The row
   * named by the form is linked; without one, the single active unlinked row with the same name is.
   * Never a row that is already linked, never a guess between two rows of one name. The row keeps
   * its id (typed cells stay where they were) and its truck: a truck is paired by Assign, not here.
   */
  private async linkBoardRow(
    principal: Principal,
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    driver: { id: string; firstName: string; lastName: string },
    boardRowId: string | null,
  ): Promise<void> {
    const companyId = principal.companyId;
    let row: typeof dispatchRoster.$inferSelect | undefined;
    if (boardRowId) {
      [row] = await tx
        .select()
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.id, boardRowId)))
        .limit(1);
      if (!row || row.driverId) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'That board row already has a driver file. Reload the board and try again.',
        });
      }
    } else {
      const wanted = normalizeName(`${driver.firstName} ${driver.lastName}`);
      if (!wanted) return;
      const candidates = (
        await tx
          .select()
          .from(dispatchRoster)
          .where(
            and(
              eq(dispatchRoster.companyId, companyId),
              isNull(dispatchRoster.driverId),
              isNull(dispatchRoster.unassignedAt),
            ),
          )
      ).filter((r) => normalizeName(r.name.split('//')[0] ?? r.name) === wanted);
      if (candidates.length !== 1) return;
      row = candidates[0];
    }
    if (!row) return;
    const now = new Date();
    const [linked] = await tx
      .update(dispatchRoster)
      .set({ driverId: driver.id, updatedAt: now, version: row.version + 1 })
      .where(
        and(
          eq(dispatchRoster.companyId, companyId),
          eq(dispatchRoster.id, row.id),
          eq(dispatchRoster.version, row.version),
          isNull(dispatchRoster.driverId),
        ),
      )
      .returning({ id: dispatchRoster.id });
    if (!linked) {
      if (boardRowId) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'That board row was changed by someone else. Reload the board and try again.',
        });
      }
      return;
    }
    await dispatchAuditEntry(tx, principal, now, 'roster', row.id, 'link-on-create', { driverId: null }, { driverId: driver.id });
  }

  /**
   * The employee record and the onboarding plan behind a new driver.
   *
   * Returns the employee id when both were made, so the roster row can point at the person. Every
   * failure is reported and none of them is fatal: a driver on the roster with no plan is a gap
   * somebody can close by hand, a driver lost because a plan could not be built is not.
   */
  private async openOnboarding(
    principal: Principal,
    driver: { id: string; firstName: string; lastName: string; email: string; phone: string },
    input: CreateDriverRequest,
  ): Promise<string | null> {
    try {
      const employee = await this.employees.create(principal, {
        firstName: driver.firstName,
        middleName: null,
        lastName: driver.lastName,
        preferredName: null,
        workEmail: driver.email,
        personalEmail: null,
        phone: driver.phone,
        secondaryPhone: null,
        department: 'dispatch',
        position: 'Driver',
        managerEmployeeId: null,
        location: `${input.homeCity.trim()}, ${input.homeState.trim().toUpperCase()}`,
        hireDate: input.hireDate,
        // An owner-operator is a contractor; a company driver is not. Settlements read the pay
        // plan on the driver, never a second rate here.
        employmentType: input.driverType === 'company' ? 'full_time' : 'contractor',
        payType: null,
        payRate: null,
        timezone: 'America/Chicago',
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelationship: null,
        notes: 'Added to the roster; onboarding opened with the driver.',
      });

      await this.db
        .update(drivers)
        .set({ employeeId: employee.id, updatedAt: new Date() })
        .where(eq(drivers.id, driver.id));

      await this.onboarding.createForHire(principal, {
        employeeId: employee.id,
        position: 'Driver',
        department: 'dispatch',
        startDate: input.hireDate,
        templateId: null,
        ownerEmployeeId: null,
        driverType: input.driverType,
        driverId: driver.id,
      });
      return employee.id;
    } catch (error) {
      this.logger.error(
        { err: error, driverId: driver.id },
        'Driver created, but onboarding could not be opened',
      );
      return null;
    }
  }

  /**
   * Puts a driver in a truck, or takes them out of one (the driver page, a hire with a unit).
   *
   * Goes through the assignment record (0047): the open `truck_driver_assignments` row is the
   * pairing, and `AssignmentsService` writes it, both pointers, the rows it closes and the audit
   * entries in one transaction — the same path the truck page uses, so the two pages can never
   * disagree about who is in a unit.
   */
  async assignTruck(
    principal: Principal,
    idOrNumber: string,
    truckId: string | null,
  ): Promise<DriverRecord> {
    const driver = await this.get(principal, idOrNumber);
    if (truckId === null) {
      await this.assignments.releaseDriver(
        principal,
        driver.id,
        'Taken out of the unit from the driver page',
      );
      return this.get(principal, driver.id);
    }
    const next = await this.truckRow(principal, truckId);
    if (!next) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No truck ${truckId}` });
    }
    if (next.id === driver.currentTruckId) return driver;
    await this.assignments.assign(
      principal,
      next.id,
      {
        driverId: driver.id,
        assignedOn: easternToday(new Date()),
        equipment: [],
        note: null,
        pickupPhotoIds: [],
      },
      'driver_page',
    );
    return this.get(principal, driver.id);
  }

  private async truckRow(principal: Principal, idOrUnit: string) {
    const [row] = await this.db
      .select()
      .from(trucks)
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          or(eq(trucks.id, idOrUnit), eq(trucks.unitNumber, idOrUnit)),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async update(
    principal: Principal,
    idOrNumber: string,
    patch: UpdateDriverRequest,
  ): Promise<DriverRecord> {
    const existing = await this.get(principal, idOrNumber);
    const now = new Date();
    const dateOfBirth =
      patch.dateOfBirth !== undefined ? checkedDateOfBirth(patch.dateOfBirth, now) : undefined;

    if (patch.email && patch.email.trim().toLowerCase() !== existing.email.toLowerCase()) {
      const email = patch.email.trim().toLowerCase();
      const [clash] = await this.db
        .select({ id: drivers.id })
        .from(drivers)
        .where(
          and(
            eq(drivers.companyId, principal.companyId),
            sql`lower(${drivers.email}) = ${email}`,
            not(eq(drivers.id, existing.id)),
          ),
        )
        .limit(1);
      if (clash) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `A driver with the email ${email} is already on the roster`,
        });
      }
    }

    const dispatcherName =
      patch.dispatcherId !== undefined
        ? ((await this.dispatcherName(patch.dispatcherId)) ?? 'Unassigned')
        : undefined;
    const scope = and(eq(drivers.companyId, principal.companyId), eq(drivers.id, existing.id));

    /*
     * One transaction: the row is locked, the version the editor read is checked against it, the
     * write and its audit entry commit together. A stale save is a 409, never a silent overwrite.
     */
    const outcome = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ updatedAt: drivers.updatedAt })
        .from(drivers)
        .where(scope)
        .for('update');
      if (!locked) return { kind: 'missing' as const };
      if (patch.expectedUpdatedAt !== undefined) {
        const read = Date.parse(patch.expectedUpdatedAt);
        if (!Number.isFinite(read) || read !== locked.updatedAt.getTime()) {
          return { kind: 'stale' as const };
        }
      }
      const [row] = await tx
        .update(drivers)
        .set({
        ...(patch.firstName !== undefined ? { firstName: patch.firstName.trim() } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName.trim() } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone.trim() } : {}),
        ...(patch.secondaryPhone !== undefined || patch.secondaryPhoneLabel !== undefined
          ? secondaryPhoneColumns({
              secondaryPhone: patch.secondaryPhone ?? existing.secondaryPhone,
              secondaryPhoneLabel:
                patch.secondaryPhoneLabel ??
                (existing.secondaryPhoneLabel as CreateDriverRequest['secondaryPhoneLabel']),
            })
          : {}),
        ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
        ...(patch.driverType !== undefined ? { driverType: patch.driverType } : {}),
        ...(patch.cdlState !== undefined ? { cdlState: patch.cdlState.trim().toUpperCase() } : {}),
        ...(patch.cdlClass !== undefined ? { cdlClass: patch.cdlClass } : {}),
        ...(patch.cdlEndorsements !== undefined ? { cdlEndorsements: patch.cdlEndorsements } : {}),
        ...(patch.cdlExpiresOn !== undefined ? { cdlExpiresOn: patch.cdlExpiresOn } : {}),
        ...(patch.medicalCardExpiresOn !== undefined
          ? { medicalCardExpiresOn: patch.medicalCardExpiresOn }
          : {}),
        ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
        ...(patch.hireDate !== undefined ? { hireDate: patch.hireDate } : {}),
        ...(patch.dispatcherId !== undefined
          ? { dispatcherId: patch.dispatcherId, dispatcherName: dispatcherName ?? 'Unassigned' }
          : {}),
        ...(patch.homeCity !== undefined ? { homeCity: patch.homeCity.trim() } : {}),
        ...(patch.homeState !== undefined
          ? { homeState: patch.homeState.trim().toUpperCase() }
          : {}),
        ...(patch.payPlan !== undefined
          ? { payPlanKind: patch.payPlan.kind, payPlanRate: String(patch.payPlan.rate) }
          : {}),
        ...(patch.preferredLanguage !== undefined
          ? { preferredLanguage: patch.preferredLanguage }
          : {}),
        updatedAt: now,
      })
        .where(scope)
        .returning();
      if (!row) return { kind: 'missing' as const };
      const after = toDriverRecord(row, existing.currentTruckUnit);
      const changes = AUDITED_FIELDS.flatMap(([field]) => {
        const old = auditText(existing[field]);
        const next = auditText(after[field]);
        return old === next ? [] : [{ field, old, new: next }];
      });
      if (changes.length === 0) return { kind: 'ok' as const, event: null };
      const labels = new Map<string, string>(AUDITED_FIELDS);
      const event = await this.audit.writeIn(tx, principal, {
        action: 'update',
        entityType: 'driver',
        entityId: existing.id,
        entityLabel: `${row.firstName} ${row.lastName}`,
        summary: `Driver profile edited: ${changes.map((c) => labels.get(c.field) ?? c.field).join(', ')}`,
        changes,
        at: now,
      });
      return { kind: 'ok' as const, event };
    });

    if (outcome.kind === 'missing') {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No driver ${idOrNumber}` });
    }
    if (outcome.kind === 'stale') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${existing.name} was changed by someone else. Reload the driver and try again.`,
      });
    }
    if (outcome.event) await this.audit.publish(outcome.event);
    return this.get(principal, existing.id);
  }

  /**
   * Terminating releases the unit the driver was on, in the same transaction. A terminated driver
   * still holding a truck is how a unit ends up unassignable with nobody able to say why.
   */
  async setStatus(
    principal: Principal,
    idOrNumber: string,
    status: DriverRecord['status'],
    reason: string | null = null,
  ): Promise<DriverRecord> {
    const existing = await this.get(principal, idOrNumber);
    // A dispatch lead without drivers.edit may only send on vacation and bring back (owner, 2026-10-17).
    if (!principal.permissions.has('drivers.edit')) {
      const vacationMove = (status === 'vacation' && ['available', 'off_duty'].includes(existing.status)) || (existing.status === 'vacation' && status === 'available');
      if (!vacationMove) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Changing a driver status needs drivers.edit.' });
    }
    const now = new Date();
    const by = principal.userName ?? principal.userId;

    const released = await this.db.transaction(async (tx) => {
      await tx
        .update(drivers)
        .set({ status, updatedAt: now })
        .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, existing.id)));

      // Vacation (owner, 2026-10-16): the days away count from here; coming back closes it.
      if (status === 'vacation' && existing.status !== 'vacation') {
        await tx.insert(driverVacations).values({ id: `dvac_${crypto.randomUUID()}`, companyId: principal.companyId, driverId: existing.id, startedOn: easternToday(now), note: reason, startedBy: by, createdAt: now, updatedAt: now });
      } else if (existing.status === 'vacation' && status !== 'vacation') {
        await tx
          .update(driverVacations)
          .set({ endedOn: easternToday(now), endedBy: by, updatedAt: now })
          // Only an actual vacation closes; a driver-app request that has not started stays as it is (0082).
          .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, existing.id), isNull(driverVacations.endedOn), isNull(driverVacations.cancelledAt), or(isNull(driverVacations.requestStatus), eq(driverVacations.requestStatus, 'started'))));
      }

      // The assignment record closes with the pointers (0047), in this same transaction.
      if (status === 'terminated') {
        return this.assignments.releaseDriverIn(tx, principal, existing.id, 'Driver terminated', now);
      }
      return [];
    });
    await this.audit.publish(...released);

    // The one event the hiring funnel reads from the roster: a hired driver's first dispatch.
    if (existing.status !== status) {
      await this.audit.write(principal, {
        action: 'status_change',
        entityType: 'driver',
        entityId: existing.id,
        entityLabel: `${existing.firstName} ${existing.lastName}`,
        summary: `Status: ${existing.status} → ${status}${reason ? ` · ${reason}` : ''}`,
        changes: [{ field: 'status', old: existing.status, new: status }],
        at: now,
      });
    }

    return this.get(principal, existing.id);
  }

  /**
   * Brings an archived driver back (the Drivers page's Archived tab). The archive time the page
   * read is the version check; the board row the archive took off comes back with the file.
   */
  async restoreArchived(
    principal: Principal,
    idOrNumber: string,
    expectedArchivedAt: string,
  ): Promise<DriverRecord> {
    const existing = await this.get(principal, idOrNumber);
    const actor = {
      userId: principal.userId,
      userName: principal.userName ?? principal.userId,
      actorType: 'user' as const,
    };
    const result = await this.db.transaction((tx) =>
      restoreArchivedDriver(tx, principal.companyId, existing.id, actor, new Date(), expectedArchivedAt),
    );
    if (result && 'conflict' in result) {
      throw new AppError({ status: 409, title: 'Conflict', detail: result.conflict });
    }
    return this.get(principal, existing.id);
  }

  private async dispatcherName(dispatcherId: string): Promise<string | null> {
    // A dispatcher is an employee (2026-09-21); the name is theirs. A driver written before that
    // carries an id from the older list, whose name lives only on the driver rows.
    const [employee] = await this.db
      .select({
        first: employees.firstName,
        last: employees.lastName,
        preferred: employees.preferredName,
      })
      .from(employees)
      .where(eq(employees.id, dispatcherId))
      .limit(1);
    if (employee) return `${employee.preferred?.trim() || employee.first} ${employee.last}`.trim();
    const [row] = await this.db
      .select({ name: drivers.dispatcherName })
      .from(drivers)
      .where(eq(drivers.dispatcherId, dispatcherId))
      .limit(1);
    return row?.name ?? null;
  }

  /**
   * Reserves the next driver id for a candidate whose qualification file opens before they are
   * hired. The roster row is created with this id at the hire, so the file never changes key.
   */
  async reserveDriverId(principal: Principal): Promise<{ id: string; driverNumber: string }> {
    return this.nextDriverId(principal);
  }

  /**
   * Reserves the next id *and* writes it onto the hiring case in one transaction, under a
   * company-wide advisory lock, so two applications submitted at the same moment cannot be
   * handed the same number. Returns the id the case now carries (its existing one, if any).
   */
  async reserveDriverIdFor(
    principal: Principal,
    hiringCaseId: string,
  ): Promise<{ id: string; driverNumber: string }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${principal.companyId}))`);
      const [current] = await tx
        .select({ driverId: hiringCases.driverId })
        .from(hiringCases)
        .where(
          and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, hiringCaseId)),
        )
        .limit(1);
      if (current?.driverId) {
        return { id: current.driverId, driverNumber: `D-${current.driverId.match(/(\d+)$/)?.[1] ?? current.driverId.replace(/^drv_/, '')}` };
      }
      const digits = (column: unknown) =>
        sql`max(nullif(regexp_replace(${column}, '\\D', '', 'g'), '')::bigint)`;
      const [highest] = await tx
        .select({
          value: sql<number>`greatest(
            coalesce((select ${digits(drivers.driverNumber)} from ${drivers} where ${drivers.companyId} = ${principal.companyId}), 0),
            coalesce((select ${digits(hiringCases.driverId)} from ${hiringCases} where ${hiringCases.companyId} = ${principal.companyId} and ${hiringCases.driverId} like 'drv\\_%'), 0)
          )::int`,
        })
        .from(sql`(select 1) as one`);
      const next = Math.max(highest?.value ?? 0, 2000) + 1;
      const reserved = { id: await this.globalDriverId(principal, next, tx), driverNumber: `D-${next}` };
      await tx
        .update(hiringCases)
        .set({ driverId: reserved.id, updatedAt: new Date() })
        .where(eq(hiringCases.id, hiringCaseId));
      return reserved;
    });
  }

  private async nextDriverId(
    principal: Principal,
    db: Pick<typeof this.db, 'select'> = this.db,
  ): Promise<{ id: string; driverNumber: string }> {
    // A candidate's reserved id (on the hiring case) counts too, so a walk-in added from the
    // roster form cannot take a number the funnel has already promised.
    const digits = (column: unknown) =>
      sql`max(nullif(regexp_replace(${column}, '\\D', '', 'g'), '')::bigint)`;
    const [highest] = await db
      .select({
        value: sql<number>`greatest(
          coalesce((select ${digits(drivers.driverNumber)} from ${drivers} where ${drivers.companyId} = ${principal.companyId}), 0),
          coalesce((select ${digits(hiringCases.driverId)} from ${hiringCases} where ${hiringCases.companyId} = ${principal.companyId} and ${hiringCases.driverId} like 'drv\\_%'), 0)
        )::int`,
      })
      .from(sql`(select 1) as one`);
    // The roster numbers drivers D-2031 upward and ids follow the same digits, so a new hire
    // continues that sequence rather than starting a second, competing one.
    const next = Math.max(highest?.value ?? 0, 2000) + 1;
    return { id: await this.globalDriverId(principal, next, db), driverNumber: `D-${next}` };
  }

  /**
   * Ids are global, numbers per company: a second company's D-2001 cannot reuse another company's
   * drv_2001 (owner, 2026-10-12: Harbor Line could not add anyone), so it takes a company prefix.
   */
  private async globalDriverId(principal: Principal, next: number, db: Pick<typeof this.db, 'select'> = this.db): Promise<string> {
    const plain = `drv_${next}`;
    const [onRoster] = await db.select({ id: drivers.id }).from(drivers).where(eq(drivers.id, plain)).limit(1);
    const [reserved] = await db.select({ id: hiringCases.id }).from(hiringCases).where(and(eq(hiringCases.driverId, plain), ne(hiringCases.companyId, principal.companyId))).limit(1);
    return onRoster || reserved ? `drv_${principal.companyId.replace(/^co_/, '')}_${next}` : plain;
  }
}
