import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  ACCOUNTING_POST_PERMISSION,
  COST_TYPE_BY_REQUIREMENT,
  COST_TYPE_LABELS,
  DEFAULT_UNIT_COSTS,
  RECRUITING_EXPENSE_CATEGORY,
  RECRUITING_EXPENSE_SOURCE,
  UNIT_COST_SETTING_KEYS,
  campaignPerformance,
  easternDay,
  costPostsToAccounting,
  sumCosts,
  sumSpend,
  type Campaign,
  type CampaignSpendEntry,
  type CostAccounting,
  type CostEntry,
  type CostQuery,
  type CostSummary,
  type CostType,
  type CreateCampaignRequest,
  type CreateCampaignSpendRequest,
  type CreateCostEntryRequest,
  type UpdateCampaignRequest,
  type UpdateCampaignSpendRequest,
  type VoidCampaignSpendRequest,
} from '@neway/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { acctExpenses } from '../../database/schema/accounting';
import { complianceDocuments, consentRequests } from '../../database/schema/compliance';
import { storedFiles } from '../../database/schema/files';
import {
  hiringCampaigns,
  hiringCampaignSpend,
  hiringCases,
  hiringCostEntries,
  hiringLeads,
  hiringOrientations,
  hiringTickets,
  type HiringCampaignRow,
  type HiringCampaignSpendRow,
  type HiringCostEntryRow,
} from '../../database/schema/hiring';
import { offers } from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { PayablesService } from '../accounting/payables.service';
import { SettingsService } from '../admin/settings.service';
import { num } from '../hr/hr.util';
import { AuditService, type AuditEvent } from '../people/audit.service';

const SCREENING_CODES = Object.keys(COST_TYPE_BY_REQUIREMENT);

/** A validation failure tied to one form field, so the screen can show it beside that field. */
function fieldError(path: string, message: string, status = 422): AppError {
  return new AppError({
    status,
    title: status === 409 ? 'Conflict' : 'Unprocessable Entity',
    detail: message,
    extensions: { errors: [{ path, message, code: 'custom' }] },
  });
}

/** One write to Accounting at a time per cost: a double click or a retry runs after the first. */
const costLock = (companyId: string, costId: string) => `hiring-cost-acct:${companyId}:${costId}`;

/** The Accounting expense a cost row links to, as the cost list needs it. */
interface LinkedExpense {
  id: string;
  status: string;
  amountCents: number;
  onDate: string;
  expenseNumber: string;
}

const NEEDS = `needs someone with ${ACCOUNTING_POST_PERMISSION} (post and edit accounting records)`;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Where a cost stands in Accounting, derived on read from the row and its linked expense - never
 * stored, so it cannot drift from what Accounting holds.
 */
export function accountingState(row: HiringCostEntryRow, expense: LinkedExpense | null): CostAccounting {
  const base = {
    expenseId: row.accountingExpenseId,
    expenseNumber: expense?.expenseNumber ?? null,
    expenseStatus: expense?.status ?? null,
  };
  const live = expense !== null && expense.status !== 'void';
  const number = expense?.expenseNumber ?? row.accountingExpenseId ?? '';
  if (row.accountingExpenseId && !row.accountingPostedAt) {
    return {
      ...base,
      state: 'attributed',
      message: row.voidedAt
        ? `Was attributed from ${number}; that expense stays in Accounting.`
        : `Attributed from ${number}, already in Accounting. Nothing new was posted.`,
      actionable: false,
    };
  }
  if (row.voidedAt) {
    if (row.accountingPostedAt && live) {
      return {
        ...base,
        state: 'needs_void',
        message: row.accountingPostNote ?? `The cost is voided but ${number} is still live in Accounting - ${NEEDS} to void it.`,
        actionable: true,
      };
    }
    return {
      ...base,
      state: 'voided',
      message: row.accountingPostedAt && expense ? `${number} voided in Accounting.` : null,
      actionable: false,
    };
  }
  if (!costPostsToAccounting(row)) {
    return {
      ...base,
      state: 'not_applicable',
      message:
        "Priced from the unit cost in Settings. The screening vendor's invoice is the expense, booked in Accounting, so this estimate is not posted.",
      actionable: false,
    };
  }
  const cents = Math.round((num(row.amount) ?? 0) * 100);
  if (row.accountingPostedAt && live && expense) {
    if (expense.amountCents === cents && expense.onDate === row.incurredOn) {
      return { ...base, state: 'posted', message: `Posted to Accounting as ${number}.`, actionable: false };
    }
    return {
      ...base,
      state: 'needs_update',
      message:
        row.accountingPostNote ??
        `Accounting still shows ${number} at ${dollars(expense.amountCents)} on ${expense.onDate}; the cost is now ${dollars(cents)} on ${row.incurredOn} - ${NEEDS} to update it.`,
      actionable: true,
    };
  }
  return {
    ...base,
    state: 'not_posted',
    message:
      row.accountingPostNote ??
      (row.accountingPostedAt && expense
        ? `${number} was voided in Accounting. Post again if the cost stands - ${NEEDS}.`
        : `Not posted to Accounting - ${NEEDS}.`),
    actionable: true,
  };
}

/**
 * Campaigns, their dated spend, and the cost ledger.
 *
 * Manual entries are typed in by a recruiter. Auto entries are filled in by this service the moment
 * the thing they price happens: a screening report filed in the qualification file (priced from the
 * unit costs in Admin → Settings), a ticket booked, orientation attended, a bonus promised in an
 * offer that became a hire. Each auto entry names its source record and the ledger holds one entry
 * per source, so a re-filed report is not charged twice and a corrected orientation replaces its
 * own line.
 *
 * Candidate costs post to Accounting as expenses (owner, 2026-10-01) through Accounting's own
 * expense service - category `recruiting`, account 6700 - when the person saving them may post
 * there; otherwise they wait, marked, for someone who may. A cost attributed from an expense
 * Accounting already had never posts a second one.
 *
 * The screening hook listens to the audit stream, like the funnel wrapper does: Safety files a
 * report exactly as it always has, and the ledger notices. The backfill at boot prices whatever
 * happened before the ledger existed, through the same functions, and posts nothing.
 */
/** What the journey's cost form adds to a cost (0050). */
export interface JourneyCostFields {
  paidBy: 'company' | 'driver';
  costOwner: 'company' | 'driver';
  vendor: string | null;
  approvalStatus: 'planned' | 'approved';
  approvedBy: string | null;
  travelItemId: string | null;
  driverAgreementNote: string | null;
}

@Injectable()
export class CostLedgerService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly payables: PayablesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CostLedgerService.name);
  }

  private get db() {
    return this.database.db;
  }

  onModuleInit(): void {
    this.audit.onWrite(async (event) => {
      try {
        await this.onAudit(event);
      } catch (error) {
        this.logger.error({ err: error, auditId: event.id }, 'Cost ledger sync failed');
      }
    });
  }

  /** A screening report filed for a driver with a hiring case is priced from the unit costs. */
  private async onAudit(event: AuditEvent): Promise<void> {
    if (event.entityType !== 'driver' || event.action !== 'document_uploaded') return;
    const code = event.changes[0]?.field;
    if (!code || !SCREENING_CODES.includes(code)) return;
    const [doc] = await this.db
      .select()
      .from(complianceDocuments)
      .where(
        and(
          eq(complianceDocuments.companyId, event.companyId),
          eq(complianceDocuments.ownerId, event.entityId),
          eq(complianceDocuments.requirementCode, code),
        ),
      )
      .orderBy(desc(complianceDocuments.uploadedAt))
      .limit(1);
    if (doc) await this.priceScreening(event.companyId, doc);
  }

  // ================================================================================= campaigns

  private toCampaign(
    row: HiringCampaignRow,
    spend: { total: number; count: number },
    performance: ReturnType<typeof campaignPerformance>,
    ownerName: string | null,
  ): Campaign {
    return {
      id: row.id,
      name: row.name,
      channel: row.channel as Campaign['channel'],
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      spend: spend.total,
      spendEntryCount: spend.count,
      ownerEmployeeId: row.ownerEmployeeId,
      ownerName,
      notes: row.notes,
      active: row.active,
      ...performance,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async assertOwner(principal: Principal, ownerEmployeeId: string | null | undefined) {
    if (!ownerEmployeeId) return;
    const [person] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, ownerEmployeeId)))
      .limit(1);
    if (!person) throw fieldError('ownerEmployeeId', 'No such employee in this company');
  }

  async listCampaigns(principal: Principal): Promise<Campaign[]> {
    const rows = await this.db
      .select({ row: hiringCampaigns, first: employees.firstName, last: employees.lastName })
      .from(hiringCampaigns)
      .leftJoin(employees, eq(employees.id, hiringCampaigns.ownerEmployeeId))
      .where(eq(hiringCampaigns.companyId, principal.companyId))
      .orderBy(
        desc(hiringCampaigns.active),
        desc(hiringCampaigns.periodStart),
        asc(hiringCampaigns.name),
      );
    const [leads, hired, costs, spendRows] = await Promise.all([
      this.db
        .select({ campaignId: hiringLeads.campaignId, hiringCaseId: hiringLeads.hiringCaseId })
        .from(hiringLeads)
        .where(
          and(
            eq(hiringLeads.companyId, principal.companyId),
            isNotNull(hiringLeads.campaignId),
            eq(hiringLeads.isTest, false),
          ),
        ),
      this.db
        .select({ id: hiringCases.id })
        .from(hiringCases)
        .where(
          and(
            eq(hiringCases.companyId, principal.companyId),
            eq(hiringCases.isTest, false),
            sql`(${hiringCases.hiredAt} is not null or ${hiringCases.state} in ('hired', 'active_driver'))`,
          ),
        ),
      this.db
        .select({ campaignId: hiringCostEntries.campaignId, amount: hiringCostEntries.amount })
        .from(hiringCostEntries)
        .where(
          and(
            eq(hiringCostEntries.companyId, principal.companyId),
            isNotNull(hiringCostEntries.campaignId),
            isNull(hiringCostEntries.voidedAt),
          ),
        ),
      // Spend is the dated entries (0038); the old single total is no longer read.
      this.db
        .select({
          campaignId: hiringCampaignSpend.campaignId,
          amount: hiringCampaignSpend.amount,
          spentOn: hiringCampaignSpend.spentOn,
        })
        .from(hiringCampaignSpend)
        .where(
          and(
            eq(hiringCampaignSpend.companyId, principal.companyId),
            isNull(hiringCampaignSpend.voidedAt),
          ),
        ),
    ]);
    const hiredCaseIds = new Set(hired.map((h) => h.id));
    const liveCosts = costs.map((c) => ({ campaignId: c.campaignId, amount: num(c.amount) ?? 0 }));
    const spend = spendRows.map((s) => ({ ...s, amount: num(s.amount) ?? 0 }));
    return rows.map(({ row, first, last }) => {
      const total = sumSpend(spend, row.id);
      return this.toCampaign(
        row,
        { total, count: spend.filter((s) => s.campaignId === row.id).length },
        campaignPerformance({
          campaignId: row.id,
          spend: total,
          leads,
          hiredCaseIds,
          costs: liveCosts,
        }),
        first ? `${first} ${last ?? ''}`.trim() : null,
      );
    });
  }

  async getCampaign(principal: Principal, id: string): Promise<Campaign> {
    const found = (await this.listCampaigns(principal)).find((c) => c.id === id);
    if (!found)
      throw new AppError({ status: 404, title: 'Not Found', detail: `No campaign ${id}` });
    return found;
  }

  async createCampaign(
    principal: Principal,
    input: CreateCampaignRequest,
    options: { at?: Date } = {},
  ): Promise<Campaign> {
    await this.assertOwner(principal, input.ownerEmployeeId);
    const at = options.at ?? new Date();
    const id = `cmp_${crypto.randomUUID()}`;
    await this.db.insert(hiringCampaigns).values({
      id,
      companyId: principal.companyId,
      name: input.name,
      channel: input.channel,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      spend: '0',
      ownerEmployeeId: input.ownerEmployeeId,
      notes: input.notes,
      active: input.active,
      createdAt: at,
      updatedAt: at,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'campaign',
      entityId: id,
      entityLabel: input.name,
      summary: `Campaign created (${input.channel.replace(/_/g, ' ')})`,
      at,
    });
    // What was already spent when it was set up is its first dated entry, on the start date.
    if (input.spend > 0) {
      await this.insertSpend(principal, id, input.name, {
        spentOn: input.periodStart,
        amount: input.spend,
        note: 'Spent when the campaign was set up',
        clientKey: null,
        at,
      });
    }
    return this.getCampaign(principal, id);
  }

  async updateCampaign(
    principal: Principal,
    id: string,
    patch: UpdateCampaignRequest,
  ): Promise<Campaign> {
    const before = await this.getCampaign(principal, id);
    await this.assertOwner(principal, patch.ownerEmployeeId);
    const at = new Date();
    await this.db
      .update(hiringCampaigns)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
        ...(patch.periodStart !== undefined ? { periodStart: patch.periodStart } : {}),
        ...(patch.periodEnd !== undefined ? { periodEnd: patch.periodEnd } : {}),
        ...(patch.ownerEmployeeId !== undefined ? { ownerEmployeeId: patch.ownerEmployeeId } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        updatedAt: at,
      })
      .where(and(eq(hiringCampaigns.companyId, principal.companyId), eq(hiringCampaigns.id, id)));
    const changes = (Object.keys(patch) as (keyof UpdateCampaignRequest)[])
      .filter(
        (k) => patch[k] !== undefined && String(patch[k]) !== String(before[k as keyof Campaign]),
      )
      .map((k) => ({
        field: k,
        old: String(before[k as keyof Campaign] ?? ''),
        new: String(patch[k] ?? ''),
      }));
    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'campaign',
        entityId: id,
        entityLabel: before.name,
        summary: `Campaign updated: ${changes.map((c) => c.field).join(', ')}`,
        changes,
        at,
      });
    }
    return this.getCampaign(principal, id);
  }

  // ============================================================================ campaign spend

  private toSpend(row: HiringCampaignSpendRow): CampaignSpendEntry {
    return {
      id: row.id,
      campaignId: row.campaignId,
      spentOn: row.spentOn,
      amount: num(row.amount) ?? 0,
      note: row.note,
      recordedBy: row.recordedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedBy: row.voidedBy,
      voidReason: row.voidReason,
    };
  }

  private async campaignRow(principal: Principal, id: string): Promise<HiringCampaignRow> {
    const [row] = await this.db
      .select()
      .from(hiringCampaigns)
      .where(and(eq(hiringCampaigns.companyId, principal.companyId), eq(hiringCampaigns.id, id)))
      .limit(1);
    // Another company's campaign is "not found", never an empty history.
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No campaign ${id}` });
    return row;
  }

  private async spendRow(principal: Principal, id: string): Promise<HiringCampaignSpendRow> {
    const [row] = await this.db
      .select()
      .from(hiringCampaignSpend)
      .where(and(eq(hiringCampaignSpend.companyId, principal.companyId), eq(hiringCampaignSpend.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No spend entry ${id}` });
    return row;
  }

  /**
   * Keeps the pre-0038 `spend` column equal to the live entries' sum. It is never read by this
   * code; it is there so a rollback to the older code shows the right totals.
   */
  private async mirrorLegacySpend(companyId: string, campaignId: string): Promise<void> {
    await this.db.execute(sql`
      update hiring_campaigns set spend = coalesce((
        select sum(amount) from hiring_campaign_spend
        where company_id = ${companyId} and campaign_id = ${campaignId} and voided_at is null
      ), 0)
      where company_id = ${companyId} and id = ${campaignId}`);
  }

  private async insertSpend(
    principal: Principal,
    campaignId: string,
    campaignName: string,
    input: { spentOn: string; amount: number; note: string | null; clientKey: string | null; at?: Date },
  ): Promise<HiringCampaignSpendRow> {
    const at = input.at ?? new Date();
    const id = `cmpsp_${crypto.randomUUID()}`;
    try {
      await this.db.insert(hiringCampaignSpend).values({
        id,
        companyId: principal.companyId,
        campaignId,
        spentOn: input.spentOn,
        amount: String(input.amount),
        note: input.note,
        recordedBy: principal.userName ?? principal.userId,
        clientKey: input.clientKey,
        createdAt: at,
        updatedAt: at,
      });
    } catch (error) {
      // Two sends of the same save raced: the first one's row is the answer.
      if (input.clientKey) {
        const [winner] = await this.db
          .select()
          .from(hiringCampaignSpend)
          .where(
            and(
              eq(hiringCampaignSpend.companyId, principal.companyId),
              eq(hiringCampaignSpend.clientKey, input.clientKey),
            ),
          )
          .limit(1);
        if (winner) return winner;
      }
      throw error;
    }
    await this.mirrorLegacySpend(principal.companyId, campaignId);
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'campaign',
      entityId: campaignId,
      entityLabel: campaignName,
      summary: `Campaign spend added: $${input.amount.toFixed(2)} on ${input.spentOn}`,
      changes: [
        { field: 'spendEntry', old: null, new: id },
        { field: 'spentOn', old: null, new: input.spentOn },
        { field: 'amount', old: null, new: String(input.amount) },
      ],
      at,
    });
    return (await this.spendRow(principal, id));
  }

  /** Every spend entry on a campaign, voided ones included (kept, struck through), newest first. */
  async listSpend(principal: Principal, campaignId: string): Promise<CampaignSpendEntry[]> {
    await this.campaignRow(principal, campaignId);
    const rows = await this.db
      .select()
      .from(hiringCampaignSpend)
      .where(
        and(
          eq(hiringCampaignSpend.companyId, principal.companyId),
          eq(hiringCampaignSpend.campaignId, campaignId),
        ),
      )
      .orderBy(desc(hiringCampaignSpend.spentOn), desc(hiringCampaignSpend.createdAt));
    return rows.map((r) => this.toSpend(r));
  }

  /** Adds a dated payment. Retry-safe: the form's `clientKey` finds the first save. */
  async addSpend(
    principal: Principal,
    campaignId: string,
    input: CreateCampaignSpendRequest,
  ): Promise<CampaignSpendEntry> {
    const campaign = await this.campaignRow(principal, campaignId);
    if (input.clientKey) {
      const [already] = await this.db
        .select()
        .from(hiringCampaignSpend)
        .where(
          and(
            eq(hiringCampaignSpend.companyId, principal.companyId),
            eq(hiringCampaignSpend.clientKey, input.clientKey),
          ),
        )
        .limit(1);
      if (already) {
        if (already.campaignId !== campaignId) {
          throw new AppError({ status: 409, title: 'Conflict', detail: 'Request key already used' });
        }
        return this.toSpend(already);
      }
    }
    const row = await this.insertSpend(principal, campaignId, campaign.name, input);
    return this.toSpend(row);
  }

  /** Corrects a spend entry. Names the version it read; an older one is a conflict, never an overwrite. */
  async updateSpend(
    principal: Principal,
    id: string,
    patch: UpdateCampaignSpendRequest,
  ): Promise<CampaignSpendEntry> {
    const before = await this.spendRow(principal, id);
    if (before.voidedAt) throw new AppError({ status: 409, title: 'Conflict', detail: 'This spend entry is voided; add a new one instead.' });
    const at = new Date();
    const updated = await this.db
      .update(hiringCampaignSpend)
      .set({
        ...(patch.spentOn !== undefined ? { spentOn: patch.spentOn } : {}),
        ...(patch.amount !== undefined ? { amount: String(patch.amount) } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        version: sql`${hiringCampaignSpend.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(hiringCampaignSpend.companyId, principal.companyId),
          eq(hiringCampaignSpend.id, id),
          eq(hiringCampaignSpend.version, patch.version),
          isNull(hiringCampaignSpend.voidedAt),
        ),
      )
      .returning({ id: hiringCampaignSpend.id });
    if (updated.length === 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Someone else changed this spend entry since you opened it. Reload it and try again.',
      });
    }
    const after = await this.spendRow(principal, id);
    const changes = (
      [
        ['spentOn', before.spentOn, after.spentOn],
        ['amount', num(before.amount), num(after.amount)],
        ['note', before.note, after.note],
      ] as const
    )
      .filter(([, a, b]) => String(a ?? '') !== String(b ?? ''))
      .map(([field, a, b]) => ({ field, old: a === null ? null : String(a), new: b === null ? null : String(b) }));
    await this.mirrorLegacySpend(principal.companyId, before.campaignId);
    const campaign = await this.campaignRow(principal, before.campaignId);
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'campaign',
      entityId: before.campaignId,
      entityLabel: campaign.name,
      summary: `Campaign spend corrected: ${changes.map((c) => c.field).join(', ') || 'no change'}`,
      changes: [{ field: 'spendEntry', old: id, new: id }, ...changes],
      at,
    });
    return this.toSpend(after);
  }

  /** Voids a spend entry: kept, struck through, out of every total, with who, when and why. */
  async voidSpend(
    principal: Principal,
    id: string,
    input: VoidCampaignSpendRequest,
  ): Promise<CampaignSpendEntry> {
    const before = await this.spendRow(principal, id);
    if (before.voidedAt) return this.toSpend(before);
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const updated = await this.db
      .update(hiringCampaignSpend)
      .set({
        voidedAt: at,
        voidedBy: by,
        voidReason: input.reason,
        version: sql`${hiringCampaignSpend.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(
          eq(hiringCampaignSpend.companyId, principal.companyId),
          eq(hiringCampaignSpend.id, id),
          eq(hiringCampaignSpend.version, input.version),
          isNull(hiringCampaignSpend.voidedAt),
        ),
      )
      .returning({ id: hiringCampaignSpend.id });
    if (updated.length === 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Someone else changed this spend entry since you opened it. Reload it and try again.',
      });
    }
    await this.mirrorLegacySpend(principal.companyId, before.campaignId);
    const campaign = await this.campaignRow(principal, before.campaignId);
    await this.audit.write(principal, {
      action: 'void',
      entityType: 'campaign',
      entityId: before.campaignId,
      entityLabel: campaign.name,
      summary: `Campaign spend voided: $${(num(before.amount) ?? 0).toFixed(2)} on ${before.spentOn}`,
      changes: [{ field: 'spendEntry', old: id, new: null }],
      reason: input.reason,
      at,
    });
    return this.toSpend(await this.spendRow(principal, id));
  }

  // ==================================================================================== ledger

  private toEntry(row: HiringCostEntryRow, expense: LinkedExpense | null): CostEntry {
    return {
      id: row.id,
      hiringCaseId: row.hiringCaseId,
      leadId: row.leadId,
      campaignId: row.campaignId,
      type: row.type as CostType,
      amount: num(row.amount) ?? 0,
      incurredOn: row.incurredOn,
      source: row.source as CostEntry['source'],
      // A manual entry's key is the client's retry key, not a record anyone can open.
      sourceRef: row.sourceRef?.startsWith('manual:') ? null : row.sourceRef,
      note: row.note,
      recordedBy: row.recordedBy,
      receiptFileId: row.receiptFileId,
      accountingExpenseId: row.accountingExpenseId,
      accounting: accountingState(row, expense),
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidedBy: row.voidedBy,
      voidReason: row.voidReason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The linked Accounting expenses of these rows, read in one query (this company only). */
  private async linkedExpenses(
    companyId: string,
    rows: readonly HiringCostEntryRow[],
  ): Promise<Map<string, LinkedExpense>> {
    const ids = [...new Set(rows.map((r) => r.accountingExpenseId).filter((v): v is string => !!v))];
    if (ids.length === 0) return new Map();
    const found = await this.db
      .select({
        id: acctExpenses.id,
        status: acctExpenses.status,
        amountCents: acctExpenses.amountCents,
        onDate: acctExpenses.onDate,
        record: acctExpenses.record,
      })
      .from(acctExpenses)
      .where(and(eq(acctExpenses.companyId, companyId), inArray(acctExpenses.id, ids)));
    return new Map(
      found.map((e) => [
        e.id,
        {
          id: e.id,
          status: e.status,
          amountCents: e.amountCents,
          onDate: e.onDate,
          expenseNumber: (e.record as { expenseNumber?: string }).expenseNumber ?? e.id,
        },
      ]),
    );
  }

  private async toEntries(companyId: string, rows: readonly HiringCostEntryRow[]): Promise<CostEntry[]> {
    const expenses = await this.linkedExpenses(companyId, rows);
    return rows.map((r) => this.toEntry(r, r.accountingExpenseId ? (expenses.get(r.accountingExpenseId) ?? null) : null));
  }

  private async entryOut(principal: Principal, id: string): Promise<CostEntry> {
    const [out] = await this.toEntries(principal.companyId, [await this.entry(principal, id)]);
    return out as CostEntry;
  }

  async list(principal: Principal, query: CostQuery): Promise<CostEntry[]> {
    const parts = [eq(hiringCostEntries.companyId, principal.companyId)];
    if (query.hiringCaseId) parts.push(eq(hiringCostEntries.hiringCaseId, query.hiringCaseId));
    if (query.leadId) parts.push(eq(hiringCostEntries.leadId, query.leadId));
    if (query.campaignId) parts.push(eq(hiringCostEntries.campaignId, query.campaignId));
    if (query.type) parts.push(eq(hiringCostEntries.type, query.type));
    const rows = await this.db
      .select()
      .from(hiringCostEntries)
      .where(and(...parts))
      .orderBy(desc(hiringCostEntries.incurredOn), desc(hiringCostEntries.createdAt));
    return this.toEntries(principal.companyId, rows);
  }

  /** Everything charged to a case, including what was charged to its lead before conversion. */
  async forCase(
    principal: Principal,
    caseId: string,
  ): Promise<{ entries: CostEntry[]; summary: CostSummary }> {
    // Another company's case is "not found", never an empty ledger.
    const [owned] = await this.db
      .select({ id: hiringCases.id })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, caseId)))
      .limit(1);
    if (!owned) throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${caseId}` });
    const [lead] = await this.db
      .select({ id: hiringLeads.id })
      .from(hiringLeads)
      .where(
        and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.hiringCaseId, caseId)),
      )
      .limit(1);
    const rows = await this.db
      .select()
      .from(hiringCostEntries)
      .where(
        and(
          eq(hiringCostEntries.companyId, principal.companyId),
          lead
            ? sql`(${hiringCostEntries.hiringCaseId} = ${caseId} or ${hiringCostEntries.leadId} = ${lead.id})`
            : eq(hiringCostEntries.hiringCaseId, caseId),
        ),
      )
      .orderBy(desc(hiringCostEntries.incurredOn), desc(hiringCostEntries.createdAt));
    const entries = await this.toEntries(principal.companyId, rows);
    return { entries, summary: sumCosts(entries) };
  }

  private async entry(principal: Principal, id: string): Promise<HiringCostEntryRow> {
    const [row] = await this.db
      .select()
      .from(hiringCostEntries)
      .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No cost entry ${id}` });
    return row;
  }

  /**
   * Records a cost a person entered, and posts it to Accounting as an expense when the person may
   * post there (`accounting.edit`); otherwise the cost is saved and waits, marked not posted, for
   * someone who may. Retry-safe: the client's `clientKey` names the save, so a resend finds the
   * entry the first attempt made (and finishes its posting if that had not happened).
   *
   * An Accounting expense can be attributed instead of typed: its amount and date are used, one
   * expense backs at most one live candidate cost, and nothing new is posted for it.
   */
  /**
   * A candidate cost from the journey (owner brief, 2026-10-11): the same save as `create`, with who
   * paid, whose cost it is and its approval written in the same insert — so the posting that follows
   * already knows whether it belongs in Accounting.
   */
  async createForJourney(principal: Principal, raw: CreateCostEntryRequest & JourneyCostFields): Promise<CostEntry> {
    const { paidBy, costOwner, vendor, approvalStatus, approvedBy, travelItemId, driverAgreementNote, ...base } = raw;
    return this.create(principal, base, {
      paidBy,
      costOwner,
      vendor,
      approvalStatus,
      approvedAt: approvalStatus === 'approved' ? new Date() : null,
      approvedBy,
      travelItemId,
      driverAgreementNote,
      driverAgreementAt: driverAgreementNote ? new Date() : null,
    });
  }

  /** Brings Accounting in line with one cost after its approval changed (when the person may post). */
  async resync(principal: Principal, id: string): Promise<void> {
    await this.postIfAllowed(principal, id);
  }

  async create(
    principal: Principal,
    raw: Omit<CreateCostEntryRequest, 'clientKey' | 'receiptFileId' | 'accountingExpenseId'> &
      Partial<Pick<CreateCostEntryRequest, 'clientKey' | 'receiptFileId' | 'accountingExpenseId'>>,
    journey: Partial<typeof hiringCostEntries.$inferInsert> = {},
  ): Promise<CostEntry> {
    const input: CreateCostEntryRequest = {
      ...raw,
      clientKey: raw.clientKey ?? null,
      receiptFileId: raw.receiptFileId ?? null,
      accountingExpenseId: raw.accountingExpenseId ?? null,
    };
    const retryKey = input.clientKey ? `manual:${principal.companyId}:${input.clientKey}` : null;
    if (retryKey) {
      const [already] = await this.db
        .select()
        .from(hiringCostEntries)
        .where(eq(hiringCostEntries.sourceRef, retryKey))
        .limit(1);
      if (already) {
        if (already.companyId !== principal.companyId) {
          throw new AppError({ status: 409, title: 'Conflict', detail: 'Request key already used' });
        }
        await this.postIfAllowed(principal, already.id);
        return this.entryOut(principal, already.id);
      }
    }
    if (input.campaignId) {
      const [c] = await this.db
        .select({ id: hiringCampaigns.id })
        .from(hiringCampaigns)
        .where(and(eq(hiringCampaigns.companyId, principal.companyId), eq(hiringCampaigns.id, input.campaignId)))
        .limit(1);
      if (!c) throw fieldError('campaignId', 'No such campaign in this company');
    }
    if (input.receiptFileId) {
      const [file] = await this.db
        .select({ id: storedFiles.id })
        .from(storedFiles)
        .where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, input.receiptFileId)))
        .limit(1);
      if (!file) throw fieldError('receiptFileId', 'The receipt upload was not found; attach it again');
    }
    let amount = input.amount;
    let incurredOn = input.incurredOn;
    let note = input.note;
    let receiptFileId = input.receiptFileId;
    if (input.accountingExpenseId) {
      if (!principal.permissions.has('accounting.view')) {
        throw new AppError({
          status: 403,
          title: 'Forbidden',
          detail: 'Attributing an Accounting expense needs access to Accounting (accounting.view).',
        });
      }
      const [expense] = await this.db
        .select()
        .from(acctExpenses)
        .where(and(eq(acctExpenses.companyId, principal.companyId), eq(acctExpenses.id, input.accountingExpenseId)))
        .limit(1);
      if (!expense) throw fieldError('accountingExpenseId', 'No such expense in Accounting');
      if (expense.status === 'void') throw fieldError('accountingExpenseId', 'That expense is void in Accounting');
      const [linked] = await this.db
        .select({ id: hiringCostEntries.id, caseId: hiringCostEntries.hiringCaseId })
        .from(hiringCostEntries)
        .where(
          and(
            eq(hiringCostEntries.companyId, principal.companyId),
            eq(hiringCostEntries.accountingExpenseId, expense.id),
            isNull(hiringCostEntries.voidedAt),
          ),
        )
        .limit(1);
      if (linked) {
        throw fieldError(
          'accountingExpenseId',
          linked.caseId === input.hiringCaseId
            ? 'This expense is already on this candidate'
            : 'This expense is already attributed to another candidate',
          409,
        );
      }
      const record = expense.record as { description?: string; receiptFileId?: string | null; expenseNumber?: string };
      amount = expense.amountCents / 100;
      incurredOn = expense.onDate;
      note = note ?? ([record.expenseNumber, record.description].filter(Boolean).join(' · ') || null);
      receiptFileId = receiptFileId ?? record.receiptFileId ?? null;
    }
    if (input.hiringCaseId) {
      const [c] = await this.db
        .select({ id: hiringCases.id })
        .from(hiringCases)
        .where(
          and(
            eq(hiringCases.companyId, principal.companyId),
            eq(hiringCases.id, input.hiringCaseId),
          ),
        )
        .limit(1);
      if (!c)
        throw new AppError({
          status: 404,
          title: 'Not Found',
          detail: `No hiring case ${input.hiringCaseId}`,
        });
    }
    if (input.leadId) {
      const [l] = await this.db
        .select({ id: hiringLeads.id })
        .from(hiringLeads)
        .where(
          and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, input.leadId)),
        )
        .limit(1);
      if (!l)
        throw new AppError({ status: 404, title: 'Not Found', detail: `No lead ${input.leadId}` });
    }
    const id = `cst_${crypto.randomUUID()}`;
    try {
      await this.db.insert(hiringCostEntries).values({
        id,
        companyId: principal.companyId,
        hiringCaseId: input.hiringCaseId,
        leadId: input.leadId,
        campaignId: input.campaignId,
        type: input.type,
        amount: String(amount),
        incurredOn,
        source: 'manual',
        sourceRef: retryKey,
        note,
        recordedBy: principal.userName ?? principal.userId,
        receiptFileId,
        accountingExpenseId: input.accountingExpenseId,
        ...journey,
      });
    } catch (error) {
      // Two sends of the same save raced: the other one won, and its entry is the answer.
      if (retryKey) {
        const [winner] = await this.db
          .select()
          .from(hiringCostEntries)
          .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.sourceRef, retryKey)))
          .limit(1);
        if (winner) {
          await this.postIfAllowed(principal, winner.id);
          return this.entryOut(principal, winner.id);
        }
      }
      if (input.accountingExpenseId) {
        throw fieldError('accountingExpenseId', 'This expense is already attributed to a candidate', 409);
      }
      throw error;
    }
    const label = await this.labelFor(principal.companyId, input.hiringCaseId, input.leadId);
    await this.audit.write(principal, {
      action: 'create',
      entityType: input.hiringCaseId ? 'hiring_case' : 'lead',
      entityId: input.hiringCaseId ?? (input.leadId as string),
      entityLabel: label,
      summary: input.accountingExpenseId
        ? `Cost attributed from Accounting: ${input.type.replace(/_/g, ' ')} $${amount}`
        : `Cost recorded: ${input.type.replace(/_/g, ' ')} $${amount}`,
      changes: [
        { field: 'costEntry', old: null, new: id },
        ...(receiptFileId ? [{ field: 'receiptFileId', old: null, new: receiptFileId }] : []),
        ...(input.accountingExpenseId
          ? [{ field: 'accountingExpenseId', old: null, new: input.accountingExpenseId }]
          : []),
      ],
    });
    await this.postIfAllowed(principal, id);
    return this.entryOut(principal, id);
  }

  /** The candidate's (or the lead's) name, for audit labels and the expense description. */
  private async labelFor(companyId: string, caseId: string | null, leadId: string | null): Promise<string> {
    if (caseId) {
      const [c] = await this.db
        .select({ name: hiringCases.candidateName })
        .from(hiringCases)
        .where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.id, caseId)))
        .limit(1);
      return c?.name ?? caseId;
    }
    if (leadId) {
      const [l] = await this.db
        .select({ first: hiringLeads.firstName, last: hiringLeads.lastName })
        .from(hiringLeads)
        .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.id, leadId)))
        .limit(1);
      return l ? `${l.first} ${l.last ?? ''}`.trim() : leadId;
    }
    return 'Recruiting';
  }

  /**
   * Voids a manual entry: kept, struck through, out of every total, with who, when and why. An
   * automatic entry follows the record it priced, so it is corrected there (the ticket, the
   * orientation, the offer), not here.
   *
   * A cost that was posted to Accounting takes its expense with it, through Accounting's own
   * void (a reversing entry, never a delete). If Accounting refuses that void - a closed month,
   * a bill over the expense - or the person may not void there, the cost is not voided either,
   * and the answer says why. A cost attributed from an existing expense only lets go of it: the
   * expense was Accounting's before and stays.
   */
  async voidEntry(principal: Principal, id: string, reason: string): Promise<CostEntry> {
    return this.withLock(costLock(principal.companyId, id), async () => {
      const row = await this.entry(principal, id);
      if (row.voidedAt) return this.entryOut(principal, id);
      if (row.source !== 'manual') {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail:
            'This cost was recorded automatically from its source record. Correct the ticket, orientation or offer it came from instead.',
        });
      }
      const [expense] = [...(await this.linkedExpenses(principal.companyId, [row])).values()];
      const posted = row.accountingPostedAt !== null && expense !== undefined && expense.status !== 'void';
      let expenseVoided: string | null = null;
      if (posted) {
        if (!principal.permissions.has(ACCOUNTING_POST_PERMISSION)) {
          throw new AppError({
            status: 403,
            title: 'Forbidden',
            detail: `This cost is posted to Accounting as ${expense.expenseNumber}. Voiding it also voids that expense, which needs someone with ${ACCOUNTING_POST_PERMISSION} (post and edit accounting records). Nothing was changed.`,
          });
        }
        const out = await this.payables.voidExpense(principal, expense.id, `Candidate cost voided: ${reason}`);
        if (!out.ok) {
          throw new AppError({
            status: 409,
            title: 'Conflict',
            detail: `Not voided. Accounting refused to void ${expense.expenseNumber}: ${out.blocked}`,
          });
        }
        expenseVoided = expense.expenseNumber;
      }
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      await this.db
        .update(hiringCostEntries)
        .set({ voidedAt: at, voidedBy: by, voidReason: reason, accountingPostNote: null })
        .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)));
      await this.audit.write(principal, {
        action: 'void',
        entityType: row.hiringCaseId ? 'hiring_case' : 'lead',
        entityId: row.hiringCaseId ?? (row.leadId as string),
        entityLabel: await this.labelFor(principal.companyId, row.hiringCaseId, row.leadId),
        summary: `Cost voided: ${row.type.replace(/_/g, ' ')} $${num(row.amount) ?? 0}${expenseVoided ? `; Accounting expense ${expenseVoided} voided with it` : ''}`,
        changes: [
          { field: 'costEntry', old: id, new: null },
          ...(expenseVoided ? [{ field: 'accountingExpenseStatus', old: 'posted', new: 'void' }] : []),
        ],
        reason,
        at,
      });
      return this.entryOut(principal, id);
    });
  }

  // =================================================================== posting to Accounting

  /** Runs `fn` alone for this key; see HiringService.withLock (same pattern, same database lock). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const outcome = await this.db.transaction(async (tx) => {
        const rows = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`,
        )) as unknown as { ok: boolean }[];
        if (!rows[0]?.ok) return { held: false as const };
        return { held: true as const, value: await fn() };
      });
      if (outcome.held) return outcome.value;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    throw new AppError({
      status: 409,
      title: 'Conflict',
      detail: 'Another save of this cost is still running. Try again in a moment.',
    });
  }

  /**
   * Brings Accounting in line with a cost when the person may post there; otherwise leaves the
   * cost marked "not posted" for someone who may. Never throws: a cost is saved whatever
   * Accounting says, and what Accounting said is kept on the row.
   */
  private async postIfAllowed(principal: Principal, id: string): Promise<void> {
    if (!principal.permissions.has(ACCOUNTING_POST_PERMISSION)) return;
    try {
      await this.syncAccounting(principal, id);
    } catch (error) {
      this.logger.error({ err: error, costId: id }, 'Posting a candidate cost to Accounting failed');
      await this.db
        .update(hiringCostEntries)
        .set({ accountingPostNote: 'Posting to Accounting failed; try Post to Accounting again.' })
        .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)));
    }
  }

  /**
   * The Post to Accounting button (`POST /hiring/costs/:id/accounting`), for a person with
   * `accounting.edit`: posts a cost that is not posted, replaces an expense that no longer
   * matches its re-priced cost, or voids the expense of a voided cost. A refusal is a 409 with
   * Accounting's own words.
   */
  async postToAccounting(principal: Principal, id: string): Promise<CostEntry> {
    const result = await this.syncAccounting(principal, id);
    if (!result.ok) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `Not posted. ${result.blocked}` });
    }
    return this.entryOut(principal, id);
  }

  /**
   * One cost, made to agree with Accounting. Under a per-cost lock, so a double click or a retry
   * runs after the first and finds its expense; the expense's source key
   * (`recruiting:<cost id>`, then `:r2`, `:r3` for a re-priced cost) is unique in Accounting, so
   * even a lost lock cannot book the same cost twice. Money is never moved: the expense is
   * recorded against Accounts payable, and a void is a reversing entry.
   */
  private async syncAccounting(principal: Principal, id: string): Promise<{ ok: true } | { ok: false; blocked: string }> {
    if (!principal.permissions.has(ACCOUNTING_POST_PERMISSION)) {
      return { ok: false, blocked: `Posting to Accounting needs someone with ${ACCOUNTING_POST_PERMISSION}.` };
    }
    return this.withLock(costLock(principal.companyId, id), async () => {
      const row = await this.entry(principal, id);
      // Attributed from an expense Accounting already had: nothing is posted for it, ever.
      if (row.accountingExpenseId && !row.accountingPostedAt) return { ok: true as const };
      const note = async (text: string | null) => {
        await this.db
          .update(hiringCostEntries)
          .set({ accountingPostNote: text })
          .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)));
      };
      const label = await this.labelFor(principal.companyId, row.hiringCaseId, row.leadId);
      const auditPost = async (summary: string, changes: { field: string; old: string | null; new: string | null }[]) =>
        this.audit.write(principal, {
          action: 'update',
          entityType: row.hiringCaseId ? 'hiring_case' : 'lead',
          entityId: row.hiringCaseId ?? (row.leadId as string),
          entityLabel: label,
          summary,
          changes,
        });
      // Every expense this cost has ever posted, live or void, oldest first.
      const mine = (
        await this.db
          .select({
            id: acctExpenses.id,
            status: acctExpenses.status,
            amountCents: acctExpenses.amountCents,
            onDate: acctExpenses.onDate,
            sourceKey: acctExpenses.sourceKey,
            record: acctExpenses.record,
          })
          .from(acctExpenses)
          .where(
            and(
              eq(acctExpenses.companyId, principal.companyId),
              sql`(${acctExpenses.sourceKey} = ${`${RECRUITING_EXPENSE_SOURCE}:${id}`} or ${acctExpenses.sourceKey} like ${`${RECRUITING_EXPENSE_SOURCE}:${id}:r%`})`,
            ),
          )
          .orderBy(asc(acctExpenses.createdAt))
      ).map((e) => ({ ...e, expenseNumber: (e.record as { expenseNumber?: string }).expenseNumber ?? e.id }));
      const live = mine.filter((e) => e.status !== 'void');
      const cents = Math.round((num(row.amount) ?? 0) * 100);
      const matches = (e: { amountCents: number; onDate: string }) => e.amountCents === cents && e.onDate === row.incurredOn;

      // Voided cost, or one that does not post: every live expense it posted is voided.
      if (row.voidedAt || !costPostsToAccounting(row)) {
        for (const e of live) {
          const out = await this.payables.voidExpense(principal, e.id, `Candidate cost ${row.voidedAt ? `voided: ${row.voidReason ?? ''}` : 'no longer posts'}`.trim());
          if (!out.ok) {
            await note(`Accounting refused to void ${e.expenseNumber}: ${out.blocked}`);
            return { ok: false as const, blocked: `Accounting refused to void ${e.expenseNumber}: ${out.blocked}` };
          }
          await auditPost(`Accounting expense ${e.expenseNumber} voided with its cost`, [
            { field: 'accountingExpenseStatus', old: e.status, new: 'void' },
          ]);
        }
        await note(null);
        return { ok: true as const };
      }

      // The one live expense that matches is the posting (a retry after a crash adopts it).
      const keep = live.find(matches) ?? null;
      for (const e of live) {
        if (e.id === keep?.id) continue;
        const out = await this.payables.voidExpense(principal, e.id, 'Candidate cost re-priced from its record; replaced by a new expense');
        if (!out.ok) {
          await note(`Accounting refused to replace ${e.expenseNumber}: ${out.blocked}`);
          return { ok: false as const, blocked: `Accounting refused to replace ${e.expenseNumber}: ${out.blocked}` };
        }
        await auditPost(`Accounting expense ${e.expenseNumber} voided: the cost was re-priced`, [
          { field: 'accountingExpenseStatus', old: e.status, new: 'void' },
        ]);
      }
      if (keep) {
        if (row.accountingExpenseId !== keep.id || !row.accountingPostedAt || row.accountingPostNote) {
          await this.db
            .update(hiringCostEntries)
            .set({
              accountingExpenseId: keep.id,
              accountingPostedAt: row.accountingPostedAt ?? new Date(),
              accountingPostedBy: row.accountingPostedBy ?? principal.userName ?? principal.userId,
              accountingPostNote: null,
            })
            .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)));
        }
        return { ok: true as const };
      }

      const sourceId = mine.length === 0 ? id : `${id}:r${mine.length + 1}`;
      const type = row.type as CostType;
      const out = await this.payables.createExpense(principal, {
        onDate: row.incurredOn,
        categoryCode: RECRUITING_EXPENSE_CATEGORY,
        description: `Recruiting · ${COST_TYPE_LABELS[type]} · ${label}`,
        amount: cents / 100,
        truckId: null,
        driverId: null,
        loadId: null,
        vendorId: null,
        paymentMethod: null,
        // Recorded, not paid: it is credited to Accounts payable; nothing leaves the bank here.
        paidDirectly: false,
        notes: [row.note, `Candidate cost ${id}${row.source === 'auto' && row.sourceRef ? ` (from ${row.sourceRef})` : ''}`].filter(Boolean).join(' · '),
        burden: 'company_borne',
        source: RECRUITING_EXPENSE_SOURCE as 'recruiting',
        sourceId,
        receiptFileId: row.receiptFileId,
        payer: 'company',
      });
      if (!out.ok) {
        await note(`Accounting refused the expense: ${out.blocked}`);
        return { ok: false as const, blocked: `Accounting refused the expense: ${out.blocked}` };
      }
      const before = row.accountingExpenseId;
      const at = new Date();
      await this.db
        .update(hiringCostEntries)
        .set({
          accountingExpenseId: out.expense.id,
          accountingPostedAt: at,
          accountingPostedBy: principal.userName ?? principal.userId,
          accountingPostNote: null,
        })
        .where(and(eq(hiringCostEntries.companyId, principal.companyId), eq(hiringCostEntries.id, id)));
      await auditPost(
        `Cost posted to Accounting as ${out.expense.expenseNumber}: ${type.replace(/_/g, ' ')} $${(cents / 100).toFixed(2)}`,
        [{ field: 'accountingExpenseId', old: before, new: out.expense.id }],
      );
      return { ok: true as const };
    });
  }

  // ============================================================================ auto entries

  /**
   * Inserts or replaces the one entry for a source record, then - when the person whose action
   * priced it may post to Accounting - brings its expense in line. Returns the entry's id.
   */
  async upsertAuto(
    companyId: string,
    entry: {
      hiringCaseId: string;
      type: CostType;
      amount: number;
      incurredOn: string;
      sourceRef: string;
      note: string | null;
      campaignId?: string | null;
    },
    principal?: Principal,
  ): Promise<string> {
    const [existing] = await this.db
      .select({ id: hiringCostEntries.id })
      .from(hiringCostEntries)
      .where(eq(hiringCostEntries.sourceRef, entry.sourceRef))
      .limit(1);
    // The actual price was entered by hand (owner, 2026-10-12): the estimate stays replaced and is
    // never brought back by a re-sync.
    const [actual] = await this.db
      .select({ id: hiringCostEntries.id })
      .from(hiringCostEntries)
      .where(
        and(
          eq(hiringCostEntries.hiringCaseId, entry.hiringCaseId),
          eq(hiringCostEntries.type, entry.type),
          eq(hiringCostEntries.source, 'manual'),
          isNull(hiringCostEntries.voidedAt),
        ),
      )
      .limit(1);
    if (actual) return existing?.id ?? actual.id;
    let id: string;
    if (existing) {
      id = existing.id;
      // Re-priced from its record; one that had been voided because the record changed is live
      // again now that the record prices it again.
      await this.db
        .update(hiringCostEntries)
        .set({
          amount: String(entry.amount),
          incurredOn: entry.incurredOn,
          note: entry.note,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        })
        .where(eq(hiringCostEntries.id, existing.id));
    } else {
      id = `cst_${crypto.randomUUID()}`;
      await this.db.insert(hiringCostEntries).values({
        id,
        companyId,
        hiringCaseId: entry.hiringCaseId,
        leadId: null,
        campaignId: entry.campaignId ?? null,
        type: entry.type,
        amount: String(entry.amount),
        incurredOn: entry.incurredOn,
        source: 'auto',
        sourceRef: entry.sourceRef,
        note: entry.note,
        recordedBy: 'System',
      });
    }
    if (principal && principal.companyId === companyId) await this.postIfAllowed(principal, id);
    return id;
  }

  /** The record no longer prices anything (orientation not attended): void, never delete. */
  async removeAuto(
    sourceRef: string,
    reason = 'Its source record no longer prices it',
    principal?: Principal,
  ): Promise<void> {
    const voided = await this.db
      .update(hiringCostEntries)
      .set({ voidedAt: new Date(), voidedBy: 'System', voidReason: reason })
      .where(and(eq(hiringCostEntries.sourceRef, sourceRef), isNull(hiringCostEntries.voidedAt)))
      .returning({ id: hiringCostEntries.id, companyId: hiringCostEntries.companyId });
    // Its posted expense goes with it when the person may void there; otherwise the cost shows
    // "still in Accounting" until someone who may presses the button.
    for (const v of voided) {
      if (principal && principal.companyId === v.companyId) await this.postIfAllowed(principal, v.id);
    }
  }

  private async unitCosts(
    companyId: string,
  ): Promise<Record<keyof typeof UNIT_COST_SETTING_KEYS, number>> {
    const v = await this.settings.valuesFor(companyId, Object.values(UNIT_COST_SETTING_KEYS));
    const read = (key: keyof typeof UNIT_COST_SETTING_KEYS) => {
      const value = v[UNIT_COST_SETTING_KEYS[key]];
      return typeof value === 'number' ? value : DEFAULT_UNIT_COSTS[key];
    };
    return {
      mvr: read('mvr'),
      psp: read('psp'),
      clearinghouse: read('clearinghouse'),
      drug_test: read('drug_test'),
    };
  }

  private async caseForDriver(companyId: string, driverId: string) {
    const [row] = await this.db
      .select({ id: hiringCases.id })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.driverId, driverId)))
      .orderBy(desc(hiringCases.openedAt))
      .limit(1);
    return row ?? null;
  }

  /** Prices one filed screening report at the unit cost in force when it is priced. */
  async priceScreening(
    companyId: string,
    doc: {
      id: string;
      ownerId: string;
      requirementCode: string;
      uploadedAt: Date;
      supersedesDocumentId: string | null;
    },
  ): Promise<boolean> {
    const type = COST_TYPE_BY_REQUIREMENT[doc.requirementCode];
    if (!type) return false;
    // A signed consent is filed under the same requirement as the report it unlocks. It is the
    // driver's authorization, not the report, and costs nothing.
    const [consent] = await this.db
      .select({ id: consentRequests.id })
      .from(consentRequests)
      .where(eq(consentRequests.signedDocumentId, doc.id))
      .limit(1);
    if (consent) return false;
    // Priced once, at the unit cost in force when it was filed. A later change to the setting
    // prices later reports; it does not rewrite what this one cost.
    const [already] = await this.db
      .select({ id: hiringCostEntries.id })
      .from(hiringCostEntries)
      .where(eq(hiringCostEntries.sourceRef, `doc:${doc.id}`))
      .limit(1);
    if (already) return true;
    const hiringCase = await this.caseForDriver(companyId, doc.ownerId);
    if (!hiringCase) return false;
    const costs = await this.unitCosts(companyId);
    // A second report of the same kind on the same case was re-ordered. (The document's own
    // version chain is not the test: the signed consent sits in it under the same code.)
    const [prior] = await this.db
      .select({ id: hiringCostEntries.id })
      .from(hiringCostEntries)
      .where(
        and(
          eq(hiringCostEntries.hiringCaseId, hiringCase.id),
          eq(hiringCostEntries.type, type),
          eq(hiringCostEntries.source, 'auto'),
          isNull(hiringCostEntries.voidedAt),
        ),
      )
      .limit(1);
    await this.upsertAuto(companyId, {
      hiringCaseId: hiringCase.id,
      type,
      amount: costs[type],
      incurredOn: doc.uploadedAt.toISOString().slice(0, 10),
      sourceRef: `doc:${doc.id}`,
      note: prior ? 'Re-ordered report' : null,
    });
    return true;
  }

  async priceTicket(
    companyId: string,
    ticket: {
      id: string;
      hiringCaseId: string;
      departAt: Date;
      travelCost: string | null;
      lodgingCost: string | null;
      lodgingNights: number;
      travelMode: string;
      carrier: string | null;
    },
    principal?: Principal,
  ): Promise<void> {
    // The business date of the departure, on the Eastern calendar (not the UTC one).
    const day = easternDay(ticket.departAt.toISOString());
    const travel = num(ticket.travelCost);
    const lodging = num(ticket.lodgingCost);
    if (travel !== null) {
      await this.upsertAuto(companyId, {
        hiringCaseId: ticket.hiringCaseId,
        type: 'travel',
        amount: travel,
        incurredOn: day,
        sourceRef: `ticket:${ticket.id}:travel`,
        note: `${ticket.travelMode.replace(/_/g, ' ')}${ticket.carrier ? ` · ${ticket.carrier}` : ''}`,
      }, principal);
    }
    if (lodging !== null) {
      await this.upsertAuto(companyId, {
        hiringCaseId: ticket.hiringCaseId,
        type: 'lodging',
        amount: lodging,
        incurredOn: day,
        sourceRef: `ticket:${ticket.id}:lodging`,
        note: `${ticket.lodgingNights} night${ticket.lodgingNights === 1 ? '' : 's'}`,
      }, principal);
    }
  }

  async priceOrientation(
    companyId: string,
    orientation: {
      id: string;
      hiringCaseId: string;
      startDate: string;
      days: number;
      perDayPay: string | null;
      attendance: string;
    },
    principal?: Principal,
  ): Promise<void> {
    const perDay = num(orientation.perDayPay);
    const ref = `orientation:${orientation.id}`;
    if (orientation.attendance !== 'attended' || perDay === null) {
      await this.removeAuto(ref, undefined, principal);
      return;
    }
    await this.upsertAuto(companyId, {
      hiringCaseId: orientation.hiringCaseId,
      type: 'orientation_pay',
      amount: Math.round(perDay * orientation.days * 100) / 100,
      incurredOn: orientation.startDate,
      sourceRef: ref,
      note: `${orientation.days} day${orientation.days === 1 ? '' : 's'} × $${perDay}`,
    }, principal);
  }

  /** The bonuses an offer promised are costs once the person is hired, not before. */
  async priceHire(
    companyId: string,
    hiringCaseId: string,
    offer: {
      id: string;
      signOnBonus: string | null;
      referralBonus: string | null;
      referringDriverId: string | null;
    },
    hiredOn: string,
    principal?: Principal,
  ): Promise<void> {
    const signOn = num(offer.signOnBonus);
    const referral = num(offer.referralBonus);
    if (signOn !== null && signOn > 0) {
      await this.upsertAuto(companyId, {
        hiringCaseId,
        type: 'sign_on_bonus',
        amount: signOn,
        incurredOn: hiredOn,
        sourceRef: `offer:${offer.id}:sign_on`,
        note: null,
      }, principal);
    }
    if (referral !== null && referral > 0) {
      await this.upsertAuto(companyId, {
        hiringCaseId,
        type: 'referral_bonus',
        amount: referral,
        incurredOn: hiredOn,
        sourceRef: `offer:${offer.id}:referral`,
        note: offer.referringDriverId ? `Paid to ${offer.referringDriverId}` : null,
      }, principal);
    }
  }

  /**
   * Prices everything that happened before the ledger existed, through the same functions the
   * live hooks use. Idempotent: every auto entry is keyed by its source record.
   */
  async backfill(companyId: string): Promise<number> {
    const before = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(hiringCostEntries)
      .where(and(eq(hiringCostEntries.companyId, companyId), eq(hiringCostEntries.source, 'auto')));

    // Entries an earlier pricing charged for a signed consent are not costs; void them (kept).
    await this.db
      .update(hiringCostEntries)
      .set({
        voidedAt: new Date(),
        voidedBy: 'System',
        voidReason: 'A signed consent is not a screening report and costs nothing',
      })
      .where(
        and(
          eq(hiringCostEntries.companyId, companyId),
          eq(hiringCostEntries.source, 'auto'),
          isNull(hiringCostEntries.voidedAt),
          sql`${hiringCostEntries.sourceRef} in (select 'doc:' || ${consentRequests.signedDocumentId} from ${consentRequests} where ${consentRequests.signedDocumentId} is not null)`,
        ),
      );
    const driverIds = (
      await this.db
        .select({ driverId: hiringCases.driverId })
        .from(hiringCases)
        .where(and(eq(hiringCases.companyId, companyId), isNotNull(hiringCases.driverId)))
    ).map((r) => r.driverId as string);
    if (driverIds.length > 0) {
      const docs = await this.db
        .select()
        .from(complianceDocuments)
        .where(
          and(
            eq(complianceDocuments.companyId, companyId),
            inArray(complianceDocuments.ownerId, driverIds),
            inArray(complianceDocuments.requirementCode, SCREENING_CODES),
          ),
        );
      for (const doc of docs) await this.priceScreening(companyId, doc);
    }
    for (const ticket of await this.db
      .select()
      .from(hiringTickets)
      .where(eq(hiringTickets.companyId, companyId))) {
      await this.priceTicket(companyId, ticket);
    }
    for (const orientation of await this.db
      .select()
      .from(hiringOrientations)
      .where(eq(hiringOrientations.companyId, companyId))) {
      await this.priceOrientation(companyId, orientation);
    }
    const hired = await this.db
      .select({ id: hiringCases.id, offerId: hiringCases.offerId, hiredAt: hiringCases.hiredAt })
      .from(hiringCases)
      .where(
        and(
          eq(hiringCases.companyId, companyId),
          isNotNull(hiringCases.hiredAt),
          isNotNull(hiringCases.offerId),
        ),
      );
    for (const c of hired) {
      const [offer] = await this.db
        .select()
        .from(offers)
        .where(eq(offers.id, c.offerId as string))
        .limit(1);
      if (offer)
        await this.priceHire(
          companyId,
          c.id,
          offer,
          (c.hiredAt as Date).toISOString().slice(0, 10),
        );
    }

    const after = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(hiringCostEntries)
      .where(and(eq(hiringCostEntries.companyId, companyId), eq(hiringCostEntries.source, 'auto')));
    const added = (after[0]?.value ?? 0) - (before[0]?.value ?? 0);
    if (added > 0)
      this.logger.info(
        { entries: added },
        'Cost ledger backfilled from the file, tickets, orientations and offers',
      );
    return added;
  }
}
