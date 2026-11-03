import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CheckCircle2, Play, RotateCcw, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Alert,
  BackButton,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  Textarea,
  Timeline,
  useToast,
  type TimelineItem,
} from '@/design-system';
import { updateRepairOrder, workOrderTransitions, type RepairOrderStatus } from '@/demo';
import { CompleteWorkOrderDialog } from './components/CompleteWorkOrderDialog';
import { WorkOrderBillingPanel } from './components/WorkOrderBillingPanel';
import { WorkOrderInvoices } from './components/WorkOrderInvoices';
import { formatDate, formatDateTime, formatMiles, formatMoney } from '@/lib/format';
import {
  FleetFactList,
  FleetMetricStrip,
  FleetPanel,
  type FleetMetric,
} from './components/FleetDetailShell';
import { DASH } from './fleet-ui';

const NO_INVOICE_LABEL: Record<string, string> = {
  warranty: 'warranty work',
  lease_operator: 'lease operator',
  internal_shop: 'internal shop',
  invoice_to_follow: 'invoice to follow',
};
import { unitLinkFor } from './unit-link';
import { useLeaseOperatorTrucks } from './lease-operator';
import { useFleet, useInvalidateFleet } from './useFleet';

const TABS = [
  { value: 'work', label: 'Work' },
  { value: 'costs', label: 'Costs' },
  { value: 'documents', label: 'Documents' },
  { value: 'activity', label: 'Activity' },
];

const PRIORITY_TONE = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
} as const;

/**
 * The work-order workspace — full screen, not a modal.
 *
 * Costs are editable here and nowhere else, because this is the only place a shop invoice is in
 * front of the person typing. The status buttons come from `workOrderTransitions`, the same table
 * the write path enforces.
 */
export function WorkOrderRoute() {
  const { orderId } = useParams({ from: '/fleet/maintenance/$orderId' });
  return <WorkOrderDetailPage orderId={orderId} />;
}

export function WorkOrderDetailPage({ orderId }: { orderId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const fleetQuery = useFleet();
  const [tab, setTab] = useState('work');

  const order = fleetQuery.data?.workOrders.find((o) => o.id === orderId || o.roNumber === orderId);
  const truck =
    order && order.unitType !== 'trailer'
      ? fleetQuery.data?.byTruckId.get(order.truckId)
      : undefined;
  const trailer =
    order && order.unitType === 'trailer' && order.trailerId
      ? fleetQuery.data?.byTrailerId.get(order.trailerId)
      : undefined;

  const [parts, setParts] = useState<string | null>(null);
  const [labor, setLabor] = useState<string | null>(null);
  const [fees, setFees] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      updateRepairOrder({
        id: order?.id ?? '',
        partsTotal: parts === null ? undefined : Number(parts),
        laborTotal: labor === null ? undefined : Number(labor),
        feesTotal: fees === null ? undefined : Number(fees),
        notes: notes === null ? undefined : notes,
      }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That change was refused', description: result.blocked });
        return;
      }
      await invalidate();
      setParts(null);
      setLabor(null);
      setFees(null);
      setNotes(null);
      toast({ tone: 'success', title: `${result.order?.roNumber} saved` });
    },
  });

  const [completing, setCompleting] = useState(false);
  const loTrucks = useLeaseOperatorTrucks();
  const move = useMutation({
    mutationFn: (status: RepairOrderStatus) => updateRepairOrder({ id: order?.id ?? '', status }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That change was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${result.order?.roNumber} moved to ${result.order?.status.replace(/_/g, ' ')}`,
        description:
          result.order?.status === 'in_shop'
            ? result.order.unitType === 'trailer'
              ? `Trailer ${result.order.unitNumber} is marked unavailable and detached from its truck while it is in the shop.`
              : `Unit ${result.order.unitNumber} is out of dispatch while it is in the shop.`
            : undefined,
      });
    },
  });

  const timeline: TimelineItem[] = useMemo(() => {
    if (!order) return [];
    const events: TimelineItem[] = [
      {
        id: 'opened',
        at: order.openedAt,
        title: `${order.roNumber} opened`,
        description: order.summary,
        tone: 'info',
      },
    ];
    if (order.promisedAt) {
      events.push({
        id: 'promised',
        at: order.promisedAt,
        title: 'Promised back',
        description: order.vendorName,
        tone: 'neutral',
      });
    }
    if (order.completedAt) {
      events.push({
        id: 'completed',
        at: order.completedAt,
        title: 'Work completed',
        description: formatMoney(order.total),
        tone: 'success',
      });
    }
    return events.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));
  }, [order]);

  if (fleetQuery.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (fleetQuery.error) {
    return <ErrorState error={fleetQuery.error} onRetry={() => void fleetQuery.refetch()} />;
  }

  if (!order) {
    return (
      <EmptyState
        title="That work order no longer exists"
        description="It may have been cancelled, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/fleet/maintenance' })}>
            Back to maintenance
          </Button>
        }
      />
    );
  }

  const metrics: FleetMetric[] = [
    { label: 'Unit', value: order.unitNumber },
    { label: 'Opened', value: formatDate(order.openedAt) },
    {
      label: 'Promised',
      value: order.promisedAt ? formatDate(order.promisedAt) : null,
      title: 'No return date was agreed with the shop.',
    },
    {
      label: 'Downtime',
      value: order.downtimeMinutes > 0 ? `${Math.round(order.downtimeMinutes / 60)} h` : null,
      title: 'Downtime is measured once the unit leaves the shop.',
    },
    {
      label: 'Total cost',
      value: order.total > 0 ? formatMoney(order.total) : null,
      title: 'Costs are recorded when the shop invoices.',
    },
  ];

  const allowed = workOrderTransitions(order.status);
  const dirty = parts !== null || labor !== null || fees !== null || notes !== null;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/maintenance" />}
        title={order.roNumber}
        description={order.summary}
        actions={
          <>
            {allowed.includes('in_shop') ? (
              <Button variant="secondary" icon={<Play />} onClick={() => move.mutate('in_shop')}>
                {order.status === 'completed' ? 'Reopen work' : 'Start work'}
              </Button>
            ) : null}
            {allowed.includes('completed') ? (
              <Button variant="primary" icon={<CheckCircle2 />} onClick={() => setCompleting(true)}>
                Complete
              </Button>
            ) : null}
            {order.status === 'completed' && allowed.includes('in_shop') ? null : allowed.includes(
                'open',
              ) ? (
              <Button variant="secondary" icon={<RotateCcw />} onClick={() => move.mutate('open')}>
                Reopen
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={order.status} />
        <Badge tone={PRIORITY_TONE[order.priority]}>
          {order.priority[0]?.toUpperCase() + order.priority.slice(1)} priority
        </Badge>
        {order.warranty ? <Badge tone="info">Warranty</Badge> : null}
        <Link {...unitLinkFor(order)} className="text-sm text-primary-text hover:underline">
          {order.unitType === 'trailer' ? 'Trailer' : 'Unit'} {order.unitNumber}
        </Link>
      </div>

      <FleetMetricStrip metrics={metrics} />

      {/* Completed work with no invoice is unfinished business, and the page says so where the
          person is rather than only on the documents tab. */}
      {order.status === 'completed' && (order.invoices ?? []).length === 0 && !(order.unitType !== 'trailer' && loTrucks.has(order.truckId)) ? (
        <Alert
          tone="warning"
          title="Waiting on the shop's invoice"
          description={
            order.awaitingInvoice
              ? `Completed without an invoice (${NO_INVOICE_LABEL[order.awaitingInvoice.reason]}: ${order.awaitingInvoice.note}). ${formatMoney(order.total)} is still the estimate; attach the invoice on the Documents tab when it arrives.`
              : `${formatMoney(order.total)} on this order is still the estimate. Attach the invoice on the Documents tab as soon as it arrives.`
          }
        />
      ) : null}
      {completing ? (
        <CompleteWorkOrderDialog order={order} invoiceOptional={order.unitType !== 'trailer' && loTrucks.has(order.truckId)} onClose={() => setCompleting(false)} />
      ) : null}

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Work order">
        <TabsContent value="work" className="pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <FleetPanel title="Issue">
              <FleetFactList
                facts={[
                  { label: 'Type', value: order.type.replace(/_/g, ' ') },
                  { label: 'Reported', value: order.summary },
                  {
                    label: 'Odometer at open',
                    value: formatMiles(order.odometer),
                  },
                  {
                    label: 'Unit',
                    value: (
                      <Link {...unitLinkFor(order)} className="text-primary-text hover:underline">
                        {order.unitType === 'trailer'
                          ? `Trailer ${order.unitNumber}`
                          : order.unitNumber}
                      </Link>
                    ),
                  },
                  {
                    label: 'Driver at open',
                    value: truck?.truck.currentDriverName ?? trailer?.truck?.currentDriverName ?? (
                      <span className="text-faint">{DASH}</span>
                    ),
                  },
                ]}
              />
            </FleetPanel>

            <FleetPanel title="Shop">
              <FleetFactList
                facts={[
                  {
                    label: 'Vendor',
                    value: order.vendorId ? (
                      <Link
                        to="/fleet/vendors/$vendorId"
                        params={{ vendorId: order.vendorId }}
                        className="text-primary-text hover:underline"
                      >
                        {order.vendorName}
                      </Link>
                    ) : (
                      order.vendorName || <span className="text-faint">{DASH}</span>
                    ),
                  },
                  {
                    label: 'Technician',
                    value: order.technician || <span className="text-faint">{DASH}</span>,
                  },
                  {
                    label: 'Promised back',
                    value: order.promisedAt ? (
                      formatDateTime(order.promisedAt)
                    ) : (
                      <span className="text-faint">Not agreed</span>
                    ),
                  },
                  {
                    label: 'Completed',
                    value: order.completedAt ? (
                      formatDateTime(order.completedAt)
                    ) : (
                      <span className="text-faint">Not yet</span>
                    ),
                  },
                ]}
              />
            </FleetPanel>
          </div>

          <Card className="mt-4 p-4">
            <FormField
              label="Notes"
              description="Diagnosis, parts ordered, anything the next person needs."
            >
              <Textarea
                rows={4}
                value={notes ?? order.notes ?? ''}
                onChange={(e) => setNotes(e.target.value)}
              />
            </FormField>
          </Card>
        </TabsContent>

        <TabsContent value="costs" className="pt-4">
          <FleetPanel title="Bill to" className="mb-4">
            <WorkOrderBillingPanel order={order} />
          </FleetPanel>
          <Card className="flex flex-col gap-4 p-4">
            <p className="text-sm text-muted">
              Enter what the shop invoiced. A work order opens at zero rather than at an estimate,
              so anything shown here is a figure someone actually recorded.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Parts">
                <Input
                  inputMode="decimal"
                  value={parts ?? String(order.partsTotal)}
                  onChange={(e) => setParts(e.target.value)}
                />
              </FormField>
              <FormField label="Labour">
                <Input
                  inputMode="decimal"
                  value={labor ?? String(order.laborTotal)}
                  onChange={(e) => setLabor(e.target.value)}
                />
              </FormField>
              <FormField label="Fees">
                <Input
                  inputMode="decimal"
                  value={fees ?? String(order.feesTotal)}
                  onChange={(e) => setFees(e.target.value)}
                />
              </FormField>
            </div>
            <p className="text-sm text-secondary">
              Total{' '}
              <span className="font-semibold text-ink">
                {formatMoney(
                  Number(parts ?? order.partsTotal) +
                    Number(labor ?? order.laborTotal) +
                    Number(fees ?? order.feesTotal),
                )}
              </span>
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <WorkOrderInvoices order={order} />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <Card className="p-4">
            <Timeline items={timeline} />
          </Card>
        </TabsContent>
      </Tabs>

      {dirty ? (
        <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-lg border border-line-strong bg-surface-raised px-4 py-3 shadow-menu">
          <span className="text-sm text-muted">Unsaved changes on this work order.</span>
          <Button
            variant="secondary"
            onClick={() => {
              setParts(null);
              setLabor(null);
              setFees(null);
              setNotes(null);
            }}
          >
            Discard
          </Button>
          <Button icon={<Save />} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
