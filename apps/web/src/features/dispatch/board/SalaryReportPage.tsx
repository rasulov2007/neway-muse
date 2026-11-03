import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, Lock, Plus, Unlock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SalaryAdjustmentKinds, periodOf, shiftPeriod, type PeriodKind, type SalaryReport, type SalaryTeam } from '@neway/shared';
import { Alert, Badge, Button, Combobox, FormField, Input, Modal, Select, Textarea, cn, useToast } from '@/design-system';
import { dispatcherOptions, useDispatchers } from '@/features/people/useDispatchers';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { sessionToken } from '@/lib/session';
import { API_PREFIX } from '@neway/shared';
import { salaryExportUrl, useAddAdjustment, useSalaryReport, useSalaryRunAction, useVoidAdjustment, useWriteAllocation } from './api';
import { AccessPill, BoardBar, PeriodStepper } from './chrome';
import { GRID, cents } from './sheet';
import { salarySearchSchema } from './search';

const KIND_LABEL: Record<PeriodKind, string> = { week: 'Week', pay_period: '28-day pay period', month: 'Calendar month' };
const ADJ_LABEL: Record<(typeof SalaryAdjustmentKinds)[number], string> = {
  lane_bonus: 'Dedicated lane bonus',
  dnu: 'DNU penalty',
  driver_departure: 'Driver departure penalty',
  freight_guard: 'Freight Guard penalty',
  junior_forfeit: 'Junior forfeiture (admin decision)',
  other_bonus: 'Other approved bonus',
  other_penalty: 'Other approved penalty',
};
const TH = cn(GRID.headNavy, 'h-8');
const TD = 'h-8 border-r border-b border-nw-border-strong bg-nw-panel px-2 text-center align-middle text-[12.5px] text-nw-text';

/**
 * The Salary Report (owner's brief §11): dispatcher compensation for a week, a 28-day pay
 * period or a calendar month, priced by the same engine as the Weekly Board; team summary,
 * per-employee allocation when shares are set, per-truck proof, approved bonuses and penalties,
 * the run's lifecycle (draft → review → final → audited reopen) and real Excel / CSV exports.
 */
export function SalaryReportPage() {
  const navigate = useNavigate();
  const account = useAccount();
  // Reading takes dispatch_pay.view (Accounting and Administrator, owner 2026-10-26); the run,
  // bonuses, penalties and splits take dispatch_pay.edit and dispatch.manage, as the server does.
  const held = account?.permissions ?? [];
  const canView = held.includes('dispatch_pay.view');
  const canEdit = held.includes('dispatch_pay.edit') && held.includes('dispatch.manage');
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => salarySearchSchema.parse(rawSearch), [rawSearch]);
  const kind = search.kind ?? 'pay_period';
  const date = search.date ?? companyToday();
  const period = periodOf(kind, date);
  // The periods up to the one we are in, newest first, for the drop-down (owner, 2026-10-19).
  const periodChoices = useMemo(() => {
    const out: { value: string; label: string; group: string }[] = [];
    for (let start = periodOf(kind, companyToday()).start, i = 0; i < 26; i += 1, start = shiftPeriod(kind, start, -1)) {
      const p = periodOf(kind, start);
      out.push({ value: p.start, label: `${p.start} – ${p.end}`, group: p.start.slice(0, 4) });
    }
    return out;
  }, [kind]);
  const report = useSalaryReport(kind, period.start, canView);
  const act = useSalaryRunAction();
  const { toast } = useToast();
  const [adjusting, setAdjusting] = useState<SalaryTeam | null>(null);
  const [allocating, setAllocating] = useState<SalaryTeam | null>(null);
  const [reopening, setReopening] = useState(false);
  const go = (next: { kind?: PeriodKind; date?: string }) => void navigate({ to: '/dispatch/salary', search: { kind: next.kind ?? kind, date: next.date ?? date }, replace: true });

  const run = async (action: 'create' | 'review' | 'finalize' | 'reopen' | 'back_to_draft', reason = '') => {
    try {
      await act.mutateAsync({ kind, date: period.start, action, reason, expectedVersion: report.data?.run?.version ?? null });
      toast({ tone: 'success', title: { create: 'Draft run created', review: 'Run sent to review', finalize: 'Run finalized and frozen', reopen: 'Run reopened', back_to_draft: 'Back to draft' }[action] });
    } catch (e) {
      toast({ tone: 'danger', title: 'Not done', description: e instanceof Error ? e.message : undefined });
    }
  };
  const download = async (format: 'xlsx' | 'csv') => {
    const token = sessionToken();
    const res = await fetch(`/${API_PREFIX}${salaryExportUrl(kind, period.start, format)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return toast({ tone: 'danger', title: 'Export failed' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `salary-${kind}-${period.start}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!canView)
    return (
      <div className="flex flex-col gap-2">
        <BoardBar current="/dispatch/salary" title="Salary Report">
          <AccessPill canWrite={false} canManage={false} />
        </BoardBar>
        <Alert tone="info">The salary report is for Accounting and administrators.</Alert>
      </div>
    );

  const data = report.data;
  const runStatus = data?.run?.status ?? null;
  return (
    <div className="flex flex-col gap-2">
      <BoardBar current="/dispatch/salary" title="Salary Report" meta={data ? `${period.label} · weeks ${data.weeks.length} · policy ${data.policyVersions.join(', ')}` : 'Loading…'}>
        <AccessPill canWrite={canEdit} canManage={canEdit} />
        <span className="inline-flex rounded-md bg-nw-segment p-0.5" role="group" aria-label="Period kind">
          {(['week', 'pay_period', 'month'] as PeriodKind[]).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => go({ kind: k })} className={cn('h-7 rounded px-2.5 text-xs font-semibold', kind === k ? 'bg-nw-accent text-nw-on-accent' : 'text-nw-text-2 hover:bg-nw-panel')}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </span>
        <PeriodStepper
          label={`${period.start} – ${period.end}`}
          onPrev={() => go({ date: shiftPeriod(kind, period.start, -1) })}
          onNext={() => go({ date: shiftPeriod(kind, period.start, 1) })}
          prevLabel="Previous period"
          nextLabel="Next period"
          options={periodChoices}
          value={period.start}
          onPick={(start) => go({ date: start })}
        />
        <Button variant="secondary" size="sm" icon={<Download />} onClick={() => void download('xlsx')} disabled={!data}>
          Excel
        </Button>
        <Button variant="secondary" size="sm" icon={<Download />} onClick={() => void download('csv')} disabled={!data}>
          CSV
        </Button>
      </BoardBar>

      {data ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nw-border-strong bg-nw-panel px-3 py-2 text-[12.5px]">
          <span className="font-bold text-nw-text">Run</span>
          {data.run ? (
            <>
              <Badge tone={runStatus === 'final' ? 'success' : runStatus === 'review' ? 'warning' : 'neutral'} size="sm" icon={runStatus === 'final' ? <Lock /> : undefined}>
                {runStatus}
              </Badge>
              <span className="text-nw-text-2">
                created by {data.run.createdByName} · {data.run.createdAt.slice(0, 16).replace('T', ' ')}
                {data.run.finalizedAt ? ` · finalized by ${data.run.finalizedByName} · ${data.run.finalizedAt.slice(0, 16).replace('T', ' ')}` : ''}
                {data.run.reopenedAt ? ` · reopened by ${data.run.reopenedByName}: ${data.run.reopenReason}` : ''}
              </span>
              {data.frozen ? <span className="text-nw-done-text">Frozen snapshot · later board or rule edits do not change it</span> : <span className="text-nw-text-3">Live figures</span>}
              {canEdit ? <span className="ml-auto flex gap-1.5">
                {runStatus === 'draft' ? (
                  <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => void run('review')}>
                    Send to review
                  </Button>
                ) : null}
                {runStatus === 'review' ? (
                  <>
                    <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => void run('back_to_draft')}>
                      Back to draft
                    </Button>
                    <Button size="sm" variant="primary" icon={<Lock />} loading={act.isPending} onClick={() => void run('finalize')}>
                      Finalize
                    </Button>
                  </>
                ) : null}
                {runStatus === 'final' ? (
                  <Button size="sm" variant="secondary" icon={<Unlock />} onClick={() => setReopening(true)}>
                    Reopen
                  </Button>
                ) : null}
              </span> : null}
            </>
          ) : (
            <>
              <span className="text-nw-text-3">No run yet · the figures below are live</span>
              {canEdit ? (
                <Button size="sm" variant="primary" className="ml-auto" loading={act.isPending} onClick={() => void run('create')}>
                  Start a draft run
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {report.isError ? <Alert tone="danger">The report could not be loaded.</Alert> : null}
      {!data ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : (
        <>
          <Summary data={data} onAdjust={data.frozen || !canEdit ? undefined : setAdjusting} onAllocate={data.frozen || !canEdit ? undefined : setAllocating} />
          {data.teams.map((t) => (
            <TeamProof key={t.dispatcherId || 'none'} team={t} frozen={data.frozen || !canEdit} />
          ))}
        </>
      )}
      {adjusting ? <AdjustmentDialog team={adjusting} months={data?.months ?? []} onClose={() => setAdjusting(null)} /> : null}
      {allocating ? <AllocationDialog team={allocating} onClose={() => setAllocating(null)} /> : null}
      {reopening ? <ReopenDialog onClose={() => setReopening(false)} onConfirm={(reason) => void run('reopen', reason).then(() => setReopening(false))} /> : null}
    </div>
  );
}

function Summary({ data, onAdjust, onAllocate }: { data: SalaryReport; onAdjust?: (t: SalaryTeam) => void; onAllocate?: (t: SalaryTeam) => void }) {
  return (
    <div className={GRID.frame}>
      <table className="nw-board w-full min-w-[1100px] border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            <th className={TH}>Dispatcher team</th>
            {data.weeks.map((w) => (
              <th key={w} className={TH}>
                Wk {w.slice(5)}
              </th>
            ))}
            <th className={TH}>Gross</th>
            <th className={TH}>Miles</th>
            <th className={TH}>RPM</th>
            <th className={TH}>Commission</th>
            <th className={TH}>Bonuses</th>
            <th className={TH}>Penalties</th>
            <th className={TH}>Payable</th>
            <th className={TH}>Allocation</th>
            <th className={cn(TH, 'border-r-0')} />
          </tr>
        </thead>
        <tbody>
          {data.teams.map((t) => (
            <tr key={t.dispatcherId || 'none'}>
              <td className={cn(TD, 'text-left font-bold')} title={t.dispatcherNickname ? (t.dispatcherFullName ?? t.dispatcherName) : undefined}>
                {t.dispatcherNickname || t.dispatcherName}
                {t.needsMiles > 0 ? (
                  <Badge tone="warning" size="sm" className="ml-1">
                    {t.needsMiles} needs miles
                  </Badge>
                ) : null}
              </td>
              {t.weeks.map((w) => (
                <td key={w.weekStart} className={cn(TD, 'tabular text-nw-text-2')} title={`${w.trucks} trucks · gross ${cents(w.grossCents)}`}>
                  {cents(w.commissionCents)}
                </td>
              ))}
              <td className={cn(TD, 'tabular')}>{cents(t.grossCents)}</td>
              <td className={cn(TD, 'tabular')}>{t.miles.toLocaleString('en-US')}</td>
              <td className={cn(TD, 'tabular')}>{t.rpm?.toFixed(2) ?? '—'}</td>
              <td className={cn(TD, 'tabular font-semibold')}>{cents(t.commissionCents)}</td>
              <td className={cn(TD, 'tabular text-nw-done-text')}>{t.bonusesCents ? cents(t.bonusesCents) : ''}</td>
              <td className={cn(TD, 'tabular text-nw-urgent-text')}>{t.penaltiesCents ? cents(t.penaltiesCents) : ''}</td>
              <td className={cn(TD, 'tabular font-bold')}>{cents(t.payableCents)}</td>
              <td className={cn(TD, 'text-left text-[12px]')}>
                {t.allocation ? (
                  t.allocation.map((a) => (
                    <span key={a.name} className="block">
                      {a.name} · {a.sharePct}% · <span className="font-semibold">{cents(a.payableCents)}</span>
                    </span>
                  ))
                ) : t.allocationEffectiveFrom ? (
                  <span className="text-nw-urgent-text">Shares do not total 100 %</span>
                ) : (
                  <span className="text-nw-warning-text">Allocation required · team total only</span>
                )}
              </td>
              <td className={cn(TD, 'border-r-0')}>
                {onAdjust || onAllocate ? (
                  <span className="flex justify-center gap-1">
                    {onAllocate ? (
                      <button type="button" className="text-[12px] font-semibold text-nw-accent-ink hover:underline" onClick={() => onAllocate(t)}>
                        Shares
                      </button>
                    ) : null}
                    {onAdjust ? (
                      <button type="button" className="inline-flex items-center gap-0.5 text-[12px] font-semibold text-nw-accent-ink hover:underline" onClick={() => onAdjust(t)}>
                        <Plus className="size-3" aria-hidden /> Adjustment
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={GRID.grand}>
            <td className={cn(GRID.grandCell, 'text-left')}>Total · {data.teams.length} teams</td>
            <td className={GRID.grandCell} colSpan={data.weeks.length} />
            <td className={GRID.grandCell}>{cents(data.totals.grossCents)}</td>
            <td className={GRID.grandCell} colSpan={2} />
            <td className={GRID.grandCell}>{cents(data.totals.commissionCents)}</td>
            <td className={GRID.grandCell}>{cents(data.totals.bonusesCents)}</td>
            <td className={GRID.grandCell}>{cents(data.totals.penaltiesCents)}</td>
            <td className={GRID.grandCell}>{cents(data.totals.payableCents)}</td>
            <td className={cn(GRID.grandCell, 'border-r-0')} colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function TeamProof({ team, frozen }: { team: SalaryTeam; frozen: boolean }) {
  const [open, setOpen] = useState(false);
  const voidAdj = useVoidAdjustment();
  const { toast } = useToast();
  return (
    <section className="rounded-[10px] border border-nw-border-strong bg-nw-panel">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left" aria-expanded={open}>
        <span className="text-[13px] font-extrabold text-nw-text" title={team.dispatcherNickname ? (team.dispatcherFullName ?? team.dispatcherName) : undefined}>{team.dispatcherNickname || team.dispatcherName}</span>
        <span className="text-[12px] text-nw-text-2">
          {team.trucks.length} truck-weeks · commission {cents(team.commissionCents)} · payable {cents(team.payableCents)}
        </span>
        <span className="ml-auto text-[12px] font-semibold text-nw-accent-ink">{open ? 'Hide proof' : 'Show calculation proof'}</span>
      </button>
      {open ? (
        <div className="border-t border-nw-border-strong">
          <div className="overflow-auto">
            <table className="nw-board w-full min-w-[1200px] border-collapse">
              <thead>
                <tr>
                  <th className={TH}>Week</th>
                  <th className={TH}>Driver</th>
                  <th className={TH}>Truck</th>
                  <th className={TH}>Unit</th>
                  <th className={TH}>Gross</th>
                  <th className={TH}>Miles</th>
                  <th className={TH}>RPM</th>
                  <th className={TH}>Base %</th>
                  <th className={TH}>Bonus %</th>
                  <th className={TH}>Calculated</th>
                  <th className={TH}>Manual</th>
                  <th className={TH}>Payable</th>
                  <th className={cn(TH, 'border-r-0')}>Formula</th>
                </tr>
              </thead>
              <tbody>
                {team.trucks.map((x) => (
                  <tr key={`${x.weekStart}|${x.rosterId}`}>
                    <td className={cn(TD, 'tabular')}>{x.weekStart}</td>
                    <td className={cn(TD, 'text-left font-semibold')}>{x.driverName}</td>
                    <td className={cn(TD, 'tabular')}>{x.truckUnit ?? ''}</td>
                    <td className={TD}>{x.unit}</td>
                    <td className={cn(TD, 'tabular')}>{cents(x.grossCents)}</td>
                    <td className={cn(TD, 'tabular')}>{x.miles.toLocaleString('en-US')}</td>
                    <td className={cn(TD, 'tabular')}>{x.rpm?.toFixed(2) ?? '—'}</td>
                    <td className={cn(TD, 'tabular')}>{x.basePct.toFixed(2)}%</td>
                    <td className={cn(TD, 'tabular')}>{x.bonusPct.toFixed(2)}%</td>
                    <td className={cn(TD, 'tabular', x.status === 'needs_miles' && 'text-nw-warning-text')}>{x.status === 'needs_miles' ? 'Needs miles' : cents(x.calculatedCents)}</td>
                    <td className={cn(TD, 'tabular text-nw-accent-ink')} title={x.overrideReason ?? undefined}>
                      {x.overrideCents === null ? '' : `${x.overrideMode === 'amount' ? '=' : '+'} ${cents(x.overrideCents)}`}
                    </td>
                    <td className={cn(TD, 'tabular font-bold')}>{cents(x.payableCents)}</td>
                    <td className={cn(TD, 'border-r-0 text-left text-[11.5px] text-nw-text-2')}>{x.formula}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {team.adjustments.length > 0 ? (
            <div className="border-t border-nw-border-strong px-3 py-2">
              <div className="text-[11px] font-extrabold tracking-[.06em] text-nw-text-3 uppercase">Approved bonuses and penalties</div>
              <ul className="mt-1 flex flex-col gap-1 text-[12.5px]">
                {team.adjustments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className={cn('tabular font-bold', a.amountCents < 0 ? 'text-nw-urgent-text' : 'text-nw-done-text')}>{cents(a.amountCents)}</span>
                    <span className="font-semibold text-nw-text">{ADJ_LABEL[a.kind]}</span>
                    <span className="text-nw-text-2">
                      {a.month}
                      {a.employeeName ? ` · ${a.employeeName}` : ''} · {a.reason} · approved by {a.approvedByName} · recorded by {a.byName}
                    </span>
                    {!frozen ? (
                      <button
                        type="button"
                        className="text-[12px] text-nw-text-3 hover:text-nw-urgent-text hover:underline"
                        onClick={() => {
                          const reason = window.prompt('Why is this adjustment voided?');
                          if (!reason) return;
                          void voidAdj.mutateAsync({ id: a.id, reason }).catch((e) => toast({ tone: 'danger', title: 'Not voided', description: e instanceof Error ? e.message : undefined }));
                        }}
                      >
                        void
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AdjustmentDialog({ team, months, onClose }: { team: SalaryTeam; months: string[]; onClose: () => void }) {
  const add = useAddAdjustment();
  const { toast } = useToast();
  const [kind, setKind] = useState<(typeof SalaryAdjustmentKinds)[number]>('lane_bonus');
  const [month, setMonth] = useState(months[0] ?? companyToday().slice(0, 7));
  const [amount, setAmount] = useState('');
  const [employee, setEmployee] = useState('');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isBonus = kind === 'lane_bonus' || kind === 'other_bonus';
  const submit = async () => {
    setError(null);
    const n = Math.abs(Number(amount.replace(/[$,]/g, '')));
    if (!Number.isFinite(n) || n === 0) return setError('Enter the amount');
    try {
      await add.mutateAsync({ dispatcherId: team.dispatcherId, employeeName: employee.trim(), month, kind, amountCents: Math.round(n * 100) * (isBonus ? 1 : -1), reason: reason.trim(), approvedByName: approvedBy.trim() });
      toast({ tone: 'success', title: 'Adjustment recorded' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Adjustment · ${team.dispatcherName}`}
      description="Only with management approval. A lane bonus is recorded once per team and month; penalties carry forward and are never capped at earnings."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={() => void submit()}>
            Record
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Kind">
          <Select options={SalaryAdjustmentKinds.map((k) => ({ value: k, label: ADJ_LABEL[k] }))} value={kind} onValueChange={(v) => setKind(v as typeof kind)} />
        </FormField>
        <FormField label="Affected month">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </FormField>
        <FormField label={isBonus ? 'Bonus $' : 'Penalty $'}>
          <Input prefix="$" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={kind === 'dnu' ? '1000' : kind === 'freight_guard' ? '4000' : kind === 'driver_departure' ? '500' : ''} />
        </FormField>
        <FormField label="Affected employee" description="Within the team, when it is one person">
          <Input value={employee} onChange={(e) => setEmployee(e.target.value)} />
        </FormField>
        <FormField label="Approved by" required>
          <Input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} />
        </FormField>
        <FormField label="Reason" required className="sm:col-span-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'lane_bonus' ? 'Lane, verified monthly volume, TMS records checked' : ''} />
        </FormField>
      </div>
      {error ? (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}

function AllocationDialog({ team, onClose }: { team: SalaryTeam; onClose: () => void }) {
  const write = useWriteAllocation();
  const { toast } = useToast();
  /*
   * Each share names the staff record it pays (owner, 2026-10-15): a typed name alone left
   * employeeId empty, and Payroll could then pay nobody - the whole team's commission went
   * unattributed. A team that is one employee starts with that employee at 100 %.
   */
  const dispatchers = useDispatchers();
  const options = dispatcherOptions(dispatchers.data);
  const [shares, setShares] = useState<{ employeeId: string | null; name: string; sharePct: string }[]>(() =>
    team.allocation && team.allocation.length > 0
      ? team.allocation.map((a) => ({ employeeId: a.employeeId, name: a.name, sharePct: String(a.sharePct) }))
      : team.dispatcherId.startsWith('emp_')
        ? [{ employeeId: team.dispatcherId, name: team.dispatcherName, sharePct: '100' }]
        : // A pair team shares its commission 50/50 (owner, 2026-10-28).
          team.dispatcherName.split('/').map((n, _i, all) => ({ employeeId: null, name: n.trim(), sharePct: all.length === 2 ? '50' : '' })),
  );
  const unnamed = shares.some((x) => !x.employeeId);
  const [effectiveFrom, setEffectiveFrom] = useState(companyToday());
  const [error, setError] = useState<string | null>(null);
  const total = shares.reduce((s, x) => s + (Number(x.sharePct) || 0), 0);
  const submit = async () => {
    setError(null);
    try {
      await write.mutateAsync({ dispatcherId: team.dispatcherId, effectiveFrom, shares: shares.map((s) => ({ employeeId: s.employeeId, name: s.name.trim(), sharePct: Number(s.sharePct) || 0 })) });
      toast({ tone: 'success', title: 'Allocation saved' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Shares · ${team.dispatcherName}`}
      description="How the team's commission splits between the people behind the name. Shares must total 100 %. Saved as a dated version; earlier versions stay."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={Math.abs(total - 100) > 0.005 || unnamed} loading={write.isPending} onClick={() => void submit()}>
            Save shares
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {shares.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_32px] items-end gap-2">
            <FormField label={i === 0 ? 'Employee' : undefined}>
              <Combobox
                aria-label={`Employee ${i + 1}`}
                options={options}
                value={s.employeeId}
                loading={dispatchers.isPending}
                placeholder={s.name ? `Pick the staff record for ${s.name}` : 'Pick a dispatcher'}
                onValueChange={(v) => setShares(shares.map((x, j) => (j === i ? { ...x, employeeId: v, name: options.find((o) => o.value === v)?.label ?? x.name } : x)))}
              />
            </FormField>
            <FormField label={i === 0 ? 'Share %' : undefined}>
              <Input size="sm" value={s.sharePct} onChange={(e) => setShares(shares.map((x, j) => (j === i ? { ...x, sharePct: e.target.value } : x)))} />
            </FormField>
            <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setShares(shares.filter((_, j) => j !== i))}>
              ×
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" className="self-start" onClick={() => setShares([...shares, { employeeId: null, name: '', sharePct: '' }])}>
          Add person
        </Button>
        <FormField label="Effective from">
          <Input size="sm" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </FormField>
        <span className={cn('text-[12.5px] font-semibold', Math.abs(total - 100) > 0.005 ? 'text-nw-urgent-text' : 'text-nw-done-text')}>Total {total.toFixed(2)} %</span>
        {unnamed ? <p className="text-xs text-nw-urgent-text">Pick the staff record for every share: Payroll pays a share only to a person on file.</p> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

function ReopenDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reopen a finalized run"
      description="The frozen snapshot is set aside and the run goes back to review with live figures. The reopen is audited with your name and reason."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>
            Reopen
          </Button>
        </>
      }
    >
      <FormField label="Reason" required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Modal>
  );
}
