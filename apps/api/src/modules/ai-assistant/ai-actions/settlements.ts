import type { AiCard } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { unprocessable } from '../../dispatch-board/ops.helpers';
import { DriverAccountsService } from '../../accounting/driver-accounts.service';
import { ExportsService } from '../../accounting/exports.service';
import { ReimbursementsService } from '../../accounting/reimbursements.service';
import { SettlementsService, type StatementRecord } from '../../accounting/settlements.service';
import { AccountingStore } from '../../accounting/store.service';
import { refusal, StaleActionError, usd, type ActionContext, type ActionDef, type ActionRefusal } from './types';

/**
 * NeWay AI actions for driver settlements. Each one goes through the same service calls the
 * Settlements page and the statement drawer make (generate, a charge on the driver's account,
 * an approved reimbursement, approve, record payment); nothing here calculates pay. Every figure
 * shown comes back from SettlementsService.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SETTLEMENTS_LINK: AiCard = { kind: 'link', label: 'Open Settlements', to: '/accounting/settlements' };
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const kindWord = (k: string) => (k === 'lo_oo' ? 'lease / owner operators' : k === 'vt' ? 'vendors' : 'company drivers');
const statementLink = (s: { id: string; settlementNumber: string }): AiCard => ({ kind: 'link', label: `Open ${s.settlementNumber}`, to: `/accounting/settlements/${encodeURIComponent(s.id)}` });
const dollarsToCents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const weekOfInput = (v: unknown): string | null => (typeof v === 'string' && DAY.test(v.trim()) ? v.trim() : null);

// ------------------------------------------------------------------ finding one statement

/** What a run compares against: any change to these since the plan makes the plan stale. */
interface StatementSeen {
  statementId: string;
  settlementNumber: string;
  partyName: string;
  version: number;
  status: StatementRecord['status'];
  netCents: number;
  payableCents: number;
  carryCents: number;
}

const statementInputSchema = {
  driver: { type: 'string', description: 'Driver name as it is on the statement, e.g. "John Smith". Use with week_of.' },
  week_of: { type: 'string', description: 'Any date in the settlement week, YYYY-MM-DD.' },
  statement_number: { type: 'string', description: 'e.g. ST-20261012-AB12CD. Use instead of driver + week_of when known.' },
} as const;

/** One statement by its number, or by driver name and a date in its week. Reads stored rows only. */
async function findStatement(ctx: ActionContext, principal: Principal, input: Record<string, unknown>, opts: { driversOnly: boolean }): Promise<StatementRecord | ActionRefusal> {
  const svc = ctx.get(SettlementsService);
  const number = String(input.statement_number ?? '').trim();
  if (number) {
    const all = await svc.statements(principal);
    const hit = all.find((s) => s.settlementNumber.toUpperCase() === number.toUpperCase() || s.id === number);
    if (!hit) return refusal(`There is no statement ${number} in this company.`);
    if (opts.driversOnly && hit.partyType !== 'driver') return refusal(`${hit.settlementNumber} is a vendor statement; this works on driver statements only.`);
    return hit;
  }
  const name = String(input.driver ?? '').trim();
  const weekOf = weekOfInput(input.week_of);
  if (!name || !weekOf) return refusal('Say which statement: the driver and a date in the week (YYYY-MM-DD), or the statement number.');
  const inWeek = (await svc.statements(principal)).filter((s) => s.status !== 'reversed' && s.periodStart <= weekOf && s.periodEnd >= weekOf && (!opts.driversOnly || s.partyType === 'driver'));
  const wanted = name.toLowerCase().replace(/\s+/g, ' ');
  const exact = inWeek.filter((s) => s.partyName.toLowerCase().replace(/\s+/g, ' ') === wanted);
  const matches = exact.length > 0 ? exact : inWeek.filter((s) => s.partyName.toLowerCase().includes(wanted));
  if (matches.length === 0) return refusal(`There is no statement for "${name}" in the week of ${weekOf}. The week's statements are generated on the Settlements page first.`);
  if (matches.length > 1) return refusal(`More than one statement matches "${name}" that week: ${matches.slice(0, 8).map((s) => `${s.partyName} (${s.settlementNumber})`).join(', ')}. Say which one.`);
  return matches[0]!;
}

/** The statement as the screen shows it (a draft is recomputed on read) plus its stored version. */
async function readStatement(ctx: ActionContext, principal: Principal, id: string): Promise<{ s: StatementRecord; seen: StatementSeen }> {
  const s = await ctx.get(SettlementsService).statement(principal, id);
  const stored = await ctx.get(AccountingStore).get<StatementRecord>('acct_settlements', principal.companyId, s.id);
  return { s, seen: { statementId: s.id, settlementNumber: s.settlementNumber, partyName: s.partyName, version: stored.version, status: s.status, netCents: s.netCents, payableCents: s.payableCents, carryCents: s.carryCents } };
}

/** Throws StaleActionError when the statement is no longer what the plan saw. */
async function recheck(ctx: ActionContext, principal: Principal, seen: StatementSeen): Promise<StatementRecord> {
  const { s, seen: now } = await readStatement(ctx, principal, seen.statementId);
  const moved: string[] = [];
  if (now.version !== seen.version) moved.push('it was saved again');
  if (now.status !== seen.status) moved.push(`status is now ${now.status}`);
  if (now.netCents !== seen.netCents || now.payableCents !== seen.payableCents || now.carryCents !== seen.carryCents) moved.push(`totals are now net ${usd(now.netCents)}, to pay ${usd(now.payableCents)}`);
  if (moved.length) throw new StaleActionError(`${seen.settlementNumber} (${seen.partyName}) changed since the plan: ${moved.join('; ')}. Ask again to see it as it stands.`);
  return s;
}

function totalsLines(s: StatementRecord): string[] {
  const c = s.computation;
  const out = [`${s.partyName}${s.unitNumber ? ` · Unit ${s.unitNumber}` : ''} · ${s.settlementNumber} · ${s.periodStart} – ${s.periodEnd} · ${s.status}`];
  if (c) out.push(`Earned ${usd(c.grossCents)} · reimbursements +${usd(c.reimbursementsCents)} · taken off −${usd(c.deductionsCents)} · escrow −${usd(c.escrowCents)}`);
  else if (s.vendor) out.push(`Vendor earnings ${usd(s.vendor.totalEarningsCents)} · deductions −${usd(s.vendor.totalDeductionsCents)}`);
  out.push(`Net ${usd(s.netCents)} · to pay out ${usd(s.payableCents)}${s.carryCents > 0 ? ` · ${usd(s.carryCents)} carried to next week` : ''}`);
  return out;
}

// ------------------------------------------------------------------ generate the week

type Preview = Awaited<ReturnType<SettlementsService['preview']>>;

/** Everything in the preview that would change what Generate writes. */
const previewKey = (p: Preview) =>
  JSON.stringify({
    period: p.period.start,
    can: p.canGenerate,
    batch: p.existingBatch ? [p.existingBatch.status, p.existingBatch.statements] : null,
    late: p.lateLoads,
    loads: p.loadsInWeek,
    drivers: p.drivers.map((d) => [d.driverId, d.grossCents, d.earnedCents, d.statementStatus, d.loads.map((l) => l.loadId).sort(), d.blockers]),
  });

export const statementsGenerate: ActionDef<{ kind: 'cd' | 'lo_oo'; weekOf: string; periodStart: string; previewKey: string }> = {
  name: 'statements_generate',
  description:
    "Create or update the week's driver statements, exactly like the Generate / Update draft statements button on the Settlements page. kind: cd (company drivers) or lo_oo (lease / owner operators). week_of: any date in the week, YYYY-MM-DD. Approved and paid statements are left alone. Returns a PDF for each statement.",
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['cd', 'lo_oo'], description: 'cd = company drivers, lo_oo = lease / owner operators' },
      week_of: { type: 'string', description: 'Any date in the week, YYYY-MM-DD.' },
    },
    required: ['kind', 'week_of'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const kind = input.kind === 'lo_oo' ? 'lo_oo' : input.kind === 'cd' ? 'cd' : null;
    const weekOf = weekOfInput(input.week_of);
    if (!kind || !weekOf) return refusal('Say which drivers (company drivers or lease / owner operators) and a date in the week (YYYY-MM-DD).');
    const p = await ctx.get(SettlementsService).preview(principal, { kind, weekOf });
    if (!p.canGenerate) {
      const missing = p.setup.filter((s) => s.key !== 'teamBaseMileageSplit');
      return refusal(`Statements cannot be generated yet - setup is missing in Settings › Accounting: ${missing.map((s) => `${s.label}: ${s.detail}`).join(' ')}`);
    }
    if (p.existingBatch?.status === 'closed') return refusal(`${kind.toUpperCase()} ${p.period.start} is closed.`);
    const gross = p.drivers.reduce((s, d) => s + d.grossCents, 0);
    const earnedKnown = p.drivers.filter((d) => d.earnedCents !== null);
    const earned = earnedKnown.reduce((s, d) => s + (d.earnedCents ?? 0), 0);
    const blocked = p.drivers.filter((d) => d.blockers.length > 0);
    const locked = p.drivers.filter((d) => d.statementStatus === 'approved' || d.statementStatus === 'paid');
    const lines = [
      `${p.drivers.length} ${kindWord(kind)} · week ${p.period.start} – ${p.period.end} (${p.timezone})`,
      `Gross on their loads ${usd(gross)} · earned ${usd(earned)}${earnedKnown.length < p.drivers.length ? ` for ${earnedKnown.length} of ${p.drivers.length} (the rest are blocked)` : ''}`,
      p.existingBatch ? `Updates the existing batch (${p.existingBatch.statements} statement(s), ${p.existingBatch.status}); approved and paid statements are left alone${locked.length ? ` (${locked.length})` : ''}.` : 'Creates the batch for this week.',
      ...blocked.slice(0, 10).map((d) => `${d.name}: ${d.blockers.join('; ')}`),
    ];
    if (blocked.length > 10) lines.push(`…and ${blocked.length - 10} more driver(s) with blockers.`);
    const warnings: string[] = [];
    for (const s of p.setup) if (s.key === 'teamBaseMileageSplit') warnings.push(`${s.label} not set: ${s.detail}`);
    if (p.lateLoads > 0) warnings.push(`${p.lateLoads} load(s) completed in an earlier week are on no statement; they are assigned on the Settlements page.`);
    if (blocked.length > 0) warnings.push(`${blocked.length} driver(s) have blockers; their statements are created in review and cannot be approved until fixed.`);
    return {
      ok: true,
      title: `Generate ${kindWord(kind)} statements · ${p.period.start} – ${p.period.end}`,
      lines,
      params: { kind, weekOf, periodStart: p.period.start, previewKey: previewKey(p) },
      fingerprint: `statements_generate:${kind}:${p.period.start}:${previewKey(p).length}`,
      totalCents: earnedKnown.length ? earned : null,
      destination: 'Settlements',
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const svc = ctx.get(SettlementsService);
    const now = await svc.preview(principal, { kind: p.kind, weekOf: p.weekOf });
    if (now.period.start !== p.periodStart || previewKey(now) !== p.previewKey) throw new StaleActionError(`The ${kindWord(p.kind)} week of ${p.periodStart} changed since the plan (loads, pay or statements moved). Ask again to see it as it stands.`);
    const batch = await svc.generate(principal, { kind: p.kind, weekOf: p.weekOf });
    const rows = (await svc.statements(principal, { batchId: batch.id })).filter((s) => batch.statementIds.includes(s.id));
    const exportsSvc = ctx.get(ExportsService);
    const cards: AiCard[] = rows.map((s) => ({ kind: 'file', title: `Statement ${s.settlementNumber} · ${s.partyName}`, path: `/accounting/settlements/${encodeURIComponent(s.id)}/pdf`, fileName: exportsSvc.fileName([s.settlementNumber, s.partyName], 'pdf') }));
    cards.push(SETTLEMENTS_LINK);
    const review = rows.filter((s) => s.status === 'review').length;
    return {
      text: `${rows.length} ${kindWord(p.kind)} statement(s) for ${batch.periodStart} – ${batch.periodEnd}: to pay ${usd(batch.totals.payableCents)}${batch.totals.carryCents ? `, ${usd(batch.totals.carryCents)} carried` : ''}${review ? `; ${review} in review with exceptions` : ''}.`,
      cards,
    };
  },
};

// ------------------------------------------------------------------ add a deduction / reimbursement

interface AdjustmentParams {
  seen: StatementSeen;
  driverId: string;
  truckId: string | null;
  kind: StatementRecord['kind'];
  periodStart: string;
  periodEnd: string;
  type: 'deduction' | 'reimbursement';
  amountCents: number;
  description: string;
  reason: string;
  installments: number;
  category: 'lumper' | 'scale' | 'parking' | 'repair_supplies' | 'other';
  missingReceiptReason: string;
}

const CATEGORIES = ['lumper', 'scale', 'parking', 'repair_supplies', 'other'] as const;

export const statementAddAdjustment: ActionDef<AdjustmentParams> = {
  name: 'statement_add_adjustment',
  description:
    "Add a deduction (a charge on the driver's account, taken from this week's pay) or a reimbursement (money the driver paid out of pocket, added to pay) to one driver's draft statement, the same way the statement drawer's Add deduction / Add reimbursement does; the week's drafts are then updated. Needs the driver and week (or statement number), the amount in dollars and a description. A deduction needs a reason kept on record; a reimbursement needs why there is no receipt (receipts are attached on the screen).",
  input_schema: {
    type: 'object',
    properties: {
      ...statementInputSchema,
      type: { type: 'string', enum: ['deduction', 'reimbursement'] },
      amount: { type: 'number', description: 'Dollars, e.g. 125.50' },
      description: { type: 'string', description: 'What the driver reads on the statement, e.g. "Damage - cracked mirror, unit 0008".' },
      reason: { type: 'string', description: 'Deduction: why (kept on record), e.g. "Agreed with the driver".' },
      weeks: { type: 'number', description: 'Deduction only: spread over this many weeks (1-52). Default 1.' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Reimbursement only. Default other.' },
      missing_receipt_reason: { type: 'string', description: 'Reimbursement only: why there is no receipt (recorded against the person).' },
    },
    required: ['type', 'amount', 'description'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const type = input.type === 'reimbursement' ? 'reimbursement' : input.type === 'deduction' ? 'deduction' : null;
    if (!type) return refusal('Say whether it is a deduction or a reimbursement.');
    const amountCents = dollarsToCents(input.amount);
    if (!amountCents) return refusal('Say the amount in dollars, more than zero.');
    const description = String(input.description ?? '').trim();
    if (description.length < 2) return refusal('Write what the driver will read on the statement.');
    if (description.length > 200) return refusal('The description is limited to 200 characters.');
    const reason = String(input.reason ?? '').trim();
    const missingReceiptReason = String(input.missing_receipt_reason ?? '').trim();
    if (type === 'deduction' && reason.length < 3) return refusal('Say why the deduction is taken (kept on record), e.g. "Agreed with the driver".');
    if (type === 'reimbursement' && missingReceiptReason.length < 3) return refusal('A reimbursement needs a receipt; it can only be attached on the statement screen. To add it here, say why there is no receipt.');
    const installments = Math.max(1, Math.min(52, Math.round(Number(input.weeks) || 1)));
    const category = CATEGORIES.find((c) => c === input.category) ?? 'other';

    const found = await findStatement(ctx, principal, input, { driversOnly: true });
    if ('ok' in found && found.ok === false) return found;
    const { s, seen } = await readStatement(ctx, principal, (found as StatementRecord).id);
    if (s.status !== 'draft' && s.status !== 'review') return refusal(`${s.settlementNumber} is ${s.status}. It is locked: a change goes on next week's statement.`);
    if (!s.computation) return refusal(`${s.settlementNumber} has not been calculated.`);

    const lines = [
      ...totalsLines(s),
      type === 'deduction'
        ? `Add deduction ${usd(amountCents)}: ${description}${installments > 1 ? ` - ${usd(Math.ceil(amountCents / installments))} a week for ${installments} weeks` : ''} · why: ${reason}`
        : `Add and approve reimbursement ${usd(amountCents)} (${category.replace('_', ' ')}): ${description} · no receipt: ${missingReceiptReason}`,
      type === 'deduction'
        ? "Taken from this week's pay as far as it allows, older amounts owed first; the rest stays owed and is taken next week."
        : 'Added to this statement as money owed to the driver.',
      `Then the week's draft ${kindWord(s.kind)} statements are updated, as the screen does.`,
    ];
    return {
      ok: true,
      title: `${type === 'deduction' ? 'Deduct' : 'Reimburse'} ${usd(amountCents)} on ${s.partyName}'s statement ${s.settlementNumber}`,
      lines,
      params: { seen, driverId: s.partyId, truckId: s.truckId, kind: s.kind, periodStart: s.periodStart, periodEnd: s.periodEnd, type, amountCents, description, reason, installments, category, missingReceiptReason },
      fingerprint: `statement_adj:${s.id}:${type}:${amountCents}:${description.slice(0, 60)}`,
      totalCents: amountCents,
      destination: s.settlementNumber,
      warnings: type === 'deduction' && s.computation && amountCents > s.computation.grossCents ? [`The deduction is more than this week's earnings (${usd(s.computation.grossCents)}); the rest stays owed.`] : undefined,
    };
  },
  async run(ctx, principal, p) {
    await recheck(ctx, principal, p.seen);
    if (p.type === 'deduction') {
      await ctx.get(DriverAccountsService).manualCharge(principal, p.driverId, {
        kind: 'manual_charge',
        amountCents: p.amountCents,
        onDate: p.periodEnd,
        description: p.description,
        reason: p.reason,
        approvalRequired: false,
        installments: p.installments > 1 ? p.installments : undefined,
      });
    } else {
      const reimb = ctx.get(ReimbursementsService);
      const r = await reimb.create(principal, {
        payerDriverId: p.driverId,
        truckId: p.truckId,
        loadId: null,
        onDate: p.periodEnd,
        category: p.category,
        receiptCents: p.amountCents,
        driverFundedCents: p.amountCents,
        currency: 'USD',
        description: p.description,
        paymentSource: 'driver_personal',
        receiptFileId: null,
        missingReceiptReason: p.missingReceiptReason,
        note: `Added on statement ${p.seen.settlementNumber} (NeWay AI)`,
      });
      if (!r.ok) throw unprocessable(r.blocked);
      await reimb.review(principal, r.expense.id, { decision: 'approve', reason: `Approved on statement ${p.seen.settlementNumber}` });
    }
    // The statement drawer updates the week's drafts after any change, so the totals stay in step.
    const svc = ctx.get(SettlementsService);
    await svc.generate(principal, { kind: p.kind, weekOf: p.periodStart });
    const after = await svc.statement(principal, p.seen.statementId);
    return {
      text: `${p.type === 'deduction' ? 'Deduction' : 'Reimbursement'} of ${usd(p.amountCents)} added on ${after.settlementNumber} (${after.partyName}). To pay out is now ${usd(after.payableCents)}${after.carryCents > 0 ? `, ${usd(after.carryCents)} carried to next week` : ''}.`,
      cards: [statementLink(after), SETTLEMENTS_LINK],
    };
  },
};

// ------------------------------------------------------------------ approve

export const statementApprove: ActionDef<{ seen: StatementSeen }> = {
  name: 'statement_approve',
  description:
    "Approve one statement (driver and week, or statement number), exactly like Approve this statement: it locks the statement, takes the recoveries, recurring charges and escrow, and posts the ledger entry. Refused while the statement has exceptions. Corrections after approval go on next week's statement.",
  input_schema: { type: 'object', properties: { ...statementInputSchema } },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const found = await findStatement(ctx, principal, input, { driversOnly: false });
    if ('ok' in found && found.ok === false) return found;
    const { s, seen } = await readStatement(ctx, principal, (found as StatementRecord).id);
    if (s.status === 'approved' || s.status === 'paid') return refusal(`${s.settlementNumber} is already ${s.status}.`);
    if (s.status === 'reversed') return refusal(`${s.settlementNumber} is reversed.`);
    if (s.exceptions.length > 0) return refusal(`Resolve the exceptions first: ${s.exceptions.join(' ')}`);
    if (s.partyType === 'driver') {
      const settings = await ctx.get(SettlementsService).settings(principal.companyId);
      const prof = await ctx.get(DriverAccountsService).profileOn(principal, s.partyId, s.periodEnd);
      if (prof && prof.contractType !== 'CD' && settings.payOnFundingOnly === null) return refusal('Pay-on-funding-only is not configured for LO/OO (Settings › Accounting).');
    }
    return {
      ok: true,
      title: `Approve ${s.settlementNumber} · ${s.partyName}`,
      lines: [...totalsLines(s), 'Approving locks the statement: it can no longer change, and corrections go on next week’s statement.'],
      params: { seen },
      fingerprint: `statement_approve:${s.id}:${seen.version}`,
      totalCents: s.payableCents,
      destination: s.settlementNumber,
    };
  },
  async run(ctx, principal, p) {
    await recheck(ctx, principal, p.seen);
    const r = await ctx.get(SettlementsService).approve(principal, p.seen.statementId);
    if (!r.ok) throw unprocessable(r.blocked);
    const s = r.statement;
    return {
      text: `${s.settlementNumber} (${s.partyName}) approved and locked: to pay out ${usd(s.payableCents)}${s.carryCents > 0 ? `, ${usd(s.carryCents)} carried to next week` : ''}.`,
      cards: [
        { kind: 'file', title: `Statement ${s.settlementNumber} · ${s.partyName}`, path: `/accounting/settlements/${encodeURIComponent(s.id)}/pdf`, fileName: ctx.get(ExportsService).fileName([s.settlementNumber, s.partyName], 'pdf') },
        statementLink(s),
        SETTLEMENTS_LINK,
      ],
    };
  },
};

// ------------------------------------------------------------------ record payment

const METHODS = ['ach', 'check', 'wire', 'cash'] as const;

export const statementRecordPayment: ActionDef<{ seen: StatementSeen; paidOn: string; reference: string; method: (typeof METHODS)[number] }> = {
  name: 'statement_record_payment',
  description:
    "Record that an approved statement was paid, like Record payment on the statement page: the full amount to pay out, the date it was paid, the method (ach, check, wire, cash) and the bank / ADP reference. Approval or an email is not payment; this is the bank's evidence.",
  input_schema: {
    type: 'object',
    properties: {
      ...statementInputSchema,
      reference: { type: 'string', description: 'Bank / ADP reference (required).' },
      method: { type: 'string', enum: [...METHODS], description: 'Default ach.' },
      paid_on: { type: 'string', description: 'YYYY-MM-DD; default today (US Eastern).' },
    },
    required: ['reference'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const reference = String(input.reference ?? '').trim();
    if (!reference) return refusal('Say the bank / ADP reference of the payment.');
    if (reference.length > 120) return refusal('The reference is limited to 120 characters.');
    const method = METHODS.find((m) => m === String(input.method ?? 'ach').toLowerCase()) ?? null;
    if (!method) return refusal('The method is ACH, check, wire or cash.');
    const today = easternToday();
    const paidOn = input.paid_on === undefined || input.paid_on === null || input.paid_on === '' ? today : weekOfInput(input.paid_on);
    if (!paidOn) return refusal('Paid on is a date, YYYY-MM-DD.');
    if (paidOn > today) return refusal(`Paid on (${paidOn}) is in the future.`);
    const found = await findStatement(ctx, principal, input, { driversOnly: false });
    if ('ok' in found && found.ok === false) return found;
    const { s, seen } = await readStatement(ctx, principal, (found as StatementRecord).id);
    if (s.status !== 'approved') return refusal(`${s.settlementNumber} is ${s.status}; only an approved statement is paid.`);
    return {
      ok: true,
      title: `Record payment ${usd(s.payableCents)} · ${s.settlementNumber} · ${s.partyName}`,
      lines: [...totalsLines(s), `Paid ${usd(s.payableCents)} on ${paidOn} by ${method.toUpperCase()} · reference ${reference}`, 'The liability is discharged in the ledger and the statement shows Paid.'],
      params: { seen, paidOn, reference, method },
      fingerprint: `statement_paid:${s.id}:${reference}`,
      totalCents: s.payableCents,
      destination: s.settlementNumber,
    };
  },
  async run(ctx, principal, p) {
    await recheck(ctx, principal, p.seen);
    const r = await ctx.get(SettlementsService).markPaid(principal, p.seen.statementId, { paidOn: p.paidOn, reference: p.reference, method: p.method });
    if (!r.ok) throw unprocessable(r.blocked);
    const s = r.statement;
    return { text: `Payment of ${usd(s.paidCents ?? s.payableCents)} recorded on ${s.settlementNumber} (${s.partyName}), ${p.method.toUpperCase()} ${p.reference}.`, cards: [statementLink(s), SETTLEMENTS_LINK] };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SETTLEMENT_ACTIONS: ActionDef<any>[] = [statementsGenerate, statementAddAdjustment, statementApprove, statementRecordPayment];
