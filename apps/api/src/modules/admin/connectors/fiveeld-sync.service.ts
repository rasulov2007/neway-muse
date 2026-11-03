import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  FIRST_SERVICE_DAYS,
  FIRST_SERVICE_INTERVAL_MILES,
  SYNC_INACTIVE_AFTER_DAYS,
  type SyncReport,
  type SyncRequest,
  type SyncSummary,
} from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { integrationAccounts, integrationSyncRuns } from '../../../database/schema/admin';
import { trucks } from '../../../database/schema/roster';
import { isFeatureEnabled } from '../../../common/flags/flags';
import { AuditService } from '../../people/audit.service';
import { PmService } from '../../pm/pm.service';
import { decrypt, type SealedCredential } from '../credential-vault';
import { FiveEldClient, FiveEldError, type FiveEldUnit, type FiveEldUnitPosition } from './fiveeld.client';
import {
  FIVEELD_LABEL,
  FIVEELD_PROVIDER,
  planFiveEldSync,
  readFiveEldVehicle,
  toPlannerStats,
  trucksWithNewerReport,
  type FiveEldOdometerUnit,
  type FiveEldReading,
} from './fiveeld-sync.plan';
import { toTruckLocation, type PlannedCreate, type SyncPlan, type TruckSnapshot } from './samsara-sync.plan';

/** How far back a vehicle is looked for (the planner's own inactive window); the fallback list's window too. */
const ACTIVE_WINDOW_DAYS = SYNC_INACTIVE_AFTER_DAYS;
/** The window a position refresh reads; two hours covers the hourly timer with slack. */
const POSITION_WINDOW_HOURS = 2;
/**
 * A pause between any two history requests. Five ELD answered 429 to a 100-truck fleet paced at
 * 150 ms (production, 2026-10-21); a second apart it keeps up. A vehicle that moved in the last day
 * costs one request; a parked one walks back in 72-hour slices until a real odometer turns up
 * (a truck parked five days: three requests); a silent one costs up to eleven, once per sync.
 */
const PACE_MS = 1_000;

/**
 * One Five ELD account, synced into the roster. The Samsara and Motive connectors' sibling.
 *
 * Reads every vehicle on the account (`current-units`, parked ones included), then per vehicle the
 * newest tracking point of the last day — further back for a parked one — asks the shared planner what that means for the
 * trucks, and either reports the plan (a preview) or applies it. Every applied change is an audit
 * entry naming the truck and the account; the run is a row with its counts; the account's status
 * is what Five ELD's answer earned it — `connected` after a good one, `error` after refused
 * credentials, with the message kept.
 *
 * Read-only toward Five ELD. The key and the token are opened here, handed to the client, and
 * dropped: not logged, not kept on this object, not part of any error this class throws.
 *
 * A vehicle silent in the last day, or whose last-day points carry no odometer (or `odometer: 0`),
 * is walked back in 72-hour slices to the inactive window, so a parked truck still gets its last
 * real odometer and its last position.
 */
@Injectable()
export class FiveEldSyncService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly pm: PmService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Asks Five ELD for yesterday's active vehicles — the cheapest valid request — and records the answer. */
  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const account = await this.account(principal, accountId);
    const client = this.client(account.credentials, account.config);
    try {
      const now = new Date();
      const { units, source } = await client.listUnits(new Date(now.getTime() - 86_400_000), now);
      const organisation = `USDOT ${account.config.usdot} (${units.length} vehicle${units.length === 1 ? '' : 's'} ${source === 'current-units' ? 'on the account' : 'active in the last day'})`;
      await this.db
        .update(integrationAccounts)
        .set({
          status: 'connected',
          externalName: organisation,
          lastError: null,
          errorCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(integrationAccounts.id, account.id));
      return { organisation };
    } catch (error) {
      await this.recordFailure(account.id, error);
      throw this.asAppError(error);
    }
  }

  async sync(principal: Principal, accountId: string, request: SyncRequest): Promise<SyncReport> {
    const account = await this.account(principal, accountId);
    if (account.status === 'disabled') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${account.name} is disabled. Enable it before syncing.`,
      });
    }
    const client = this.client(account.credentials, account.config);
    const startedAt = new Date();
    const inactiveAfterDays = numberFrom(account.config, 'inactiveAfterDays') ?? ACTIVE_WINDOW_DAYS;

    let plan: SyncPlan;
    try {
      const units = await this.units(client, account.name, startedAt, inactiveAfterDays);
      const roster = await this.roster(principal.companyId);
      const readings = await this.readings(client, units, startedAt, inactiveAfterDays, knownOdometers(roster, account.id));
      plan = planFiveEldSync(readings, roster, {
        accountId: account.id,
        now: startedAt,
        inactiveAfterDays,
        createMissing: request.createMissing,
        odometerUnit: odometerUnitFrom(account.config),
      });
    } catch (error) {
      await this.recordFailure(account.id, error, request.dryRun ? null : startedAt);
      throw this.asAppError(error);
    }

    if (!request.dryRun) {
      await this.apply(principal, account.id, account.name, plan, startedAt);
    }

    const durationMs = Date.now() - startedAt.getTime();
    if (!request.dryRun) {
      await this.recordRun(principal.companyId, account.id, plan.summary, durationMs, startedAt);
    }

    return {
      accountId: account.id,
      provider: FIVEELD_PROVIDER,
      dryRun: request.dryRun,
      startedAt: startedAt.toISOString(),
      durationMs,
      summary: plan.summary,
      updated: plan.updates.map((u) => u.line),
      created: plan.creates.map((c) => c.line),
      unchanged: plan.unchanged,
      inactive: plan.inactive,
      duplicates: plan.duplicates,
      unmatched: plan.unmatched,
      conflicts: plan.conflicts,
    };
  }

  /**
   * Positions only, for the live map between full syncs. One `units-by-usdot` (v2) request says
   * when each unit last reported; only the linked trucks with a report newer than the position we
   * hold are then read (their last two hours, for the address, speed and heading v2 does not carry).
   * When v2 fails or does not name a truck, that truck is read as before. Nothing else changes and
   * nothing is audited.
   */
  async refreshPositions(principal: Principal, accountId: string): Promise<number> {
    const account = await this.account(principal, accountId);
    if (account.status === 'disabled') return 0;
    const client = this.client(account.credentials, account.config);
    const linked = await this.db
      .select({
        id: trucks.id,
        externalId: trucks.telematicsExternalId,
        unitNumber: trucks.unitNumber,
        vin: trucks.vin,
        location: trucks.location,
      })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.telematicsAccountId, account.id)));
    let positions: FiveEldUnitPosition[] | null = null;
    try {
      positions = await client.unitPositions();
    } catch (error) {
      if (error instanceof FiveEldError && error.refusedCredential) throw error;
      console.warn(`${FIVEELD_LABEL} positions (${account.name}): units-by-usdot unavailable, reading every linked truck`, error instanceof Error ? error.message : error);
    }
    const toRead = trucksWithNewerReport(
      linked.map((t) => ({ id: t.id, unitNumber: t.unitNumber, vin: t.vin, locationAt: locationAtOf(t.location) })),
      positions,
    );
    const now = new Date();
    const since = new Date(now.getTime() - POSITION_WINDOW_HOURS * 3_600_000);
    let moved = 0;
    let sent = 0;
    for (const truck of linked) {
      if (!truck.externalId || !toRead.has(truck.id)) continue;
      if (sent > 0) await pause(PACE_MS);
      sent += 1;
      const points = await client.trackings(truck.externalId, since, now);
      const point = [...points].reverse().find((p) => p.latitude !== null && p.longitude !== null) ?? null;
      const location = toTruckLocation(toPlannerStats(truck.externalId, truck.unitNumber, point, odometerUnitFrom(account.config)));
      if (!location) continue;
      const updated = await this.db
        .update(trucks)
        .set({ location, telematicsSyncedAt: now })
        .where(
          and(
            eq(trucks.id, truck.id),
            eq(trucks.companyId, principal.companyId),
            sql`coalesce((${trucks.location}->>'updatedAt')::timestamptz, 'epoch') < ${location.updatedAt}::timestamptz`,
          ),
        )
        .returning({ id: trucks.id });
      moved += updated.length;
    }
    return moved;
  }

  // ------------------------------------------------------------------------------ reading

  /** Every vehicle on the account (`current-units`); the ones active in the window when that list is unknown. */
  private async units(client: FiveEldClient, accountName: string, now: Date, inactiveAfterDays: number): Promise<FiveEldUnit[]> {
    const listed = await client.listUnits(new Date(now.getTime() - inactiveAfterDays * 86_400_000), now);
    if (listed.source === 'active-units') {
      console.warn(`${FIVEELD_LABEL} sync (${accountName}): current-units unavailable (${listed.fallbackReason}); listed vehicles from active-units`);
    } else {
      console.log(`${FIVEELD_LABEL} sync (${accountName}): ${listed.units.length} vehicle(s) from current-units`);
    }
    return listed.units;
  }

  /**
   * Per vehicle, the last day first; a vehicle with no point there, or no real odometer there, is
   * walked back in 72-hour slices to the inactive window until a slice carries an odometer above
   * zero (see `readFiveEldVehicle`). One second between any two requests.
   */
  private async readings(
    client: FiveEldClient,
    units: FiveEldUnit[],
    now: Date,
    inactiveAfterDays: number,
    known: Map<string, Date>,
  ): Promise<FiveEldReading[]> {
    let sent = 0;
    const out: FiveEldReading[] = [];
    for (const unit of units) {
      const reading = await readFiveEldVehicle(
        unit,
        async (from, to) => {
          if (sent > 0) await pause(PACE_MS);
          sent += 1;
          return client.trackings(unit.id, from, to);
        },
        { now, inactiveAfterDays, knownOdometerAt: known.get(unit.id) ?? null },
      );
      out.push({ unit: reading.unit, latest: reading.latest, odometerPoint: reading.odometerPoint });
    }
    return out;
  }

  // -------------------------------------------------------------------------------- apply

  private async apply(
    principal: Principal,
    accountId: string,
    accountName: string,
    plan: SyncPlan,
    now: Date,
  ): Promise<void> {
    for (const update of plan.updates) {
      await this.db
        .update(trucks)
        .set({
          ...(update.odometer !== null && update.odometerAt !== null
            ? { odometer: update.odometer, odometerAt: new Date(update.odometerAt) }
            : {}),
          ...(update.engineHours !== null ? { engineHours: String(update.engineHours) } : {}),
          ...(update.location ? { location: update.location } : {}),
          // An odometer-only update leaves the truck linked to the ELD that places it.
          ...(update.odometerOnly
            ? {}
            : {
                telematicsProvider: FIVEELD_PROVIDER,
                telematicsStatus: 'connected',
                telematicsAccountId: accountId,
                telematicsExternalId: update.externalId,
                telematicsSyncedAt: now,
              }),
          updatedAt: now,
        })
        .where(and(eq(trucks.id, update.truckId), eq(trucks.companyId, principal.companyId)));

      await this.audit.write(principal, {
        action: 'update',
        entityType: 'truck',
        entityId: update.truckId,
        entityLabel: update.line.unitNumber ?? update.line.name,
        summary: `${update.line.note} (from ${accountName})`,
        changes:
          update.odometer !== null
            ? [
                {
                  field: 'odometer',
                  old:
                    update.line.odometerBefore === null ? null : String(update.line.odometerBefore),
                  new: String(update.odometer),
                },
              ]
            : [{ field: 'telematicsExternalId', old: null, new: update.externalId }],
      });
    }

    for (const create of plan.creates) {
      await this.createTruck(principal, accountId, accountName, create, now);
    }

    // The odometer history behind the PM board, as the Samsara sync writes it. Only vehicles
    // with an odometer reach `readings`, so a position-only point never becomes a reading. A
    // failure here must not undo a sync that already applied.
    if (isFeatureEnabled('pm_module') && plan.readings.length > 0) {
      try {
        await this.pm.ingestEldReadings(
          principal.companyId,
          plan.readings.map((r) => ({
            unitId: r.truckId,
            odometerMiles: r.odometer,
            engineHours: r.engineHours,
            readingAt: r.odometerAt,
          })),
          `${FIVEELD_LABEL} sync`,
        );
      } catch (error) {
        console.warn(`${FIVEELD_LABEL} sync: the odometer history could not be written for ${accountName}`, error);
      }
    }
  }

  /** A truck from a Five ELD vehicle; the same record the Samsara connector writes, naming Five ELD. */
  private async createTruck(
    principal: Principal,
    accountId: string,
    accountName: string,
    create: PlannedCreate,
    now: Date,
  ): Promise<void> {
    const id = await this.nextTruckId(create.unitNumber);
    const inService = now.toISOString().slice(0, 10);
    const nextService = new Date(now.getTime() + FIRST_SERVICE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await this.db.insert(trucks).values({
      id,
      companyId: principal.companyId,
      unitNumber: create.unitNumber,
      vin: create.vin,
      year: create.year,
      make: create.make,
      model: create.model,
      plate: create.plate,
      plateState: null,
      color: null,
      status: 'available',
      health: 'healthy',
      ownership: 'owned',
      odometer: create.odometer,
      odometerAt: now,
      engineHours: String(create.engineHours),
      inServiceDate: inService,
      currentDriverId: null,
      currentTrailerId: null,
      currentLoadId: null,
      location: null,
      nextServiceOdometer: create.odometer + FIRST_SERVICE_INTERVAL_MILES,
      nextServiceDate: nextService,
      nextServiceType: 'pm_service',
      telematicsProvider: FIVEELD_PROVIDER,
      telematicsStatus: 'connected',
      telematicsAccountId: accountId,
      telematicsExternalId: create.externalId,
      telematicsSyncedAt: now,
      mpg30d: '0',
      mpg90d: '0',
      idlePercent30d: '0',
      idlePercent90d: '0',
      homeTerminal: null,
    });
    create.line.truckId = id;
    create.line.unitNumber = create.unitNumber;

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'truck',
      entityId: id,
      entityLabel: create.unitNumber,
      summary: `Unit ${create.unitNumber} created from ${accountName} (VIN ${create.vin})`,
      changes: [
        { field: 'unitNumber', old: null, new: create.unitNumber },
        { field: 'vin', old: null, new: create.vin },
        { field: 'odometer', old: null, new: String(create.odometer) },
      ],
    });
  }

  /** The same rule TrucksService uses: `trk_<unit>` for a numeric unit, else the next free number. */
  private async nextTruckId(unitNumber: string): Promise<string> {
    const candidate = /^\d{1,6}$/.test(unitNumber) ? `trk_${unitNumber}` : null;
    if (candidate) {
      const [taken] = await this.db
        .select({ id: trucks.id })
        .from(trucks)
        .where(eq(trucks.id, candidate))
        .limit(1);
      if (!taken) return candidate;
    }
    const [highest] = await this.db
      .select({
        value: sql<number>`coalesce(max(nullif(regexp_replace(${trucks.id}, '\\D', '', 'g'), '')::bigint), 0)::int`,
      })
      .from(trucks);
    let next = (highest?.value ?? 0) + 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = `trk_${String(next).padStart(3, '0')}`;
      const [taken] = await this.db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, id)).limit(1);
      if (!taken) return id;
      next += 1;
    }
    throw new Error('Could not find a free truck id after 50 attempts');
  }

  // ---------------------------------------------------------------------------- bookkeeping

  private async recordRun(
    companyId: string,
    accountId: string,
    summary: SyncSummary,
    durationMs: number,
    startedAt: Date,
  ): Promise<void> {
    await this.db.insert(integrationSyncRuns).values({
      id: `run_${crypto.randomUUID()}`,
      companyId,
      integrationAccountId: accountId,
      direction: 'inbound',
      entity: 'vehicles',
      status: 'succeeded',
      records: summary.updated + summary.created,
      durationMs,
      error: null,
      summary,
      startedAt,
    });
    await this.db
      .update(integrationAccounts)
      .set({
        status: 'connected',
        lastSyncAt: startedAt,
        lastSuccessAt: startedAt,
        lastError: null,
        lastSummary: summary,
        errorCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, accountId));
  }

  private async recordFailure(
    accountId: string,
    error: unknown,
    startedAt: Date | null = null,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const refused = error instanceof FiveEldError && !error.retryable;
    const [row] = await this.db
      .select({
        companyId: integrationAccounts.companyId,
        errorCount: integrationAccounts.errorCount,
      })
      .from(integrationAccounts)
      .where(eq(integrationAccounts.id, accountId))
      .limit(1);
    await this.db
      .update(integrationAccounts)
      .set({
        // Refused credentials are an error the account carries; a network blip or a 429 is not.
        ...(refused ? { status: 'error' } : {}),
        lastError: message,
        errorCount: (row?.errorCount ?? 0) + 1,
        ...(startedAt ? { lastSyncAt: startedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, accountId));
    if (startedAt && row) {
      await this.db.insert(integrationSyncRuns).values({
        id: `run_${crypto.randomUUID()}`,
        companyId: row.companyId,
        integrationAccountId: accountId,
        direction: 'inbound',
        entity: 'vehicles',
        status: 'failed',
        records: 0,
        durationMs: Date.now() - startedAt.getTime(),
        error: message,
        summary: null,
        startedAt,
      });
    }
  }

  private asAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof FiveEldError) {
      return new AppError({
        status: error.retryable ? 502 : 422,
        title: FIVEELD_LABEL,
        detail: error.message,
      });
    }
    return new AppError({
      status: 502,
      title: FIVEELD_LABEL,
      detail: error instanceof Error ? error.message : 'The sync failed',
    });
  }

  // ----------------------------------------------------------------------------- loading

  private async account(principal: Principal, accountId: string) {
    const [row] = await this.db
      .select({
        id: integrationAccounts.id,
        provider: integrationAccounts.provider,
        name: integrationAccounts.name,
        status: integrationAccounts.status,
        config: integrationAccounts.config,
        credentials: integrationAccounts.credentials,
      })
      .from(integrationAccounts)
      .where(
        and(
          eq(integrationAccounts.companyId, principal.companyId),
          eq(integrationAccounts.id, accountId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such integration account' });
    }
    if (row.provider !== FIVEELD_PROVIDER) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${row.name} is a ${row.provider} account, not ${FIVEELD_LABEL}.`,
      });
    }
    if (!row.credentials) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${row.name} has no credential stored. Add the API key and provider token first.`,
      });
    }
    return {
      ...row,
      config: (row.config ?? {}) as Record<string, string>,
      credentials: row.credentials as Record<string, SealedCredential>,
    };
  }

  /** Opens the two secrets, reads the USDOT from the plain config, and hands all three to the client. */
  private client(credentials: Record<string, SealedCredential>, config: Record<string, string>): FiveEldClient {
    const usdot = (config.usdot ?? '').trim();
    if (!credentials.apiKey || !credentials.providerToken || usdot === '') {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${FIVEELD_LABEL} needs an API key, a provider token and the USDOT number. Replace the credential with all three.`,
      });
    }
    let apiKey: string;
    let providerToken: string;
    try {
      apiKey = decrypt(credentials.apiKey);
      providerToken = decrypt(credentials.providerToken);
    } catch {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          'The stored credential cannot be read: it was sealed under a different server secret. Replace the credential.',
      });
    }
    const baseUrl = process.env.FIVEELD_BASE_URL?.trim() || undefined;
    return new FiveEldClient({ apiKey, providerToken, usdot }, { baseUrl });
  }

  private async roster(companyId: string): Promise<TruckSnapshot[]> {
    return this.db
      .select({
        id: trucks.id,
        unitNumber: trucks.unitNumber,
        vin: trucks.vin,
        status: trucks.status,
        odometer: trucks.odometer,
        odometerAt: trucks.odometerAt,
        telematicsAccountId: trucks.telematicsAccountId,
        telematicsExternalId: trucks.telematicsExternalId,
        telematicsProvider: trucks.telematicsProvider,
        location: trucks.location,
      })
      .from(trucks)
      .where(eq(trucks.companyId, companyId))
      .then((rows) =>
        rows.map(({ location, ...row }) => {
          const at = (location as { updatedAt?: unknown } | null)?.updatedAt;
          const parsed = typeof at === 'string' ? new Date(at) : null;
          return { ...row, locationAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null };
        }),
      );
  }
}

/** The Five ELD vehicle id → the time of the odometer the roster already holds from this account. */
function knownOdometers(roster: TruckSnapshot[], accountId: string): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const t of roster) {
    if (t.telematicsAccountId === accountId && t.telematicsExternalId && t.odometerAt) out.set(t.telematicsExternalId, t.odometerAt);
  }
  return out;
}

function locationAtOf(location: unknown): Date | null {
  const at = (location as { updatedAt?: unknown } | null)?.updatedAt;
  const parsed = typeof at === 'string' ? new Date(at) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function numberFrom(config: Record<string, string>, key: string): number | undefined {
  const n = Number(config[key]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `odometerUnit: km` on the account's config turns Five ELD's reading into miles; miles otherwise. */
function odometerUnitFrom(config: Record<string, string>): FiveEldOdometerUnit {
  return (config.odometerUnit ?? '').trim().toLowerCase() === 'km' ? 'km' : 'mi';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
