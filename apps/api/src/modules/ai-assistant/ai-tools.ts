import type Anthropic from '@anthropic-ai/sdk';
import { BILLING_QUEUES, type AiCard, type AiTableCard } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { InvoicesService } from '../accounting/invoices.service';
import { RtsBatchesService } from '../accounting/rts-batches.service';
import { SettlementsService } from '../accounting/settlements.service';
import { SalaryService } from '../dispatch-board/salary.service';
import { LoadProblemsService } from '../loads/load-problems.service';
import { LoadsService } from '../loads/loads.service';
import { searchGuide } from './knowledge';

/**
 * The tools NeWay AI may call (Phase 1, Accounting). Each wraps an existing service and reads
 * through it with the person's own principal: the company comes from the session, every tool
 * checks the permission its page needs, and money is the service's figure - the model only
 * chooses the tool and explains the answer. Nothing here writes, except `propose_rts_submission`,
 * which stores a proposal the person still has to confirm.
 */

export interface ToolOutcome {
  /** What the model reads: compact JSON. */
  content: string;
  /** What the person sees under the answer. */
  cards: AiCard[];
  isError?: boolean;
}

export interface ToolDeps {
  invoices: InvoicesService;
  rts: RtsBatchesService;
  settlements: SettlementsService;
  salary: SalaryService;
  loads: LoadsService;
  problems: LoadProblemsService;
  propose: (principal: Principal, input: { action: 'rts_submission'; invoiceIds: string[] }) => Promise<ToolOutcome>;
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refuse = (text: string): ToolOutcome => ({ content: JSON.stringify({ error: text }), cards: [{ kind: 'notice', tone: 'warning', text }], isError: true });
const need = (principal: Principal, code: string, what: string): ToolOutcome | null =>
  hasPermission(principal, code) ? null : refuse(`You do not have access to ${what} (${code}).`);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const AI_TOOLS: Anthropic.Tool[] = [
  {
    name: 'tms_guide',
    description:
      'The NeWay TMS user guide. Call it for EVERY "how do I / where is / which button / why can not I" question about any part of the TMS (loads, dispatch, invoices, settlements, RTS, fleet, repairs, PTI, safety, claims, violations, hiring, admin). Returns the matching guide sections with exact menu paths, button labels and the real reasons the app refuses. Answer only from what it returns.',
    input_schema: { type: 'object', properties: { question: { type: 'string', description: 'The topic in English keywords, e.g. "issue invoice blocked missing POD".' } }, required: ['question'] },
  },
  {
    name: 'find_load',
    description: 'One load by its number (e.g. L-100005): status, driver, truck, stops, documents on file, open flags, invoice, and - when delivered - what the billing check says is missing before it can be invoiced. Use to explain why a load cannot be invoiced, settled or moved on.',
    input_schema: { type: 'object', properties: { load_number: { type: 'string' } }, required: ['load_number'] },
  },
  {
    name: 'list_overdue_invoices',
    description: 'Invoices with a balance still owed, oldest past-due first, with days past due. Use for overdue / unpaid / aging questions.',
    input_schema: {
      type: 'object',
      properties: {
        min_days_past_due: { type: 'integer', minimum: 0, description: '0 = include not-yet-due unpaid invoices. Default 1.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'billing_queue',
    description: 'Delivered loads in the billing queue and why each sits where it does (needs documents, needs review, ready to bill, ready to submit, submission issues, revisions).',
    input_schema: {
      type: 'object',
      properties: { queue: { type: 'string', enum: [...BILLING_QUEUES] } },
    },
  },
  {
    name: 'rts_candidates',
    description: 'Issued invoices that can go to RTS (factoring) now, and the reasons the others cannot. Returns invoice ids for propose_rts_submission.',
    input_schema: { type: 'object', properties: { eligible_only: { type: 'boolean' } } },
  },
  {
    name: 'propose_rts_submission',
    description:
      'Prepare (not send) an RTS submission for the given eligible invoice ids. Creates a confirmation card; nothing is sent until the person presses Confirm, and never in Dry run.',
    input_schema: {
      type: 'object',
      properties: { invoice_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } },
      required: ['invoice_ids'],
    },
  },
  {
    name: 'driver_statements_preview',
    description: 'Preview driver settlement statements for one week: drivers, loads, gross, earnings and what blocks each. kind: cd (company drivers) or lo_oo (lease / owner operators). week_of: any date in the week, YYYY-MM-DD.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['cd', 'lo_oo'] }, week_of: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['kind', 'week_of'],
    },
  },
  {
    name: 'dispatcher_pay_report',
    description: 'Dispatcher pay for a period from the stored KPI / commission rules: per team gross, miles, RPM, commission, bonuses, penalties, payable. period: week, pay_period or month; date: any date inside it, YYYY-MM-DD.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['week', 'pay_period', 'month'] }, date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['period', 'date'],
    },
  },
];

export async function runTool(deps: ToolDeps, principal: Principal, name: string, raw: unknown): Promise<ToolOutcome> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (name) {
    case 'list_overdue_invoices': {
      const denied = need(principal, 'accounting.view', 'invoices');
      if (denied) return denied;
      const min = Number.isInteger(input.min_days_past_due) ? Math.max(0, input.min_days_past_due as number) : 1;
      const limit = Number.isInteger(input.limit) ? Math.min(50, Math.max(1, input.limit as number)) : 25;
      const rows = (await deps.invoices.receivables(principal))
        .filter((i) => i.balance > 0.005 && !['void', 'draft', 'superseded', 'paid'].includes(i.status) && i.agingDays >= min)
        .sort((a, b) => b.agingDays - a.agingDays);
      const shown = rows.slice(0, limit);
      const totalCents = rows.reduce((s, i) => s + Math.round(i.balance * 100), 0);
      const card: AiTableCard = {
        kind: 'table',
        title: `${rows.length} invoice${rows.length === 1 ? '' : 's'} ${min > 0 ? `${min}+ days past due` : 'unpaid'} · ${usd(totalCents)} owed`,
        columns: ['Invoice', 'Bill to', 'Due', 'Days past due', 'Balance', 'Status'],
        rows: shown.map((i) => [i.invoiceNumber, i.billToName, i.dueOn ?? '—', String(i.agingDays), usd(Math.round(i.balance * 100)), i.status]),
        note: rows.length > shown.length ? `Showing ${shown.length} of ${rows.length}.` : undefined,
      };
      return {
        content: JSON.stringify({ count: rows.length, totalBalance: usd(totalCents), invoices: shown.map((i) => ({ invoice: i.invoiceNumber, billTo: i.billToName, dueOn: i.dueOn, daysPastDue: i.agingDays, balance: usd(Math.round(i.balance * 100)), status: i.status })) }),
        cards: [card],
      };
    }
    case 'billing_queue': {
      const denied = need(principal, 'accounting.view', 'billing');
      if (denied) return denied;
      const q = await deps.invoices.queue(principal);
      const want = typeof input.queue === 'string' && (BILLING_QUEUES as readonly string[]).includes(input.queue) ? input.queue : null;
      const rows = q.rows.filter((r) => r.verdict.queue && (!want || r.verdict.queue === want));
      const shown = rows.slice(0, 25);
      return {
        content: JSON.stringify({
          counts: q.counts,
          loads: shown.map((r) => ({ load: r.load.loadNumber, broker: r.load.brokerName ?? r.load.customerName, rate: usd(Math.round(r.load.rate * 100)), queue: r.verdict.queue, reasons: r.verdict.conditions.map((c) => c.message), rc: r.verdict.rc.state ?? null, invoice: r.invoice?.invoiceNumber ?? null })),
        }),
        cards: [
          {
            kind: 'table',
            title: want ? `${rows.length} load${rows.length === 1 ? '' : 's'} · ${want.replace(/_/g, ' ')}` : `Billing queue · ${rows.length} load${rows.length === 1 ? '' : 's'}`,
            columns: ['Load', 'Broker', 'Rate', 'Queue', 'Why'],
            rows: shown.map((r) => [r.load.loadNumber, r.load.brokerName ?? r.load.customerName, usd(Math.round(r.load.rate * 100)), (r.verdict.queue ?? '').replace(/_/g, ' '), r.verdict.conditions.map((c) => c.message).join('; ') || '—']),
            note: rows.length > shown.length ? `Showing ${shown.length} of ${rows.length}.` : undefined,
          },
        ],
      };
    }
    case 'rts_candidates': {
      const denied = need(principal, 'accounting.view', 'RTS batches');
      if (denied) return denied;
      const all = await deps.rts.candidates(principal);
      const list = input.eligible_only === true ? all.filter((c) => c.eligibility.eligible) : all;
      const shown = list.slice(0, 30);
      const eligibleCents = all.filter((c) => c.eligibility.eligible).reduce((s, c) => s + c.fundableCents, 0);
      return {
        content: JSON.stringify({
          eligible: all.filter((c) => c.eligibility.eligible).length,
          eligibleTotal: usd(eligibleCents),
          invoices: shown.map((c) => ({ invoiceId: c.invoiceId, invoice: c.invoiceNumber, debtor: c.debtor, amount: usd(c.fundableCents), eligible: c.eligibility.eligible, reasons: c.eligibility.reasons, warnings: c.eligibility.warnings })),
        }),
        cards: [
          {
            kind: 'table',
            title: `${all.filter((c) => c.eligibility.eligible).length} invoice(s) ready for RTS · ${usd(eligibleCents)}`,
            columns: ['Invoice', 'Debtor', 'Amount', 'Ready', 'Why not'],
            rows: shown.map((c) => [c.invoiceNumber, c.debtor, usd(c.fundableCents), c.eligibility.eligible ? 'Yes' : 'No', c.eligibility.reasons.join(' ') || '—']),
          },
        ],
      };
    }
    case 'propose_rts_submission': {
      const denied = need(principal, 'accounting.edit', 'sending to RTS');
      if (denied) return denied;
      const ids = Array.isArray(input.invoice_ids) ? input.invoice_ids.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
      if (ids.length === 0) return refuse('Name at least one invoice id from rts_candidates.');
      return deps.propose(principal, { action: 'rts_submission', invoiceIds: [...new Set(ids)] });
    }
    case 'driver_statements_preview': {
      const denied = need(principal, 'accounting.view', 'driver settlements');
      if (denied) return denied;
      const kind = input.kind === 'lo_oo' ? 'lo_oo' : input.kind === 'cd' ? 'cd' : null;
      const weekOf = typeof input.week_of === 'string' && isoDate.test(input.week_of) ? input.week_of : null;
      if (!kind || !weekOf) return refuse('Say which drivers (company drivers or lease / owner operators) and which week.');
      const p = await deps.settlements.preview(principal, { kind, weekOf });
      const drivers = p.drivers.slice(0, 40);
      const withStatement = drivers.filter((d) => d.statementId).slice(0, 12);
      const blocked = p.drivers.filter((d) => d.blockers.length > 0).length;
      return {
        content: JSON.stringify({
          period: p.period,
          setupMissing: p.setup.map((s) => s.label),
          canGenerate: p.canGenerate,
          existingBatch: p.existingBatch,
          drivers: drivers.map((d) => ({ driver: d.name, unit: d.unitNumber, contract: d.contractType, loads: d.loads.length, gross: usd(d.grossCents), earned: d.earnedCents === null ? null : usd(d.earnedCents), blockers: d.blockers, statement: d.statementStatus, statementNumber: d.statementNumber, pdf: d.statementId ? 'a download card is shown under your answer' : 'no statement generated yet: it is generated on the Settlements page' })),
        }),
        cards: [
          ...(p.setup.length ? [{ kind: 'notice' as const, tone: 'warning' as const, text: `Settlement setup not finished: ${p.setup.map((s) => s.label).join(', ')}.` }] : []),
          {
            kind: 'table',
            title: `${p.drivers.length} driver${p.drivers.length === 1 ? '' : 's'} · ${p.period.start} – ${p.period.end}${blocked ? ` · ${blocked} blocked` : ''}`,
            columns: ['Driver', 'Unit', 'Type', 'Loads', 'Gross', 'Earned', 'Blocked by'],
            rows: drivers.map((d) => [d.name, d.unitNumber ?? '—', d.contractType, String(d.loads.length), usd(d.grossCents), d.earnedCents === null ? '—' : usd(d.earnedCents), d.blockers.join('; ') || '—']),
            note: p.drivers.length > drivers.length ? `Showing ${drivers.length} of ${p.drivers.length}.` : undefined,
          },
          ...withStatement.map((d) => ({ kind: 'file' as const, title: `Statement ${d.statementNumber ?? ''} · ${d.name}`.replace('  ', ' '), path: `/accounting/settlements/${encodeURIComponent(d.statementId!)}/pdf`, fileName: `${d.statementNumber ?? 'statement'}-${d.name.replace(/[^A-Za-z0-9]+/g, '-')}.pdf` })),
          ...(drivers.some((d) => !d.statementId) ? [{ kind: 'link' as const, label: 'Open Settlements', to: '/accounting/settlements' }] : []),
        ],
      };
    }
    case 'dispatcher_pay_report': {
      const denied = need(principal, 'dispatch_pay.view', 'dispatcher pay') ?? need(principal, 'dispatch.manage', 'the salary report');
      if (denied) return denied;
      const period = input.period === 'week' || input.period === 'pay_period' || input.period === 'month' ? input.period : null;
      const date = typeof input.date === 'string' && isoDate.test(input.date) ? input.date : null;
      if (!period || !date) return refuse('Say the period (week, pay period or month) and a date in it.');
      const r = await deps.salary.report(principal, period, date);
      return {
        content: JSON.stringify({
          label: r.label,
          run: r.run?.status ?? 'not started',
          totals: { gross: usd(r.totals.grossCents), commission: usd(r.totals.commissionCents), bonuses: usd(r.totals.bonusesCents), penalties: usd(r.totals.penaltiesCents), payable: usd(r.totals.payableCents) },
          teams: r.teams.map((t) => ({ dispatcher: t.dispatcherName, gross: usd(t.grossCents), miles: t.miles, rpm: t.rpm, commission: usd(t.commissionCents), bonuses: usd(t.bonusesCents), penalties: usd(t.penaltiesCents), payable: usd(t.payableCents) })),
        }),
        cards: [
          {
            kind: 'table',
            title: `Dispatcher pay · ${r.label} · ${usd(r.totals.payableCents)} payable${r.run ? ` · ${r.run.status}` : ' · not started'}`,
            columns: ['Dispatcher', 'Gross', 'Miles', 'RPM', 'Commission', 'Bonuses', 'Penalties', 'Payable'],
            rows: r.teams.map((t) => [t.dispatcherName, usd(t.grossCents), t.miles.toLocaleString('en-US'), t.rpm === null ? '—' : `$${t.rpm.toFixed(2)}`, usd(t.commissionCents), usd(t.bonusesCents), usd(t.penaltiesCents), usd(t.payableCents)]),
          },
        ],
      };
    }
    case 'tms_guide': {
      const question = typeof input.question === 'string' ? input.question.slice(0, 300) : '';
      const found = searchGuide(question, 3);
      if (found.length === 0) return { content: JSON.stringify({ found: 0, note: 'The guide has no section on this. Say you do not know rather than guess menu paths or buttons.' }), cards: [] };
      const links = found.filter((f) => f.route && !f.route.includes('$') && !f.route.includes(':'));
      return {
        content: JSON.stringify({ sections: found.map((f) => ({ title: f.title, page: f.route, text: f.text })) }),
        cards: [...new Map(links.map((f) => [f.route!.split('?')[0]!, f])).entries()].slice(0, 2).map(([to, f]) => ({ kind: 'link' as const, label: `Open ${f.title}`, to })),
      };
    }
    case 'find_load': {
      const denied = need(principal, 'loads.view', 'loads');
      if (denied) return denied;
      const number = typeof input.load_number === 'string' ? input.load_number.trim().toUpperCase() : '';
      if (!number) return refuse('Say the load number, e.g. L-100005.');
      const load = await deps.loads.get(principal, number).catch(() => null);
      if (!load) return refuse(`There is no load ${number} in this company.`);
      const rec = load as Record<string, unknown>;
      const flags = (await deps.problems.forLoad(principal, load.id)).filter((p) => !p.closedAt);
      let billing: unknown = null;
      if (hasPermission(principal, 'accounting.view') && ['delivered', 'closed'].includes(load.status)) {
        const q = await deps.invoices.queue(principal);
        const row = q.rows.find((r) => r.load.id === load.id);
        if (row) billing = { queue: row.verdict.queue, missing: row.verdict.conditions.map((c) => c.message), rc: row.verdict.rc.state ?? null, invoice: row.invoice?.invoiceNumber ?? null };
      }
      const docs = load.documents.map((d) => `${d.type} (${d.review ?? d.status})`);
      return {
        content: JSON.stringify({
          load: load.loadNumber,
          status: load.status,
          driver: rec.driverName ?? null,
          truck: rec.truckUnit ?? null,
          dispatcher: load.dispatcherName,
          stops: load.stops.map((st) => ({ kind: st.kind, place: `${st.city}, ${st.state}`, status: st.status })),
          documents: docs,
          openFlags: flags.map((f) => ({ kind: f.kind, note: f.note })),
          invoiceId: rec.invoiceId ?? null,
          cancelled: load.cancellation ?? null,
          billing,
        }),
        cards: [
          {
            kind: 'table',
            title: `${load.loadNumber} · ${String(load.status).replace(/_/g, ' ')}`,
            columns: ['Driver', 'Truck', 'Documents', 'Open flags', 'Billing'],
            rows: [[String(rec.driverName ?? 'Unassigned'), String(rec.truckUnit ?? '—'), docs.join(', ') || 'none', flags.map((f) => f.kind).join(', ') || 'none', billing ? ((billing as { missing: string[] }).missing.join('; ') || String((billing as { queue: string }).queue ?? '').replace(/_/g, ' ')) : '—']],
          },
          { kind: 'link', label: `Open ${load.loadNumber}`, to: `/loads/${encodeURIComponent(load.loadNumber)}` },
        ],
      };
    }
    default:
      return refuse(`There is no tool called ${name}.`);
  }
}
