import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  FIRST_SERVICE_DAYS,
  FIRST_SERVICE_INTERVAL_MILES,
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
import { MotiveClient, MotiveError } from './motive.client';
import { planMotiveSync, toPlannerStats } from './motive-sync.plan';
import { toTruckLocation, type PlannedCreate, type SyncPlan, type TruckSnapshot } from './samsara-sync.plan';

/**
 * One Motive account, synced into the roster. The Samsara connector's twin.
 *
 * Reads the vehicle list and the latest location (with odometer and engine hours) of every
 * vehicle, asks the shared planner what that means for the trucks, and either reports the plan
 * (a preview) or applies it. Every applied change is an audit entry naming the truck and the
 * account; the run is a row with its counts; the account's status is what Motive's answer earned
 * it — `connected` after a good one, `error` after a refused key, with the message kept.
 *
 * Read-only toward Motive. The key is opened here, handed to the client, and dropped: not logged,
 * not kept on this object, not part of any error this class throws.
 */
@Injectable()
export class MotiveSyncService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly pm: PmService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Asks Motive which company the key belongs to, and records the answer. */
  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const account = await this.account(principal, accountId);
    const client = this.client(account.credentials);
    try {
      const company = await client.company();
      await this.db
        .update(integrationAccounts)
        .set({
          status: 'connected',
          externalName: company.name || null,
          lastError: null,
          errorCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(integrationAccounts.id, account.id));
      return { organisation: company.name };
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
    const client = this.client(account.credentials);
    const startedAt = new Date();

    let plan: SyncPlan;
    try {
      // One after the other: Motive's rate limit is per key, and two paginated walks at once
      // are the quickest way to meet it.
      const vehicles = await client.vehicles();
      const locations = await client.vehicleLocations();
      const roster = await this.roster(principal.companyId);
      plan = planMotiveSync(vehicles, locations, roster, {
        accountId: account.id,
        now: startedAt,
        inactiveAfterDays: numberFrom(account.config, 'inactiveAfterDays'),
        createMissing: request.createMissing,
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
      provider: 'motive',
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
   * Positions only, for the live map between full syncs. Moves the trucks already linked to this
   * account's vehicles; nothing else changes and nothing is audited. An older fix is ignored.
   */
  async refreshPositions(principal: Principal, accountId: string): Promise<number> {
    const account = await this.account(principal, accountId);
    if (account.status === 'disabled') return 0;
    const locations = await this.client(account.credentials).vehicleLocations();
    const now = new Date();
    let moved = 0;
    for (const loc of locations) {
      const location = toTruckLocation(toPlannerStats(loc));
      if (!location) continue;
      const updated = await this.db
        .update(trucks)
        .set({ location, telematicsSyncedAt: now })
        .where(
          and(
            eq(trucks.companyId, principal.companyId),
            eq(trucks.telematicsAccountId, account.id),
            eq(trucks.telematicsExternalId, loc.id),
            sql`coalesce((${trucks.location}->>'updatedAt')::timestamptz, 'epoch') < ${location.updatedAt}::timestamptz`,
          ),
        )
        .returning({ id: trucks.id });
      moved += updated.length;
    }
    return moved;
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
                telematicsProvider: 'motive',
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

    // The odometer history behind the PM board, as the Samsara sync writes it. A failure here
    // must not undo a sync that already applied.
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
          'Motive sync',
        );
      } catch (error) {
        console.warn(`Motive sync: the odometer history could not be written for ${accountName}`, error);
      }
    }
  }

  /** A truck from a Motive vehicle; the same record the Samsara connector writes, naming Motive. */
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
      telematicsProvider: 'motive',
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
    const refused = error instanceof MotiveError && !error.retryable;
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
        // A refused key is an error the account carries; a network blip or a 429 is not.
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
    if (error instanceof MotiveError) {
      return new AppError({
        status: error.retryable ? 502 : 422,
        title: 'Motive',
        detail: error.message,
      });
    }
    return new AppError({
      status: 502,
      title: 'Motive',
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
    if (row.provider !== 'motive') {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${row.name} is a ${row.provider} account, not Motive.`,
      });
    }
    if (!row.credentials) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${row.name} has no credential stored. Add the API key first.`,
      });
    }
    return {
      ...row,
      config: (row.config ?? {}) as Record<string, string>,
      credentials: row.credentials as Record<string, SealedCredential>,
    };
  }

  private client(credentials: Record<string, SealedCredential>): MotiveClient {
    const sealed = credentials.apiKey;
    if (!sealed) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'No API key is stored.' });
    }
    let key: string;
    try {
      key = decrypt(sealed);
    } catch {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          'The stored key cannot be read: it was sealed under a different server secret. Replace the credential.',
      });
    }
    return new MotiveClient(key);
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

function numberFrom(config: Record<string, string>, key: string): number | undefined {
  const n = Number(config[key]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
