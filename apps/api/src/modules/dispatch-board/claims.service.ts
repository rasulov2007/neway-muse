import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Claim, WriteClaimInput } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { dispatchClaims } from '../../database/schema/dispatch-ops';
import { audit, conflict, forbidden, newId, notFound, unprocessable } from './ops.helpers';

type ClaimRecord = typeof dispatchClaims.$inferSelect;

/**
 * Detention & Layover (owner's brief §13): one live claim per load number, the requested and
 * recovered money, who chased it and what they are paid for it. Accessorial money: it never
 * enters the linehaul gross the commission engine reads.
 */
@Injectable()
export class ClaimsService {
  constructor(private readonly database: DatabaseService) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  private toClaim(r: ClaimRecord): Claim {
    return {
      id: r.id,
      loadNumber: r.loadNumber,
      claimType: r.claimType as Claim['claimType'],
      rosterId: r.rosterId,
      driverName: r.driverName,
      claimDate: String(r.claimDate),
      requestedCents: r.requestedCents,
      recoveredCents: r.recoveredCents,
      updater: r.updater,
      updaterPayoutCents: r.updaterPayoutCents,
      status: r.status as Claim['status'],
      notes: r.notes,
      byName: r.byName,
      at: r.at.toISOString(),
      version: r.version,
    };
  }

  async list(principal: Principal): Promise<Claim[]> {
    const rows = await this.db
      .select()
      .from(dispatchClaims)
      .where(and(eq(dispatchClaims.companyId, principal.companyId), isNull(dispatchClaims.voidedAt)))
      .orderBy(desc(dispatchClaims.claimDate), desc(dispatchClaims.at));
    return rows.map((r) => this.toClaim(r));
  }

  async write(principal: Principal, id: string | null, input: WriteClaimInput): Promise<Claim> {
    if (!hasPermission(principal, 'dispatch.manage')) throw forbidden('Editing claims takes dispatch.manage');
    if (input.recoveredCents > input.requestedCents && input.requestedCents > 0)
      throw unprocessable('Recovered cannot exceed requested');
    if (input.updaterPayoutCents > input.recoveredCents) throw unprocessable('The updater payout cannot exceed what was recovered');
    const now = this.clock();
    const companyId = principal.companyId;
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: dispatchClaims.id })
        .from(dispatchClaims)
        .where(and(eq(dispatchClaims.companyId, companyId), eq(dispatchClaims.loadNumber, input.loadNumber), isNull(dispatchClaims.voidedAt)))
        .limit(1);
      if (dup && dup.id !== id) throw conflict(`Load ${input.loadNumber} already has a claim`);
      let existing: ClaimRecord | null = null;
      if (id) {
        const [row] = await tx
          .select()
          .from(dispatchClaims)
          .where(and(eq(dispatchClaims.companyId, companyId), eq(dispatchClaims.id, id)))
          .limit(1);
        if (!row || row.voidedAt) throw notFound('No such claim');
        if (input.expectedVersion !== undefined && input.expectedVersion !== row.version)
          throw conflict('This claim was changed by someone else. Reload and try again.', { currentVersion: row.version });
        existing = row;
      }
      const row = {
        id: existing?.id ?? newId('dcl'),
        companyId,
        loadNumber: input.loadNumber,
        claimType: input.claimType,
        rosterId: input.rosterId ?? null,
        driverName: input.driverName,
        claimDate: input.claimDate,
        requestedCents: input.requestedCents,
        recoveredCents: input.recoveredCents,
        updater: input.updater,
        updaterPayoutCents: input.updaterPayoutCents,
        status: input.status,
        notes: input.notes,
        by: principal.userId,
        byName: principal.userName ?? principal.userId,
        at: now,
        version: (existing?.version ?? 0) + 1,
      };
      if (existing) await tx.update(dispatchClaims).set(row).where(eq(dispatchClaims.id, existing.id));
      else await tx.insert(dispatchClaims).values(row);
      await audit(tx, principal, now, 'claim', row.id, existing ? 'update' : 'create', existing, row);
      return this.toClaim({ ...row, voidedAt: null, voidReason: null } as ClaimRecord);
    });
  }

  async void(principal: Principal, id: string, reason: string, expectedVersion: number): Promise<Claim> {
    if (!hasPermission(principal, 'dispatch.manage')) throw forbidden('Voiding claims takes dispatch.manage');
    if (reason.trim().length < 3) throw unprocessable('Voiding needs a reason');
    const now = this.clock();
    const [row] = await this.db
      .select()
      .from(dispatchClaims)
      .where(and(eq(dispatchClaims.companyId, principal.companyId), eq(dispatchClaims.id, id)))
      .limit(1);
    if (!row || row.voidedAt) throw notFound('No such claim');
    if (row.version !== expectedVersion) throw conflict('This claim was changed by someone else. Reload and try again.');
    await this.db.transaction(async (tx) => {
      await tx.update(dispatchClaims).set({ voidedAt: now, voidReason: reason, version: row.version + 1 }).where(eq(dispatchClaims.id, id));
      await audit(tx, principal, now, 'claim', id, 'void', row, { reason });
    });
    return this.toClaim({ ...row, voidedAt: now, voidReason: reason, version: row.version + 1 });
  }
}
