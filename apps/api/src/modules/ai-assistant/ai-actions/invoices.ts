import { invoiceLinesFor, type AiCard } from '@neway/shared';
import type { Principal } from '../../../common/auth/principal';
import { InvoicesService, type InvoiceRecord } from '../../accounting/invoices.service';
import { unprocessable } from '../../dispatch-board/ops.helpers';
import { LoadsService } from '../../loads/loads.service';
import { refusal, StaleActionError, usd, type ActionDef } from './types';

/**
 * NeWay AI actions for invoices: create from a load, issue, record a customer payment, void.
 *
 * Each goes through InvoicesService exactly as the Accounting screens do (POST
 * /accounting/invoices/from-loads, /invoices/:id/issue, /payments, /invoices/:id/void), so the
 * billing verdict, the ledger postings, the audit entries and the frozen PDF are the service's
 * own. The money shown on a plan is the service's: the queue's lines, the invoice's total and
 * balance. Every run re-reads the record and refuses when it moved on since the plan.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['ach', 'check', 'card', 'wire', 'cash'] as const;
type Method = (typeof METHODS)[number];

const cents = (dollars: number) => Math.round(dollars * 100);
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();

/** "Today" on the server clock, as a US Eastern business date. */
const easternToday = (svc: InvoicesService) => svc.clock().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const invoiceCards = (inv: { id: string; invoiceNumber: string }, withPdf: boolean): AiCard[] => {
  const cards: AiCard[] = [{ kind: 'link', label: `Open ${inv.invoiceNumber}`, to: `/accounting/invoices/${encodeURIComponent(inv.id)}` }];
  if (withPdf) cards.push({ kind: 'file', title: `${inv.invoiceNumber} PDF`, path: `/accounting/invoices/${encodeURIComponent(inv.id)}/pdf`, fileName: `${inv.invoiceNumber}.pdf` });
  return cards;
};

async function findInvoice(svc: InvoicesService, principal: Principal, number: string): Promise<InvoiceRecord | null> {
  return svc.get(principal, number).catch(() => null);
}

/**
 * The check `issue()` runs at the moment of issue. It is private on the service; it is read-only
 * (it loads and computes the verdict), so the plan asks the very same question the issue will.
 */
function issueCheck(svc: InvoicesService, principal: Principal, loadId: string | null): Promise<string | null> {
  return svc['billingBlock'](principal, loadId);
}

// ------------------------------------------------------------------ create from a load

interface CreateParams {
  loadId: string;
  loadNumber: string;
  expectedUpdatedAt: string;
  totalCents: number;
}

const invoiceCreateFromLoad: ActionDef<CreateParams> = {
  name: 'invoice_create_from_load',
  description:
    'Create the draft invoice for a delivered load, exactly as the "Create invoice" button on the billing queue does. Needs the load number. Refuses, in the billing check\'s own words, when the load is not ready to bill (documents missing, needs review, open flags, already invoiced).',
  input_schema: {
    type: 'object',
    properties: { load_number: { type: 'string', description: 'e.g. L-100005' } },
    required: ['load_number'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const number = norm(input.load_number);
    if (!number) return refusal('Say which load, e.g. L-100005.');
    const load = await ctx.get(LoadsService).get(principal, number).catch(() => null);
    if (!load) return refusal(`There is no load ${number} in this company.`);
    const svc = ctx.get(InvoicesService);
    const { rows } = await svc.queue(principal);
    const row = rows.find((r) => r.load.id === load.id);
    if (!row) {
      const existing = await svc.invoiceForLoad(principal, load.id);
      if (existing) return refusal(`${load.loadNumber} is already on ${existing.invoiceNumber}.`);
      if (load.status === 'cancelled') return refusal(`${load.loadNumber}: Cancelled without a fee: nothing to bill.`);
      return refusal(`${load.loadNumber}: The load is not delivered yet.`);
    }
    if (row.invoice) return refusal(`${load.loadNumber} is already on ${row.invoice.invoiceNumber} (${row.invoice.status}).`);
    if (row.verdict.queue !== 'ready_to_bill') {
      const why = row.verdict.conditions.map((c) => c.message).join(' ') || `The load is in ${String(row.verdict.queue).replace(/_/g, ' ')}.`;
      return refusal(`${load.loadNumber} cannot be invoiced yet. ${why}`);
    }
    const lines = invoiceLinesFor(row.load);
    const totalCents = lines.reduce((s, l) => s + cents(l.amount), 0);
    const billToBroker = Boolean(row.load.brokerId || row.load.brokerName);
    const billTo = billToBroker ? (row.load.brokerName ?? row.load.customerName) : row.load.customerName;
    return {
      ok: true,
      title: `Create the draft invoice for ${load.loadNumber}`,
      lines: [`Bill to: ${billTo || '(no name on the load)'} (${billToBroker ? 'broker' : 'customer'})`, ...lines.map((l) => `${l.description}: ${usd(cents(l.amount))}`), `Total: ${usd(totalCents)}`, 'Saved as a draft; nothing posts until it is issued.'],
      params: { loadId: load.id, loadNumber: load.loadNumber, expectedUpdatedAt: row.load.updatedAt, totalCents },
      fingerprint: `invoice_create:${load.id}`,
      totalCents,
      destination: billTo || null,
    };
  },
  async run(ctx, principal, p) {
    const svc = ctx.get(InvoicesService);
    const { rows } = await svc.queue(principal);
    const row = rows.find((r) => r.load.id === p.loadId);
    if (!row || row.invoice || row.verdict.queue !== 'ready_to_bill') throw new StaleActionError(`${p.loadNumber} is no longer ready to bill. Ask again to see why.`);
    const totalNow = invoiceLinesFor(row.load).reduce((s, l) => s + cents(l.amount), 0);
    if (row.load.updatedAt !== p.expectedUpdatedAt || totalNow !== p.totalCents) throw new StaleActionError(`${p.loadNumber} changed since the plan.`);
    const res = await svc.createFromLoads(principal, [p.loadId]);
    const inv = res.created[0];
    if (!inv) throw unprocessable(`${p.loadNumber}: ${res.skipped[0]?.reason ?? 'the invoice was not created.'}`);
    return { text: `${inv.invoiceNumber} drafted from ${p.loadNumber} for ${usd(cents(inv.total))}.`, cards: invoiceCards(inv, true) };
  },
};

// ------------------------------------------------------------------ issue

interface IssueParams {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
  totalCents: number;
  revision: boolean;
}

const invoiceIssue: ActionDef<IssueParams> = {
  name: 'invoice_issue',
  description:
    'Issue a draft invoice: posts the revenue and the receivable and freezes the PDF. Give the invoice number (INV-10004), or the load number when that load has exactly one draft. Refuses with the issue check\'s reasons when the paperwork no longer holds up. A draft revision (INV2-...) is issued as a revision.',
  input_schema: {
    type: 'object',
    properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-10004' },
      load_number: { type: 'string', description: 'e.g. L-100005, when no invoice number is given' },
    },
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const svc = ctx.get(InvoicesService);
    const invNumber = norm(input.invoice_number);
    const loadNumber = norm(input.load_number);
    let inv: InvoiceRecord | null = null;
    if (invNumber) {
      inv = await findInvoice(svc, principal, invNumber);
      if (!inv) return refusal(`Invoice ${invNumber} is not on file.`);
    } else if (loadNumber) {
      const drafts = (await svc.list(principal)).filter((i) => i.loadNumber.toUpperCase() === loadNumber && i.status === 'draft');
      if (drafts.length === 0) return refusal(`${loadNumber} has no draft invoice. Create one first.`);
      if (drafts.length > 1) return refusal(`${loadNumber} has ${drafts.length} drafts (${drafts.map((d) => d.invoiceNumber).join(', ')}). Say which invoice number.`);
      inv = drafts[0]!;
    } else return refusal('Say which invoice (e.g. INV-10004) or which load.');
    if (inv.status !== 'draft') return refusal(`${inv.invoiceNumber} has already been issued.`);
    const totalCents = cents(inv.total);
    if (inv.revisionOf) {
      return {
        ok: true,
        title: `Issue revision ${inv.invoiceNumber}`,
        lines: [`Replaces ${inv.revisionOf.invoiceNumber} (${usd(cents(inv.revisionOf.previousTotal))}): ${inv.revisionOf.reason}`, `New total: ${usd(totalCents)} (${inv.revisionOf.adjustment >= 0 ? '+' : '-'}${usd(Math.abs(cents(inv.revisionOf.adjustment)))})`, `Bill to: ${inv.billToName}`, 'Posts only what changed; payments carry over.'],
        params: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, expectedUpdatedAt: inv.updatedAt, totalCents, revision: true },
        fingerprint: `invoice_issue:${inv.id}`,
        totalCents,
        destination: inv.billToName,
      };
    }
    const blocked = await issueCheck(svc, principal, inv.loadId);
    if (blocked) return refusal(`${inv.invoiceNumber} cannot be issued: ${blocked}`);
    const issuedOn = svc.clock().toISOString().slice(0, 10);
    return {
      ok: true,
      title: `Issue ${inv.invoiceNumber} · ${inv.loadNumber}`,
      lines: [`Bill to: ${inv.billToName}`, ...inv.lines.map((l) => `${l.description}: ${usd(cents(l.amount))}`), `Total: ${usd(totalCents)}`, `Issued ${issuedOn}, due in ${inv.paymentTermsDays} days`, 'Posts revenue and the receivable; the PDF is frozen as issued.'],
      params: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, expectedUpdatedAt: inv.updatedAt, totalCents, revision: false },
      fingerprint: `invoice_issue:${inv.id}`,
      totalCents,
      destination: inv.billToName,
    };
  },
  async run(ctx, principal, p) {
    const svc = ctx.get(InvoicesService);
    const now = await svc.get(principal, p.invoiceId);
    if (now.updatedAt !== p.expectedUpdatedAt || cents(now.total) !== p.totalCents || now.status !== 'draft') throw new StaleActionError(`${p.invoiceNumber} changed since the plan.`);
    if (p.revision) {
      const res = await svc.issueRevision(principal, p.invoiceId, { expectedUpdatedAt: p.expectedUpdatedAt });
      if (!res.ok) throw unprocessable(res.blocked);
      return { text: `${res.invoice.invoiceNumber} issued as a revision (${usd(cents(res.invoice.total))}).`, cards: invoiceCards(res.invoice, true) };
    }
    const res = await svc.issue(principal, p.invoiceId);
    if (!res.ok) throw unprocessable(res.blocked);
    return { text: `${res.invoice.invoiceNumber} issued for ${usd(cents(res.invoice.total))}, due ${res.invoice.dueOn}.`, cards: invoiceCards(res.invoice, true) };
  },
};

// ------------------------------------------------------------------ record a payment

interface PaymentParams {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
  balanceCents: number;
  partyType: 'customer' | 'broker';
  partyId: string;
  partyName: string;
  amount: number;
  method: Method;
  receivedOn: string;
  reference: string;
  notes: string | null;
}

const invoiceRecordPayment: ActionDef<PaymentParams> = {
  name: 'invoice_record_payment',
  description:
    'Record a payment received from the customer or broker and apply it to one invoice (a direct receipt, not an RTS funding). Needs the invoice number, the amount in dollars, the method (ach, check, card, wire, cash) and the reference (check number, ACH trace). The date defaults to today (US Eastern).',
  input_schema: {
    type: 'object',
    properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-10004' },
      amount: { type: 'number', description: 'Dollars received, e.g. 1850.00' },
      method: { type: 'string', enum: [...METHODS] },
      reference: { type: 'string', description: 'Check number, ACH trace or wire reference.' },
      received_on: { type: 'string', description: 'YYYY-MM-DD; leave out for today.' },
      notes: { type: 'string' },
    },
    required: ['invoice_number', 'amount', 'method', 'reference'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const svc = ctx.get(InvoicesService);
    const number = norm(input.invoice_number);
    if (!number) return refusal('Say which invoice, e.g. INV-10004.');
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return refusal('Say the amount received, in dollars.');
    const method = String(input.method ?? '').trim().toLowerCase() as Method;
    if (!METHODS.includes(method)) return refusal('Say how it was paid: ACH, check, card, wire or cash.');
    const reference = String(input.reference ?? '').trim();
    if (!reference) return refusal('Give the payment reference (check number, ACH trace or wire reference).');
    if (reference.length > 120) return refusal('The reference is too long (120 characters at most).');
    const today = easternToday(svc);
    const receivedOn = input.received_on ? String(input.received_on).trim() : today;
    if (!DAY.test(receivedOn)) return refusal('Give the date as YYYY-MM-DD.');
    const notes = input.notes ? String(input.notes).trim().slice(0, 1000) || null : null;
    const inv = await findInvoice(svc, principal, number);
    if (!inv) return refusal(`Invoice ${number} is not on file.`);
    if (inv.status === 'draft') return refusal(`${inv.invoiceNumber} is a draft. Issue it first.`);
    if (inv.status === 'void' || inv.status === 'superseded' || !inv.isCurrent) return refusal(`${inv.invoiceNumber} is ${inv.status === 'void' ? 'void' : 'not the current version'}; it cannot take a payment.`);
    const balanceCents = cents(inv.balance);
    if (balanceCents <= 0) return refusal(`${inv.invoiceNumber} has no balance left.`);
    if (cents(amount) > balanceCents) return refusal(`${usd(cents(amount))} is more than the ${usd(balanceCents)} still open on ${inv.invoiceNumber}.`);
    const warnings: string[] = [];
    if (receivedOn > today) warnings.push(`The date ${receivedOn} is after today (${today}).`);
    if ((inv.factoring?.fundedGross ?? 0) > 0 || (inv.submission && inv.submission.status !== 'prepared')) warnings.push(`${inv.invoiceNumber} has gone to RTS. A broker's payment to RTS is not company cash; record RTS money as a funding instead.`);
    const remaining = balanceCents - cents(amount);
    return {
      ok: true,
      title: `Record ${usd(cents(amount))} on ${inv.invoiceNumber}`,
      lines: [`From: ${inv.billToName} (${inv.billToType})`, `${method.toUpperCase()} · ${reference} · received ${receivedOn}`, `Open now: ${usd(balanceCents)} → after: ${usd(remaining)}${remaining === 0 ? ' (paid)' : ''}`, ...(notes ? [`Note: ${notes}`] : [])],
      params: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, expectedUpdatedAt: inv.updatedAt, balanceCents, partyType: inv.billToType, partyId: inv.billToId || inv.billToName, partyName: inv.billToName, amount, method, receivedOn, reference, notes },
      fingerprint: `invoice_payment:${inv.id}:${reference}:${receivedOn}:${cents(amount)}`,
      totalCents: cents(amount),
      destination: inv.invoiceNumber,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const svc = ctx.get(InvoicesService);
    const now = await svc.get(principal, p.invoiceId);
    if (now.updatedAt !== p.expectedUpdatedAt || cents(now.balance) !== p.balanceCents) throw new StaleActionError(`${p.invoiceNumber} changed since the plan (balance now ${usd(cents(now.balance))}).`);
    const res = await svc.recordPayment(principal, {
      partyType: p.partyType,
      partyId: p.partyId,
      partyName: p.partyName,
      amount: p.amount,
      method: p.method,
      receivedOn: p.receivedOn,
      reference: p.reference,
      applications: [{ invoiceId: p.invoiceId, amount: p.amount }],
      notes: p.notes,
    });
    if (!res.ok) throw unprocessable(res.blocked);
    const after = await svc.get(principal, p.invoiceId);
    return {
      text: `${usd(cents(p.amount))} from ${p.partyName} recorded on ${p.invoiceNumber} (${p.reference}). Balance now ${usd(cents(after.balance))}.`,
      cards: [...invoiceCards(after, false), { kind: 'link', label: 'Open receivables', to: '/accounting/receivables' }],
    };
  },
};

// ------------------------------------------------------------------ void

interface VoidParams {
  invoiceId: string;
  invoiceNumber: string;
  expectedUpdatedAt: string;
  totalCents: number;
  reason: string;
}

const invoiceVoid: ActionDef<VoidParams> = {
  name: 'invoice_void',
  description:
    'Void an invoice, with a reason (3 to 500 characters). An issued invoice gets a reversing ledger entry; the record is kept, marked void. Refuses while a payment is applied to it.',
  input_schema: {
    type: 'object',
    properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-10004' },
      reason: { type: 'string', description: 'Why it is voided, in the person\'s words.' },
    },
    required: ['invoice_number', 'reason'],
  },
  permission: 'accounting.edit',
  risk: 'confirm',
  async plan(ctx, principal, input) {
    const svc = ctx.get(InvoicesService);
    const number = norm(input.invoice_number);
    if (!number) return refusal('Say which invoice, e.g. INV-10004.');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3) return refusal('A void needs a reason (at least 3 characters).');
    if (reason.length > 500) return refusal('The reason is too long (500 characters at most).');
    const inv = await findInvoice(svc, principal, number);
    if (!inv) return refusal(`Invoice ${number} is not on file.`);
    if (inv.status === 'void') return refusal(`${inv.invoiceNumber} is already void.`);
    if (inv.status === 'superseded') return refusal(`${inv.invoiceNumber} has been replaced by a revision; void the current version instead.`);
    if (inv.paid > 0) return refusal(`${inv.invoiceNumber} has ${usd(cents(inv.paid))} applied. Reverse the payment before voiding it.`);
    const totalCents = cents(inv.total);
    const warnings: string[] = [];
    if (inv.submission && inv.submission.status !== 'prepared') warnings.push(`${inv.invoiceNumber} was ${inv.submission.status} to ${inv.submission.provider}${inv.submission.reference ? ` (${inv.submission.reference})` : ''}. Tell them it is void.`);
    if (inv.rtsBatch) warnings.push(`${inv.invoiceNumber} is in RTS batch ${inv.rtsBatch.batchNumber}.`);
    return {
      ok: true,
      title: `Void ${inv.invoiceNumber} · ${inv.loadNumber}`,
      lines: [`${inv.status} · ${usd(totalCents)} · bill to ${inv.billToName}`, `Reason: ${reason}`, inv.status === 'draft' ? 'A draft: nothing to reverse in the ledger.' : 'Posts a reversing entry for the revenue and the receivable.', 'The invoice is kept, marked void.'],
      params: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, expectedUpdatedAt: inv.updatedAt, totalCents, reason },
      fingerprint: `invoice_void:${inv.id}`,
      totalCents,
      destination: inv.billToName,
      warnings,
    };
  },
  async run(ctx, principal, p) {
    const svc = ctx.get(InvoicesService);
    const now = await svc.get(principal, p.invoiceId);
    if (now.updatedAt !== p.expectedUpdatedAt || cents(now.total) !== p.totalCents || now.status === 'void') throw new StaleActionError(`${p.invoiceNumber} changed since the plan.`);
    const res = await svc.void(principal, p.invoiceId, p.reason);
    if (!res.ok) throw unprocessable(res.blocked);
    return { text: `${p.invoiceNumber} voided: ${p.reason}`, cards: [...invoiceCards(res.invoice, false), { kind: 'link', label: 'Open invoices', to: '/accounting/invoices' }] };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const INVOICE_ACTIONS: ActionDef<any>[] = [invoiceCreateFromLoad, invoiceIssue, invoiceRecordPayment, invoiceVoid];
