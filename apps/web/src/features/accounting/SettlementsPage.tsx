import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronLeft, ChevronRight, CircleCheck, CircleDashed, Download, Mail, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { SETTLEMENT_KINDS, batchTotals, type SettlementKind } from '@neway/shared';
import { Badge, Button, Checkbox, Drawer, DropdownMenu, FormField, Input, MenuItem, Modal, PageHeader, Select, cn, useToast } from '@/design-system';
import {
  fetchSettlementPreview,
  accountingFileUrl,
  approveStatement,
  closeBatch,
  emailDocuments,
  fetchArrangements,
  fetchBatches,
  fetchDriverReview,
  fetchPayees,
  fetchStatements,
  generateBatch,
  listDrivers,
  listTrucks,
  listVendors,
  saveArrangement,
  savePayee,
  verifyPayee,
  type DriverReviewRow,
  type PayeeProfile,
  type SettlementBatch,
  type Statement,
} from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { ReviewDialog } from './DriverReviewPanel';
import { today } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { AuthedFileLink } from './AuthedFileLink';
import { useInvalidateAccounting } from './useAccounting';
import { StatementWorkspace } from './StatementWorkspace';
import { payWindowLabel } from './pay-window';
import { SendAllEmailDialog, SendStatementEmailButton, StatementEmailBadge, useStatementEmailStatus } from './StatementEmail';

/**
 * Settlements: paying drivers and vendors for one week of delivered loads.
 *
 * The page is laid out as the four things a person does each week, top to bottom, so someone
 * opening it for the first time can follow it without being taught:
 *
 *   1. Check    - anything that would make a statement wrong (setup, a driver's pay setup, loads
 *                 from earlier weeks that were never paid).
 *   2. Create   - what the week contains, and the button that turns it into statements.
 *   3. Approve  - each statement, with its money in plain words; approving locks it.
 *   4. Send/pay - email the PDFs, export for the bank, close the week.
 *
 * Each step says in one sentence what it is for and shows whether it is done. ONE week selector
 * (owner, 2026-10-22: ‹ week ⌄ ›, the weeks with their status, "This week" beside it, the
 * Monday-noon window and payday as a caption under it) drives everything below it: the
 * statements shown are always the ones for the week picked.
 * Nothing about how pay is calculated lives here; every figure comes from the server.
 */

const c = (cents: number) => formatMoney(cents / 100);

/** The three kinds, named for a new user, with the one line that says who they pay. */
const KIND: Record<SettlementKind, { tab: string; who: string }> = {
  cd: { tab: 'Company drivers', who: 'Drivers employed by the company (CD), paid per load or per mile.' },
  lo_oo: { tab: 'Lease & owner operators', who: 'Lease operators and owner operators (LO & OO), paid a share of each load.' },
  vt: { tab: 'Vendors', who: 'Truck owners (VT): one statement per vendor covering all of their trucks.' },
};

/** A driver's pay-setup issue, said as the thing to do about it. */
const ISSUE_WORDS: Record<DriverReviewRow['issues'][number]['kind'], string> = {
  rate_ambiguous: 'Pay rate is unclear — confirm it',
  basis_unconfirmed: 'Confirm what the percentage is taken from',
  plan_unreviewed: 'Pay plan has not been reviewed',
  opening_debt: 'Starting debt balance not confirmed',
  opening_escrow: 'Starting escrow balance not confirmed',
  no_payee: 'No bank details — cannot be paid',
  no_email: 'No email — statement cannot be emailed',
};

/** A statement's status as a symbol, a word and a colour - never the colour alone. */
function StatementStatus({ s }: { s: Statement }) {
  const look =
    s.status === 'paid' ? { tone: 'success' as const, icon: <CircleCheck className="size-3" />, word: 'Paid' }
    : s.status === 'approved' ? { tone: 'info' as const, icon: <Lock className="size-3" />, word: 'Approved · not paid' }
    : s.status === 'review' ? { tone: 'warning' as const, icon: <TriangleAlert className="size-3" />, word: 'Needs a look' }
    : { tone: 'neutral' as const, icon: <CircleDashed className="size-3" />, word: 'Draft · not approved' };
  return <Badge tone={look.tone} size="sm"><span className="inline-flex items-center gap-1">{look.icon}{look.word}</span></Badge>;
}

/** One step of the week: its number, what it is for, whether it is done, and its contents. */
function Step({ n, title, why, state, children, testId }: { n: number; title: string; why: string; state: { tone: 'success' | 'warning' | 'info' | 'neutral'; word: string }; children?: ReactNode; testId?: string }) {
  const icon = state.tone === 'success' ? <CircleCheck className="size-3.5" /> : state.tone === 'warning' ? <TriangleAlert className="size-3.5" /> : <CircleDashed className="size-3.5" />;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface" data-testid={testId}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold', state.tone === 'success' ? 'bg-success-soft text-success-text' : 'bg-primary-soft text-primary-text')}>{state.tone === 'success' ? <Check className="size-4" /> : n}</span>
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="text-xs text-muted">{why}</p>
          </div>
        </div>
        <Badge tone={state.tone} size="sm"><span className="inline-flex items-center gap-1">{icon}{state.word}</span></Badge>
      </header>
      {children ? <div className="border-t border-line-soft">{children}</div> : null}
    </section>
  );
}

/** A figure with its name and, underneath, what it means. */
function Figure({ label, value, meaning, tone }: { label: string; value: string; meaning: string; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums text-ink', tone)}>{value}</p>
      <p className="text-2xs text-muted">{meaning}</p>
    </div>
  );
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The Monday that starts the calendar week of a day. */
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));
/** A week's status in the selector, in words. */
const BATCH_WORD: Record<SettlementBatch['status'], string> = { open: 'open', review: 'open · needs a look', approved: 'approved', closed: 'closed' };

export function SettlementsPage() {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const canBank = account?.permissions.includes('accounting.bank') ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounting();
  const [kind, setKind] = useState<SettlementKind>('cd');
  const [weekOf, setWeekOf] = useState(today());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [emailing, setEmailing] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);
  const [showArrangements, setShowArrangements] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [showWeekLoads, setShowWeekLoads] = useState(false);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'waiting' | 'approved' | 'paid'>('all');
  const batches = useQuery({ queryKey: ['accounting', 'batches'], queryFn: fetchBatches });

  const payees = useQuery({ queryKey: ['accounting', 'payees'], queryFn: fetchPayees });
  const review = useQuery({ queryKey: ['accounting', 'driver-review'], queryFn: fetchDriverReview, staleTime: 30_000, enabled: kind !== 'vt' });
  const preview = useQuery({ queryKey: ['accounting', 'settlement-preview', kind, weekOf], queryFn: () => fetchSettlementPreview(kind, weekOf), staleTime: 15_000 });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting'] }), invalidate()]);

  const generate = useMutation({
    mutationFn: (includeLateLoadIds?: string[]) => generateBatch({ kind, weekOf, includeLateLoadIds }),
    onSuccess: async (b) => {
      await refresh();
      toast({ tone: 'success', title: `Statements created for ${payWindowLabel(b)}`, description: `${b.statementIds.length} statement${b.statementIds.length === 1 ? '' : 's'}. Nothing is approved or paid yet.` });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Statements not created', description: e instanceof Error ? e.message : undefined }),
  });
  const approve = useMutation({
    mutationFn: async (ids: string[]) => {
      const out: string[] = [];
      for (const id of ids) {
        const r = await approveStatement(id);
        if (!r.ok) out.push(r.blocked);
      }
      return out;
    },
    onSuccess: async (blocked) => {
      await refresh();
      setSelected(new Set());
      toast({ tone: blocked.length ? 'warning' : 'success', title: blocked.length ? `${blocked.length} not approved` : 'Approved and locked', description: blocked.join(' ') || 'These statements can no longer change. Corrections go on next week’s statement.' });
    },
  });
  const close = useMutation({
    mutationFn: (id: string) => closeBatch(id),
    onSuccess: async () => {
      await refresh();
      toast({ tone: 'success', title: 'Week closed' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Week not closed', description: e instanceof Error ? e.message : undefined }),
  });

  const p = preview.data;
  const batchList = useMemo(() => (batches.data ?? []).filter((b) => b.kind === kind).sort((a, b) => b.periodStart.localeCompare(a.periodStart)), [batches.data, kind]);
  // The statements shown are always the picked week's - never "whichever batch is newest".
  const batch: SettlementBatch | null = p ? (batchList.find((b) => b.periodStart === p.period.start) ?? null) : null;
  // The one week selector: the weeks with statements (and their status), this week, and the week
  // picked even when nothing has been created for it yet - newest first.
  const pickedStart = p?.period.start ?? mondayOf(weekOf);
  const weekOptions = useMemo(() => {
    const starts = new Set([...batchList.map((b) => b.periodStart), mondayOf(today()), pickedStart]);
    return [...starts].sort((a, b) => b.localeCompare(a)).map((start) => {
      const b = batchList.find((x) => x.periodStart === start);
      return { value: start, label: `${formatIsoDate(start)} – ${formatIsoDate(addDays(start, 6))} · ${b ? BATCH_WORD[b.status] ?? b.status : 'not created'}` };
    });
  }, [batchList, pickedStart]);
  // The picked week's statements, asked for by its batch: the server recomputes every draft of the
  // week on read (owner, 2026-10-22), so the money shown is never a stale draft's.
  const statements = useQuery({ queryKey: ['accounting', 'statements', kind, batch?.id ?? null], queryFn: () => fetchStatements({ kind, batchId: batch!.id }), enabled: Boolean(batch) });
  const weekRows = useMemo(() => (batch ? (statements.data ?? []).filter((s) => s.batchId === batch.id) : []), [statements.data, batch]);
  const rows = weekRows;
  // Each driver statement's last email (and the bounced flag), from the server's email log.
  const emailStatus = useStatementEmailStatus(kind !== 'vt' ? batch?.id : null);
  // The week's figures from the statements as read now (every draft recomputed on read), so a
  // stale stored total never shows (owner, 2026-10-22).
  const totals = statements.data ? batchTotals(rows) : null;
  const visibleRows = weekRows.filter((r) => statusFilter === 'all' || (statusFilter === 'waiting' ? r.status === 'draft' || r.status === 'review' : r.status === statusFilter));
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const drafts = rows.filter((r) => r.status === 'draft' || r.status === 'review');
  const approvedCount = rows.filter((r) => r.status === 'approved' || r.status === 'paid').length;
  const paidCount = rows.filter((r) => r.status === 'paid').length;
  const payeeFor = (s: Statement) => (payees.data ?? []).find((x) => x.partyType === s.partyType && x.partyId === s.partyId) ?? null;
  const exportUrl = (format: 'csv' | 'xlsx' | 'zip') => accountingFileUrl(`settlements/export/${format}?${selected.size ? `ids=${[...selected].join(',')}` : batch ? `batchId=${batch.id}` : ''}`);
  const focus = rows.find((r) => r.id === focusId) ?? null;
  const pickWeek = (w: string) => { setWeekOf(w); setSelected(new Set()); setFocusId(null); };

  // Step 1: what to check, for this kind of driver only.
  const contract = kind === 'cd' ? ['CD'] : ['LO', 'OO'];
  const payingThisWeek = new Set([...(p?.drivers ?? []).map((d) => d.driverId), ...rows.map((r) => r.partyId)]);
  const allDriverIssues = kind === 'vt' ? [] : (review.data ?? []).filter((r) => r.issues.length > 0 && contract.includes(r.contractType));
  // Only the people being paid this week can make this week's statements wrong; the others are
  // counted, not listed, so the step stays about this week.
  const driverIssues = allDriverIssues.filter((r) => payingThisWeek.has(r.driverId));
  const otherIssues = allDriverIssues.length - driverIssues.length;
  const shownIssues = showAllIssues ? driverIssues : driverIssues.slice(0, 5);
  const lateLoads = batch?.lateLoads ?? [];
  const lateCount = batch ? lateLoads.length : (p?.lateLoads ?? 0);
  const toCheck = (p?.setup.length ?? 0) + driverIssues.length + (lateCount > 0 ? 1 : 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Settlements"
        description="Pay drivers and vendors for one week of delivered loads. Work down the page: check, create statements, approve, then send and pay."
      />

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Who is being paid">
          {SETTLEMENT_KINDS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setSelected(new Set()); setFocusId(null); }} className={cn('h-8 rounded-lg px-3 text-sm font-semibold', kind === k ? 'bg-primary-soft text-primary-text ring-1 ring-primary/30' : 'text-muted hover:bg-surface-hover')}>{KIND[k].tab}</button>
          ))}
          <div className="ml-auto flex flex-col items-end gap-0.5" data-testid="week-picker">
            <div className="flex items-center gap-1">
              <div className="flex h-9 items-center gap-0.5 rounded-lg border border-line bg-surface px-0.5" role="group" aria-label="Pay week">
                <button type="button" aria-label="Previous week" onClick={() => pickWeek(addDays(pickedStart, -7))} className="grid size-8 place-items-center rounded text-secondary hover:bg-surface-hover"><ChevronLeft className="size-4" aria-hidden /></button>
                <Select className="w-72 border-0" options={weekOptions} value={pickedStart} onValueChange={pickWeek} aria-label="Week" />
                <button type="button" aria-label="Next week" onClick={() => pickWeek(addDays(pickedStart, 7))} className="grid size-8 place-items-center rounded text-secondary hover:bg-surface-hover"><ChevronRight className="size-4" aria-hidden /></button>
              </div>
              <Button variant="link" size="sm" disabled={pickedStart === mondayOf(today())} onClick={() => pickWeek(mondayOf(today()))}>This week</Button>
            </div>
            <p className="text-2xs text-muted" data-testid="week-label">{p ? `${payWindowLabel(p.period)} · Payday ${formatIsoDate(p.period.payDate)}` : 'Loading…'}</p>
          </div>
          {kind === 'vt' ? <Button variant="link" size="sm" onClick={() => setShowArrangements(true)}>Which vendor owns which truck</Button> : null}
        </div>
        <p className="text-xs text-muted">{KIND[kind].who}{p ? ` A load counts in this week if it was completed from ${payWindowLabel(p.period).replace(' – ', ' up to ')} (Monday noon to Monday noon, US Eastern). Accounting can set a load’s pay date on the load.` : ''}</p>
      </div>

      {/* ------------------------------------------------------------ 1. check */}
      <Step
        n={1}
        testId="step-check"
        title="Check before paying"
        why="These can make a statement wrong. Fix them first — or go ahead knowing they are open."
        state={preview.isPending ? { tone: 'neutral', word: 'Loading…' } : toCheck === 0 ? { tone: 'success', word: 'All clear' } : { tone: 'warning', word: `${toCheck} to check` }}
      >
        {toCheck === 0 && !preview.isPending ? null : (
          <div className="flex flex-col divide-y divide-line-soft">
            {p && p.setup.length > 0 ? (
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-ink">Accounting settings are incomplete</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">{p.setup.map((s) => <li key={s.key}><span className="font-semibold">{s.label}:</span> {s.detail}</li>)}</ul>
                <Link to="/accounting" search={{ tab: 'settings' }} className="mt-1 inline-block text-xs font-semibold text-primary-text underline">Open Accounting settings</Link>
              </div>
            ) : null}
            {driverIssues.length > 0 ? (
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-ink">Drivers whose pay setup needs a look</p>
                <ul className="mt-2 flex flex-col divide-y divide-line-soft rounded-lg border border-line">
                  {shownIssues.map((r) => (
                    <li key={r.driverId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-48">
                        <Link to="/drivers/$driverId" params={{ driverId: r.driverId }} search={{ tab: 'financial' }} className="text-sm font-medium text-primary-text hover:underline">{r.name}</Link>
                        <span className="block text-2xs text-muted">{r.driverNumber} · pay plan {r.plan ? (r.plan.basis === 'n/a' ? `${r.plan.kind.replace(/_/g, ' ')} ${r.plan.rate}` : `${r.rate?.asPercent ?? r.plan.rate} of ${r.plan.basis}`) : 'not set'}</span>
                      </span>
                      <span className="flex flex-1 flex-wrap gap-1">{r.issues.map((i) => <Badge key={i.kind} tone={i.kind === 'no_payee' || i.kind === 'rate_ambiguous' ? 'warning' : 'neutral'} size="sm" title={i.detail}><span className="inline-flex items-center gap-1"><TriangleAlert className="size-3" />{ISSUE_WORDS[i.kind] ?? i.label}</span></Badge>)}</span>
                      {canEdit ? <Button variant="secondary" size="sm" onClick={() => setFixing(r.driverId)}>Fix pay setup</Button> : null}
                    </li>
                  ))}
                </ul>
                {driverIssues.length > 5 ? (
                  <button type="button" className="mt-2 text-xs font-semibold text-primary-text underline" onClick={() => setShowAllIssues((v) => !v)}>
                    {showAllIssues ? 'Show fewer' : `Show all ${driverIssues.length}`}
                  </button>
                ) : null}
              </div>
            ) : null}
            {otherIssues > 0 ? (
              <p className="px-4 py-2 text-2xs text-muted">{otherIssues} other driver{otherIssues === 1 ? '' : 's'} not paid this week also {otherIssues === 1 ? 'has' : 'have'} pay setup to review; they are listed on each driver's Financial tab.</p>
            ) : null}
            {lateCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span>
                  <p className="text-xs font-semibold text-ink">{lateCount} load{lateCount === 1 ? '' : 's'} from an earlier week never made it onto a statement</p>
                  <p className="text-xs text-secondary">{lateLoads.length ? lateLoads.map((l) => `${l.loadNumber} (delivered ${formatIsoDate(l.completedAt.slice(0, 10))})`).join(' · ') : 'Create this week’s statements to see which loads, then choose whether to pay them this week.'}</p>
                </span>
                {canEdit && batch && lateLoads.length ? <Button variant="secondary" size="sm" loading={generate.isPending} onClick={() => generate.mutate(lateLoads.map((l) => l.loadId))}>Pay them this week</Button> : null}
              </div>
            ) : null}
          </div>
        )}
      </Step>

      {/* ------------------------------------------------------------ 2. create */}
      <Step
        n={2}
        testId="step-create"
        title="Create this week’s statements"
        why="Collects every load delivered this week and works out what each person is owed. Safe to repeat: approved statements are never changed."
        state={batch ? { tone: 'success', word: `Created · ${rows.length} statement${rows.length === 1 ? '' : 's'}` } : p && !p.canGenerate ? { tone: 'warning', word: 'Blocked by settings (step 1)' } : { tone: 'info', word: 'Not created yet' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-xs text-secondary">
            {p ? (kind === 'vt' ? 'One statement per vendor for the trucks they own this week.' : `${p.drivers.length} ${p.drivers.length === 1 ? 'person' : 'people'} with ${p.loadsInWeek} load${p.loadsInWeek === 1 ? '' : 's'} delivered this week.`) : 'Loading…'}
            {p && kind !== 'vt' && p.drivers.length > 0 ? <button type="button" className="ml-2 font-semibold text-primary-text underline" onClick={() => setShowWeekLoads((v) => !v)}>{showWeekLoads ? 'Hide' : 'Show'} who and which loads</button> : null}
          </p>
          {canEdit ? (
            <Button variant="primary" icon={<RefreshCw />} loading={generate.isPending} disabled={!p?.canGenerate} title={p && !p.canGenerate ? 'Complete the settings in step 1 first' : undefined} onClick={() => generate.mutate(undefined)}>
              {batch ? 'Update draft statements' : 'Create statements'}
            </Button>
          ) : null}
        </div>
        {showWeekLoads && p && kind !== 'vt' ? (
          <table className="w-full text-sm" data-testid="week-preview">
            <thead className="bg-surface-muted text-left text-xs text-muted"><tr><th className="px-4 py-2 font-semibold">Driver</th><th className="px-4 py-2 font-semibold">Truck</th><th className="px-4 py-2 font-semibold">Loads</th><th className="px-4 py-2 text-right font-semibold">Load revenue</th><th className="px-4 py-2 text-right font-semibold">Estimated pay</th><th className="px-4 py-2 font-semibold">Can be paid?</th></tr></thead>
            <tbody className="divide-y divide-line-soft">
              {p.drivers.map((d) => (
                <tr key={d.driverId}>
                  <td className="px-4 py-2">{d.name}<span className="block text-2xs text-muted">{d.driverNumber}</span></td>
                  <td className="px-4 py-2 text-xs">{d.unitNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-xs">{d.loads.map((l) => l.loadNumber).join(', ') || '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-secondary">{c(d.grossCents)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{d.earnedCents === null ? <span className="text-muted">Cannot work out yet</span> : c(d.earnedCents)}</td>
                  <td className="px-4 py-2">{d.blockers.length === 0 ? <Badge tone="success" size="sm"><span className="inline-flex items-center gap-1"><CircleCheck className="size-3" />Yes</span></Badge> : <span className="text-xs text-warning-text" title={d.blockers.join(' · ')}>{d.blockers[0]}{d.blockers.length > 1 ? ` (+${d.blockers.length - 1})` : ''}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Step>

      {/* ------------------------------------------------------------ 3. approve */}
      <Step
        n={3}
        testId="step-approve"
        title="Review and approve"
        why="Open a statement to check it. Approving locks it: after that it cannot change, and corrections go on next week’s statement."
        state={!batch ? { tone: 'neutral', word: 'Waiting for step 2' } : rows.length > 0 && drafts.length === 0 ? { tone: 'success', word: 'All approved' } : { tone: 'warning', word: `${approvedCount} of ${rows.length} approved` }}
      >
        {batch ? (
          <>
            <div className="grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0" data-testid="week-figures">
              <Figure label="To pay out" value={totals ? c(totals.payableCents) : 'Loading…'} meaning="What actually goes to people's bank accounts." tone="text-success-text" />
              <Figure label="Carried to next week" value={totals ? c(totals.carryCents) : 'Loading…'} meaning={!totals ? ' ' : totals.carryCents > 0 ? 'Owed by someone whose deductions were more than their pay.' : 'Nobody ended the week owing money.'} tone={totals && totals.carryCents > 0 ? 'text-danger-text' : undefined} />
              <Figure label="Statements" value={`${rows.length}`} meaning={`${approvedCount} approved · ${paidCount} paid`} />
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-2">
              {canEdit ? <Button variant="primary" size="sm" icon={<Check />} disabled={selectedRows.filter((r) => r.status === 'draft').length === 0} loading={approve.isPending} onClick={() => approve.mutate(selectedRows.filter((r) => r.status === 'draft').map((r) => r.id))}>Approve selected{selectedRows.length ? ` (${selectedRows.filter((r) => r.status === 'draft').length})` : ''}</Button> : null}
              <span className="text-xs text-muted">{selectedRows.length ? `${selectedRows.length} selected` : 'Tick statements to approve, email or export them. Click a row to open it.'}</span>
              <span className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Show statements">
                {([['all', 'All', rows.length], ['waiting', 'Waiting for approval', drafts.length], ['approved', 'Approved', rows.filter((r) => r.status === 'approved').length], ['paid', 'Paid', paidCount]] as const).map(([k, label, n]) => (
                  <button key={k} type="button" aria-pressed={statusFilter === k} onClick={() => setStatusFilter(k)} className={cn('h-7 rounded-lg px-2.5 text-xs font-semibold', statusFilter === k ? 'bg-primary-soft text-primary-text ring-1 ring-primary/30' : 'text-muted hover:bg-surface-hover')}>
                    {label} <span className="tabular-nums">{n}</span>
                  </button>
                ))}
              </span>
            </div>
            {statements.isPending ? <p className="px-4 py-6 text-sm text-muted">Loading…</p> : visibleRows.length === 0 ? <p className="px-4 py-6 text-sm text-muted">{rows.length === 0 ? 'No statements this week.' : 'None in this view.'}</p> : (
              <table className="w-full text-sm" data-testid="statements-table">
                <thead className="bg-surface-muted text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 px-4 py-2"><Checkbox aria-label="Select all shown" checked={visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id))} onCheckedChange={(v) => setSelected(v === true ? new Set(visibleRows.map((r) => r.id)) : new Set())} /></th>
                    <th className="px-4 py-2 font-semibold">{kind === 'vt' ? 'Vendor' : 'Driver'}</th>
                    <th className="px-4 py-2 font-semibold">{kind === 'vt' ? 'Trucks' : 'Truck'}</th>
                    <th className="px-4 py-2 text-right font-semibold">Earned</th>
                    <th className="px-4 py-2 text-right font-semibold">Taken off</th>
                    <th className="px-4 py-2 text-right font-semibold">To pay out</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {visibleRows.map((s) => (
                    <tr key={s.id} className={cn('cursor-pointer hover:bg-surface-hover', focusId === s.id && 'bg-primary-soft/40')} onClick={() => setFocusId(s.id)} data-testid={`statement-${s.settlementNumber}`}>
                      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}><Checkbox aria-label={`Select ${s.partyName}`} checked={selected.has(s.id)} onCheckedChange={(v) => setSelected((prev) => { const n = new Set(prev); if (v === true) n.add(s.id); else n.delete(s.id); return n; })} /></td>
                      <td className="px-4 py-2"><span className="font-semibold text-ink">{s.partyName}</span><span className="block text-2xs text-muted">{s.settlementNumber}</span></td>
                      <td className="px-4 py-2 text-xs">{s.unitNumber ?? (s.vendor ? `${s.vendor.trucks.length} truck${s.vendor.trucks.length === 1 ? '' : 's'}` : '—')}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c((s.computation?.grossCents ?? s.vendor?.totalEarningsCents ?? 0) + (s.computation?.reimbursementsCents ?? 0))}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-secondary">{c((s.computation?.deductionsCents ?? s.vendor?.totalDeductionsCents ?? 0) + (s.computation?.escrowCents ?? 0))}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{c(s.payableCents)}</td>
                      <td className="px-4 py-2"><StatementStatus s={s} />{emailStatus.data?.[s.id] ? <span className="mt-0.5 block"><StatementEmailBadge state={emailStatus.data[s.id]} /></span> : null}{s.exceptions.length ? <span className="mt-0.5 flex items-center gap-1 text-2xs text-warning-text"><TriangleAlert className="size-3" />{s.exceptions.length} thing{s.exceptions.length === 1 ? '' : 's'} to check</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </Step>

      {/* ------------------------------------------------------------ 4. send and pay */}
      <Step
        n={4}
        testId="step-send"
        title="Send and pay"
        why="Email each person their own statement, export the payment file for the bank, then close the week. Emailing never marks anything paid."
        state={!batch ? { tone: 'neutral', word: 'Waiting for step 3' } : batch.status === 'closed' ? { tone: 'success', word: 'Week closed' } : { tone: 'info', word: `${paidCount} of ${rows.length} paid` }}
      >
        {batch ? (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            {canEdit && kind !== 'vt' ? <Button variant="secondary" size="sm" icon={<Mail />} disabled={approvedCount === 0} title={approvedCount === 0 ? 'Approve statements in step 3 first' : undefined} onClick={() => setSendingAll(true)}>Send all by email</Button> : null}
            {canEdit && kind === 'vt' ? <Button variant="secondary" size="sm" icon={<Mail />} disabled={selectedRows.length === 0} title={selectedRows.length === 0 ? 'Tick statements in step 3 first' : undefined} onClick={() => setEmailing(true)}>Email PDFs{selectedRows.length ? ` (${selectedRows.length})` : ''}</Button> : null}
            <DropdownMenu trigger={<Button variant="secondary" size="sm" icon={<Download />}>Export{selectedRows.length ? ` (${selectedRows.length})` : ' all'}</Button>}>
              <MenuItem onSelect={() => window.open(exportUrl('zip'), '_blank')}>PDF statements (ZIP)</MenuItem>
              <MenuItem onSelect={() => window.open(exportUrl('xlsx'), '_blank')}>Excel</MenuItem>
              <MenuItem onSelect={() => window.open(exportUrl('csv'), '_blank')}>CSV</MenuItem>
              <MenuItem onSelect={() => window.print()}>Print this page</MenuItem>
            </DropdownMenu>
            {canEdit && batch.status !== 'closed' ? (
              <Button variant="outline" size="sm" className="ml-auto" disabled={drafts.length > 0} title={drafts.length > 0 ? 'Approve every statement first' : undefined} onClick={() => close.mutate(batch.id)}>Close the week</Button>
            ) : null}
            <p className="w-full text-2xs text-muted">Payroll (ADP) is not connected yet: pay from the bank, then press "Record payment" on each statement. {drafts.length > 0 && batch.status !== 'closed' ? 'The week can be closed once every statement is approved.' : ''}</p>
          </div>
        ) : null}
      </Step>

      <Drawer open={focus !== null} onOpenChange={(o) => { if (!o) setFocusId(null); }} size="md" title={focus ? focus.partyName : 'Statement'} description={focus ? `${focus.settlementNumber} · ${payWindowLabel(focus)}` : undefined}>
        {focus ? (
          <div className="flex flex-col gap-4">
            {/* A driver statement is finished here: every line, add a deduction or a reimbursement, approve. */}
            {focus.partyType === 'driver' ? <div className="flex flex-wrap items-center gap-2"><SendStatementEmailButton s={focus} canEdit={canEdit} /></div> : null}
            {focus.partyType === 'driver' ? <StatementWorkspace statementId={focus.id} canEdit={canEdit} refreshWeek={() => generateBatch({ kind, weekOf })} onChanged={refresh} /> : null}
            <StatementSummary s={focus} payee={payeeFor(focus)} canBank={canBank} onChanged={refresh} hideSummary={focus.partyType === 'driver'} />
          </div>
        ) : null}
      </Drawer>

      {fixing ? <ReviewDialog driverId={fixing} row={driverIssues.find((r) => r.driverId === fixing)!} onClose={() => setFixing(null)} onDone={async () => { await review.refetch(); await refresh(); }} /> : null}
      {sendingAll && batch ? <SendAllEmailDialog batchId={batch.id} weekLabel={`${KIND[kind].tab} · ${payWindowLabel(batch)}`} onClose={() => setSendingAll(false)} /> : null}
      {emailing ? <EmailDialog rows={selectedRows} onClose={() => setEmailing(false)} /> : null}
      {showArrangements ? <ArrangementsDialog onClose={() => setShowArrangements(false)} /> : null}
    </div>
  );
}

function StatementSummary({ s, payee, canBank, onChanged, hideSummary = false }: { s: Statement; payee: PayeeProfile | null; canBank: boolean; onChanged: () => Promise<unknown>; hideSummary?: boolean }) {
  const { toast } = useToast();
  const [editingPayee, setEditingPayee] = useState(false);
  const verify = useMutation({ mutationFn: (id: string) => verifyPayee(id), onSuccess: async () => { await onChanged(); toast({ tone: 'success', title: 'Bank details verified' }); } });
  return (
    <>
      {hideSummary ? null : <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-sm font-semibold text-ink">{s.partyType === 'vendor' ? 'Vendor statement summary' : 'What this statement pays'}</p>
        <p className="text-xs text-muted">{s.settlementNumber} · {formatIsoDate(s.periodStart)} – {formatIsoDate(s.periodEnd)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
          {s.vendor ? (
            <>
              <dt className="text-muted">Vendor earnings (total)</dt><dd className="text-right tabular-nums">{c(s.vendor.totalEarningsCents)}</dd>
              <dt className="text-muted">Driver pay deducted</dt><dd className="text-right tabular-nums">{c(s.vendor.trucks.reduce((x, t) => x + t.driverPayDeductedCents, 0))}</dd>
              <dt className="text-muted">Fuel deducted</dt><dd className="text-right tabular-nums">{c(s.vendor.trucks.reduce((x, t) => x + t.fuelCents, 0))}</dd>
              <dt className="text-muted">Tolls deducted</dt><dd className="text-right tabular-nums">{c(s.vendor.trucks.reduce((x, t) => x + t.tollsCents, 0))}</dd>
              <dt className="mt-2 font-semibold text-ink">Final vendor payout</dt><dd className="mt-2 text-right text-lg font-bold text-ink">{c(s.vendor.payoutCents)}</dd>
            </>
          ) : s.computation ? (
            <>
              <dt className="text-muted">Earned</dt><dd className="text-right tabular-nums">{c(s.computation.grossCents)}</dd>
              <dt className="text-muted">Reimbursements</dt><dd className="text-right tabular-nums">{c(s.computation.reimbursementsCents)}</dd>
              <dt className="text-muted">Taken off (deductions)</dt><dd className="text-right tabular-nums">({c(s.computation.deductionsCents)})</dd>
              <dt className="text-muted">Escrow withheld</dt><dd className="text-right tabular-nums">({c(s.computation.escrowCents)})</dd>
              <dt className="text-muted">Owed before → after this week</dt><dd className="text-right tabular-nums">{s.computation.openingDebtCents === null ? 'unknown' : c(s.computation.openingDebtCents)} → {s.computation.closingDebtCents === null ? 'unknown' : c(s.computation.closingDebtCents)}</dd>
              <dt className="mt-2 font-semibold text-ink">Net for the week</dt><dd className={cn('mt-2 text-right font-semibold', s.netCents < 0 ? 'text-danger-text' : 'text-ink')}>{c(s.netCents)}</dd>
              <dt className="font-semibold text-ink">To pay out</dt><dd className="text-right text-lg font-bold text-ink">{c(s.payableCents)}</dd>
              {s.carryCents > 0 ? <><dt className="text-danger-text">Carried to next week</dt><dd className="text-right text-danger-text">{c(s.carryCents)}</dd></> : null}
            </>
          ) : null}
        </dl>
        {s.exceptions.length ? <ul className="mt-2 text-xs text-warning-text">{s.exceptions.map((e) => <li key={e}>• {e}</li>)}</ul> : null}
        <div className="mt-3 flex gap-2 text-xs"><Link to="/accounting/settlements/$settlementId" params={{ settlementId: s.id }} className="text-primary-text underline">Open statement</Link><AuthedFileLink path={`/accounting/settlements/${s.id}/pdf`} fileName={`${s.settlementNumber}.pdf`} className="text-primary-text underline">PDF</AuthedFileLink>{s.partyType === 'driver' ? <Link to="/drivers/$driverId" params={{ driverId: s.partyId }} search={{ tab: 'financial' }} className="text-primary-text underline">Financial account</Link> : null}</div>
      </div>}
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between"><p className="text-sm font-semibold text-ink">Payee / Payment details</p>{canBank ? <Button variant="link" size="sm" onClick={() => setEditingPayee(true)}>Edit</Button> : null}</div>
        {payee ? (
          <div className="mt-2 text-sm">
            <p className="font-semibold text-ink">{payee.legalName}</p>
            <p className="text-xs text-muted">Account ••••{payee.accountLast4 ?? '????'} · {payee.accountType ?? 'type not set'} · v{payee.bankVersion}</p>
            <p className={cn('mt-1 text-xs', payee.verifiedAt ? 'text-success-text' : 'text-warning-text')}>{payee.verifiedAt ? `Verified ${formatIsoDate(payee.verifiedAt.slice(0, 10))}` : 'Not verified — no payout until verified'}</p>
            {!payee.verifiedAt && canBank ? <Button className="mt-2" variant="secondary" size="sm" loading={verify.isPending} onClick={() => verify.mutate(payee.id)}>Verify</Button> : null}
            <p className="mt-2 text-2xs text-muted">Restricted edits: bank details are sealed and shown as the last four digits only; changing them requires accounting.bank and re-verification, and puts any approved unsent batch back to review.</p>
          </div>
        ) : <p className="mt-2 text-xs text-muted">No bank details on file. Optional: while ADP is not connected, pay from the bank and press "Record payment" on the statement.{canBank ? ' Add them here if you want them on record.' : ''}</p>}
        {s.snapshot?.payeeVersion !== undefined && s.snapshot?.payeeVersion !== null ? <p className="mt-1 text-2xs text-muted">Approved against payee version {s.snapshot.payeeVersion}.</p> : null}
      </div>
      {editingPayee ? <PayeeDialog s={s} payee={payee} onClose={() => setEditingPayee(false)} onDone={onChanged} /> : null}
    </>
  );
}

function PayeeDialog({ s, payee, onClose, onDone }: { s: Statement; payee: PayeeProfile | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [legalName, setLegalName] = useState(payee?.legalName ?? s.partyName);
  const [accountType, setAccountType] = useState<'checking' | 'savings'>(payee?.accountType ?? 'checking');
  const [routing, setRouting] = useState('');
  const [acct, setAcct] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => savePayee({ partyType: s.partyType, partyId: s.partyId, legalName, accountType, routingNumber: routing || undefined, accountNumber: acct || undefined, reason: reason || undefined }),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: 'Payee saved', description: routing ? 'Bank details sealed; verification required before payout.' : undefined });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title="Payee profile" description="Numbers are sealed on save and never shown again in full." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="Legal / business name" required><Input value={legalName} onChange={(e) => setLegalName(e.target.value)} aria-label="Legal name" /></FormField>
        <FormField label="Account type"><Select options={[{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }]} value={accountType} onValueChange={(v) => setAccountType(v as 'checking' | 'savings')} /></FormField>
        <FormField label="Routing number" description={payee?.routingLast4 ? `On file ending ${payee.routingLast4}; leave blank to keep.` : undefined}><Input value={routing} onChange={(e) => setRouting(e.target.value)} inputMode="numeric" aria-label="Routing number" /></FormField>
        <FormField label="Account number" description={payee?.accountLast4 ? `On file ending ${payee.accountLast4}; leave blank to keep.` : undefined}><Input value={acct} onChange={(e) => setAcct(e.target.value)} inputMode="numeric" aria-label="Account number" /></FormField>
        <FormField label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" /></FormField>
      </div>
    </Modal>
  );
}

function EmailDialog({ rows, onClose }: { rows: Statement[]; onClose: () => void }) {
  const { toast } = useToast();
  const drivers = useQuery({ queryKey: ['drivers', 'settlement-email'], queryFn: () => listDrivers({ pageSize: 10_000 }) });
  const vendors = useQuery({ queryKey: ['accounting', 'vendors'], queryFn: () => listVendors({ pageSize: 10_000 }) });
  const items = rows.map((s) => {
    const email = s.partyType === 'driver' ? (drivers.data?.data.find((d) => d.id === s.partyId)?.email ?? null) : (vendors.data?.data.find((v) => v.id === s.partyId)?.contactEmail ?? null);
    return { documentId: s.id, recipient: email, label: `${s.partyName} (${s.settlementNumber})`, amountCents: s.payableCents, ready: Boolean(email) && (s.status === 'approved' || s.status === 'paid'), reason: !email ? 'Missing email' : s.status !== 'approved' && s.status !== 'paid' ? 'Not approved (draft PDF)' : null };
  });
  const send = useMutation({
    mutationFn: () => emailDocuments({ documentType: 'statement', items: items.filter((i) => i.ready).map(({ documentId, recipient, label, amountCents }) => ({ documentId, recipient, label, amountCents })) }),
    onSuccess: (r) => {
      toast({ tone: r.transportConfigured ? 'success' : 'warning', title: r.transportConfigured ? 'Queued for sending' : 'Logged, not sent', description: r.transportConfigured ? `${r.results.filter((x) => x.status === 'pending').length} queued.` : 'No email transport is configured on this server; each delivery is logged as pending with the reason. Sending never marks a statement paid.' });
      onClose();
    },
  });
  const ready = items.filter((i) => i.ready);
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={`Batch delivery (${rows.length} selected)`} description={`${ready.length} ready · ${items.length - ready.length} blocked. Each recipient gets only their own statement.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={ready.length === 0 || send.isPending} loading={send.isPending} onClick={() => send.mutate()}>Send {ready.length}</Button></>}>
      <table className="w-full text-xs">
        <thead className="text-left text-muted"><tr><th className="py-1">Statement</th><th>Payout</th><th>Email</th><th>Status</th></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {items.map((i) => <tr key={i.documentId}><td className="py-1">{i.label}</td><td className="tabular-nums">{c(i.amountCents)}</td><td>{i.recipient ?? '—'}</td><td>{i.ready ? <span className="text-success-text">Ready</span> : <span className="text-warning-text">{i.reason}</span>}</td></tr>)}
        </tbody>
      </table>
      <p className="mt-2 text-2xs text-muted">Total {c(ready.reduce((s, i) => s + i.amountCents, 0))} across {ready.length} statement{ready.length === 1 ? '' : 's'}. Email does not mark Paid.</p>
    </Modal>
  );
}

function ArrangementsDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const arrangements = useQuery({ queryKey: ['accounting', 'arrangements'], queryFn: fetchArrangements });
  const vendors = useQuery({ queryKey: ['accounting', 'vendors'], queryFn: () => listVendors({ pageSize: 10_000 }) });
  const trucks = useQuery({ queryKey: ['trucks', 'arrangements'], queryFn: () => listTrucks({ pageSize: 500 }) });
  const [vendorId, setVendorId] = useState('');
  const [truckId, setTruckId] = useState('');
  const [from, setFrom] = useState(today());
  const [pct, setPct] = useState('');
  const save = useMutation({
    mutationFn: () => saveArrangement({ vendorId, truckId, effectiveFrom: from, effectiveTo: null, percentBps: pct === '' ? null : Math.round(Number(pct) * 100) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounting', 'arrangements'] });
      toast({ tone: 'success', title: 'Arrangement saved' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title="Truck → vendor arrangements" description="Effective-dated. Activity is assigned by date, not by today's ownership. The vendor share is never assumed." footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_130px_90px_auto] items-end gap-2">
        <FormField label="Vendor"><Select options={(vendors.data?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} value={vendorId} onValueChange={setVendorId} placeholder="Vendor" /></FormField>
        <FormField label="Truck"><Select options={(trucks.data?.data ?? []).map((t) => ({ value: t.id, label: `Unit ${t.unitNumber}` }))} value={truckId} onValueChange={setTruckId} placeholder="Truck" /></FormField>
        <FormField label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /></FormField>
        <FormField label="Share %"><Input type="number" step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} aria-label="Share percent" /></FormField>
        <Button variant="primary" size="sm" disabled={!vendorId || !truckId} loading={save.isPending} onClick={() => save.mutate()}>Add</Button>
      </div>
      <ul className="mt-3 divide-y divide-line-soft text-xs">
        {(arrangements.data ?? []).map((a) => <li key={a.id} className="flex justify-between py-1"><span>{(vendors.data?.data ?? []).find((v) => v.id === a.vendorId)?.name ?? a.vendorId} · Unit {(trucks.data?.data ?? []).find((t) => t.id === a.truckId)?.unitNumber ?? a.truckId}</span><span>{formatIsoDate(a.effectiveFrom)}{a.effectiveTo ? ` – ${formatIsoDate(a.effectiveTo)}` : ''} · {a.percentBps === null ? <span className="text-warning-text">share not set</span> : `${a.percentBps / 100}%`}</span></li>)}
      </ul>
    </Modal>
  );
}

export type { SettlementBatch };
