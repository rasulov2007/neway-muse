import { Link } from '@tanstack/react-router';
import { safetyRules as R } from '@neway/shared';
import { cn } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';
import { useProfileAccidents } from './api';
import { Empty, Loading, Panel, SevBadge, StageBadge, ToneBadge } from './ui';

/**
 * Accidents section on a truck, trailer or driver profile (SPEC §6.2–6.3, ACCEPTANCE L1–L3) — behind `accidents_v2`.
 * Reads the accident cases themselves (`safety_accidents`), so a unit with one case and nothing else still shows it.
 * Test results are never part of this section; a disciplinary item the viewer may not see is a lock line.
 */
export function ProfileAccidents({ kind, id }: { kind: 'truck' | 'trailer' | 'driver'; id: string }) {
  const q = useProfileAccidents(kind, id);
  // A role that may not read accidents simply does not get this section — the rest of the profile stays.
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  if (q.isLoading) return <Panel title="Accidents"><Loading /></Panel>;
  if (q.error || !q.data) return null;
  const d = q.data;
  const k = d.kpis;
  const days = (n: number) => (n > 0 ? `${n.toFixed(n < 10 ? 1 : 0)} d` : '—');
  return (
    <Panel
      title="Accidents"
      id={`accidents-${kind}`}
      sub={kind === 'driver' ? 'From Safety’s accident cases. Test results stay restricted.' : 'From Safety’s accident cases on this unit.'}
      actions={k.reviewSuggested ? <ToneBadge tone="warning">Review suggested</ToneBadge> : null}
      pad={false}
    >
      <div className="grid grid-cols-2 gap-px border-b border-nw-border bg-nw-border sm:grid-cols-4">
        <Stat label="Accident cases" value={String(k.total)} sub={`${k.last12m} in 12 months`} />
        {kind === 'driver' ? (
          <>
            <Stat label="Preventable (12 mo)" value={String(k.preventable12m)} sub={`${k.nonPreventable12m} non-preventable`} />
            <Stat label="DOT-recordable (12 mo)" value={String(k.dotRecordable12m)} sub="49 CFR 390.5T" />
            <Stat label="Open corrective actions" value={String(k.openCorrectiveActions)} sub="Coaching, retraining, reviews" />
          </>
        ) : (
          <>
            <Stat label="Accident-related spend" value={k.spendCents === null ? '—' : R.money(k.spendCents, { compact: true })} sub={k.spendCents === null ? 'Not shown to your role' : 'Paid so far'} />
            <Stat label="Accident downtime" value={days(k.downtimeDays)} sub={kind === 'trailer' ? 'Trailer-days' : 'Truck-days'} />
            <Stat label="DOT-recordable (12 mo)" value={String(k.dotRecordable12m)} sub="49 CFR 390.5T" />
          </>
        )}
      </div>
      {d.note ? <p className="border-b border-nw-border bg-nw-warning-bg px-4 py-2 text-xs text-nw-warning-text" data-testid="accidents-note">{d.note}</p> : null}
      {d.cases.length === 0 ? (
        <Empty title={kind === 'driver' ? 'No accident cases for this driver' : 'No accident cases on this unit'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nw-border text-left text-xs text-nw-text-3">
                <th className="px-4 py-2 font-semibold">Case</th>
                <th className="px-2 py-2 font-semibold">Type</th>
                <th className="px-2 py-2 font-semibold">Severity</th>
                <th className="px-2 py-2 font-semibold">DOT</th>
                <th className="px-2 py-2 font-semibold">Outcome</th>
                <th className="px-2 py-2 text-right font-semibold">Downtime</th>
                <th className="px-4 py-2 text-right font-semibold">Net cost</th>
              </tr>
            </thead>
            <tbody>
              {d.cases.map((c) => (
                <tr key={c.id} className="border-b border-nw-border align-top last:border-0">
                  <td className="px-4 py-2">
                    <Link to="/safety/accidents/$accidentId" params={{ accidentId: c.id }} className="font-semibold text-nw-accent-ink hover:underline">{c.number}</Link>
                    <div className="text-xs text-nw-text-3">{R.fmtShort(c.occurredAt, c.tz, nowMs())}</div>
                    {c.workOrders.length ? <div className="text-xs text-nw-text-3">{c.workOrders.map((w) => `${w.number} · ${w.status}`).join(', ')}</div> : null}
                  </td>
                  <td className="max-w-56 px-2 py-2 text-nw-text">{c.type}</td>
                  <td className="px-2 py-2"><SevBadge sev={c.severity} /></td>
                  <td className="px-2 py-2"><ToneBadge tone={c.dotRecordable === 'yes' ? 'urgent' : c.dotRecordable === 'no' ? 'neutral' : 'warning'}>{c.dotRecordable === 'yes' ? 'Recordable' : c.dotRecordable === 'no' ? 'No' : 'Pending'}</ToneBadge></td>
                  <td className="px-2 py-2 text-xs text-nw-text-2">{c.stage === 'closed' ? (c.outcome ?? 'Closed') : <StageBadge stage={c.stage} />}<div className="text-nw-text-3">{R.PREVENT_LABEL[c.preventability]}</div></td>
                  <td className="px-2 py-2 text-right tabular-nums">{days(c.downtimeDays)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{c.netCostCents === null ? '—' : R.money(c.netCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kind === 'driver' && d.correctiveActions.length ? (
        <div className="border-t border-nw-border px-4 py-3">
          <div className="mb-1.5 text-xs font-bold tracking-wide text-nw-text-2 uppercase">Corrective actions &amp; coaching</div>
          <ul className="flex flex-col gap-1">
            {d.correctiveActions.map((a) => (
              <li key={a.id} className={cn('flex flex-wrap items-center gap-2 text-sm', a.locked ? 'text-nw-text-3' : 'text-nw-text')}>
                <span className="text-xs text-nw-text-3">{a.caseNumber}</span>
                <span className="min-w-0 flex-1">{a.locked ? 'Restricted personnel action' : `${a.kind} — ${a.title}`}</span>
                {a.locked ? <ToneBadge tone="neutral">Restricted</ToneBadge> : <ToneBadge tone={a.status === 'Completed' ? 'done' : a.status === 'Waived' ? 'neutral' : Date.parse(a.dueAt) < nowMs() ? 'urgent' : 'moving'}>{a.status}</ToneBadge>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-nw-panel px-4 py-3">
      <div className="text-xs font-semibold text-nw-text-3">{label}</div>
      <div className="text-lg font-extrabold text-nw-text tabular-nums">{value}</div>
      <div className="text-xs text-nw-text-3">{sub}</div>
    </div>
  );
}
