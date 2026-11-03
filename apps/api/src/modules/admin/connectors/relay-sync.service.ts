import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { SyncReport, SyncRequest, SyncSummary, SyncVehicleLine } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { integrationAccounts, integrationSyncRuns } from '../../../database/schema/admin';
import { drivers, trucks } from '../../../database/schema/roster';
import { odometerReadings } from '../../../database/schema/pm';
import { odometerAt, type OdometerPoint } from './fuel-odometer';
import { AuditService } from '../../people/audit.service';
import { StateService } from '../../state/state.service';
import { decrypt, type SealedCredential } from '../credential-vault';
import { RelayClient, RelayError } from './relay.client';
import { planRelaySync, type RelayPlan, type WorkspaceFuelTransaction } from './relay-sync.plan';

/** The workspace collection the Fuel page reads; the web client owns its shape. */
const FUEL_KEY = 'ws2-fueltransactions';
/** How far back a sync reads. Relay posts late, so a window is re-read on purpose. */
const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_LOOKBACK_DAYS = 120;
/** A browser can save the same collection between our read and our write. */
const WRITE_ATTEMPTS = 3;

/**
 * One Relay account, synced into the fuel ledger.
 *
 * Reads the transactions in a recent window, asks the planner which of them the ledger does not
 * have yet, and either reports that (a preview) or writes them. The ledger is the workspace
 * collection the Fuel page already reads, so a Relay fill appears beside the hand-keyed ones with
 * no second screen. Every write re-reads the collection and refuses to overwrite a newer save, so
 * a dispatcher typing a fill-up at the same moment loses nothing.
 *
 * Read-only against Relay. Nothing is ever sent back - not a code, not a correction.
 *
 * The key is opened here, handed to the client, and dropped: never logged, never kept on this
 * object, never part of an error this class throws.
 */
@Injectable()
export class RelaySyncService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly state: StateService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Reads one day of transactions with the key and records the answer.
   *
   * Relay has no "who am I" endpoint, so the cheapest real read stands in for one. An account
   * becomes `connected` only when Relay has answered a request made with its key.
   */
  async test(principal: Principal, accountId: string): Promise<{ organisation: string }> {
    const account = await this.account(principal, accountId);
    const client = this.client(account.credentials);
    try {
      const end = new Date();
      const found = await client.transactions(new Date(end.getTime() - 86_400_000), end);
      await this.db
        .update(integrationAccounts)
        .set({ status: 'connected', externalName: 'Relay', lastError: null, errorCount: 0, updatedAt: new Date() })
        .where(eq(integrationAccounts.id, account.id));
      return { organisation: `Relay - ${found.length} transaction(s) in the last 24 hours` };
    } catch (error) {
      await this.recordFailure(account.id, error);
      throw this.asAppError(error);
    }
  }

  async sync(principal: Principal, accountId: string, request: SyncRequest): Promise<SyncReport> {
    const account = await this.account(principal, accountId);
    if (account.status === 'disabled') {
      throw new AppError({ status: 409, title: 'Conflict', detail: `${account.name} is disabled. Enable it before syncing.` });
    }
    const client = this.client(account.credentials);
    const startedAt = new Date();
    const days = Math.min(MAX_LOOKBACK_DAYS, numberFrom(account.config, 'lookbackDays') ?? DEFAULT_LOOKBACK_DAYS);
    const windowStart = new Date(startedAt.getTime() - days * 86_400_000);

    let plan: RelayPlan;
    let written = 0;
    let backfilled = 0;
    try {
      const transactions = await client.transactions(windowStart, startedAt);
      const fleet = await this.fleet(principal.companyId);
      if (request.dryRun) {
        const ledger = await this.readLedger(principal.companyId);
        plan = planRelaySync(transactions, { ...fleet, existing: ledger.rows });
        await this.fillOdometers(principal.companyId, plan.add);
      } else {
        // Plan against what is stored at the moment of writing, and plan again if a browser saved
        // in between: the conflict check is what keeps a hand-keyed fill from being overwritten.
        let attempt = 0;
        for (;;) {
          attempt += 1;
          const ledger = await this.readLedger(principal.companyId);
          plan = planRelaySync(transactions, { ...fleet, existing: ledger.rows });
          // Relay has no odometer: new fills, and Relay fills saved before this existed, take it
          // from the unit's odometer history (owner, 2026-10-05).
          await this.fillOdometers(principal.companyId, plan.add);
          backfilled = await this.fillOdometers(principal.companyId, ledger.rows);
          if (plan.add.length === 0 && backfilled === 0) break;
          // Newest first, as the ledger keeps them.
          const next = [...plan.add].sort((a, b) => b.at.localeCompare(a.at)).concat(ledger.rows);
          const savedAt = await this.state.putFor(principal.companyId, FUEL_KEY, JSON.stringify(next), ledger.updatedAt ?? undefined);
          if (savedAt !== null) {
            written = plan.add.length;
            break;
          }
          if (attempt >= WRITE_ATTEMPTS) {
            throw new AppError({
              status: 409,
              title: 'Conflict',
              detail: 'The fuel ledger kept changing while Relay was being written. Nothing was lost; run the sync again.',
            });
          }
        }
      }
    } catch (error) {
      await this.recordFailure(account.id, error, request.dryRun ? null : startedAt);
      throw this.asAppError(error);
    }

    if (!request.dryRun && written > 0) {
      await this.audit.write(principal, {
        action: 'create',
        entityType: 'fuel_transaction',
        entityId: account.id,
        entityLabel: `${written} Relay fill-up${written === 1 ? '' : 's'}`,
        summary: `${written} fuel transaction(s) imported from ${account.name}, ${days} days back`,
        changes: [{ field: 'fuelTransactions', old: null, new: String(written) }],
      });
    }
    if (!request.dryRun && backfilled > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'fuel_transaction',
        entityId: account.id,
        entityLabel: `${backfilled} Relay fill-up${backfilled === 1 ? '' : 's'}`,
        summary: `Odometer filled from the odometer history on ${backfilled} Relay fuel transaction(s) that had none`,
        changes: [{ field: 'odometer', old: '0', new: `${backfilled} filled` }],
      });
    }

    const durationMs = Date.now() - startedAt.getTime();
    if (!request.dryRun) {
      await this.recordRun(principal.companyId, account.id, plan.summary, durationMs, startedAt);
    }

    const line = (row: WorkspaceFuelTransaction): SyncVehicleLine => ({
      externalId: row.id,
      name: `${row.unitNumber} · ${row.product} · ${row.gallons} gal · $${row.amount.toFixed(2)}`,
      vin: null,
      truckId: row.truckId,
      unitNumber: row.unitNumber,
      odometerBefore: null,
      odometerAfter: null,
      lastSeenAt: row.at,
      note: `${row.station.name || row.station.brand}${row.station.city ? `, ${row.station.city}` : ''}${row.station.state ? ` ${row.station.state}` : ''} · ${row.driverName}${row.anomalyFlags.length ? ` · ${row.anomalyFlags.join(', ')}` : ''}`,
    });

    return {
      accountId: account.id,
      provider: 'relay',
      dryRun: request.dryRun,
      startedAt: startedAt.toISOString(),
      durationMs,
      summary: plan.summary,
      updated: [],
      created: plan.add.map(line),
      unchanged: [],
      inactive: [],
      duplicates: plan.add.filter((r) => r.anomalyFlags.includes('duplicate')).map(line),
      unmatched: plan.unmatched.map((text, i) => ({
        externalId: `unmatched_${i}`,
        name: text,
        vin: null,
        truckId: null,
        unitNumber: null,
        odometerBefore: null,
        odometerAfter: null,
        lastSeenAt: null,
        note: text,
      })),
      conflicts: [],
    };
  }

  // ----------------------------------------------------------------------------- loading

  /**
   * Sets the odometer of every Relay fill that has none (0) from the unit's odometer history, in
   * place. Hand-keyed fills are left alone: their odometer is what the driver typed. Returns how
   * many rows changed.
   */
  private async fillOdometers(companyId: string, rows: WorkspaceFuelTransaction[]): Promise<number> {
    const open = rows.filter((r) => r.id.startsWith('fue_rly_') && !(r.odometer > 0) && r.truckId);
    if (open.length === 0) return 0;
    const times = open.map((r) => Date.parse(r.at)).filter(Number.isFinite);
    if (times.length === 0) return 0;
    const from = new Date(Math.min(...times) - 5 * 86_400_000);
    const to = new Date(Math.max(...times) + 5 * 86_400_000);
    const readings = await this.db
      .select({ unitId: odometerReadings.unitId, at: odometerReadings.readingAt, miles: odometerReadings.odometerMiles })
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          inArray(odometerReadings.unitId, [...new Set(open.map((r) => r.truckId))]),
          eq(odometerReadings.status, 'ok'),
          gte(odometerReadings.readingAt, from),
          lte(odometerReadings.readingAt, to),
        ),
      )
      .orderBy(asc(odometerReadings.readingAt));
    const byUnit = new Map<string, OdometerPoint[]>();
    for (const r of readings) {
      const list = byUnit.get(r.unitId) ?? [];
      list.push({ atMs: r.at.getTime(), miles: r.miles });
      byUnit.set(r.unitId, list);
    }
    let changed = 0;
    for (const row of open) {
      const miles = odometerAt(byUnit.get(row.truckId) ?? [], Date.parse(row.at));
      if (miles !== null && miles > 0) {
        row.odometer = miles;
        changed += 1;
      }
    }
    return changed;
  }

  private async readLedger(companyId: string): Promise<{ rows: WorkspaceFuelTransaction[]; updatedAt: string | null }> {
    const stored = await this.state.getFor(companyId, FUEL_KEY);
    if (!stored) return { rows: [], updatedAt: null };
    try {
      const parsed = JSON.parse(stored.value) as unknown;
      return { rows: Array.isArray(parsed) ? (parsed as WorkspaceFuelTransaction[]) : [], updatedAt: stored.updatedAt };
    } catch {
      // An unreadable ledger is not ours to replace: refuse rather than overwrite it with Relay's rows.
      throw new AppError({ status: 409, title: 'Conflict', detail: 'The stored fuel ledger cannot be read, so nothing was written.' });
    }
  }

  private async fleet(companyId: string) {
    const [truckRows, driverRows] = await Promise.all([
      this.db
        .select({ id: trucks.id, unitNumber: trucks.unitNumber, currentDriverId: trucks.currentDriverId })
        .from(trucks)
        .where(eq(trucks.companyId, companyId)),
      this.db
        .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, currentTruckId: drivers.currentTruckId })
        .from(drivers)
        .where(eq(drivers.companyId, companyId)),
    ]);
    return {
      trucks: truckRows.map((t) => ({ id: t.id, unitNumber: t.unitNumber, currentDriverId: t.currentDriverId ?? null })),
      drivers: driverRows.map((d) => ({ id: d.id, name: `${d.first} ${d.last}`.trim(), currentTruckId: d.currentTruckId ?? null })),
    };
  }

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
      .where(and(eq(integrationAccounts.companyId, principal.companyId), eq(integrationAccounts.id, accountId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such integration account' });
    if (row.provider !== 'relay') {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${row.name} is a ${row.provider} account, not Relay.` });
    }
    if (!row.credentials) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${row.name} has no API key stored. Add it first.` });
    }
    return {
      ...row,
      config: (row.config ?? {}) as Record<string, string>,
      credentials: row.credentials as Record<string, SealedCredential>,
    };
  }

  private client(credentials: Record<string, SealedCredential>): RelayClient {
    const sealed = credentials.apiKey;
    if (!sealed) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'No Relay API key is stored.' });
    let key: string;
    try {
      key = decrypt(sealed);
    } catch {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'The stored key cannot be read: it was sealed under a different server secret. Replace the credential.',
      });
    }
    return new RelayClient(key);
  }

  // ---------------------------------------------------------------------------- bookkeeping

  private async recordRun(companyId: string, accountId: string, summary: SyncSummary, durationMs: number, startedAt: Date): Promise<void> {
    await this.db.insert(integrationSyncRuns).values({
      id: `run_${crypto.randomUUID()}`,
      companyId,
      integrationAccountId: accountId,
      direction: 'inbound',
      entity: 'fuel_transactions',
      status: 'succeeded',
      records: summary.created,
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

  private async recordFailure(accountId: string, error: unknown, startedAt: Date | null = null): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const refused = error instanceof RelayError && !error.retryable;
    const [row] = await this.db
      .select({ companyId: integrationAccounts.companyId, errorCount: integrationAccounts.errorCount })
      .from(integrationAccounts)
      .where(eq(integrationAccounts.id, accountId))
      .limit(1);
    await this.db
      .update(integrationAccounts)
      .set({
        // A refused key is an error the account carries; a slow Relay is not.
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
        entity: 'fuel_transactions',
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
    if (error instanceof RelayError) {
      return new AppError({ status: error.retryable ? 502 : 422, title: 'Relay', detail: error.message });
    }
    return new AppError({ status: 502, title: 'Relay', detail: error instanceof Error ? error.message : 'The sync failed' });
  }
}

function numberFrom(config: Record<string, string>, key: string): number | undefined {
  const n = Number(config[key]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
