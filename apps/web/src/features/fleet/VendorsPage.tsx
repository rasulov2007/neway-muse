import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Combine, Pencil, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { VENDOR_KIND_LABEL, getVendor, listFleetVendors, retireVendor, type Vendor } from '@/demo';
import {
  Alert,
  BackButton,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  createColumns,
  useToast,
} from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';
import { ordersOf, statsOf, useVendorOrders } from './vendor-orders';
import { NameShopsPanel } from './components/NameShopsPanel';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { VendorFormDialog } from './components/VendorFormDialog';
import { FleetFactList, FleetPanel } from './components/FleetDetailShell';
import { DASH } from './fleet-ui';
import { unitLinkFor } from './unit-link';

/**
 * The vendors the fleet spends with, as records.
 *
 * Every row here is a shop, dealer or tyre truck that a work order names by id — which is what
 * lets the spend dashboard add up "TA Truck Service" without squinting at the spelling.
 */

interface VendorRow extends Vendor {
  workOrders: number;
  spend: number;
  lastUsedAt: string | null;
}

const col = createColumns<VendorRow>();

export function VendorsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const query = useQuery({
    queryKey: ['vendors', 'list'],
    // A vendor merged into another is kept but leaves the list (owner, 2026-10-14).
    queryFn: () => listFleetVendors(true).filter((v) => !v.mergedIntoId),
  });
  const orders = useVendorOrders();
  const all = useMemo<VendorRow[]>(
    () => (query.data ?? []).map((vendor) => ({ ...vendor, ...statsOf(ordersOf(vendor, orders.rows)) })),
    [query.data, orders.rows],
  );
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((v) => [v.name, v.phone ?? '', v.city, v.state, v.street ?? '', VENDOR_KIND_LABEL[v.kind]].join(' ').toLowerCase().includes(needle));
  }, [all, q]);
  const loading = query.isPending || orders.loading;
  const mostVisited = all.reduce<VendorRow | null>((best, v) => (v.workOrders > 0 && (!best || v.workOrders > best.workOrders) ? v : best), null);
  const mostSpend = all.reduce<VendorRow | null>((best, v) => (v.spend > 0 && (!best || v.spend > best.spend) ? v : best), null);

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('name', {
          header: 'Vendor',
          meta: { primary: true },
          cell: ({ row }) => (
            <Link
              to="/fleet/vendors/$vendorId"
              params={{ vendorId: row.original.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.name}
            </Link>
          ),
        }),
        col.accessor('kind', {
          header: 'Type',
          cell: ({ getValue }) => VENDOR_KIND_LABEL[getValue()],
          meta: { width: 130 },
        }),
        col.accessor('phone', {
          header: 'Phone',
          cell: ({ getValue }) => getValue() ?? <span className="text-faint">{DASH}</span>,
          meta: { width: 150 },
        }),
        col.accessor('city', {
          header: 'City',
          cell: ({ row }) =>
            row.original.city
              ? `${row.original.city}${row.original.state ? `, ${row.original.state}` : ''}`
              : <span className="text-faint">{DASH}</span>,
          meta: { width: 160 },
        }),
        col.accessor('workOrders', {
          header: 'Work orders',
          cell: ({ getValue }) => formatNumber(getValue()),
          meta: { align: 'right', width: 110 },
        }),
        col.accessor('spend', {
          header: 'Total spend',
          cell: ({ getValue }) => formatMoney(getValue()),
          meta: { align: 'right', width: 130 },
        }),
        col.accessor('lastUsedAt', {
          header: 'Last used',
          cell: ({ getValue }) => {
            const value = getValue();
            return value ? formatDate(value) : <span className="text-faint">{DASH}</span>;
          },
          meta: { width: 120 },
        }),
        col.accessor('status', {
          header: 'Status',
          cell: ({ getValue }) => <StatusBadge status={getValue()} size="sm" />,
          meta: { width: 100 },
        }),
      ]),
    [],
  );

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Vendors"
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="vendor-headline">
            <span>
              <b className="tabular text-nw-text">{loading ? '…' : formatNumber(all.length)}</b> vendors
            </span>
            <span>
              Most visited:{' '}
              {loading ? '…' : mostVisited ? (
                <Link to="/fleet/vendors/$vendorId" params={{ vendorId: mostVisited.id }} className="font-semibold text-nw-accent-ink hover:underline">
                  {mostVisited.name} · {formatNumber(mostVisited.workOrders)} orders
                </Link>
              ) : (
                DASH
              )}
            </span>
            <span>
              Most spent:{' '}
              {loading ? '…' : mostSpend ? (
                <Link to="/fleet/vendors/$vendorId" params={{ vendorId: mostSpend.id }} className="font-semibold text-nw-accent-ink hover:underline">
                  {mostSpend.name} · {formatMoney(mostSpend.spend)}
                </Link>
              ) : (
                DASH
              )}
            </span>
          </span>
        }
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)}>
            Add vendor
          </Button>
        }
      />
      <NameShopsPanel />
      <Card padding="none">
        <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-3">
          <Input
            size="sm"
            type="search"
            prefix={<Search />}
            aria-label="Search vendors"
            placeholder="Search name, phone, city or type"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-72"
            data-testid="vendor-search"
          />
          {q ? (
            <span className="text-xs text-nw-text-3">
              {formatNumber(rows.length)} of {formatNumber(all.length)}
            </span>
          ) : null}
        </div>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(row) => row.id}
          loading={loading}
          emptyTitle={q ? 'No vendor matches the search' : 'No vendors yet'}
          emptyDescription={q ? 'Clear the search or try part of the name, a phone number or a city.' : "Vendors are created here or from a work order's vendor field."}
          onRowClick={(row) => void navigate({ to: '/fleet/vendors/$vendorId', params: { vendorId: row.id } })}
        />
      </Card>
      {creating ? (
        <VendorFormDialog
          onClose={() => setCreating(false)}
          onSaved={(vendor) => {
            setCreating(false);
            void navigate({ to: '/fleet/vendors/$vendorId', params: { vendorId: vendor.id } });
          }}
        />
      ) : null}
    </div>
  );
}

export function VendorDetailRoute() {
  const { vendorId } = useParams({ from: '/fleet/vendors/$vendorId' });
  return <VendorDetailPage vendorId={vendorId} />;
}

export function VendorDetailPage({ vendorId }: { vendorId: string }) {
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const query = useQuery({
    queryKey: ['vendors', 'detail', vendorId],
    queryFn: () => getVendor(vendorId),
  });
  const all = useVendorOrders();
  if (query.isPending) return null;
  if (!query.data) {
    return (
      <EmptyState
        title="That vendor is not on the list"
        description="It may have been merged, or the link may be out of date."
        action={
          <Button variant="secondary" asChild>
            <Link to="/fleet/vendors">Open vendors</Link>
          </Button>
        }
      />
    );
  }
  const vendor = query.data;
  const orders = ordersOf(vendor, all.rows);
  const stats = statsOf(orders);
  const mergedInto = vendor.mergedIntoId ? getVendor(vendor.mergedIntoId) : null;
  const address = [vendor.street, [vendor.city, vendor.state].filter(Boolean).join(', '), vendor.zip]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/vendors" />}
        title={vendor.name}
        description={`${VENDOR_KIND_LABEL[vendor.kind]}${address ? ` · ${address}` : ''}`}
        meta={<StatusBadge status={vendor.status} size="sm" />}
        actions={
          <span className="flex gap-2">
            {!vendor.mergedIntoId ? (
              <Button variant="secondary" icon={<Combine />} onClick={() => setMerging(true)} data-testid="vendor-merge">
                Merge into…
              </Button>
            ) : null}
            <Button variant="secondary" icon={<Pencil />} onClick={() => setEditing(true)}>
              Edit vendor
            </Button>
          </span>
        }
      />
      {mergedInto ? (
        <Alert tone="info" title="Merged">
          This record was merged into{' '}
          <Link to="/fleet/vendors/$vendorId" params={{ vendorId: mergedInto.id }} className="font-semibold text-nw-accent-ink hover:underline">
            {mergedInto.name}
          </Link>
          . It is kept for the history and hidden from lists.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <FleetPanel title="Vendor record">
          <FleetFactList
            facts={[
              { label: 'Type', value: VENDOR_KIND_LABEL[vendor.kind] },
              { label: 'Phone', value: vendor.phone ?? <span className="text-faint">{DASH}</span> },
              { label: 'Email', value: vendor.email ?? vendor.contactEmail ?? <span className="text-faint">{DASH}</span> },
              { label: 'Website', value: vendor.website ?? <span className="text-faint">{DASH}</span> },
              { label: 'Address', value: address || <span className="text-faint">{DASH}</span> },
              { label: 'Our account number', value: vendor.accountNumber ?? <span className="text-faint">{DASH}</span> },
              { label: 'Payment terms', value: `Net ${vendor.paymentTermsDays}` },
              { label: 'Work orders', value: formatNumber(stats.workOrders) },
              { label: 'Total spend', value: formatMoney(stats.spend) },
              { label: 'Last used', value: stats.lastUsedAt ? formatDate(stats.lastUsedAt) : DASH },
            ]}
          />
          {vendor.notes ? (
            <p className="mt-3 text-xs whitespace-pre-line text-muted">{vendor.notes}</p>
          ) : null}
        </FleetPanel>
        <FleetPanel title="Contacts">
          {(vendor.contacts ?? []).length === 0 ? (
            <p className="text-sm text-muted">No additional contacts recorded.</p>
          ) : (
            <ul className="divide-y divide-line-soft text-sm">
              {(vendor.contacts ?? []).map((contact) => (
                <li key={contact.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium text-ink">{contact.name}</span>
                    {contact.role ? <span className="ml-2 text-xs text-muted">{contact.role}</span> : null}
                  </span>
                  <span className="text-xs text-secondary">
                    {[contact.phone, contact.email].filter(Boolean).join(' · ') || DASH}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </FleetPanel>
      </div>

      <Card title="Work order history" description={`${formatNumber(orders.length)} orders · ${formatMoney(stats.spend)} completed spend`} padding="none">
        {orders.length === 0 ? (
          <div className="p-4">
            <EmptyState size="sm" title="No work orders yet" description="Orders that name this vendor will appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Vendor work orders">
              <thead className="bg-surface-muted text-xs font-semibold text-secondary">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">WO #</th>
                  <th className="px-3 py-2 text-left font-medium">Unit</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Opened</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="px-4 py-2">
                      {order.server ? (
                        <Link to="/fleet/shop/$orderId" params={{ orderId: order.id }} className="font-medium text-primary-text hover:underline">
                          {order.number}
                        </Link>
                      ) : (
                        <Link to="/fleet/maintenance/$orderId" params={{ orderId: order.id }} className="font-medium text-primary-text hover:underline">
                          {order.number}
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        {...unitLinkFor({ unitType: order.unitType, truckId: order.unitType === 'truck' ? order.unitId : '', trailerId: order.unitType === 'trailer' ? order.unitId : null })}
                        className="hover:underline"
                      >
                        {order.unitType === 'trailer' ? `Trailer ${order.unitNumber}` : order.unitNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{order.summary}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={order.status} size="sm" />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(order.openedAt)}</td>
                    <td className="tabular px-4 py-2 text-right">
                      {order.cost !== null ? formatMoney(order.cost) : <Badge tone="neutral" variant="outline" size="sm">{order.status === 'completed' ? DASH : 'open'}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <VendorFormDialog
          vendor={vendor}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}
      {merging ? <MergeVendorDialog vendor={vendor} orders={orders.length} onClose={() => setMerging(false)} /> : null}
    </div>
  );
}

/**
 * One shop entered twice (owner, 2026-10-14): the orders move to the record that stays, and this
 * one is retired - kept, hidden, pointing at it. Nothing is deleted.
 */
function MergeVendorDialog({ vendor, orders, onClose }: { vendor: Vendor; orders: number; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [into, setInto] = useState('');
  const [reason, setReason] = useState('Same shop entered twice');
  const targets = listFleetVendors(true).filter((v) => v.id !== vendor.id && !v.mergedIntoId);
  const target = targets.find((v) => v.id === into) ?? null;
  const merge = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error('Pick the vendor to keep');
      if (isEnabled('fleet_v2'))
        await apiPost('/fleet/work-orders/merge-vendor', { fromVendorId: vendor.id, toVendorId: target.id, toVendorName: target.name, reason: reason.trim() });
      await retireVendor(vendor.id, target.id, reason.trim());
      return target;
    },
    onSuccess: (t) => {
      toast.toast({ tone: 'success', title: `Merged into ${t.name}` });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['fleet'] });
      onClose();
      void navigate({ to: '/fleet/vendors/$vendorId', params: { vendorId: t.id } });
    },
    onError: (e: Error) => toast.toast({ tone: 'danger', title: 'Not merged', description: e.message }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Merge ${vendor.name}`}
      description={`Its ${formatNumber(orders)} work order${orders === 1 ? '' : 's'} move to the vendor you keep. This record is kept for the history and hidden from lists.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Combine />} disabled={!target || reason.trim().length < 3} loading={merge.isPending} onClick={() => merge.mutate()} data-testid="vendor-merge-confirm">
            Merge
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Keep this vendor" required>
          <Select
            aria-label="Keep this vendor"
            value={into}
            placeholder="Pick the vendor to keep…"
            options={targets.map((v) => ({ value: v.id, label: `${v.name}${v.city ? ` · ${v.city}${v.state ? `, ${v.state}` : ''}` : ''}` }))}
            onValueChange={setInto}
          />
        </FormField>
        <FormField label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </FormField>
      </div>
    </Modal>
  );
}
