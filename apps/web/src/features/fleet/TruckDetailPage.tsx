import { loadStatusLabel } from '@/features/loads/loads-search';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Award,
  Ban,
  Calendar,
  CalendarClock,
  ChartColumn,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Coins,
  CreditCard,
  Droplet,
  EllipsisVertical,
  FileText,
  Fuel,
  Gauge,
  IdCard,
  Info,
  MapPin,
  Package,
  Radio,
  Receipt,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  StickyNote,
  Truck,
  Upload,
  User,
  Wrench,
} from 'lucide-react';
import { TruckConditionList } from './components/PtiConditionPanels';
import { InvestigationPanel } from './expenses/investigations';
import { usePmUnit } from './pm/api';
import { OilIntervalDialog } from './pm/OilIntervalDialog';
import { useMemo, useRef, useState } from 'react';
import {
  useToast,
  Alert,
  Textarea,
  Badge,
  BackButton,
  Button,
  Card,
  DataTable,
  DropdownMenu,
  EmptyState,
  FormField,
  IconButton,
  Input,
  ErrorState,
  MenuItem,
  PageHeader,
  SectionCard,
  Select,
  Skeleton,
  StatTile,
  StatusBadge,
  Tabs,
  TabsContent,
  Timeline,
  cn,
  createColumns,
  type TimelineItem,
} from '@/design-system';
import { actionsFor } from '@neway/shared';
import { EditVendorPercentDialog, EndVendorDialog, MoveToVendorDialog } from './components/TruckVendorDialog';
import {
  demoCurrentUser,
  listTruckNotes,
  addTruckNote,
  attachWorkOrderInvoice,
  maintenanceTypeLabel,
  type RepairOrder,
  type TruckNote,
} from '@/demo';
import { formatBytes } from '@/features/loads/loadUtils';
import { DocumentViewer } from '@/features/documents';
import { uploadFile } from '@/lib/files';
import { FleetPositionMap } from '@/features/operations/FleetPositionMap';
import {
  formatDate,
  formatDateTime,
  formatIsoDate,
  formatMiles,
  formatMoney,
  formatNumber,
  formatRelative,
} from '@/lib/format';
import { FleetFactList, FleetInfoBar, FleetScheduledNotice } from './components/FleetDetailShell';
import { ScheduleServiceDialog } from './components/ScheduleServiceDialog';
import { UnitExitNotice } from './components/UnitExitNotice';
import { UnitStatusDialog } from './components/UnitStatusDialog';
import { UnitStatusCell } from './components/UnitStatusCell';
import { ArchiveTruckDialog } from './components/ArchiveTruckDialog';
import { useAccount } from '@/features/auth/auth-context';
import {
  AVAILABILITY_LABEL,
  AVAILABILITY_TONE,
  DASH,
  MAINTENANCE_LABEL,
  MAINTENANCE_TONE,
  TRUCK_TABS,
  type TruckTab,
} from './fleet-ui';
import { CreateWorkOrderDialog } from './components/CreateWorkOrderDialog';
import { UnitDocumentChip } from './components/UnitDocumentChip';
import { UnitDocumentsTab } from './components/UnitDocumentsTab';
import { TruckHistoryTab } from './TruckHistoryTab';
import { TruckExpensesTab } from './expenses/TruckExpensesTab';
import { useFleet, useInvalidateFleet, type FleetTruck } from './useFleet';
import { useUnitWorkOrders, type UnitWorkOrderRow } from './unit-work-orders';
import { AssignDriverPanel } from './components/AssignDriverPanel';
import { hasUnitDocumentIssue } from './unit-documents';
import { MissingDetails } from './components/MissingDetails';
import { unitHeaderLine, unitIdentity } from './unit-header';
import { isEnabled } from '@/lib/feature-flags';
import { useUnitServiceStatus } from './pti/api';
import { OpenDefectsCard } from './pti/OpenDefectsCard';
import { TruckPtiIssueBadge } from './pti/PtiIssueBadge';
import { headerVerdict } from './pti/unit-verdict';
import { UnitVerdictBadge, UnitVerdictLine } from './pti/UnitVerdict';

const TAB_LABEL: Record<TruckTab, string> = {
  overview: 'Overview',
  driver: 'Driver',
  load: 'Load',
  tracking: 'Tracking',
  maintenance: 'Maintenance',
  expenses: 'Expenses',
  history: 'History',
  documents: 'Documents',
  performance: 'Performance',
  notes: 'Notes',
  activity: 'Activity',
};

const TABS = TRUCK_TABS.map((value) => ({ value, label: TAB_LABEL[value] }));

function isTruckTab(value: unknown): value is TruckTab {
  return typeof value === 'string' && (TRUCK_TABS as readonly string[]).includes(value);
}

/** The breadcrumb's links go through the router so they behave like every other link here. */

/**
 * Truck 360 — a full page, not a modal.
 *
 * A unit's whole history does not fit in a drawer, and a drawer cannot be linked to, printed or
 * left open beside a load. Every tab reads the same `useFleet` bundle the list reads, so the unit
 * never says one thing here and another in the list.
 */
export function TruckDetailRoute() {
  const { truckId } = useParams({ from: '/fleet/trucks/$truckId' });
  return <TruckDetailPage truckId={truckId} />;
}

export function TruckDetailPage({ truckId }: { truckId: string }) {
  const navigate = useNavigate();
  const fleetQuery = useFleet();
  /*
   * The section lives in the URL, not in this component. A unit's history sends people out to an
   * accident and the browser's Back button has to bring them to the section they left, not to the
   * top of the page.
   */
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const tab: TruckTab = isTruckTab(search.tab) ? search.tab : 'overview';
  function setTab(next: string) {
    if (!isTruckTab(next)) return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, tab: next }),
      replace: true,
      resetScroll: false,
    });
  }
  const [scheduling, setScheduling] = useState(false);
  const [creatingWorkOrder, setCreatingWorkOrder] = useState(false);
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [archiveMode, setArchiveMode] = useState<'archive' | 'restore' | null>(null);
  const [vendorMode, setVendorMode] = useState<'move' | 'end' | 'percent' | null>(null);
  const account = useAccount();
  const canEditTrucks =
    account !== null && (account.isOwner || account.permissions.includes('trucks.edit'));

  const row = fleetQuery.data?.byTruckId.get(truckId) ?? fleetQuery.data?.byUnitNumber.get(truckId);
  // The defect-derived verdict (§4.2), from the server. Behind fleet_v2 with the routes it reads.
  const fleetV2 = isEnabled('fleet_v2');
  const serviceStatus = useUnitServiceStatus(fleetV2 ? (row?.truck.id ?? null) : null);

  if (fleetQuery.isPending) {
    return (
      <div className="flex flex-col gap-(--section-gap)">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (fleetQuery.error) {
    return <ErrorState error={fleetQuery.error} onRetry={() => void fleetQuery.refetch()} />;
  }

  if (!row) {
    return (
      <EmptyState
        title="That unit is not in the fleet"
        description="It may have been sold, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/fleet/trucks' })}>Back to trucks</Button>
        }
      />
    );
  }

  const { truck, availability, service } = row;
  /** The booked PM row, when one exists. Drives the green confirmation under the header. */
  const booking = row.schedule.find((item) => item.scheduledFor) ?? null;
  // The actions come from the lifecycle table, so this menu can never offer a move the unit's
  // current status does not allow.
  const statusActions = actionsFor('truck', truck.status).filter(
    (action) => action.kind === 'status',
  );
  // Archived (owner, 2026-10-05): the unit is off every list; its page stays reachable for history
  // and for Restore.
  const archived = truck.status === 'archived';
  /*
   * The availability pill sits beside the title. The stored status is only repeated when it says
   * something the pill does not (an active unit that reads "Available" needs no second pill), and
   * the paperwork chip only when there is paperwork to worry about.
   */
  // Missing paperwork counts as an issue: a unit with nothing on file is held the same way
  // one with an expired document is, and the chip has to be able to say so.
  const hasDocumentIssue = hasUnitDocumentIssue(row.documents);
  const showStoredStatus = !fleetV2 && truck.status !== 'active';
  /*
   * With fleet_v2 the three pills become one verdict (§4.2): an open defect outranks the shop,
   * the shop outranks the load, and the line under the title says why and what releases it. The
   * stored status and the availability reasons are folded into that line rather than shown
   * beside it, which is how "Available" and "In maintenance" used to sit on one truck.
   */
  const verdict = fleetV2
    ? headerVerdict({ service: serviceStatus.data?.verdict, availability })
    : null;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/trucks" />}
        title={`Unit ${truck.unitNumber}`}
        meta={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {/* Off the road (owner, 2026-10-10): the status says why, in colour, and changes from here. */}
            {['inactive', 'out_of_service', 'sold'].includes(truck.status) ? (
              <UnitStatusCell
                entity="truck"
                id={truck.id}
                unitNumber={truck.unitNumber}
                status={truck.status}
                tone={AVAILABILITY_TONE[availability.availability]}
                label={AVAILABILITY_LABEL[availability.availability]}
              />
            ) : verdict ? (
              <UnitVerdictBadge verdict={verdict} />
            ) : (
              <Badge tone={AVAILABILITY_TONE[availability.availability]} dot>
                {AVAILABILITY_LABEL[availability.availability]}
              </Badge>
            )}
            {/* The same PTI sign the Trucks list carries (owner, 2026-10-21); opens Maintenance. */}
            <TruckPtiIssueBadge truckId={truck.id} />
            {/* A vendor's own truck (owner, 2026-10-28): whose it is and what the company keeps. */}
            {truck.vendor ? (
              <Badge tone="info" title={`Company keeps ${truck.vendor.companyPercent}% of gross since ${truck.vendor.since}`}>
                Vendor · {truck.vendor.vendorName} · {truck.vendor.companyPercent}%
              </Badge>
            ) : null}
          </span>
        }
        description={
          unitHeaderLine([truck.year, truck.make, truck.model], truck.vin) || undefined
        }
        actions={
          <>
            {archived ? null : (
              <>
                <Button
                  variant="primary"
                  icon={<Wrench />}
                  onClick={() => setCreatingWorkOrder(true)}
                >
                  Create repair
                </Button>
                <Button
                  variant="secondary"
                  icon={<CalendarClock />}
                  onClick={() => setScheduling(true)}
                >
                  Schedule maintenance
                </Button>
              </>
            )}
            {statusActions.length > 0 || canEditTrucks ? (
              <DropdownMenu
                trigger={
                  <IconButton label="More actions" variant="secondary">
                    <EllipsisVertical />
                  </IconButton>
                }
              >
                {statusActions.map((action) => (
                  <MenuItem
                    key={action.key}
                    icon={action.destructive ? <Ban /> : <RotateCcw />}
                    destructive={action.destructive}
                    onSelect={() => setStatusAction(action.key)}
                  >
                    {action.label}
                  </MenuItem>
                ))}
                {canEditTrucks && !archived ? (
                  truck.vendor ? (
                    <>
                      <MenuItem icon={<RotateCcw />} onSelect={() => setVendorMode('percent')}>
                        Edit percentage
                      </MenuItem>
                      <MenuItem icon={<RotateCcw />} onSelect={() => setVendorMode('end')}>
                        Move back to company
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem icon={<RotateCcw />} onSelect={() => setVendorMode('move')}>
                      Move to vendor
                    </MenuItem>
                  )
                ) : null}
                {canEditTrucks ? (
                  archived ? (
                    <MenuItem icon={<ArchiveRestore />} onSelect={() => setArchiveMode('restore')}>
                      Restore truck
                    </MenuItem>
                  ) : (
                    <MenuItem
                      icon={<Archive />}
                      destructive
                      onSelect={() => setArchiveMode('archive')}
                    >
                      Archive truck
                    </MenuItem>
                  )
                ) : null}
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {archived ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status="archived" />
          <span className="text-sm text-muted">
            Archived: hidden from every truck list, picker and count. Its history is kept below.
          </span>
          {canEditTrucks ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<ArchiveRestore />}
              onClick={() => setArchiveMode('restore')}
            >
              Restore
            </Button>
          ) : null}
        </div>
      ) : null}

      {verdict ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <UnitDocumentChip issues={row.documents} onOpen={() => setTab('documents')} />
          <UnitVerdictLine verdict={verdict} />
        </div>
      ) : showStoredStatus || hasDocumentIssue || availability.reasons.length > 0 ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          {showStoredStatus ? <StatusBadge status={truck.status} /> : null}
          <UnitDocumentChip issues={row.documents} onOpen={() => setTab('documents')} />
          <span className="text-sm text-muted">{availability.reasons.join('. ')}</span>
        </div>
      ) : null}

      <UnitExitNotice unitId={truck.id} />
      <MissingDetails truck={truck} />

      {booking ? (
        // Shown whenever a booking exists, including on a unit that is already overdue: a booked
        // repair does not un-overdue a truck, so the two facts sit beside each other rather than
        // one hiding the other.
        <FleetScheduledNotice>
          Next service scheduled — {maintenanceTypeLabel(booking.type).toLowerCase()} on{' '}
          {formatIsoDate(booking.scheduledFor as string)}
          {service.milesRemaining !== null && service.milesRemaining > 0
            ? `, ${formatMiles(service.milesRemaining)} remaining`
            : ''}
        </FleetScheduledNotice>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          size="lg"
          icon={<Gauge />}
          label="Odometer"
          value={formatMiles(truck.odometer)}
          hint={`As of ${formatDate(truck.odometerAt)}`}
        />
        <NextServiceCard row={row} />
        <OperatingMetricsCard row={row} />
      </div>

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Unit detail">
        <TabsContent value="overview" className="pt-4">
          <OverviewTab
            row={row}
            held={verdict !== null && verdict.status !== 'cleared' && verdict.status !== 'loading'}
          />
        </TabsContent>
        <TabsContent value="driver" className="pt-4">
          <DriverTab row={row} />
        </TabsContent>
        <TabsContent value="load" className="pt-4">
          <LoadTab row={row} />
        </TabsContent>
        <TabsContent value="tracking" className="pt-4">
          <TrackingTab row={row} />
        </TabsContent>
        <TabsContent value="notes" className="pt-4">
          <TruckNotesTab truckId={truck.id} unitNumber={truck.unitNumber} />
        </TabsContent>
        <TabsContent value="maintenance" className="flex flex-col gap-4 pt-4">
          {/* Repairs and expenses on this truck nobody has decided who pays for yet (owner, 2026-10-13). */}
          <InvestigationPanel query={{ unitId: row.truck.id }} hideUnit emptyHidden />
          <MaintenanceTab
            row={row}
            onSchedule={() => setScheduling(true)}
            onCreateWorkOrder={() => setCreatingWorkOrder(true)}
          />
        </TabsContent>
        <TabsContent value="history" className="pt-4">
          <TruckHistoryTab
            truckId={truck.id}
            unitNumber={truck.unitNumber}
            repairs={row.allWorkOrders}
          />
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <UnitDocumentsTab
            ownerType="truck"
            ownerId={truck.id}
            ownerLabel={`Unit ${truck.unitNumber}`}
          />
        </TabsContent>
        <TabsContent value="expenses" className="pt-4">
          <TruckExpensesTab truckId={truck.id} unitNumber={truck.unitNumber}>
            <RunningCosts row={row} />
          </TruckExpensesTab>
        </TabsContent>
        <TabsContent value="performance" className="pt-4">
          <PerformanceTab row={row} />
        </TabsContent>
        <TabsContent value="activity" className="pt-4">
          <ActivityTab row={row} />
        </TabsContent>
      </Tabs>

      <CreateWorkOrderDialog
        open={creatingWorkOrder}
        onOpenChange={setCreatingWorkOrder}
        trucks={[row]}
        defaultTruckId={truck.id}
        onDone={() => setCreatingWorkOrder(false)}
      />

      <ScheduleServiceDialog
        open={scheduling}
        onOpenChange={setScheduling}
        truck={row}
        onDone={() => setScheduling(false)}
      />

      <ArchiveTruckDialog
        mode={archiveMode}
        truckId={truck.id}
        unitNumber={truck.unitNumber}
        updatedAt={truck.updatedAt}
        onClose={() => setArchiveMode(null)}
      />

      <MoveToVendorDialog
        open={vendorMode === 'move'}
        truckId={truck.id}
        unitNumber={truck.unitNumber}
        updatedAt={truck.updatedAt}
        driverId={truck.currentDriverId ?? null}
        driverName={truck.currentDriverName ?? null}
        onClose={() => setVendorMode(null)}
      />
      {truck.vendor ? (
        <EditVendorPercentDialog
          open={vendorMode === 'percent'}
          truckId={truck.id}
          unitNumber={truck.unitNumber}
          vendorName={truck.vendor.vendorName}
          currentPercent={truck.vendor.companyPercent}
          updatedAt={truck.updatedAt}
          onClose={() => setVendorMode(null)}
        />
      ) : null}
      {truck.vendor ? (
        <EndVendorDialog
          open={vendorMode === 'end'}
          truckId={truck.id}
          unitNumber={truck.unitNumber}
          vendorName={truck.vendor.vendorName}
          updatedAt={truck.updatedAt}
          onClose={() => setVendorMode(null)}
        />
      ) : null}

      <UnitStatusDialog
        entity="truck"
        id={truck.id}
        status={truck.status}
        label={`Unit ${truck.unitNumber}`}
        actionKey={statusAction}
        onOpenChange={(open) => {
          if (!open) setStatusAction(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Metric strip
// ---------------------------------------------------------------------------------------------

const SERVICE_CARD: Record<(typeof MAINTENANCE_TONE)[keyof typeof MAINTENANCE_TONE], string> = {
  success: 'border-success-border bg-success-soft/40',
  warning: 'border-warning-border bg-warning-soft/40',
  danger: 'border-danger-border bg-danger-soft/40',
  info: 'border-info-border bg-info-soft/40',
  neutral: 'border-line-soft bg-surface',
  violet: 'border-violet-border bg-violet-soft/40',
};

const SERVICE_TILE: Record<(typeof MAINTENANCE_TONE)[keyof typeof MAINTENANCE_TONE], string> = {
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  neutral: 'bg-neutral-soft text-neutral-text',
  violet: 'bg-violet-soft text-violet-text',
};

/**
 * How far the next service is, in whichever units the schedule knows. Miles and days are each
 * shown only when the engine could compute them; a unit with no interval says so rather than
 * showing a reassuring blank.
 */
function NextServiceCard({ row }: { row: FleetTruck }) {
  const { service } = row;
  const tone = MAINTENANCE_TONE[service.urgency];
  const miles = service.milesRemaining;
  const days = service.daysRemaining;
  const good = service.urgency === 'ok' || service.urgency === 'scheduled';
  // Miles between oil changes (owner, 2026-10-10: a number, not a truck type): the PM engine's plan.
  const pmOn = isEnabled('pm_module');
  const pm = usePmUnit(pmOn ? row.truck.id : null);
  const plan = pm.data?.plan ?? null;
  const [typing, setTyping] = useState(false);
  return (
    <div
      className={cn('flex items-start gap-3 rounded-lg border px-4 py-3', SERVICE_CARD[tone])}
      title={service.summary}
    >
      {typing ? (
        <OilIntervalDialog
          unit={{ id: row.truck.id, unitNumber: row.truck.unitNumber }}
          currentMiles={plan?.intervalMiles ?? null}
          onClose={() => setTyping(false)}
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
          SERVICE_TILE[tone],
        )}
      >
        <Wrench />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-muted">Next service</span>
        {miles === null && days === null ? (
          <span className="text-base font-medium text-faint">No interval configured</span>
        ) : (
          <>
            {miles !== null ? (
              <span className="text-xl leading-tight font-semibold tracking-tight text-ink tabular-nums">
                {formatMiles(Math.abs(miles))} {miles < 0 ? 'overdue' : 'remaining'}
              </span>
            ) : null}
            {days !== null ? (
              <span
                className={cn(
                  'truncate font-medium text-secondary tabular-nums',
                  miles === null ? 'text-2xl tracking-tight text-ink' : 'text-sm',
                )}
              >
                {formatNumber(Math.abs(days))} {Math.abs(days) === 1 ? 'day' : 'days'}{' '}
                {days < 0 ? 'overdue' : 'remaining'}
              </span>
            ) : null}
          </>
        )}
        {pmOn ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {pm.isPending ? (
              'Loading…'
            ) : (
              <>
                <span>
                  {plan
                    ? `Oil change every ${formatMiles(plan.intervalMiles)}`
                    : 'Oil change interval not set'}
                </span>
                <Button variant="link" size="sm" onClick={() => setTyping(true)}>
                  {plan ? 'Change' : 'Set interval'}
                </Button>
              </>
            )}
          </span>
        ) : null}
      </span>
      <Badge tone={tone} icon={good ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}>
        {MAINTENANCE_LABEL[service.urgency]}
      </Badge>
    </div>
  );
}

/** Five figures the unit earns or burns, each honest about when it cannot be computed. */
function OperatingMetricsCard({ row }: { row: FleetTruck }) {
  const { economics, fuel } = row;
  /*
   * What the shops have charged for this unit.
   *
   * The same completed work orders the Maintenance tab adds up, read here so the figure is on
   * the first screen rather than a tab away - and to the cent, because a repair bill is a real
   * number somebody was invoiced for, not a rounded one.
   */
  const unitOrders = useUnitWorkOrders(row.truck.id, row.allWorkOrders);
  // A repair the vendor paid for (owner, 2026-10-28) is not the company's spend on the unit.
  const repairSpend = unitOrders.rows
    .filter((order) => order.status === 'completed' && !order.vendorPays)
    .reduce((total, order) => total + (order.total ?? 0), 0);
  const cells: Array<{ label: string; value: string | null; tone?: string; title: string }> = [
    {
      label: 'Revenue',
      value: economics.revenue === null ? null : formatMoney(economics.revenue, { compact: true }),
      title:
        economics.revenue === null
          ? 'No load on this unit carries enough detail to price.'
          : `${economics.coverage.priced} of ${economics.coverage.loads} loads priced`,
    },
    {
      label: 'Profit',
      value: economics.profit === null ? null : formatMoney(economics.profit, { compact: true }),
      tone: economics.profit !== null && economics.profit < 0 ? 'text-danger-text' : undefined,
      title:
        economics.profit === null
          ? 'No load on this unit carries enough detail to price.'
          : economics.marginPct === null
            ? ''
            : `${economics.marginPct}% margin`,
    },
    {
      label: 'Repair spend',
      value: unitOrders.loading ? null : formatMoney(repairSpend),
      title: unitOrders.loading
        ? 'Reading this unit’s work orders…'
        : 'Every completed work order on this unit, at what the shop charged.',
    },
    {
      label: 'MPG',
      value: fuel.mpg === null ? null : fuel.mpg.toFixed(2),
      title:
        fuel.mpg === null
          ? 'MPG needs at least two fills with odometer readings on this unit.'
          : `over ${formatMiles(fuel.measuredMiles)}`,
    },
    {
      label: 'Deadhead',
      value: economics.deadheadPct === null ? null : `${economics.deadheadPct}%`,
      tone: (economics.deadheadPct ?? 0) >= 15 ? 'text-warning-text' : undefined,
      title: 'Deadhead share needs priced loads with recorded empty miles.',
    },
  ];
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line-soft bg-surface px-4 py-3">
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-5"
      >
        <ChartColumn />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-muted">Operating metrics</span>
        <span className="mt-1 grid grid-cols-5 divide-x divide-line-soft">
          {cells.map((cell) => (
            <span key={cell.label} className="flex min-w-0 flex-col px-2 first:pl-0 last:pr-0">
              <span className="truncate text-2xs font-medium text-muted">{cell.label}</span>
              <span
                className={cn(
                  'truncate text-base font-semibold tabular-nums',
                  cell.value === null ? 'text-faint' : (cell.tone ?? 'text-ink'),
                )}
                title={cell.title}
              >
                {cell.value ?? DASH}
              </span>
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

/** `held`: the derived verdict is not cleared, so the map marker must not paint the unit green. */
function OverviewTab({ row, held = false }: { row: FleetTruck; held?: boolean }) {
  const { truck, trailer, currentLoad } = row;
  /*
   * Two rows, not three columns. The information and assignment panels are what people read
   * constantly and share the first row at equal width; the map gets a full row of its own beneath,
   * where the position, the last fix and its source have room instead of a cramped third.
   */
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard icon={<Truck />} title="Truck information" padding="sm">
          <FleetFactList
            facts={[
              { label: 'Unit', value: truck.unitNumber },
              { label: 'VIN', value: <span className="font-mono text-xs">{truck.vin}</span> },
              {
                label: 'Year / make / model',
                value: unitIdentity([truck.year, truck.make, truck.model]) || 'Not set',
              },
              {
                label: 'Plate',
                value: truck.plate
                  ? `${truck.plate}${truck.plateState ? ` (${truck.plateState})` : ''}`
                  : 'Not set',
              },
              { label: 'Colour', value: truck.color || 'Not set' },
              { label: 'Ownership', value: sentence(truck.ownership) },
              {
                label: 'In service since',
                value: truck.inServiceDate ? formatIsoDate(truck.inServiceDate) : 'Not set',
              },
              { label: 'Home terminal', value: truck.homeTerminal || 'Not set' },
              { label: 'Engine hours', value: formatNumber(truck.engineHours) },
            ]}
          />
        </SectionCard>

        <SectionCard icon={<User />} title="Current assignment" padding="sm">
          <FleetFactList
            facts={[
              {
                label: 'Driver',
                value: truck.currentDriverId ? (
                  <Link
                    to="/drivers"
                    search={{ driver: truck.currentDriverId }}
                    className="text-primary-text hover:underline"
                  >
                    {truck.currentDriverName}
                  </Link>
                ) : (
                  <span className="text-faint">Unassigned</span>
                ),
              },
              {
                label: 'Trailer',
                value: trailer ? (
                  <Link
                    to="/fleet/trailers/$trailerId"
                    params={{ trailerId: trailer.id }}
                    className="text-primary-text hover:underline"
                  >
                    {trailer.unitNumber}
                  </Link>
                ) : (
                  <span className="text-faint">None attached</span>
                ),
              },
              {
                label: 'Load',
                value: currentLoad ? (
                  <Link
                    to="/loads/$loadNumber"
                    params={{ loadNumber: currentLoad.loadNumber }}
                    className="text-primary-text hover:underline"
                  >
                    {currentLoad.loadNumber}
                  </Link>
                ) : (
                  <span className="text-faint">No load attached</span>
                ),
              },
              {
                label: 'Route',
                value: currentLoad
                  ? `${currentLoad.origin.city}, ${currentLoad.origin.state} → ${currentLoad.destination.city}, ${currentLoad.destination.state}`
                  : DASH,
              },
              {
                label: 'Open work orders',
                value:
                  row.openWorkOrders.length > 0 ? (
                    <span className="text-warning-text">
                      {row.openWorkOrders.map((o) => o.roNumber).join(', ')}
                    </span>
                  ) : (
                    'None'
                  ),
              },
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard icon={<MapPin />} title="Current location" padding="sm">
        {truck.location ? (
          <div className="flex flex-col gap-3">
            <FleetPositionMap
              units={[
                {
                  id: truck.id,
                  unitNumber: truck.unitNumber,
                  lat: truck.location.lat,
                  lng: truck.location.lng,
                  city: truck.location.city,
                  state: truck.location.state,
                  tone: held
                    ? 'held'
                    : row.availability.availability === 'available'
                      ? 'available'
                      : 'active',
                  tracking: row.tracking.state,
                  moving: (truck.location.speedMph ?? 0) >= 5,
                  label: `Unit ${truck.unitNumber}`,
                },
              ]}
              height={260}
              selectedUnit={truck.unitNumber}
              onSelect={() => undefined}
              unpositioned={0}
            />
            <FleetFactList
              facts={[
                { label: 'Position', value: `${truck.location.city}, ${truck.location.state}` },
                { label: 'Speed', value: `${formatNumber(truck.location.speedMph)} mph` },
                { label: 'Engine', value: sentence(truck.location.engineState) },
                {
                  label: 'Last fix',
                  value: formatRelative(truck.location.updatedAt),
                  title: formatDateTime(truck.location.updatedAt),
                },
              ]}
            />
          </div>
        ) : (
          <EmptyState
            icon={<MapPin />}
            title="No position reported"
            description={`Telematics for this unit is ${truck.telematicsStatus}. A position needs a connected feed; nothing is estimated here.`}
          />
        )}
      </SectionCard>
    </div>
  );
}

const DRIVER_FACTS = [
  { icon: <Clock />, title: 'Hours of service' },
  { icon: <ShieldCheck />, title: 'Safety score' },
  { icon: <Award />, title: 'Qualifications' },
];

function DriverTab({ row }: { row: FleetTruck }) {
  const { truck } = row;
  const driverId = truck.currentDriverId;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <AssignDriverPanel truckId={truck.id} unitNumber={truck.unitNumber} />

      <SectionCard icon={<IdCard />} title="Driver information" padding="sm">
        <div className="flex flex-col gap-3">
          <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
            {DRIVER_FACTS.map((fact) => {
              const body = (
                <>
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-4"
                  >
                    {fact.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{fact.title}</span>
                    <span className="block text-xs text-muted">View on driver profile</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </>
              );
              const classes = 'flex items-center gap-3 px-3 py-2.5';
              return (
                <li key={fact.title}>
                  {driverId ? (
                    <Link
                      to="/drivers/$driverId"
                      params={{ driverId }}
                      className={cn(classes, 'hover:bg-surface-hover')}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={cn(classes, 'opacity-60')}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          <FleetInfoBar icon={<Info />}>
            {driverId
              ? 'Current details are available on the driver profile.'
              : 'Hours of service, safety score and qualifications belong to the driver record; assign a driver to see them.'}
          </FleetInfoBar>
        </div>
      </SectionCard>
    </div>
  );
}

function LoadTab({ row }: { row: FleetTruck }) {
  const load = row.currentLoad;
  return (
    <SectionCard icon={<Package />} title="Current load" padding="sm">
      {!load ? (
        <EmptyState
          size="sm"
          icon={<Package />}
          title="No load on this unit"
          description="When freight is dispatched to this truck it appears here with its stops and appointments."
        />
      ) : (
        <FleetFactList
          facts={[
            {
              label: 'Load',
              value: (
                <Link
                  to="/loads/$loadNumber"
                  params={{ loadNumber: load.loadNumber }}
                  className="text-primary-text hover:underline"
                >
                  {load.loadNumber}
                </Link>
              ),
            },
            {
              label: 'Status',
              value: <StatusBadge status={load.status} label={loadStatusLabel(load.status)} />,
            },
            { label: 'Customer', value: load.customerName },
            { label: 'Broker', value: load.brokerName ?? DASH },
            {
              label: 'Route',
              value: `${load.origin.city}, ${load.origin.state} → ${load.destination.city}, ${load.destination.state}`,
            },
            { label: 'Loaded miles', value: formatMiles(load.loadedMiles) },
            { label: 'Empty miles', value: formatMiles(load.emptyMiles) },
            {
              label: 'Revenue',
              value: load.financials ? formatMoney(load.financials.revenue) : DASH,
            },
          ]}
        />
      )}
    </SectionCard>
  );
}

function TrackingTab({ row }: { row: FleetTruck }) {
  const { truck, tracking } = row;
  if (!truck.location) {
    return (
      <SectionCard icon={<Radio />} title="Tracking" padding="sm">
        <EmptyState
          size="sm"
          icon={<Radio />}
          title="This unit is not reporting"
          description={`Telematics status is ${truck.telematicsStatus}. Position, speed and engine state all come from that feed; none of them are inferred.`}
        />
      </SectionCard>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <SectionCard icon={<MapPin />} title="Position" padding="sm">
        <FleetPositionMap
          units={[
            {
              id: truck.id,
              unitNumber: truck.unitNumber,
              lat: truck.location.lat,
              lng: truck.location.lng,
              city: truck.location.city,
              state: truck.location.state,
              tone: tracking.state === 'stale' || tracking.state === 'offline' ? 'stale' : 'active',
              tracking: tracking.state,
              label: `Unit ${truck.unitNumber}`,
            },
          ]}
          selectedUnit={truck.unitNumber}
          onSelect={() => undefined}
          unpositioned={0}
          height={320}
        />
      </SectionCard>
      <SectionCard icon={<Radio />} title="Feed" padding="sm">
        <FleetFactList
          facts={[
            { label: 'Provider', value: truck.telematicsProvider },
            { label: 'Feed status', value: sentence(truck.telematicsStatus) },
            { label: 'Freshness', value: sentence(tracking.state) },
            {
              label: 'Last fix',
              value: formatRelative(truck.location.updatedAt),
              title: formatDateTime(truck.location.updatedAt),
            },
            { label: 'Latitude', value: truck.location.lat.toFixed(4) },
            { label: 'Longitude', value: truck.location.lng.toFixed(4) },
          ]}
        />
      </SectionCard>
    </div>
  );
}

const scheduleCol = createColumns<FleetTruck['schedule'][number]>();
const workOrderCol = createColumns<UnitWorkOrderRow>();

const WORK_ORDER_STATUSES = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_shop', label: 'In the shop' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function MaintenanceTab({
  row,
  onSchedule,
  onCreateWorkOrder,
}: {
  row: FleetTruck;
  onSchedule: () => void;
  onCreateWorkOrder: () => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const unitOrders = useUnitWorkOrders(row.truck.id, row.allWorkOrders);
  // Marked in the shop on the unit itself with no open work order behind it (0018, owner
  // 2026-10-16): say so where the work orders are, and offer the one step that puts it on record.
  const heldWithoutOrder =
    !unitOrders.loading &&
    (row.truck.status === 'in_shop' || row.truck.status === 'maintenance') &&
    !unitOrders.rows.some((o) => o.status === 'in_shop' || o.status === 'open' || o.status === 'scheduled');

  const scheduleColumns = useMemo(
    () =>
      scheduleCol.columns([
        scheduleCol.accessor('typeLabel', { header: 'Service', meta: { primary: true } }),
        scheduleCol.accessor('status', {
          header: 'Status',
          cell: ({ getValue }) => <StatusBadge status={getValue()} />,
          meta: { width: 130 },
        }),
        scheduleCol.accessor('nextDueAt', {
          header: 'Due date',
          cell: ({ getValue }) => formatIsoDate(getValue()),
          meta: { width: 130 },
        }),
        scheduleCol.accessor('milesUntilDue', {
          header: 'Miles to due',
          cell: ({ getValue }) => {
            const miles = getValue();
            return (
              <span className={cn(miles <= 0 && 'font-medium text-danger-text')}>
                {miles <= 0 ? `${formatMiles(Math.abs(miles))} over` : formatMiles(miles)}
              </span>
            );
          },
          meta: { align: 'right', width: 130 },
        }),
        scheduleCol.accessor('scheduledFor', {
          header: 'Booked for',
          cell: ({ getValue }) => {
            const value = getValue();
            return value ? formatIsoDate(value) : <span className="text-faint">{DASH}</span>;
          },
          meta: { width: 130 },
        }),
        scheduleCol.accessor('vendorName', {
          header: 'Vendor',
          cell: ({ getValue }) => getValue() ?? <span className="text-faint">{DASH}</span>,
        }),
      ]),
    [],
  );

  const workOrderColumns = useMemo(
    () =>
      workOrderCol.columns([
        workOrderCol.display({
          id: 'roNumber',
          header: 'Work order',
          meta: { primary: true, width: 120 },
          cell: ({ row: r }) =>
            r.original.source === 'server' ? (
              <Link
                to="/fleet/shop/$orderId"
                params={{ orderId: r.original.id }}
                className="font-medium text-primary-text hover:underline"
              >
                {r.original.number}
              </Link>
            ) : (
              <Link
                to="/fleet/maintenance/$orderId"
                params={{ orderId: r.original.id }}
                className="font-medium text-primary-text hover:underline"
              >
                {r.original.number}
              </Link>
            ),
        }),
        workOrderCol.accessor('status', {
          header: 'Status',
          cell: ({ getValue }) => <StatusBadge status={getValue()} />,
          meta: { width: 120 },
        }),
        workOrderCol.accessor('summary', { header: 'Description' }),
        workOrderCol.accessor('vendorName', {
          header: 'Vendor',
          cell: ({ getValue }) => getValue() || <span className="text-faint">{DASH}</span>,
        }),
        workOrderCol.accessor('openedAt', {
          header: 'Opened',
          cell: ({ getValue }) => formatDate(getValue()),
          meta: { width: 120 },
        }),
        workOrderCol.accessor('total', {
          header: 'Cost',
          cell: ({ getValue }) => {
            const value = getValue();
            return value === null ? <span className="text-faint">{DASH}</span> : formatMoney(value);
          },
          meta: { align: 'right', width: 110 },
        }),
        workOrderCol.display({
          id: 'invoices',
          header: 'Invoice',
          meta: { width: 170 },
          cell: ({ row: r }) =>
            r.original.order ? (
              <WorkOrderInvoiceCell order={r.original.order} />
            ) : (
              <Link
                to="/fleet/shop/$orderId"
                params={{ orderId: r.original.id }}
                className="text-xs font-medium text-primary-text hover:underline"
              >
                {r.original.invoiceCount === 0
                  ? 'Attach on the work order'
                  : `${r.original.invoiceCount} on file`}
              </Link>
            ),
        }),
      ]),
    [],
  );

  const orders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return unitOrders.rows.filter((order) => {
      if (status !== 'all' && order.status !== status) return false;
      if (!needle) return true;
      return [order.number, order.summary, order.vendorName]
        .filter(Boolean)
        .some((text) => text.toLowerCase().includes(needle));
    });
  }, [unitOrders.rows, query, status]);

  return (
    <div className="flex flex-col gap-4">
      {heldWithoutOrder ? (
        <Alert
          tone="warning"
          title={`Unit ${row.truck.unitNumber} is in maintenance with no work order`}
          description="It was added as In shop, so the shop, the repair and its cost are not on record and Repairs does not count it. Press Create repair; closing the repair returns the unit to service."
          actions={
            <Button size="sm" variant="secondary" icon={<Wrench />} onClick={onCreateWorkOrder}>
              Create repair
            </Button>
          }
        />
      ) : null}
      {/*
       * The repair record comes first.
       *
       * The tab is called Maintenance and the question people bring to it is "what has been done
       * to this unit". That list used to sit under two context cards, below the fold on a laptop,
       * which is why a unit with three work orders on it was reported as showing none. Condition
       * and the service schedule are what you read next, not first.
       */}
      <SectionCard
        icon={<Wrench />}
        title="Work orders"
        description="Every work order raised against this unit, open or finished."
        padding="none"
        actions={
          <>
            <Input
              size="sm"
              prefix={<Search />}
              placeholder="Search work orders..."
              aria-label="Search work orders"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-52"
            />
            <Select
              size="sm"
              aria-label="Status"
              value={status}
              onValueChange={setStatus}
              options={WORK_ORDER_STATUSES}
              className="w-36"
            />
            <Button size="sm" variant="primary" icon={<Wrench />} onClick={onCreateWorkOrder}>
              Create work order
            </Button>
          </>
        }
        footer={
          unitOrders.loading
            ? 'Loading…'
            : `${orders.length} ${orders.length === 1 ? 'work order' : 'work orders'}`
        }
      >
        <DataTable
          columns={workOrderColumns}
          data={orders}
          rowKey={(order) => order.id}
          caption="Work orders"
          showColumnChooser={false}
          emptyTitle={
            unitOrders.loading
              ? 'Loading…'
              : unitOrders.rows.length === 0
                ? 'No work orders on this unit'
                : 'No work orders match'
          }
          emptyDescription={
            unitOrders.loading
              ? undefined
              : unitOrders.rows.length === 0
                ? 'Every work order raised against this unit appears here, open or finished.'
                : 'Clear the search or the status filter to see the rest.'
          }
        />
      </SectionCard>

      {/* The defect records behind the header's verdict - the same rows the board shows (§4.5). */}
      {isEnabled('fleet_v2') ? <OpenDefectsCard unitId={row.truck.id} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* "What shape is this unit in?" — the video's verdict, beside the shop's record. */}
        <SectionCard
          icon={<Settings />}
          title="Vehicle condition"
          description="From the weekly walk-around video. A rating carries forward until the component is rated again."
          padding="sm"
        >
          <TruckConditionList truckId={row.truck.id} />
        </SectionCard>

        <SectionCard
          icon={<Calendar />}
          title="Service schedule"
          description="Preventive maintenance intervals and what is booked."
          padding={row.schedule.length === 0 ? 'sm' : 'none'}
          actions={
            row.schedule.length > 0 ? (
              <Button size="sm" variant="secondary" icon={<CalendarClock />} onClick={onSchedule}>
                Schedule maintenance
              </Button>
            ) : undefined
          }
        >
          {row.schedule.length === 0 ? (
            <EmptyState
              size="sm"
              icon={<Calendar />}
              title="No service intervals configured"
              description="Set up service intervals to keep this unit on track."
              action={
                <Button size="sm" variant="secondary" icon={<CalendarClock />} onClick={onSchedule}>
                  Schedule maintenance
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={scheduleColumns}
              data={row.schedule}
              rowKey={(item) => item.id}
              caption="Service schedule"
              showColumnChooser={false}
              dense
            />
          )}
        </SectionCard>
      </div>
    </div>
  );
}

/**
 * What the old truck Costs tab carried besides repairs: freight economics and fuel. Repairs and
 * every other cost now live in the Expenses list above it (owner, 2026-10-12), so this keeps the
 * two figures that are not expenses without showing any spend twice.
 */
function RunningCosts({ row }: { row: FleetTruck }) {
  const { economics, fuel } = row;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard
        icon={<Coins />}
        title="Freight economics"
        description="What this unit's freight earned on the miles it turned."
        padding="sm"
      >
        <div className="flex flex-col gap-3">
          <FleetFactList
            facts={[
              {
                label: 'Revenue',
                value: economics.revenue === null ? insufficient() : formatMoney(economics.revenue),
              },
              {
                label: 'Cost incl. deadhead',
                value: economics.cost === null ? insufficient() : formatMoney(economics.cost),
              },
              {
                label: 'Profit',
                value: economics.profit === null ? insufficient() : formatMoney(economics.profit),
              },
              {
                label: 'Margin',
                value: economics.marginPct === null ? insufficient() : `${economics.marginPct}%`,
              },
              {
                label: 'Total miles',
                value:
                  economics.totalMiles === null
                    ? insufficient()
                    : formatMiles(economics.totalMiles),
              },
              {
                label: 'Revenue per mile',
                value:
                  economics.revenuePerMile === null
                    ? insufficient()
                    : formatMoney(economics.revenuePerMile),
              },
              {
                label: 'Profit per mile',
                value:
                  economics.profitPerMile === null
                    ? insufficient()
                    : formatMoney(economics.profitPerMile),
              },
            ]}
          />
          <FleetInfoBar icon={<Info />}>
            {economics.coverage.loads === 0
              ? 'No load data available · 0 loads.'
              : `Based on ${economics.coverage.priced} of ${economics.coverage.loads} loads.`}
            {economics.estimated
              ? ' Includes an estimated cost for the empty miles this unit ran, priced at its own running rate.'
              : ''}
          </FleetInfoBar>
        </div>
      </SectionCard>

      <SectionCard
        icon={<Fuel />}
        title="Fuel"
        description="From the fuel card, not the telematics feed."
        padding="sm"
        actions={
          <Badge tone="neutral" icon={<Clock aria-hidden />}>
            Last 30 days
          </Badge>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile icon={<CreditCard />} label="Spend" value={formatMoney(fuel.spend)} />
            <StatTile icon={<Droplet />} label="Gallons" value={formatNumber(fuel.gallons, 1)} />
          </div>
          <FleetFactList
            facts={[
              {
                label: 'Average price',
                value:
                  fuel.avgPricePerGallon === null
                    ? insufficient()
                    : `$${fuel.avgPricePerGallon.toFixed(3)}`,
              },
              {
                label: 'MPG',
                value:
                  fuel.mpg === null
                    ? insufficient('Needs two fills with odometer readings')
                    : fuel.mpg.toFixed(2),
              },
              {
                label: 'Fuel cost per mile',
                value:
                  fuel.costPerMile === null ? insufficient() : `$${fuel.costPerMile.toFixed(3)}`,
              },
              { label: 'Measured miles', value: formatMiles(fuel.measuredMiles) },
              { label: 'Fills', value: formatNumber(fuel.transactions) },
            ]}
          />
        </div>
      </SectionCard>
    </div>
  );
}

function PerformanceTab({ row }: { row: FleetTruck }) {
  const { truck, economics } = row;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard icon={<ChartColumn />} title="Utilisation" padding="sm">
        <FleetFactList
          facts={[
            { label: 'Loads run', value: formatNumber(economics.coverage.loads) },
            { label: 'Cancelled loads', value: formatNumber(economics.coverage.cancelled) },
            {
              label: 'Deadhead share',
              value: economics.deadheadPct === null ? insufficient() : `${economics.deadheadPct}%`,
            },
            {
              label: 'Total miles',
              value:
                economics.totalMiles === null ? insufficient() : formatMiles(economics.totalMiles),
            },
          ]}
        />
      </SectionCard>
      <SectionCard icon={<Radio />} title="Telematics-reported" padding="sm">
        <FleetFactList
          facts={[
            {
              label: 'MPG (30d)',
              value: truck.mpg30d > 0 ? truck.mpg30d.toFixed(2) : insufficient(),
            },
            {
              label: 'MPG (90d)',
              value: truck.mpg90d > 0 ? truck.mpg90d.toFixed(2) : insufficient(),
            },
            {
              label: 'Idle (30d)',
              value: truck.mpg30d > 0 ? `${truck.idlePercent30d}%` : insufficient(),
            },
            {
              label: 'Idle (90d)',
              value: truck.mpg90d > 0 ? `${truck.idlePercent90d}%` : insufficient(),
            },
          ]}
        />
        <p className="mt-3 text-xs text-faint">
          These come from the telematics provider. The MPG on the Expenses tab is computed from the
          fuel card instead — the two are different measurements and are shown separately rather
          than reconciled into one number.
        </p>
      </SectionCard>
    </div>
  );
}

type ActivityKind = 'work_order' | 'maintenance' | 'tracking';

const ACTIVITY_FILTERS: Array<{ value: ActivityKind | 'all'; label: string }> = [
  { value: 'all', label: 'All activity' },
  { value: 'work_order', label: 'Work orders' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'tracking', label: 'Tracking' },
];

type ActivityRange = 'month' | '30' | '90' | 'all';

/** The window an activity range covers, on the real clock; null bounds mean unbounded. */
function activityWindow(
  range: ActivityRange,
  now: Date,
): { from: number | null; to: number | null } {
  if (range === 'all') return { from: null, to: null };
  if (range === 'month') {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime(),
    };
  }
  return { from: now.getTime() - Number(range) * 86_400_000, to: null };
}

function ActivityTab({ row }: { row: FleetTruck }) {
  const [kind, setKind] = useState<ActivityKind | 'all'>('all');
  const [range, setRange] = useState<ActivityRange>('month');
  const now = useMemo(() => new Date(), []);

  const items = useMemo(() => {
    const events: Array<TimelineItem & { kind: ActivityKind }> = [];
    for (const order of row.openWorkOrders) {
      events.push({
        kind: 'work_order',
        id: `wo-${order.id}`,
        at: order.openedAt,
        title: `${order.roNumber} opened — ${order.summary}`,
        description: `${order.vendorName}${order.technician ? ` · ${order.technician}` : ''}`,
        tone: 'warning',
      });
    }
    for (const item of row.schedule.filter((m) => m.scheduledFor)) {
      events.push({
        kind: 'maintenance',
        id: `sched-${item.id}`,
        at: `${item.scheduledFor as string}T08:00:00Z`,
        title: `${item.typeLabel} booked`,
        description: item.vendorName ?? undefined,
        tone: 'info',
      });
    }
    if (row.truck.location) {
      events.push({
        kind: 'tracking',
        id: 'fix',
        at: row.truck.location.updatedAt,
        title: `Position reported — ${row.truck.location.city}, ${row.truck.location.state}`,
        description: `${formatNumber(row.truck.location.speedMph)} mph, engine ${row.truck.location.engineState}`,
        tone: 'neutral',
      });
    }
    return events.sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));
  }, [row]);

  const window = activityWindow(range, now);
  const visible = items.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    const at = Date.parse(String(item.at));
    if (window.from !== null && at < window.from) return false;
    if (window.to !== null && at > window.to) return false;
    return true;
  });

  const monthLabel = `${formatDate(new Date(now.getFullYear(), now.getMonth(), 1))} – ${formatDate(
    new Date(now.getFullYear(), now.getMonth() + 1, 0),
  )}`;
  const RANGES: Array<{ value: ActivityRange; label: string }> = [
    { value: 'month', label: monthLabel },
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
    { value: 'all', label: 'All time' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-md font-bold text-ink">Activity</h3>
        <p className="text-xs text-muted">Unit updates in one place.</p>
      </div>
      <Card padding="none">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {ACTIVITY_FILTERS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant="secondary"
                aria-pressed={kind === option.value}
                className={cn(
                  kind === option.value && 'border-primary bg-primary-soft text-primary-text',
                )}
                onClick={() => setKind(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <span className="flex items-center gap-1.5">
            <Calendar className="size-4 text-muted" aria-hidden />
            <Select
              size="sm"
              aria-label="Period"
              value={range}
              onValueChange={(value) => setRange(value as ActivityRange)}
              options={RANGES}
              className="w-56"
            />
          </span>
        </div>
        <div className="p-4">
          {visible.length === 0 ? (
            <EmptyState
              size="sm"
              icon={<Clock />}
              title={
                items.length === 0 ? 'No activity recorded yet.' : 'No activity in this period.'
              }
              description={
                items.length === 0
                  ? 'Work orders, maintenance bookings and location updates will appear here.'
                  : 'Widen the period or clear the filter to see the rest.'
              }
            />
          ) : (
            <Timeline items={visible} />
          )}
        </div>
      </Card>
    </div>
  );
}

function insufficient(title?: string) {
  return (
    <span className="text-faint" title={title ?? 'Insufficient data'}>
      {DASH}
    </span>
  );
}

/** `in_shop` → `In shop`: the stored codes read as sentences in a fact list. */
function sentence(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The shop paperwork on a work order.
 *
 * An invoice is what the work actually cost, so attaching one replaces the estimate typed when the
 * order was opened. Stored as a data URL, like every other file in this build.
 */
function WorkOrderInvoiceCell({ order }: { order: RepairOrder }) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // By id, so a re-read of the order hands the viewer the current file rather than a stale copy.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const invoices = order.invoices ?? [];
  const viewing = invoices.find((i) => i.id === viewingId) ?? null;

  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast({ tone: 'danger', title: 'That file is over 10 MB' });
      return;
    }
    setBusy(true);
    try {
      const stored = await uploadFile(file);
      await attachWorkOrderInvoice({
        orderId: order.id,
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        fileUrl: stored.url,
        fileId: stored.id,
        uploadedBy: demoCurrentUser.name,
        amount: null,
      });
      await invalidate();
      toast({ tone: 'success', title: `Invoice attached to ${order.roNumber}` });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'The invoice could not be attached',
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  /* On the page, not in a second tab: reading the bill and typing what it says are one job. */
  const open = (invoice: NonNullable<RepairOrder['invoices']>[number]) => {
    if (!invoice.fileUrl && !invoice.fileId && !invoice.dataUrl) {
      toast({ tone: 'info', title: 'No file on record for this invoice' });
      return;
    }
    setViewingId(invoice.id);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      {/*
       * The first invoice is the link; any further ones are a button each. The button is the file:
       * a column of long filenames pushed the table wide and said nothing a person could not learn
       * by opening it.
       */}
      {invoices.length === 0 ? <span className="text-faint">{DASH}</span> : null}
      {invoices.map((invoice, index) =>
        index === 0 ? (
          <Button
            key={invoice.id}
            variant="link"
            size="sm"
            icon={<FileText />}
            onClick={() => open(invoice)}
            title={`${invoice.fileName} · ${formatBytes(invoice.sizeBytes)}`}
          >
            View invoice
          </Button>
        ) : (
          <IconButton
            key={invoice.id}
            label={`Open ${invoice.fileName}`}
            variant="ghost"
            size="sm"
            onClick={() => open(invoice)}
            title={`${invoice.fileName} · ${formatBytes(invoice.sizeBytes)}`}
          >
            <Receipt />
          </IconButton>
        ),
      )}
      <IconButton
        label={invoices.length > 0 ? 'Attach another invoice' : 'Upload the invoice'}
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={() => fileRef.current?.click()}
      >
        <Upload />
      </IconButton>
      {viewing ? (
        <DocumentViewer
          source={{
            kind: 'file',
            file: {
              fileUrl: viewing.fileUrl,
              fileId: viewing.fileId,
              dataUrl: viewing.dataUrl,
              fileName: viewing.fileName,
            },
          }}
          title={viewing.fileName}
          subtitle={`${order.roNumber ?? order.id} · ${viewing.uploadedBy} · ${formatDateTime(viewing.uploadedAt)}`}
          contentType={viewing.mimeType}
          fileName={viewing.fileName}
          onClose={() => setViewingId(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Notes on a unit.
 *
 * Kept with the truck rather than on a work order: most of what people need to write down about a
 * truck is not a repair - which trailer it pulls best, that the APU rattles, who has the spare key.
 */
function TruckNotesTab({ truckId, unitNumber }: { truckId: string; unitNumber: string }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<TruckNote[]>(() => listTruckNotes(truckId));

  const add = () => {
    const body = draft.trim();
    if (!body) return;
    setNotes(addTruckNote({ truckId, body, authorName: demoCurrentUser.name }));
    setDraft('');
    toast({ tone: 'success', title: `Note added to unit ${unitNumber}` });
  };

  const needle = query.trim().toLowerCase();
  const visible = [...notes]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter(
      (note) =>
        !needle ||
        note.body.toLowerCase().includes(needle) ||
        note.authorName.toLowerCase().includes(needle),
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <SectionCard
        icon={<StickyNote />}
        title={`Notes (${notes.length})`}
        description="What the next person on this unit should know."
        padding="sm"
        actions={
          <Input
            size="sm"
            prefix={<Search />}
            placeholder="Search notes..."
            aria-label="Search notes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-48"
          />
        }
      >
        {notes.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<StickyNote />}
            title="No notes yet"
            description="Add a note to keep the team informed."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Search />}
            title="No notes match"
            description="Try another word."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((note) => (
              <li key={note.id} className="border-b border-line-soft pb-3 last:border-b-0">
                <p className="text-sm whitespace-pre-wrap text-ink">{note.body}</p>
                <p className="mt-1 text-xs text-muted">
                  {note.authorName} · {formatDate(note.at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard icon={<StickyNote />} title="Add a note" padding="sm">
        <div className="flex flex-col gap-3">
          <FormField label="Note" description="Keep notes clear and useful for the next shift.">
            <Textarea
              rows={4}
              value={draft}
              placeholder="Write an update about this unit..."
              onChange={(event) => setDraft(event.target.value)}
            />
          </FormField>
          <Button variant="primary" fullWidth disabled={draft.trim().length === 0} onClick={add}>
            Add note
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
