import { Injectable } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import type { DriverDispatchContact } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships } from '../../database/schema/admin';
import { trailers } from '../../database/schema/fleet';
import { employees } from '../../database/schema/people';
import { companies, drivers, trucks } from '../../database/schema/roster';

export type DriverRow = typeof drivers.$inferSelect;
export type TruckRow = typeof trucks.$inferSelect;
export type TrailerRow = typeof trailers.$inferSelect;

/** Who the driver app is acting for, resolved on the server for every request. */
export interface DriverContext {
  companyId: string;
  companyName: string;
  companyTimezone: string;
  membershipId: string;
  driverId: string;
  driverName: string;
  driver: DriverRow;
  truck: TruckRow | null;
  trailer: TrailerRow | null;
}

const NOT_A_DRIVER = () =>
  new AppError({ status: 403, title: 'Forbidden', detail: 'This account is not linked to a driver. Ask the office to give you driver app access.' });

/**
 * principal.membershipId → memberships.driver_id → the `drivers` row in principal.companyId.
 *
 * The only way any `/driver/*` route learns who the driver is. Nothing the phone sends (a driver
 * id, a company id) is ever read for this; a membership with no driver link, a link to a driver
 * of another company or an archived driver gets 403.
 */
@Injectable()
export class DriverContextService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(principal: Principal): Promise<DriverContext> {
    const db = this.database.db;
    if (!principal.membershipId) throw NOT_A_DRIVER();
    const [member] = await db
      .select({ driverId: memberships.driverId, companyName: companies.name, companyTimezone: companies.timezone })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(and(eq(memberships.id, principal.membershipId), eq(memberships.companyId, principal.companyId), eq(memberships.status, 'active')))
      .limit(1);
    if (!member?.driverId) throw NOT_A_DRIVER();
    const [driver] = await db
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, member.driverId)))
      .limit(1);
    if (!driver || driver.archivedAt) throw NOT_A_DRIVER();

    // The truck that names this driver; the driver's own pointer when no truck does.
    const truckRows = await db
      .select()
      .from(trucks)
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          driver.currentTruckId ? or(eq(trucks.currentDriverId, driver.id), eq(trucks.id, driver.currentTruckId)) : eq(trucks.currentDriverId, driver.id),
        ),
      );
    const truck = truckRows.find((t) => t.currentDriverId === driver.id) ?? truckRows[0] ?? null;
    const trailerId = driver.currentTrailerId ?? truck?.currentTrailerId ?? null;
    const [trailer] = trailerId
      ? await db.select().from(trailers).where(and(eq(trailers.companyId, principal.companyId), eq(trailers.id, trailerId))).limit(1)
      : [];
    return {
      companyId: principal.companyId,
      companyName: member.companyName,
      companyTimezone: member.companyTimezone || 'America/New_York',
      membershipId: principal.membershipId,
      driverId: driver.id,
      driverName: `${driver.firstName} ${driver.lastName}`.trim(),
      driver,
      truck,
      trailer: trailer ?? null,
    };
  }

  /** The driver's dispatcher, with a phone and email when the workforce record has them. */
  async dispatchContact(companyId: string, dispatcherId: string | null | undefined, dispatcherName: string | null | undefined): Promise<DriverDispatchContact | null> {
    if (!dispatcherId && !dispatcherName) return null;
    const [person] = dispatcherId
      ? await this.database.db
          .select({ phone: employees.phone, email: employees.workEmail, firstName: employees.firstName, lastName: employees.lastName })
          .from(employees)
          .where(and(eq(employees.companyId, companyId), or(eq(employees.id, dispatcherId), eq(employees.userId, dispatcherId))))
          .limit(1)
      : [];
    return {
      name: dispatcherName?.trim() || (person ? `${person.firstName} ${person.lastName}`.trim() : 'Dispatch'),
      phone: person?.phone?.trim() || null,
      email: person?.email?.trim() || null,
    };
  }
}

/** The company's (Eastern) day for an instant. */
export function companyDay(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
