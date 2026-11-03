import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Scale } from 'lucide-react';
import { useMemo, useState } from 'react';
import { INVESTIGATION_OVERDUE_DAYS, type InvestigationItem, type InvestigationQuery } from '@neway/shared';
import { Alert, Button, Card, Combobox, FormField, Modal, StatusSymbol, Textarea, cn, useToast } from '@/design-system';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { money } from './expense-format';
import { useInvestigations } from './investigations-api';

/**
 * Under investigation (owner, 2026-10-13): repairs and expenses nobody has decided who bears yet.
 * Costs, the unit and the driver read the same list from the server; a fleet manager or Safety
 * settles each one as Company or Driver, with a reason, and the decision is audited.
 */

const enc = encodeURIComponent;

interface ResolveBody {
  item: InvestigationItem;
  to: 'company' | 'driver';
  driverId: string | null;
  driverInformed: boolean | null;
  reason: string;
}

function useResolveInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ item, to, driverId, driverInformed, reason }: ResolveBody) =>
      item.kind === 'work_order'
        ? // A repair is settled through its own Who pays, so its history stays in one place.
          apiPost(`/fleet/work-orders/${enc(item.id)}/charge`, {
            party: to,
            driverId: to === 'driver' ? driverId : null,
            driverInformed: to === 'driver' ? driverInformed : null,
            note: `Investigation settled: ${reason}`.slice(0, 500),
          })
        : apiPost(`/fleet/expenses/${enc(item.id)}/resolve-investigation`, {
            to,
            driverId: to === 'driver' ? driverId : null,
            reason,
            expectedVersion: item.version,
          }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fleet'] }),
        queryClient.invalidateQueries({ queryKey: ['work-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
    },
  });
}

/** Days under investigation, as symbol + word: overdue past the limit. */
export function InvestigationAge({ item }: { item: InvestigationItem }) {
  return item.overdue ? (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-nw-urgent-text">
      <StatusSymbol family="urgent" size={10} className="text-nw-urgent-icon" />
      Overdue · {item.days} days
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-nw-warning-text">
      <StatusSymbol family="warning" size={10} className="text-nw-warning-icon" />
      {item.days === 0 ? 'Today' : `${item.days} ${item.days === 1 ? 'day' : 'days'}`}
    </span>
  );
}

/**
 * The list, as a card: every item with its unit, driver, amount and age, and Settle for those
 * who may decide. `hideUnit` / `hideDriver` drop what the page already says.
 */
export function InvestigationPanel({
  query,
  title = 'Under investigation',
  hideUnit = false,
  hideDriver = false,
  emptyHidden = false,
  className,
}: {
  query: InvestigationQuery;
  title?: string;
  hideUnit?: boolean;
  hideDriver?: boolean;
  /** Render nothing when nothing is under investigation (unit and driver pages). */
  emptyHidden?: boolean;
  className?: string;
}) {
  const list = useInvestigations(query);
  const [settling, setSettling] = useState<InvestigationItem | null>(null);
  const data = list.data;
  if (emptyHidden && (!data || data.items.length === 0)) return null;
  return (
    <Card padding="none" className={cn('flex flex-col overflow-hidden', className)} data-testid="investigation-panel">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-nw-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-nw-text">
          <StatusSymbol family="warning" size={12} className="text-nw-warning-icon" />
          {title}
        </h2>
        {data ? (
          <span className="text-xs text-nw-text-3">
            {data.items.length} {data.items.length === 1 ? 'item' : 'items'} · {money(data.totalCents)}
            {data.overdueCount > 0 ? ` · ${data.overdueCount} over ${INVESTIGATION_OVERDUE_DAYS} days` : ''} · nothing deducted until settled
          </span>
        ) : null}
      </div>
      {list.isError ? (
        <p className="px-4 py-6 text-sm text-nw-urgent-text">{list.error instanceof Error ? list.error.message : 'Could not load.'}</p>
      ) : !data ? (
        <p className="px-4 py-8 text-center text-sm text-nw-text-3">Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-nw-text-3">Nothing is under investigation.</p>
      ) : (
        <ul className="max-h-[440px] divide-y divide-nw-border overflow-y-auto">
          {data.items.map((i) => (
            <li key={`${i.kind}:${i.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="investigation-item">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 text-[13px] font-bold text-nw-text">
                  {i.kind === 'work_order' ? (
                    <Link to="/fleet/shop/$orderId" params={{ orderId: i.id }} className="text-nw-accent-ink hover:underline">
                      {i.reference}
                    </Link>
                  ) : (
                    <span>{i.reference}</span>
                  )}
                  {hideUnit ? null : (
                    <span className="font-semibold text-nw-text-2">
                      {i.unitKind === 'trailer' ? 'Trailer' : 'Unit'} {i.unitNumber}
                    </span>
                  )}
                  {hideDriver || !i.driverName ? null : <span className="font-semibold text-nw-text-2">· {i.driverName}</span>}
                  {i.open ? <span className="text-[11.5px] font-semibold text-nw-text-3">· still open (estimate)</span> : null}
                </span>
                <span className="block truncate text-xs text-nw-text-3">
                  {formatIsoDate(i.date)}
                  {i.description ? ` · ${i.description}` : ''}
                </span>
              </span>
              <InvestigationAge item={i} />
              <span className="tabular w-24 text-right text-sm font-bold text-nw-text">{money(i.amountCents)}</span>
              {data.canResolve ? (
                <Button size="sm" variant="outline" icon={<Scale />} onClick={() => setSettling(i)} data-testid="investigation-settle">
                  Settle
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {settling ? <SettleInvestigationDialog item={settling} onClose={() => setSettling(null)} /> : null}
    </Card>
  );
}

interface DriverOption {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
}

/** Company or Driver, with what the investigation found; a repair's driver charge also asks whether the driver was told. */
export function SettleInvestigationDialog({ item, onClose }: { item: InvestigationItem; onClose: () => void }) {
  const { toast } = useToast();
  const resolve = useResolveInvestigation();
  const [to, setTo] = useState<'company' | 'driver' | null>(null);
  const [driverId, setDriverId] = useState<string | null>(item.driverId);
  const [informed, setInformed] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const drivers = useQuery({
    queryKey: ['drivers', 'options'],
    queryFn: () => apiGet<{ data: DriverOption[] }>('/drivers', { pageSize: 10_000 }),
    enabled: to === 'driver',
    staleTime: 60_000,
  });
  const options = useMemo(() => {
    const rows = (drivers.data?.data ?? []).map((d) => ({ value: d.id, label: d.name || `${d.firstName} ${d.lastName}`.trim() }));
    if (item.driverId && item.driverName && !rows.some((r) => r.value === item.driverId)) rows.push({ value: item.driverId, label: item.driverName });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [drivers.data, item.driverId, item.driverName]);
  const ready =
    to !== null && reason.trim().length >= 3 && (to === 'company' || (driverId !== null && (item.kind === 'fleet_expense' || informed !== null)));
  const segment = (active: boolean) =>
    active
      ? 'inline-flex h-9 items-center rounded-md border border-nw-accent bg-nw-accent-tint px-3 text-sm font-semibold text-nw-accent-ink'
      : 'inline-flex h-9 items-center rounded-md border border-nw-border bg-nw-panel px-3 text-sm text-nw-text-2 hover:bg-nw-hover';
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Settle ${item.reference}`}
      description={`${item.unitKind === 'trailer' ? 'Trailer' : 'Unit'} ${item.unitNumber} · ${money(item.amountCents)} · under investigation ${item.days} ${item.days === 1 ? 'day' : 'days'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={resolve.isPending}
            data-testid="investigation-confirm"
            onClick={() =>
              to &&
              resolve.mutate(
                { item, to, driverId, driverInformed: informed, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: to === 'company' ? `${item.reference}: the company bears it` : `${item.reference}: charged to the driver` });
                    onClose();
                  },
                },
              )
            }
          >
            Settle
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {resolve.error ? <Alert tone="danger" title="Not settled" description={resolve.error instanceof ApiError ? resolve.error.message : 'Try again.'} /> : null}
        <FormField label="Who bears it" required>
          <div role="radiogroup" aria-label="Who bears it" className="flex flex-wrap gap-2">
            <button type="button" role="radio" aria-checked={to === 'company'} onClick={() => setTo('company')} className={segment(to === 'company')} data-testid="settle-company">
              Company
            </button>
            <button type="button" role="radio" aria-checked={to === 'driver'} onClick={() => setTo('driver')} className={segment(to === 'driver')} data-testid="settle-driver">
              Driver
            </button>
          </div>
        </FormField>
        {to === 'driver' ? (
          <>
            <FormField label="Driver charged" required>
              <Combobox options={options} value={driverId} onValueChange={(v) => setDriverId(v ?? null)} placeholder={drivers.isPending ? 'Loading…' : 'Choose the driver'} searchPlaceholder="Driver name…" />
            </FormField>
            {item.kind === 'work_order' ? (
              <FormField label="Has the driver been told?" required description="Told: accounting deducts it. Not told: it is held until somebody tells them.">
                <div role="radiogroup" aria-label="Driver informed" className="flex flex-wrap gap-2">
                  <button type="button" role="radio" aria-checked={informed === true} onClick={() => setInformed(true)} className={segment(informed === true)}>
                    Driver informed
                  </button>
                  <button type="button" role="radio" aria-checked={informed === false} onClick={() => setInformed(false)} className={segment(informed === false)}>
                    Not informed yet
                  </button>
                </div>
              </FormField>
            ) : (
              <p className="text-xs text-nw-text-3">Accounting then posts it and approves the deduction against settlements, as with any driver charge.</p>
            )}
          </>
        ) : null}
        <FormField label="What the investigation found" required>
          <Textarea rows={3} value={reason} maxLength={480} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Camera shows the driver backed into the post" />
        </FormField>
      </div>
    </Modal>
  );
}
