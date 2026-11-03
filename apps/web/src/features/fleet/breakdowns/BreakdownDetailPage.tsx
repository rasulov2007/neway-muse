import { Link, useParams } from '@tanstack/react-router';
import { ArrowRight, Paperclip } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BREAKDOWN_STATUS_LABEL, canMoveBreakdown, type FleetBreakdown } from '@neway/shared';
import { BackButton, Badge, Button, ErrorState, Input, PageHeader, Select, Textarea, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError, apiGet } from '@/lib/api-client';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useWorkOrders } from '../useFleetToday';
import { BREAKDOWN_TONE, useBreakdown, useBreakdownAction, useBreakdownPeople, useBreakdownShops } from './api';

export function BreakdownDetailRoute() {
  const { breakdownId } = useParams({ from: '/fleet/breakdowns/$breakdownId' });
  return <BreakdownDetailPage id={breakdownId} />;
}

/**
 * One breakdown case (mobile M3). What the driver reported, then Fleet's work on it: assign,
 * arrange the shop, open or link the work order, In repair / Ready / Close. In repair needs the
 * work order to have the unit in the shop - that is the down period, and the only one. Closing the
 * case never completes the work order; the shop's record stays the shop's. Notes are internal.
 */
export function BreakdownDetailPage({ id }: { id: string }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('maintenance.edit') ?? false;
  const query = useBreakdown(id);
  const bd = query.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={<BackButton fallback="/fleet/breakdowns" label="Breakdowns" />}
        title={bd ? `${bd.number} · ${bd.categoryLabel}` : 'Breakdown'}
        description={bd ? `Reported ${formatDateTime(bd.createdAt)} by ${bd.driver?.name ?? 'a driver'} from the driver app` : 'Loading…'}
        meta={
          bd ? (
            <Badge tone={BREAKDOWN_TONE[bd.status]} dot>
              {bd.statusLabel}
            </Badge>
          ) : null
        }
      />
      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !bd ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="What the driver reported">
              <p className="whitespace-pre-wrap text-sm text-nw-text">{bd.description}</p>
              <dl className="mt-3 grid grid-cols-[120px_minmax(0,1fr)] gap-y-1.5 text-sm">
                <dt className="text-nw-text-2">Truck</dt>
                <dd>{bd.truck ? <Link to="/fleet/trucks/$truckId" params={{ truckId: bd.truck.id }} className="font-semibold text-nw-accent-ink hover:underline">{bd.truck.unitNumber}</Link> : 'None'}</dd>
                <dt className="text-nw-text-2">Trailer</dt>
                <dd>{bd.trailer?.unitNumber ?? 'None'}</dd>
                <dt className="text-nw-text-2">Load</dt>
                <dd>{bd.load ? <Link to="/loads/$loadNumber" params={{ loadNumber: bd.load.loadNumber }} className="font-semibold text-nw-accent-ink hover:underline">{bd.load.loadNumber}</Link> : 'Not on a load'}</dd>
                <dt className="text-nw-text-2">Where</dt>
                <dd>
                  {bd.location?.text || 'Not given'}
                  {bd.location?.lat != null && bd.location?.lng != null ? (
                    <span className="block text-xs text-nw-text-3">
                      {bd.location.lat.toFixed(5)}, {bd.location.lng.toFixed(5)} · {bd.location.source === 'gps' ? 'phone GPS' : 'typed'}
                    </span>
                  ) : null}
                </dd>
                <dt className="text-nw-text-2">Photos / video</dt>
                <dd className="flex flex-wrap gap-2">
                  {bd.fileIds.length === 0 ? 'None' : bd.fileIds.map((f, i) => <FileButton key={f} fileId={f} label={`File ${i + 1}`} />)}
                </dd>
              </dl>
            </Panel>
            <Panel title="History">
              <ol className="flex flex-col gap-2.5" data-testid="breakdown-history">
                {bd.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="text-sm">
                    <span className="font-semibold text-nw-text">{h.kind === 'note' ? 'Note' : BREAKDOWN_STATUS_LABEL[h.status]}</span>
                    <span className="text-nw-text-3"> · {formatDateTime(h.at)} · {h.byName}</span>
                    {h.note ? <span className="block text-nw-text-2">{h.note}</span> : null}
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="Working it">
              <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1.5 text-sm">
                <dt className="text-nw-text-2">Assigned to</dt>
                <dd>{bd.responsible?.name ?? 'Nobody yet'}</dd>
                <dt className="text-nw-text-2">Shop</dt>
                <dd>{bd.vendor?.name ?? 'Not arranged'}</dd>
                <dt className="text-nw-text-2">Estimate</dt>
                <dd>{bd.estimateCents != null ? formatMoney(bd.estimateCents / 100) : '—'}</dd>
                <dt className="text-nw-text-2">Work order</dt>
                <dd>
                  {bd.workOrder ? (
                    <Link to="/fleet/shop/$orderId" params={{ orderId: bd.workOrder.id }} className="inline-flex items-center gap-1 font-semibold text-nw-accent-ink hover:underline">
                      {bd.workOrder.number} · {bd.workOrder.status === 'in_shop' ? 'In shop' : bd.workOrder.status === 'completed' ? 'Completed' : 'Scheduled'} <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : (
                    'None yet'
                  )}
                </dd>
              </dl>
            </Panel>
            {canEdit && bd.status !== 'closed' ? <Actions bd={bd} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-[10px] border border-nw-border-strong bg-nw-panel p-4">
      <h2 className="mb-2 text-base font-bold text-nw-text">{title}</h2>
      {children}
    </section>
  );
}

function FileButton({ fileId, label }: { fileId: string; label: string }) {
  const { toast } = useToast();
  return (
    <Button
      size="sm"
      variant="outline"
      icon={<Paperclip />}
      onClick={() =>
        void apiGet<{ url: string }>(`/files/${encodeURIComponent(fileId)}/link`)
          .then((r) => window.open(r.url, '_blank', 'noopener'))
          .catch(() => toast({ tone: 'danger', title: 'The file could not be opened' }))
      }
    >
      {label}
    </Button>
  );
}

function Actions({ bd }: { bd: FleetBreakdown }) {
  const { toast } = useToast();
  const action = useBreakdownAction(bd.id);
  const people = useBreakdownPeople(true);
  const shops = useBreakdownShops(true);
  const orders = useWorkOrders();
  const [assignee, setAssignee] = useState('');
  const [shop, setShop] = useState(bd.vendor?.id ?? '');
  const [estimate, setEstimate] = useState('');
  const [linkWo, setLinkWo] = useState('');
  const [note, setNote] = useState('');
  const truckId = bd.truck?.id ?? null;
  const trailerId = bd.trailer?.id ?? null;
  const unitOrders = useMemo(() => (orders.data ?? []).filter((o) => (o.unitId === truckId || o.unitId === trailerId) && o.status !== 'completed'), [orders.data, truckId, trailerId]);

  const run = (a: Parameters<typeof action.mutate>[0], done: string) =>
    action.mutate(a, {
      onSuccess: () => {
        toast({ tone: 'success', title: done });
        setNote('');
      },
      onError: (e) => toast({ tone: 'danger', title: e instanceof ApiError && e.status === 409 ? 'Someone changed this case. It has been reloaded.' : 'Not saved', description: e instanceof Error ? e.message : undefined }),
    });
  const inShop = bd.workOrder?.status === 'in_shop';
  const busy = action.isPending;

  return (
    <Panel title="Actions">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap items-end gap-2">
          <Select size="sm" aria-label="Assign to" placeholder={people.isPending ? 'Loading…' : 'Assign to'} value={assignee} onValueChange={setAssignee} className="w-56" options={(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          <Button size="sm" variant="secondary" disabled={!assignee || busy} onClick={() => run({ kind: 'assign', body: { version: bd.version, userId: assignee } }, 'Assigned')}>
            Assign
          </Button>
        </div>
        {bd.status === 'received' || bd.status === 'assigned' || bd.status === 'shop_arranged' ? (
          <div className="flex flex-wrap items-end gap-2">
            <Select size="sm" aria-label="Shop" placeholder={shops.isPending ? 'Loading…' : 'Choose the shop'} value={shop} onValueChange={setShop} className="w-56" options={(shops.data ?? []).map((s) => ({ value: s.id, label: `${s.name}${s.city ? ` · ${s.city}${s.state ? `, ${s.state}` : ''}` : ''}` }))} />
            <Input size="sm" aria-label="Estimate ($)" placeholder="Estimate $" inputMode="decimal" value={estimate} onChange={(e) => setEstimate(e.target.value)} className="w-28" />
            <Button
              size="sm"
              variant="secondary"
              disabled={!shop || busy}
              onClick={() => {
                const dollars = estimate.trim() ? Number(estimate.replace(/[$,]/g, '')) : null;
                run({ kind: 'shop', body: { version: bd.version, vendorId: shop, estimateCents: dollars !== null && Number.isFinite(dollars) ? Math.round(dollars * 100) : null } }, 'Shop arranged');
              }}
            >
              Shop arranged
            </Button>
          </div>
        ) : null}
        {!bd.workOrder ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => run({ kind: 'work-order', body: { version: bd.version, create: { status: 'in_shop' } } }, 'Work order opened; the unit is in the shop')}>
                Open work order · in the shop
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ kind: 'work-order', body: { version: bd.version, create: { status: 'scheduled' } } }, 'Work order booked')}>
                Book the shop (scheduled)
              </Button>
            </div>
            {unitOrders.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <Select size="sm" aria-label="Link an open work order" placeholder="Or link an open work order" value={linkWo} onValueChange={setLinkWo} className="w-64" options={unitOrders.map((o) => ({ value: o.id, label: `${o.number} · ${o.status === 'in_shop' ? 'In shop' : 'Scheduled'}` }))} />
                <Button size="sm" variant="secondary" disabled={!linkWo || busy} onClick={() => run({ kind: 'work-order', body: { version: bd.version, workOrderId: linkWo } }, 'Work order linked')}>
                  Link
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <Textarea aria-label="Note" placeholder="What changed (the driver reads the note on a status change; Add note stays internal)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            {canMoveBreakdown(bd.status, 'in_repair') && bd.status !== 'in_repair' ? (
              <Button size="sm" variant="secondary" disabled={!inShop || busy} title={inShop ? undefined : 'Needs a linked work order with the unit in the shop'} onClick={() => run({ kind: 'status', body: { version: bd.version, status: 'in_repair', note: note.trim() || null } }, 'In repair')}>
                In repair
              </Button>
            ) : null}
            {canMoveBreakdown(bd.status, 'ready') ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => run({ kind: 'status', body: { version: bd.version, status: 'ready', note: note.trim() || null } }, 'Marked ready')}>
                Ready
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ kind: 'status', body: { version: bd.version, status: 'closed', note: note.trim() || null } }, 'Case closed')}>
              Close case
            </Button>
            <Button size="sm" variant="ghost" disabled={!note.trim() || busy} onClick={() => run({ kind: 'note', body: { version: bd.version, note: note.trim() } }, 'Note added')}>
              Add note
            </Button>
          </div>
          <p className="text-xs text-nw-text-3">Closing the case does not complete the work order or put the unit back in service; the shop's record does that.</p>
        </div>
      </div>
    </Panel>
  );
}
