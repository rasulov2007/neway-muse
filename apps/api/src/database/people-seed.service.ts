import { Injectable } from '@nestjs/common';
import { eq, isNull, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from './database.service';
import { employees, positionHistory } from './schema/people';
import { drivers } from './schema/roster';
import { ROSTER_SEED } from './seed/roster.seed';
import { STAFF_SEED } from './seed/staff.seed';

/**
 * Builds the employee record for people this carrier already has.
 *
 * Nothing here invents a person. There are exactly two populations already in the system and each
 * gets one employee record:
 *
 *   staff   — the twelve people who hold accounts. Their `user_id` links the account to the person.
 *   drivers — the seventy driving profiles. `drivers.employee_id` links the profile to the person.
 *
 * The join is a link, never a copy: an employee does not hold a CDL number and a driver does not
 * hold a department. Each fact lives in exactly one of the two records.
 *
 * Like the roster import this runs once, conditional on the table being empty, and is never an
 * upsert. Re-running it on a live database would overwrite real HR edits with derived values.
 */
@Injectable()
export class PeopleSeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PeopleSeedService.name);
  }

  async seed(): Promise<{ seeded: boolean; employees: number }> {
    const db = this.database.db;
    const companyId = ROSTER_SEED.company.id;

    const [existing] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(employees)
      .where(eq(employees.companyId, companyId));
    if ((existing?.value ?? 0) > 0) {
      this.logger.info(
        { employees: existing?.value ?? 0 },
        'Employees already present; nothing imported',
      );
      return { seeded: false, employees: existing?.value ?? 0 };
    }

    // Managers must exist before the people who report to them can point at them, so staff are
    // written first and the manager link is applied in a second pass.
    let sequence = 1000;
    const nextId = () => {
      sequence += 1;
      return { id: `emp_${sequence}`, employeeNumber: `EMP-${sequence}` };
    };

    const staffRows = STAFF_SEED.map((person) => {
      const { id, employeeNumber } = nextId();
      return {
        seedId: person.userId,
        managerSeedId: person.managerUserId,
        row: {
          id,
          companyId,
          employeeNumber,
          firstName: person.firstName,
          middleName: null,
          lastName: person.lastName,
          preferredName: null,
          workEmail: person.email.toLowerCase(),
          personalEmail: null,
          phone: person.phone,
          secondaryPhone: null,
          department: person.department,
          position: person.title,
          managerEmployeeId: null as string | null,
          location: person.location,
          hireDate: person.hireDate,
          terminationDate: null,
          status: person.active ? 'active' : 'suspended',
          employmentType: 'full_time',
          // Salaries are not on file for these people. Null says so; a number would be invented.
          payType: null,
          payRate: null,
          timezone: 'America/New_York',
          userId: person.userId,
          emergencyContact: null,
          notes: null,
        },
      };
    });

    const driverRows = ROSTER_SEED.drivers.map((driver) => {
      const { id, employeeNumber } = nextId();
      return {
        driverId: driver.id,
        dispatcherUserId: driver.dispatcherId,
        row: {
          id,
          companyId,
          employeeNumber,
          firstName: driver.firstName,
          middleName: null,
          lastName: driver.lastName,
          preferredName: null,
          workEmail: driver.email.toLowerCase(),
          personalEmail: null,
          phone: driver.phone,
          secondaryPhone: null,
          department: 'dispatch',
          position: 'Driver',
          managerEmployeeId: null as string | null,
          location: `${driver.homeCity}, ${driver.homeState}`,
          hireDate: driver.hireDate,
          terminationDate: driver.status === 'terminated' ? driver.hireDate : null,
          status: employmentStatusFor(driver.status),
          // An owner-operator drives under contract; a company driver is employed. The distinction
          // decides tax treatment, so it is carried across rather than flattened.
          employmentType: driver.driverType === 'company' ? 'full_time' : 'contractor',
          // Deliberately absent: a driver is paid from the pay plan on their driving profile, and a
          // second rate here would be a second answer to what they earn.
          payType: null,
          payRate: null,
          timezone: 'America/New_York',
          userId: null,
          emergencyContact: null,
          notes: null,
        },
      };
    });

    await db.transaction(async (tx) => {
      await tx
        .insert(employees)
        .values([...staffRows.map((s) => s.row), ...driverRows.map((d) => d.row)]);

      const byUserId = new Map(staffRows.map((s) => [s.seedId, s.row.id]));

      for (const staff of staffRows) {
        if (!staff.managerSeedId) continue;
        const managerId = byUserId.get(staff.managerSeedId);
        if (!managerId) continue;
        await tx
          .update(employees)
          .set({ managerEmployeeId: managerId })
          .where(eq(employees.id, staff.row.id));
      }

      // A driver's manager is their dispatcher — the relationship the load board already uses.
      for (const driver of driverRows) {
        const managerId = byUserId.get(driver.dispatcherUserId);
        if (managerId) {
          await tx
            .update(employees)
            .set({ managerEmployeeId: managerId })
            .where(eq(employees.id, driver.row.id));
        }
        await tx
          .update(drivers)
          .set({ employeeId: driver.row.id })
          .where(eq(drivers.id, driver.driverId));
      }

      // Each employment record opens on the day the person was hired.
      const all = [...staffRows.map((s) => s.row), ...driverRows.map((d) => d.row)];
      await tx.insert(positionHistory).values(
        all.map((row) => ({
          id: `poh_${row.id}_1`,
          companyId,
          employeeId: row.id,
          position: row.position,
          department: row.department,
          managerEmployeeId: null,
          location: row.location,
          effectiveFrom: row.hireDate,
          effectiveTo: null,
          reason: 'Hired',
        })),
      );
    });

    const total = staffRows.length + driverRows.length;
    this.logger.info(
      { staff: staffRows.length, drivers: driverRows.length },
      'Employees built for the people already on file',
    );
    return { seeded: true, employees: total };
  }

  /** Drivers with no employee record, which is how a link would silently go missing. */
  async unlinkedDrivers(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: sql<number>`count(*)::int` })
      .from(drivers)
      .where(isNull(drivers.employeeId));
    return row?.value ?? 0;
  }
}

/**
 * A driver's availability is not their employment status.
 *
 * `off_duty` means they are not driving right now; it does not mean they are not employed. Only
 * `terminated` and `suspended` say anything about the employment relationship, and everything else
 * maps to active.
 */
function employmentStatusFor(driverStatus: string): string {
  if (driverStatus === 'terminated') return 'terminated';
  if (driverStatus === 'suspended') return 'suspended';
  if (driverStatus === 'inactive') return 'on_leave';
  return 'active';
}
