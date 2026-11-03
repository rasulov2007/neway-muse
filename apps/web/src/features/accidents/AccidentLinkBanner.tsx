import { AlertTriangle, Link2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { safetyRules as R } from '@neway/shared';
import { Button } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { accApi, useAccWrite, useBoard, useCan, useWorkOrderAccidentLink } from './api';
import { NSelect } from './ui';

/**
 * On Fleet's work-order page (Accident & Claims v2, SPEC §6.5 / ACCEPTANCE I5): an Accident repair with no accident
 * case says "Link to an accident case or report it to Safety"; a linked one names its case. Rendered only when
 * `accidents_v2` is on (the caller checks the flag), so the page is unchanged with the flag off.
 */
export function AccidentLinkBanner({ workOrderId }: { workOrderId: string }) {
  const navigate = useNavigate();
  const q = useWorkOrderAccidentLink(workOrderId, true);
  const canEdit = useCan('accidents.edit');
  const canFleet = useCan('accidents.fleet');
  const canLink = canEdit || canFleet;
  const cases = useBoard({ chip: 'all', range: '12m', pageSize: 200 });
  const [to, setTo] = useState('');
  const link = useAccWrite((accidentId: string) => accApi.wo(workOrderId, 'link-accident', { updatedAt: q.data?.updatedAt, accidentId }), 'Work order linked to the accident case');
  const d = q.data;
  if (!d || (!d.accident && !d.needsAccidentLink)) return null;
  if (d.accident) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2 text-sm text-nw-text">
        <Link2 className="size-4 text-nw-text-3" aria-hidden />
        Repair for accident <b>{d.accident.number}</b>
        <Button size="sm" variant="ghost" onClick={() => void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: d.accident!.id }, search: { tab: 'equipment' } } as never)}>
          Open the case
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg px-3 py-2 text-sm text-nw-warning-text" role="status" id="accident-link-banner">
      <AlertTriangle className="size-4" aria-hidden />
      <span className="min-w-0 flex-1 font-semibold">Accident repair with no case — link it to an accident case or report it to Safety.</span>
      {canLink ? (
        <>
          <NSelect ariaLabel="Accident case" className="h-8 w-[220px]" value={to} onChange={setTo}>
            <option value="">Link to accident…</option>
            {(cases.data?.items ?? []).filter((r) => !r.isDraft).map((r) => (
              <option key={r.id} value={r.id}>{r.number} · {r.truck ? `Truck ${r.truck.unit}` : 'no truck'} · {R.fmtShort(r.occurredAt, r.occurredTz, nowMs())}</option>
            ))}
          </NSelect>
          {to ? <Button size="sm" variant="primary" loading={link.isPending} onClick={() => link.mutate(to)}>Link</Button> : null}
        </>
      ) : null}
      <Button size="sm" variant="secondary" onClick={() => void navigate({ to: '/safety/accidents/new' })}>Report to Safety</Button>
    </div>
  );
}
