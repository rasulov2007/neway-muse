import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { VACATION_REQUEST_STATUS_LABEL, type ConfirmTruckParkedInput, type DecideVacationRequestInput, type VacationRequestList, type VacationRequestRow, type VacationRequestStatus } from '@neway/shared';
import { Badge, Button, Checkbox, Input, useToast, type BadgeTone } from '@/design-system';
import { useCanManageVacations } from '@/features/operations/vacation-api';
import { apiPost } from '@/lib/api-client';
import { useVacationRequests } from './vacation-requests-api';
import { formatDateTime, formatIsoDate } from '@/lib/format';

/**
 * Vacation requests drivers sent from the driver app (mobile M3). Dispatch approves or rejects
 * (a rejection says why, for the driver); the truck is confirmed parked - by the driver in the app
 * or here - and the keys handed over. Approval alone starts nothing and parks nothing: the vacation
 * starts with Start vacation on the driver page (or VACATION on the Daily board), which takes the
 * approved request over, and the return and Safety's review stay where they are.
 */
const TONE: Record<VacationRequestStatus, BadgeTone> = {
  requested: 'warning',
  approved: 'info',
  rejected: 'danger',
  cancelled: 'neutral',
  started: 'success',
};

export function VacationRequests() {
  const list = useVacationRequests();
  const canManage = useCanManageVacations();
  const rows = (list.data?.requests ?? []).filter((r) => r.status === 'requested' || r.status === 'approved' || r.status === 'rejected');
  if (list.isPending) return <p className="text-sm text-nw-text-3">Loading…</p>;
  if (list.isError || rows.length === 0) return null;
  return (
    <section aria-label="Vacation requests from the driver app" className="rounded-[12px] border border-nw-border-strong bg-nw-panel p-3">
      <h2 className="mb-2 px-1 text-base font-bold text-nw-text">
        Requests from the driver app
        <span className="ml-2 text-sm font-medium text-nw-text-2">
          {list.data.counts.requested} waiting · {list.data.counts.approved} approved
        </span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm" data-testid="vacation-requests">
          <thead className="border-b border-nw-border text-left text-[13px] text-nw-text-2">
            <tr>
              <th className="px-3 py-2 font-medium">Driver</th>
              <th className="px-3 py-2 font-medium">Dates</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Truck parked</th>
              <th className="px-3 py-2 font-medium">{canManage ? 'Action' : ''}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {rows.map((r) => (
              <RequestRow key={r.id} r={r} canManage={canManage} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestRow({ r, canManage }: { r: VacationRequestRow; canManage: boolean }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [keys, setKeys] = useState(false);
  const write = useMutation({
    mutationFn: (a: { path: 'decision'; body: DecideVacationRequestInput } | { path: 'parked'; body: ConfirmTruckParkedInput }) => apiPost<VacationRequestList>(`/drivers/vacation-requests/${encodeURIComponent(r.id)}/${a.path}`, a.body),
    onSuccess: async (next) => {
      client.setQueryData(['drivers', 'vacation-requests'], next);
      await client.invalidateQueries({ queryKey: ['drivers'] });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <tr className="align-top">
      <td className="px-3 py-3">
        <Link to="/drivers/$driverId" params={{ driverId: r.driverId }} className="font-semibold text-nw-text hover:underline">
          {r.driverName}
        </Link>
        <span className="block text-xs text-nw-text-3">
          {r.unitNumber ? `Unit ${r.unitNumber}` : 'No unit'} · {r.dispatcherName ?? 'No dispatcher'}
        </span>
      </td>
      <td className="px-3 py-3 tabular-nums">
        {formatIsoDate(r.from)} – {formatIsoDate(r.to)}
        {r.note ? <span className="block max-w-[240px] text-xs text-nw-text-2">“{r.note}”</span> : null}
      </td>
      <td className="px-3 py-3">
        <Badge tone={TONE[r.status]} dot size="sm">
          {VACATION_REQUEST_STATUS_LABEL[r.status]}
        </Badge>
        {r.decidedBy ? <span className="block text-xs text-nw-text-3">{r.decidedBy}{r.decidedReason ? ` — ${r.decidedReason}` : ''}</span> : null}
      </td>
      <td className="px-3 py-3 text-xs text-nw-text-2">
        {r.truckParkedAt ? (
          <>
            {formatDateTime(r.truckParkedAt)} · {r.truckParkedBy}
            {r.truckParkedNote ? <span className="block">{r.truckParkedNote}</span> : null}
            <span className="block">{r.keysHandedAt ? 'Keys handed over' : 'Keys not handed over yet'}</span>
          </>
        ) : r.status === 'approved' ? (
          'Not confirmed yet'
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-3">
        {!canManage ? null : r.status === 'requested' ? (
          rejecting ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input size="sm" aria-label="Reason for the driver" placeholder="Reason the driver reads" value={reason} onChange={(e) => setReason(e.target.value)} className="w-56" />
              <Button size="sm" variant="danger" disabled={reason.trim().length < 3 || write.isPending} onClick={() => write.mutate({ path: 'decision', body: { version: r.version, decision: 'reject', reason: reason.trim() } })}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                Back
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={write.isPending} onClick={() => write.mutate({ path: 'decision', body: { version: r.version, decision: 'approve' } })}>
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
                Reject…
              </Button>
            </div>
          )
        ) : r.status === 'approved' && (!r.truckParkedAt || !r.keysHandedAt) ? (
          <div className="flex flex-wrap items-center gap-2">
            {!r.keysHandedAt ? (
              <Checkbox checked={keys} onCheckedChange={(v) => setKeys(v === true)} label="Keys handed over" />
            ) : null}
            <Button size="sm" variant="secondary" disabled={write.isPending} onClick={() => write.mutate({ path: 'parked', body: { version: r.version, keysHandedOver: keys || undefined } })}>
              {r.truckParkedAt ? 'Save' : 'Confirm truck parked'}
            </Button>
          </div>
        ) : null}
      </td>
    </tr>
  );
}
