import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Calendar, Check, CircleCheck, DollarSign, Download, FileText, Plus, TriangleAlert, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Avatar, Badge, Button, Drawer, FormField, Input, KpiCard, Modal, PageHeader, Select, Textarea, cn, useToast } from '@/design-system';
import { fetchPayrollPeriods, fetchSettings, fetchStaff, generatePayrollPeriod, saveSettings, saveStaffPlan, updatePayrollPeriod, type ServerPayrollPeriod, type StaffMember, type StaffPayPlan } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { today } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { PayrollLineDialog } from './PayrollLineDialog';
import { useInvalidateAccounting } from './useAccounting';

/**
 * Staff payroll (corrective brief 2, section 5): staff, never drivers.
 *
 * Useful before any period exists: every staff member is a row with their plan status, and a
 * missing plan is an "Edit plan" action, not an empty canvas. Dispatchers run on a 28-day cycle
 * from a confirmed anchor; without one, only their period is held back. Unknown amounts read
 * "Needs setup", never $0; currencies are never added together; approval never marks paid.
 */

const c = (cents: number) => formatMoney(cents / 100);
type Tab = 'dispatchers' | 'salary' | 'plans' | 'history';
const isDispatcher = (s: StaffMember) => /dispatch/i.test(s.position) || /dispatch/i.test(s.department);
const activePlan = (s: StaffMember, on: string): StaffPayPlan | null => [...s.plans].filter((p) => p.effectiveFrom <= on && (!p.effectiveTo || p.effectiveTo >= on)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? s.plans[0] ?? null;

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The 28-day cycle that contains `day`, counted from the anchor. */
function cycleFor(anchor: string, day: string): { start: string; end: string } {
  const ms = new Date(`${day}T00:00:00Z`).getTime() - new Date(`${anchor}T00:00:00Z`).getTime();
  const n = Math.floor(ms / (28 * 86_400_000));
  const start = addDays(anchor, n * 28);
  return { start, end: addDays(start, 27) };
}

export function PayrollPage() {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounting();
  const periods = useQuery({ queryKey: ['accounting', 'payroll-periods'], queryFn: fetchPayrollPeriods });
  const staff = useQuery({ queryKey: ['accounting', 'staff'], queryFn: fetchStaff });
  const settings = useQuery({ queryKey: ['accounting', 'settings'], queryFn: fetchSettings });
  const [tab, setTab] = useState<Tab>('dispatchers');
  const [date, setDate] = useState(today());
  const [salaryStart, setSalaryStart] = useState(addDays(today(), -27));
  const [salaryEnd, setSalaryEnd] = useState(today());
  const [planFor, setPlanFor] = useState<StaffMember | null>(null);
  const [lineFor, setLineFor] = useState<{ period: ServerPayrollPeriod; employeeId: string } | null>(null);
  const [anchorOpen, setAnchorOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting'] }), invalidate()]);

  const kind: 'dispatcher' | 'salary' = tab === 'salary' ? 'salary' : 'dispatcher';
  const anchor = settings.data?.dispatcherPeriodAnchor ?? null;
  const cycle = kind === 'dispatcher' ? (anchor ? cycleFor(anchor, date) : null) : { start: salaryStart, end: salaryEnd };
  const list = periods.data ?? [];
  const period = cycle ? list.find((p) => p.kind === kind && p.periodStart === cycle.start) ?? null : null;
  const members = (staff.data ?? []).filter((s) => (kind === 'dispatcher' ? isDispatcher(s) : !isDispatcher(s)));

  const generate = useMutation({
    mutationFn: () => generatePayrollPeriod(kind === 'dispatcher' ? { kind, date } : { kind, date: salaryEnd, periodStart: salaryStart, periodEnd: salaryEnd }),
    onSuccess: async (p) => { await refresh(); toast({ tone: p.blocked > 0 ? 'warning' : 'success', title: `${p.periodNumber} previewed`, description: p.blocked > 0 ? `${p.blocked} line(s) need setup` : `${p.lines.length} line(s) computed` }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Preview not calculated', description: e instanceof Error ? e.message : undefined }),
  });
  const move = useMutation({
    mutationFn: (input: { id: string; status: 'finalized' | 'paid' | 'closed'; acknowledgeExcluded?: string[] }) => updatePayrollPeriod({ periodId: input.id, status: input.status, paidOn: today(), reference: `payroll ${today()}`, acknowledgeExcluded: input.acknowledgeExcluded }),
    onSuccess: async (r) => { await refresh(); toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? `${r.period?.periodNumber} is ${r.period?.status}` : 'Refused', description: r.ok ? undefined : r.blocked }); },
  });

  // One row per staff member, whether or not a period exists.
  const rows = useMemo(() => members.map((s) => {
    const plan = activePlan(s, cycle?.end ?? today());
    const line = period?.lines.find((l) => l.employeeId === s.id) ?? null;
    const planStatus: 'configured' | 'formula_missing' | 'missing' = !plan ? 'missing' : plan.kind === 'dispatcher_commission' && (line ? line.exceptions.length > 0 : true) ? 'formula_missing' : 'configured';
    const preview: number | null = line ? (line.exceptions.length > 0 ? null : line.baseCents) : plan?.kind === 'salary' && plan.salaryCents !== null ? plan.salaryCents : null;
    const net: number | null = line ? (line.exceptions.length > 0 ? null : line.netCents) : preview;
    return { s, plan, line, planStatus, preview, net, currency: plan?.currency ?? 'USD', issue: !plan ? 'No pay plan configured' : plan.kind === 'dispatcher_commission' && planStatus === 'formula_missing' ? (line?.exceptions[0] ?? 'Commission formula missing') : null };
  }), [members, cycle, period]);
  const ready = rows.filter((r) => r.planStatus === 'configured');
  const needsSetup = rows.filter((r) => r.planStatus !== 'configured');
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const approvedPayable = period && (period.status === 'finalized' || period.status === 'paid' || period.status === 'closed') ? period.netCents : 0;
  const draftEstimate = ready.reduce((s, r) => s + (r.net ?? 0), 0);

  const card = (label: string, value: string, hint: string | undefined, icon: React.ReactNode, tone?: 'done' | 'warning') => <KpiCard label={label} value={value} hint={hint} icon={icon} iconTile variant="feature" tone={tone} />;
  const loading = staff.isPending || periods.isPending || settings.isPending;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Staff Payroll" description="Dispatchers on four-week commission cycles, other departments on a fixed salary. Drivers are paid through Settlements, never here." actions={<div className="flex gap-2">{canEdit ? <Button variant="primary" size="sm" icon={<Plus />} disabled={!cycle} onClick={() => generate.mutate()} loading={generate.isPending}>Create period</Button> : null}<Button variant="secondary" size="sm" icon={<Download />} disabled={!period} onClick={() => period && exportPeriod(period)}>Export</Button></div>} />

      <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist" aria-label="Payroll">
        {([['dispatchers', 'Dispatchers (4-week)'], ['salary', 'Fixed Salary'], ['plans', 'Pay Plans'], ['history', 'History']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', tab === k ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>

      {tab === 'dispatchers' || tab === 'salary' ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 text-sm">
            <Calendar className="size-4 text-muted" />
            {kind === 'dispatcher' ? (
              <>
                <span className="text-xs text-muted">Select 4-week period</span>
                <Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="A date in the period" />
                {cycle ? <span className="rounded-lg bg-surface-muted px-2 py-1 text-xs text-ink">{formatIsoDate(cycle.start)} – {formatIsoDate(cycle.end)} · 28 days</span> : null}
                {anchor ? <span className="text-2xs text-muted">Cycles run 28 days from {formatIsoDate(anchor)}</span> : <><Button variant="secondary" size="sm" onClick={() => setAnchorOpen(true)} disabled={!canEdit}>Set cycle start</Button><Badge tone="warning" size="sm">Cycle start needs confirmation</Badge></>}
              </>
            ) : (
              <>
                <span className="text-xs text-muted">Period</span>
                <Input type="date" className="w-40" value={salaryStart} onChange={(e) => setSalaryStart(e.target.value)} aria-label="Period start" />
                <span className="text-xs text-muted">to</span>
                <Input type="date" className="w-40" value={salaryEnd} onChange={(e) => setSalaryEnd(e.target.value)} aria-label="Period end" />
                <span className="text-2xs text-muted">Fixed salary does not depend on the dispatcher cycle.</span>
              </>
            )}
            {period ? <Badge tone={period.status === 'paid' || period.status === 'closed' ? 'success' : period.status === 'finalized' ? 'info' : 'neutral'} size="sm" className="ml-auto">{period.periodNumber} · {period.status}</Badge> : <span className="ml-auto text-2xs text-muted">No period calculated for these dates yet</span>}
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {card('Staff', loading ? 'Loading…' : String(rows.length), kind === 'dispatcher' ? 'dispatchers in scope' : 'salaried staff in scope', <Users />)}
            {card('Ready', loading ? 'Loading…' : String(ready.length), 'plan configured', <CircleCheck />, 'done')}
            {card('Needs setup', loading ? 'Loading…' : String(needsSetup.length), 'plan or formula missing', <TriangleAlert />, needsSetup.length > 0 ? 'warning' : undefined)}
            {card('Approved payable', loading ? 'Loading…' : currencies.length > 1 ? 'Mixed currencies' : c(approvedPayable), period && period.status === 'draft' ? `draft estimate ${currencies.length > 1 ? 'per currency only' : c(draftEstimate)} · not approved` : 'from a finalized period only', <DollarSign />)}
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            {loading ? <p className="p-6 text-sm text-muted">Loading…</p> : rows.length === 0 ? <p className="p-6 text-sm text-muted">No {kind === 'dispatcher' ? 'dispatchers' : 'salaried staff'} on the staff list. Staff are created in People; drivers never appear here.</p> : (
              <table className="w-full text-sm">
                <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Staff</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Pay type</th><th className="px-3 py-2">Plan status</th><th className="px-3 py-2 text-right">Earnings preview</th><th className="px-3 py-2 text-right">Adjustments</th><th className="px-3 py-2 text-right">Net preview</th><th className="px-3 py-2">Approval</th><th className="px-3 py-2" /></tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {rows.map(({ s, plan, line, planStatus, preview, net, currency, issue }) => (
                    <tr key={s.id}>
                      <td className="px-3 py-2"><span className="flex items-center gap-2"><Avatar name={s.name} size="sm" /><span><span className="block font-medium text-ink">{s.name}</span><span className="block text-xs text-muted">{s.position}</span></span></span></td>
                      <td className="px-3 py-2 text-xs">{s.department}</td>
                      <td className="px-3 py-2 text-xs">{plan ? (plan.kind === 'salary' ? 'Salary' : 'Commission') : '—'}</td>
                      <td className="px-3 py-2">{planStatus === 'configured' ? <Badge tone="success" size="sm">Configured</Badge> : planStatus === 'formula_missing' ? <Badge tone="warning" size="sm">Formula missing</Badge> : <Badge tone="warning" size="sm">No plan</Badge>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{preview === null ? <span className="text-muted">Needs setup</span> : `${c(preview)}${currency !== 'USD' ? ` ${currency}` : ''}`}{!line && preview !== null ? <span className="block text-2xs text-muted">estimate, not calculated</span> : null}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line ? c(line.bonusCents + line.adjustments.reduce((x, a) => x + a.cents, 0) - line.advanceCents) : <span className="text-muted">—</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{net === null ? <span className="font-normal text-muted">Needs setup</span> : c(net)}</td>
                      <td className="px-3 py-2">{period ? <Badge tone={period.status === 'paid' || period.status === 'closed' ? 'success' : period.status === 'finalized' ? 'info' : line?.exceptions.length ? 'warning' : 'neutral'} size="sm">{line?.exceptions.length ? 'Needs setup' : period.status === 'draft' ? 'Draft' : period.status[0]!.toUpperCase() + period.status.slice(1)}</Badge> : <span className="text-xs text-muted">—</span>}</td>
                      <td className="px-3 py-2 text-right">{canEdit ? (issue || !plan ? <Button variant="link" size="sm" onClick={() => setPlanFor(s)}>Edit plan</Button> : line && (period?.status === 'draft' || period?.status === 'review') ? <Button variant="link" size="sm" onClick={() => setLineFor({ period: period!, employeeId: s.id })}>Adjust</Button> : <Button variant="link" size="sm" onClick={() => setPlanFor(s)}>Plan</Button>) : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-semibold text-ink">Exceptions <span className="font-normal text-muted">{needsSetup.length} staff need pay plans</span></p>
              <p className="text-xs text-muted">These staff members are missing plan rules and will not be included in payroll until configured.</p>
              {needsSetup.length === 0 ? <p className="mt-2 text-xs text-muted">Every staff member in scope has a configured plan.</p> : (
                <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[440px] text-sm">
                  <thead className="text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="py-1">Staff</th><th className="py-1">Department</th><th className="py-1">Issue</th><th className="py-1 text-right">Action</th></tr></thead>
                  <tbody className="divide-y divide-line-soft">
                    {needsSetup.map(({ s, issue }) => <tr key={s.id}><td className="py-2"><span className="flex items-center gap-2"><Avatar name={s.name} size="sm" /><span className="text-ink">{s.name}</span></span></td><td className="py-2 text-xs">{s.department}</td><td className="py-2 text-xs text-warning-text">{issue}</td><td className="py-2 text-right">{canEdit ? <Button variant="outline" size="sm" onClick={() => setPlanFor(s)}>Edit Plan</Button> : null}</td></tr>)}
                  </tbody>
                </table></div>
              )}
            </div>
            <div className="rounded-lg bg-info-soft p-4 text-xs text-info-text">
              <p className="font-semibold">Drivers are paid through Settlements.</p>
              <p className="mt-1">Driver pay is processed from load settlements and is not included in Staff Payroll. A dispatcher's commission is the DISP-KPI-01 calculation from Dispatch › Commission, priced per truck per week under the policy version in force that week and summed over the four weeks of the period. The figures here and on the Salary Report are the same calculation.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
            <Calculator className="size-4 text-muted" /><span className="text-sm font-semibold text-ink">Payroll review</span><span className="text-xs text-muted">Calculate preview → Review → Approve → Create payroll payment.</span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {canEdit ? <Button variant="primary" size="sm" disabled={!cycle || generate.isPending} loading={generate.isPending} onClick={() => generate.mutate()} title={cycle ? undefined : 'Set the cycle start first'}>Calculate preview</Button> : null}
              {canEdit ? <Button variant="secondary" size="sm" disabled={!period || period.status !== 'draft'} onClick={() => period && updatePayrollPeriod({ periodId: period.id, status: 'review' }).then(refresh)} title={!period ? 'Calculate a preview first' : period.status !== 'draft' ? `Period is ${period.status}` : undefined}>Review</Button> : null}
              {canEdit ? <Button variant="secondary" size="sm" icon={<Check />} disabled={!period || (period.status !== 'draft' && period.status !== 'review') || period.lines.some((l) => l.exceptions.length > 0 && l.plan !== null)} onClick={() => setApproving(true)} title={!period ? 'Calculate a preview first' : period.lines.some((l) => l.exceptions.length > 0 && l.plan !== null) ? 'A line with a plan still needs its figure' : undefined}>Approve for payroll</Button> : null}
              {canEdit ? <Button variant="secondary" size="sm" icon={<FileText />} disabled={!period || period.status !== 'finalized'} onClick={() => period && move.mutate({ id: period.id, status: 'paid' })} title={!period || period.status !== 'finalized' ? 'Approve the period first; approval does not pay' : undefined}>Create payroll payment</Button> : null}
            </span>
            {period && period.blocked > 0 ? <span className="w-full text-2xs text-warning-text"><TriangleAlert className="mr-1 inline size-3" />Resolve missing pay plans to enable approval. Independent rows are already computed.</span> : <span className="w-full text-2xs text-muted">Process approved payment separately; approval never marks a period paid. No tax, attendance or statutory deduction is computed: those rules are not on file.</span>}
          </div>
        </>
      ) : null}

      {tab === 'plans' ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          {staff.isPending ? <p className="p-6 text-sm text-muted">Loading…</p> : (
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Staff</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Plan</th><th className="px-3 py-2">Effective</th><th className="px-3 py-2">Frequency</th><th className="px-3 py-2">Currency</th><th className="px-3 py-2" /></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {(staff.data ?? []).map((s) => { const plan = activePlan(s, today()); return (
                  <tr key={s.id}>
                    <td className="px-3 py-2"><span className="text-ink">{s.name}</span><span className="block text-xs text-muted">{s.position}</span></td>
                    <td className="px-3 py-2 text-xs">{s.department}</td>
                    <td className="px-3 py-2">{plan ? (plan.kind === 'salary' ? `Salary ${plan.salaryCents === null ? '(amount missing)' : c(plan.salaryCents)}` : `Commission${plan.commissionBase ? ` · ${plan.commissionRatePercent ?? '?'}% of ${plan.commissionBase.replace(/_/g, ' ')} (recorded; formula unconfirmed)` : ' · base/rate not recorded'}`) : <Badge tone="warning" size="sm">No plan</Badge>}</td>
                    <td className="px-3 py-2 text-xs">{plan ? `${formatIsoDate(plan.effectiveFrom)}${plan.effectiveTo ? ` – ${formatIsoDate(plan.effectiveTo)}` : ''}` : '—'}</td>
                    <td className="px-3 py-2 text-xs">{plan?.frequency.replace(/_/g, ' ') ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">{plan?.currency ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{canEdit ? <Button variant="link" size="sm" onClick={() => setPlanFor(s)}>{plan ? 'Edit plan' : 'Add plan'}</Button> : null}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          {periods.isPending ? <p className="p-6 text-sm text-muted">Loading…</p> : list.length === 0 ? <p className="p-6 text-sm text-muted">No payroll period yet. Calculate a preview from the Dispatchers or Fixed Salary tab.</p> : (
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Period</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Dates</th><th className="px-3 py-2">Pay date</th><th className="px-3 py-2 text-right">Lines</th><th className="px-3 py-2 text-right">Net</th><th className="px-3 py-2">Status</th></tr></thead>
              <tbody className="divide-y divide-line-soft">
                {[...list].sort((a, b) => b.periodStart.localeCompare(a.periodStart)).map((p) => <tr key={p.id}><td className="px-3 py-2 font-medium text-ink">{p.periodNumber}</td><td className="px-3 py-2 text-xs">{p.kind === 'dispatcher' ? 'Dispatchers (4-week)' : 'Fixed salary'}</td><td className="px-3 py-2 text-xs">{formatIsoDate(p.periodStart)} – {formatIsoDate(p.periodEnd)}</td><td className="px-3 py-2 text-xs">{formatIsoDate(p.payDate)}</td><td className="px-3 py-2 text-right tabular-nums">{p.lines.length}{p.blocked > 0 ? <span className="text-warning-text"> ({p.blocked} blocked)</span> : ''}</td><td className="px-3 py-2 text-right tabular-nums">{p.blocked > 0 ? <span className="text-muted">Incomplete</span> : c(p.netCents)}</td><td className="px-3 py-2"><Badge tone={p.status === 'paid' || p.status === 'closed' ? 'success' : p.status === 'finalized' ? 'info' : 'neutral'} size="sm">{p.status}</Badge></td></tr>)}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {planFor ? <PlanDrawer member={planFor} onClose={() => setPlanFor(null)} onDone={refresh} /> : null}
      {lineFor ? <PayrollLineDialog period={lineFor.period} employeeId={lineFor.employeeId} onClose={() => setLineFor(null)} onDone={refresh} /> : null}
      {approving && period ? <ApproveDialog period={period} onClose={() => setApproving(false)} onApprove={(ack) => { move.mutate({ id: period.id, status: 'finalized', acknowledgeExcluded: ack }); setApproving(false); }} /> : null}
      {anchorOpen && settings.data ? <AnchorDialog version={settings.data.version} onClose={() => setAnchorOpen(false)} onDone={refresh} /> : null}
    </div>
  );
}

function exportPeriod(p: ServerPayrollPeriod) {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Period', 'Employee', 'Role', 'Plan', 'Base', 'Bonus', 'Adjustments', 'Advance', 'Net', 'Exceptions'];
  const lines = p.lines.map((l) => [p.periodNumber, l.employeeName, l.role, l.plan?.kind ?? '', l.baseCents / 100, l.bonusCents / 100, l.adjustments.reduce((s, a) => s + a.cents, 0) / 100, l.advanceCents / 100, l.netCents / 100, l.exceptions.join('; ')].map(esc).join(','));
  const blob = new Blob([[head.map(esc).join(','), ...lines].join(String.fromCharCode(10))], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.periodNumber}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Approval shows exactly who is left out and why, and asks for each exclusion to be acknowledged.
 * A partial payroll is never presented as complete: the total below is only the included lines.
 */
function ApproveDialog({ period, onClose, onApprove }: { period: ServerPayrollPeriod; onClose: () => void; onApprove: (acknowledgeExcluded: string[]) => void }) {
  const excluded = period.lines.filter((l) => l.exceptions.length > 0 && l.plan === null);
  const included = period.lines.filter((l) => l.exceptions.length === 0);
  const [ack, setAck] = useState<Set<string>>(new Set());
  const allAcknowledged = excluded.every((l) => ack.has(l.employeeId));
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={`Approve ${period.periodNumber} for payroll`} description={`${formatIsoDate(period.periodStart)} – ${formatIsoDate(period.periodEnd)} · ${included.length} of ${period.lines.length} staff included`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Check />} disabled={!allAcknowledged} onClick={() => onApprove([...ack])}>Approve {included.length} line{included.length === 1 ? '' : 's'} · {c(period.netCents)}</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface-muted text-left text-muted"><tr><th className="px-2 py-1">Included</th><th className="px-2 py-1 text-right">Net</th></tr></thead>
            <tbody className="divide-y divide-line-soft">{included.map((l) => <tr key={l.employeeId}><td className="px-2 py-1 text-ink">{l.employeeName}</td><td className="px-2 py-1 text-right tabular-nums">{c(l.netCents)}</td></tr>)}</tbody>
          </table>
        </div>
        {excluded.length > 0 ? (
          <Alert tone="warning" title={`${excluded.length} staff member${excluded.length === 1 ? '' : 's'} will be left out of this period`} description={<div className="mt-1 flex flex-col gap-1">{excluded.map((l) => <label key={l.employeeId} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-primary" checked={ack.has(l.employeeId)} onChange={(e) => setAck((p) => { const n = new Set(p); if (e.target.checked) n.add(l.employeeId); else n.delete(l.employeeId); return n; })} /><span><span className="font-semibold">{l.employeeName}</span> — {(l.exceptions[0] ?? 'No pay plan').replace(/\.$/, '')}. I acknowledge this person is not paid in this period.</span></label>)}</div>} />
        ) : null}
        <p className="text-2xs text-muted">Approval freezes the included lines and posts the payroll expense and liability. It does not pay anyone; payment is a separate step.</p>
      </div>
    </Modal>
  );
}

/** The cycle start is the owner's to confirm; the page never invents one. */
function AnchorDialog({ version, onClose, onDone }: { version: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [anchor, setAnchor] = useState('');
  const save = useMutation({
    mutationFn: () => saveSettings({ expectedVersion: version, settings: {}, dispatcherPeriodAnchor: anchor }),
    onSuccess: async () => { await onDone(); toast({ tone: 'success', title: 'Cycle start set', description: `Dispatcher periods run 28 days from ${formatIsoDate(anchor)}.` }); onClose(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title="Set cycle start" description="The first day of a dispatcher four-week cycle, as the owner confirms it. Every cycle is 28 days from here." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!anchor} loading={save.isPending} onClick={() => save.mutate()}>Confirm cycle start</Button></>}>
      <FormField label="Cycle start (Monday)" required><Input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} aria-label="Cycle start" /></FormField>
    </Modal>
  );
}

/** The plan, preloaded from what is on record; base and rate are recorded as the owner states them, never turned into a formula here. */
function PlanDrawer({ member, onClose, onDone }: { member: StaffMember; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const existing = activePlan(member, today());
  const dispatcher = isDispatcher(member);
  const [kind, setKind] = useState<'salary' | 'dispatcher_commission'>(existing?.kind ?? (dispatcher ? 'dispatcher_commission' : 'salary'));
  const [salary, setSalary] = useState(existing?.salaryCents === null || existing?.salaryCents === undefined ? '' : String(existing.salaryCents / 100));
  const [currency, setCurrency] = useState(existing?.currency ?? 'USD');
  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'four_weekly' | 'monthly'>((existing?.frequency as 'weekly' | 'biweekly' | 'four_weekly' | 'monthly' | undefined) ?? 'four_weekly');
  const [from, setFrom] = useState(existing?.effectiveFrom ?? today());
  const [base, setBase] = useState<string>(existing?.commissionBase ?? '');
  const [rate, setRate] = useState(existing?.commissionRatePercent === null || existing?.commissionRatePercent === undefined ? '' : String(existing.commissionRatePercent));
  const [shared, setShared] = useState<string>(existing?.sharedCreditRule ?? '');
  // Every version says why it was set; the server refuses a plan without it (owner, 2026-10-15).
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => saveStaffPlan(member.id, { kind, effectiveFrom: from, effectiveTo: null, currency, salaryCents: kind === 'salary' ? Math.round(Number(salary) * 100) : null, frequency, sharedCreditRule: (shared || null) as 'split_equal' | 'primary_only' | null, commissionPolicyVersion: null, commissionBase: kind === 'dispatcher_commission' ? ((base || null) as 'gross' | 'linehaul' | 'net_revenue' | null) : null, commissionRatePercent: kind === 'dispatcher_commission' && rate !== '' ? Number(rate) : null, reason: reason.trim() }),
    onSuccess: async () => { await onDone(); toast({ tone: 'success', title: 'Plan saved', description: kind === 'dispatcher_commission' ? 'Base and rate recorded. The commission formula stays unconfirmed until the dispatch policy says so.' : undefined }); onClose(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  const valid = (kind === 'salary' ? Number(salary) > 0 : true) && reason.trim() !== '';
  return (
    <Drawer open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title={`${member.name} · Pay plan`} description={`${member.position} · ${member.department}${existing ? ` · current plan from ${formatIsoDate(existing.effectiveFrom)}` : ' · no plan on record'}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Save plan</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="Effective date" required description="Earlier periods keep their terms."><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Effective date" /></FormField>
        <FormField label="Pay type"><Select options={[{ value: 'salary', label: 'Fixed salary' }, { value: 'dispatcher_commission', label: 'Dispatcher commission (4-week)' }]} value={kind} onValueChange={(v) => setKind(v as typeof kind)} /></FormField>
        {kind === 'salary' ? <FormField label="Fixed salary per period" required><Input type="number" step="0.01" value={salary} onChange={(e) => setSalary(e.target.value)} prefix="$" aria-label="Salary" /></FormField> : (
          <>
            <FormField label="Commission base" description="Recorded as stated; not applied until the dispatch policy confirms the formula."><Select options={[{ value: '', label: 'Select commission base' }, { value: 'gross', label: 'Gross revenue' }, { value: 'linehaul', label: 'Linehaul' }, { value: 'net_revenue', label: 'Net revenue' }]} value={base} onValueChange={setBase} /></FormField>
            <FormField label="Rate (%)"><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Rate" /></FormField>
            <FormField label="Shared credit on one load"><Select options={[{ value: '', label: 'Not decided (blocks shared loads)' }, { value: 'split_equal', label: 'Split equally' }, { value: 'primary_only', label: 'Primary dispatcher only' }]} value={shared} onValueChange={setShared} /></FormField>
            <Alert tone="info" title="The commission itself comes from the dispatch board" description="It is earned per truck per week on the Weekly Board under the commission policy; Dispatch › Salary report shows the weeks that were priced. No truck-week there means nothing to pay." />
          </>
        )}
        <FormField label="Currency"><Select options={[{ value: 'USD', label: 'USD' }, { value: 'UZS', label: 'UZS' }, { value: 'EUR', label: 'EUR' }]} value={currency} onValueChange={setCurrency} /></FormField>
        <FormField label="Frequency"><Select options={[{ value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every two weeks' }, { value: 'four_weekly', label: 'Every four weeks' }, { value: 'monthly', label: 'Monthly' }]} value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)} /></FormField>
        <FormField label="Why this plan" required description="Kept with this version of the plan."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Why this plan" placeholder="New dispatcher, commission per the 2026 policy" /></FormField>
        <p className="text-2xs text-muted">Adjustment rules (bonus, advance recovery, approved adjustments) are entered per period line with a reason; no deduction or tax formula is applied unless configured.</p>
      </div>
    </Drawer>
  );
}
