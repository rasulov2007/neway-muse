import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Calendar, Coins, FileText, Truck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, FormField, Input, Modal, StatusSymbol, Tabs, TabsContent, useToast } from '@/design-system';
import { setPayrollLine, type ServerPayrollPeriod } from '@/demo';
import { formatIsoDate } from '@/lib/format';
import { capitalise, classifyCommissionNote, formatDayRange, toCents, type CommissionNote } from './payroll-review';

type PayLine = ServerPayrollPeriod['lines'][number];
type Detail = NonNullable<PayLine['commissionDetail']>;

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Review one staff member's pay line (Accounting › Staff payroll › Adjust).
 *
 * For a dispatcher it shows the truck-weeks behind the commission KPI, the notes the KPI raised,
 * and the admin adjustment (commission, bonus). Changing the KPI commission asks for a reason;
 * advances and approved adjustments live under "Pay adjustments". Figures are the server's;
 * nothing here is inferred.
 */
export function PayrollLineDialog({ period, employeeId, onClose, onDone }: { period: ServerPayrollPeriod; employeeId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const line = period.lines.find((l) => l.employeeId === employeeId)!;
  const dispatcher = line.plan?.kind === 'dispatcher_commission';
  const detail = dispatcher ? line.commissionDetail ?? null : null;
  const kpiText = line.commissionCents === null ? '' : String(line.commissionCents / 100);
  const [tab, setTab] = useState(detail ? 'kpi' : 'adjustments');
  const [commission, setCommission] = useState(kpiText);
  const [bonus, setBonus] = useState(String(line.bonusCents / 100));
  const [advance, setAdvance] = useState(String(line.advanceCents / 100));
  const [adjDesc, setAdjDesc] = useState('');
  const [adjCents, setAdjCents] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const commissionChanged = dispatcher && commission !== kpiText;
  const save = useMutation({
    mutationFn: () => setPayrollLine(period.id, { employeeId, commissionCents: commissionChanged ? (commission === '' ? null : Math.round(Number(commission) * 100)) : undefined, reason: overrideReason || undefined, bonusCents: Math.round(Number(bonus) * 100), advanceCents: Math.round(Number(advance) * 100), adjustment: adjDesc && adjCents ? { description: adjDesc, cents: Math.round(Number(adjCents) * 100), reason: adjReason || 'approved' } : undefined }),
    onSuccess: async () => { await onDone(); toast({ tone: 'success', title: 'Line updated' }); onClose(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });

  const earnings = dispatcher ? toCents(commission) : line.baseCents;
  const bonusCents = toCents(bonus) ?? 0;
  const totalPay = earnings === null ? null : earnings + bonusCents;
  const policy = detail?.policyVersions.length ? detail.policyVersions.map((v) => formatIsoDate(v)).join(', ') : detail ? 'built-in' : null;

  const adjustmentsPanel = (
    <div className="flex flex-col gap-4">
      {detail && detail.adjustments.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-nw-text">Approved monthly bonuses and penalties</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-nw-text-3">
            {detail.adjustments.map((a, i) => <li key={i}>{a.month} · {a.kind.replace(/_/g, ' ')} {money(a.amountCents)} — {a.reason}</li>)}
          </ul>
          <p className="mt-2 text-xs font-semibold text-nw-text">
            Period total {money(detail.payableCents)} = commission {money(detail.commissionCents)}
            {detail.bonusesCents ? ` + bonuses ${money(detail.bonusesCents)}` : ''}
            {detail.penaltiesCents ? ` − penalties ${money(Math.abs(detail.penaltiesCents))}` : ''}
          </p>
        </div>
      ) : null}
      {line.adjustments.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-nw-text">Adjustments on this line</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-nw-text-3">
            {line.adjustments.map((a, i) => <li key={i}>{a.description} {money(a.cents)} — {a.reason}</li>)}
          </ul>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Advance to recover ($)"><Input type="number" step="0.01" value={advance} onChange={(e) => setAdvance(e.target.value)} aria-label="Advance" /></FormField>
      </div>
      <div className="rounded-[10px] border border-nw-border bg-nw-subtle p-3">
        <p className="text-xs font-semibold text-nw-text">Add an approved adjustment</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><Input placeholder="Description" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} aria-label="Adjustment description" /><Input type="number" step="0.01" placeholder="± amount" value={adjCents} onChange={(e) => setAdjCents(e.target.value)} aria-label="Adjustment amount" /></div>
        <Input className="mt-2" placeholder="Reason" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} aria-label="Adjustment reason" />
      </div>
    </div>
  );

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      className="max-w-215"
      title={dispatcher ? 'Review dispatcher pay' : 'Review staff pay'}
      description={`${line.employeeName} · ${period.periodNumber}`}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></>}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-nw-text-2">
          <span className="inline-flex items-center gap-2"><Calendar className="size-4 text-nw-text-3" aria-hidden /><span className="font-semibold text-nw-text">Period</span><span>{formatDayRange(period.periodStart, period.periodEnd)}</span></span>
          {policy ? (
            <>
              <span className="hidden h-4 w-px bg-nw-border sm:block" aria-hidden />
              <span className="inline-flex items-center gap-2"><FileText className="size-4 text-nw-text-3" aria-hidden /><span>KPI rule · {policy}</span></span>
            </>
          ) : null}
          {detail?.sharePct !== null && detail?.sharePct !== undefined ? <span className="text-xs text-nw-text-3">{detail.sharePct}% share of {detail.dispatcherName || 'the team'}</span> : null}
        </div>

        {detail ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberCard icon={<Coins />} label="KPI commission" value={money(detail.commissionCents)} />
            <NumberCard icon={<Truck />} value={`${detail.trucks.length} truck-week${detail.trucks.length === 1 ? '' : 's'}`} />
          </div>
        ) : null}

        {detail ? (
          <Tabs value={tab} onValueChange={setTab} size="sm" aria-label="Pay review" items={[{ value: 'kpi', label: 'KPI breakdown' }, { value: 'adjustments', label: 'Pay adjustments' }]}>
            <TabsContent value="kpi" className="pt-4">
              <KpiBreakdown detail={detail} />
            </TabsContent>
            <TabsContent value="adjustments" className="pt-4">{adjustmentsPanel}</TabsContent>
          </Tabs>
        ) : dispatcher ? (
          <p className="text-xs text-nw-text-3">The commission KPI has no breakdown for this line yet.</p>
        ) : null}

        <div>
          <div className="flex items-center gap-3">
            <p className="text-xs font-bold tracking-wide text-nw-text-3 uppercase">Admin adjustment</p>
            <span className="h-px flex-1 bg-nw-border" aria-hidden />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {dispatcher ? (
              <FormField
                label="Commission ($)"
                description={
                  line.commissionSource === 'manual'
                    ? `Entered by hand: ${line.commissionReason ?? 'no reason recorded'}`
                    : line.commissionSource === 'computed'
                      ? 'Changing the KPI amount requires a reason.'
                      : 'The KPI has produced no figure for this period yet; see the notes above.'
                }
              >
                <Input type="number" step="0.01" value={commission} onChange={(e) => setCommission(e.target.value)} aria-label="Commission" />
              </FormField>
            ) : null}
            <FormField label="Bonus ($)"><Input type="number" step="0.01" value={bonus} onChange={(e) => setBonus(e.target.value)} aria-label="Bonus" /></FormField>
            <FormField label="Total pay"><Input readOnly tabIndex={-1} value={totalPay === null ? '' : money(totalPay)} placeholder="Needs a commission" aria-label="Total pay" className="font-semibold" /></FormField>
          </div>
          {commissionChanged ? (
            <FormField className="mt-3" label="Why is this being set by hand?" description="Kept on the line so the override can be explained later.">
              <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} aria-label="Override reason" />
            </FormField>
          ) : null}
        </div>

        {!detail ? adjustmentsPanel : null}
      </div>
    </Modal>
  );
}

function NumberCard({ icon, label, value }: { icon: ReactNode; label?: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-4 shadow-card">
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-nw-accent-tint text-nw-accent-ink [&_svg]:size-5" aria-hidden>{icon}</span>
      <span className="min-w-0">
        {label ? <span className="block text-xs font-semibold text-nw-text-3">{label}</span> : null}
        <span className="tabular block text-xl font-bold text-nw-text">{value}</span>
      </span>
    </div>
  );
}

function KpiBreakdown({ detail }: { detail: Detail }) {
  const navigate = useNavigate();
  const notes = detail.exceptions.map(classifyCommissionNote);
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-[10px] border border-nw-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-nw-subtle text-left text-xs font-semibold text-nw-text-3">
            <tr>
              <th className="px-3 py-2 font-semibold">Week</th>
              <th className="px-3 py-2 font-semibold">Truck</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-3 py-2 text-right font-semibold">Gross</th>
              <th className="px-3 py-2 text-right font-semibold">Miles</th>
              <th className="px-3 py-2 text-right font-semibold">RPM</th>
              <th className="px-3 py-2 text-right font-semibold">Rate</th>
              <th className="px-3 py-2 text-right font-semibold">Commission</th>
            </tr>
          </thead>
          <tbody className="tabular divide-y divide-nw-border">
            {detail.trucks.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-4 text-xs text-nw-text-3">No truck-week on the dispatch board is credited to this person for this period.</td></tr>
            ) : detail.trucks.map((t, i) => (
              <tr key={`${t.weekStart}-${t.truckUnit}-${i}`} title={t.formula}>
                <td className="px-3 py-2 whitespace-nowrap text-nw-text">{formatIsoDate(t.weekStart)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-nw-text">{t.truckUnit ?? '—'}</td>
                <td className="px-3 py-2">{capitalise(t.unit)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <span className="block text-nw-text">{money(t.grossCents)}</span>
                  <span className="block text-2xs text-nw-text-3">
                    {t.tier}
                    {t.bonusPct > 0 ? ` +${t.bonusPct}` : ''}
                    {t.overrideCents !== null ? ' · override' : ''}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{t.miles.toLocaleString('en-US')}</td>
                <td className="px-3 py-2 text-right">{t.rpm === null ? '—' : `$${t.rpm.toFixed(2)}`}</td>
                <td className="px-3 py-2 text-right">{(t.basePct + t.bonusPct).toFixed(2)}%</td>
                <td className="px-3 py-2 text-right font-semibold text-nw-text">{money(t.payableCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-nw-border bg-nw-subtle">
              <td className="px-3 py-2 font-semibold text-nw-text" colSpan={7}>Period commission</td>
              <td className="tabular px-3 py-2 text-right font-bold text-nw-text">{money(detail.commissionCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {notes.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {notes.map((n, i) => <NoteCard key={i} note={n} onAllocation={() => void navigate({ to: '/dispatch/salary' })} onPeriods={() => void navigate({ to: '/accounting', search: { tab: 'settings' } })} />)}
        </div>
      ) : null}
    </div>
  );
}

function NoteCard({ note, onAllocation, onPeriods }: { note: CommissionNote; onAllocation: () => void; onPeriods: () => void }) {
  let title: string;
  let lines: string[];
  let action: { label: string; onClick: () => void } | null = null;
  switch (note.kind) {
    case 'allocation':
      title = 'Dispatcher allocation incomplete';
      lines = [`${note.name} has no complete allocation. Review the split before finalizing.`];
      action = { label: 'Review allocation', onClick: onAllocation };
      break;
    case 'grid':
      title = 'Payroll and KPI periods differ';
      lines = note.payroll && note.board ? [`Payroll ${formatDayRange(note.payroll.start, note.payroll.end, { year: false })} · Board ${formatDayRange(note.board.start, note.board.end, { year: false })}`] : [note.text];
      action = { label: 'Review periods', onClick: onPeriods };
      break;
    case 'miles':
      title = 'Miles missing';
      lines = [note.text];
      break;
    default:
      title = 'Needs review';
      lines = [note.text];
  }
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg p-3 sm:flex-row sm:items-start" title={note.text}>
      <StatusSymbol family="warning" size={16} className="mt-0.5 text-nw-warning-icon" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-nw-warning-text"><span className="sr-only">Warning: </span>{title}</p>
        {lines.map((l) => <p key={l} className="mt-0.5 text-xs text-nw-text-2">{l}</p>)}
      </div>
      {action ? <Button variant="outline" size="sm" className="shrink-0 self-start" onClick={action.onClick}>{action.label}</Button> : null}
    </div>
  );
}
