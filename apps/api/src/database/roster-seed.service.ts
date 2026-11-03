import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from './database.service';
import { companies, drivers, trucks } from './schema/roster';
import { ROSTER_SEED } from './seed/roster.seed';

/**
 * Brings the database up to the current schema, then imports the roster once.
 *
 * The import is conditional on the table being empty and is never an upsert. A carrier that has
 * been running for a week has real edits in these rows — a corrected VIN, a reassigned driver — and
 * re-applying a seed on every boot would quietly revert them. Empty means "this database has never
 * held the roster"; anything else means somebody's data is in there and it is not ours to rewrite.
 */
@Injectable()
export class RosterSeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RosterSeedService.name);
  }

  /** Applies pending migrations. Every migration this project generates is additive. */
  async migrate(): Promise<void> {
    // The SQL is copied into dist beside this file by the nest-cli asset rule.
    await migrate(this.database.db, { migrationsFolder: join(__dirname, 'migrations') });
    this.logger.info('Database migrations are up to date');
  }

  /**
   * The company row, whether or not the demo roster follows it.
   *
   * An upsert: it is configuration, not operational data, and every foreign key in the schema
   * needs it to exist before anything else can be written — including the accounts a database
   * with no demo data still has to hold. Runs on every boot; a row somebody has renamed since is
   * left as it is.
   */
  async ensureCompany(): Promise<void> {
    const seed = ROSTER_SEED;
    await this.database.db
      .insert(companies)
      .values({
        id: seed.company.id,
        name: seed.company.name,
        timezone: seed.company.timezone,
        weekStart: seed.company.weekStart,
      })
      .onConflictDoNothing({ target: companies.id });
  }

  async seed(): Promise<{ seeded: boolean; trucks: number; drivers: number }> {
    const db = this.database.db;
    const seed = ROSTER_SEED;

    await this.ensureCompany();

    const [truckCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(trucks)
      .where(sql`${trucks.companyId} = ${seed.company.id}`);
    const [driverCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(drivers)
      .where(sql`${drivers.companyId} = ${seed.company.id}`);

    if ((truckCount?.count ?? 0) > 0 || (driverCount?.count ?? 0) > 0) {
      this.logger.info(
        { trucks: truckCount?.count ?? 0, drivers: driverCount?.count ?? 0 },
        'Roster already present; nothing imported',
      );
      return { seeded: false, trucks: truckCount?.count ?? 0, drivers: driverCount?.count ?? 0 };
    }

    // Drivers first: a truck's `current_driver_id` points at one, and both sides are written in the
    // same transaction so the pairing cannot end up half-applied.
    await db.transaction(async (tx) => {
      await tx.insert(drivers).values(
        seed.drivers.map((driver) => ({
          id: driver.id,
          companyId: seed.company.id,
          driverNumber: driver.driverNumber,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          email: driver.email,
          driverType: driver.driverType,
          cdlState: driver.cdlState,
          cdlClass: driver.cdlClass,
          cdlEndorsements: driver.cdlEndorsements,
          cdlExpiresOn: driver.cdlExpiresOn,
          cdlStatus: driver.cdlStatus,
          medicalCardExpiresOn: driver.medicalCardExpiresOn,
          medicalCardStatus: driver.medicalCardStatus,
          hireDate: driver.hireDate,
          status: driver.status,
          dispatcherId: driver.dispatcherId,
          dispatcherName: driver.dispatcherName,
          currentTruckId: driver.currentTruckId,
          currentTrailerId: driver.currentTrailerId,
          homeCity: driver.homeCity,
          homeState: driver.homeState,
          safetyScore: String(driver.safetyScore),
          safetyEvents30d: driver.safetyEvents30d,
          payPlanKind: driver.payPlan.kind,
          payPlanRate: String(driver.payPlan.rate),
          preferredLanguage: driver.preferredLanguage,
        })),
      );

      await tx.insert(trucks).values(
        seed.trucks.map((truck) => ({
          id: truck.id,
          companyId: seed.company.id,
          unitNumber: truck.unitNumber,
          vin: truck.vin,
          year: truck.year,
          make: truck.make,
          model: truck.model,
          plate: truck.plate,
          plateState: truck.plateState,
          color: truck.color,
          status: truck.status,
          health: truck.health,
          ownership: truck.ownership,
          odometer: truck.odometer,
          odometerAt: new Date(truck.odometerAt),
          engineHours: String(truck.engineHours),
          inServiceDate: truck.inServiceDate,
          currentDriverId: truck.currentDriverId,
          currentTrailerId: truck.currentTrailerId,
          currentLoadId: truck.currentLoadId,
          location: truck.location,
          nextServiceOdometer: truck.nextServiceOdometer,
          nextServiceDate: truck.nextServiceDate,
          nextServiceType: truck.nextServiceType,
          telematicsProvider: truck.telematicsProvider,
          telematicsStatus: truck.telematicsStatus,
          mpg30d: String(truck.mpg30d),
          mpg90d: String(truck.mpg90d),
          idlePercent30d: String(truck.idlePercent30d),
          idlePercent90d: String(truck.idlePercent90d),
          homeTerminal: truck.homeTerminal,
        })),
      );
    });

    this.logger.info(
      { trucks: seed.trucks.length, drivers: seed.drivers.length },
      'Roster imported into an empty database',
    );
    return { seeded: true, trucks: seed.trucks.length, drivers: seed.drivers.length };
  }
}
