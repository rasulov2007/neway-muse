import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Ban,
  Calendar,
  Container,
  EllipsisVertical,
  ExternalLink,
  Info,
  Link2,
  MapPin,
  Package,
  Pencil,
  RotateCcw,
  Shield,
  Truck,
  User,
  Wrench,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Avatar,
  BackButton,
  Button,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  MenuItem,
  PageHeader,
  SectionCard,
  Skeleton,
  StatTile,
  StatusBadge,
  Tabs,
  TabsContent,
  cn,
} from '@/design-system';
import { actionsFor } from '@neway/shared';
import { formatDateTime, formatIsoDate, formatNumber, formatRelative } from '@/lib/format';
import { FleetPositionMap } from '@/features/operations/FleetPositionMap';
import { FleetFactList, FleetInfoBar } from './components/FleetDetailShell';
import { CreateWorkOrderDialog } from './components/CreateWorkOrderDialog';
import { UnitDocumentChip } from './components/UnitDocumentChip';
import { UnitDocumentsTab } from './components/UnitDocumentsTab';
import { UnitExitNotice } from './components/UnitExitNotice';
import { formatDate, formatMoney } from '@/lib/format';
import { UnitStatusDialog } from './components/UnitStatusDialog';
import { UnitStatusCell } from './components/UnitStatusCell';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, DASH, trailerStatusLabel } from './fleet-ui';
import { useFleet, type FleetTrailer } from './useFleet';
import { hasUnitDocumentIssue } from './unit-documents';
import { unitHeaderLine, unitIdentity } from './unit-header';
import { MissingDetails } from './components/MissingDetails';
import { EditTrailerIdentityDialog } from './components/EditTrailerIdentityDialog';
import { useAccount } from '@/features/auth/auth-context';
import { useUnitWorkOrders } from './unit-work-orders';
import { InvestigationPanel } from './expenses/investigations';
import { isEnabled } from '@/lib/feature-flags';
import { ProfileAccidents } from '@/features/accidents/ProfileAccidents';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'assignment', label: 'Assignment' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'documents', label: 'Documents' },
];

/** `dry_van` → `Dry van`: the stored codes read as sentences on the page. */
function sentence(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Trailer 360.
 *
 * The same page anatomy as a truck, with one honest difference: a trailer carries no telematics,
 * no odometer and no economics of its own. Rather than borrowing the pulling truck's figures and
 * presenting them as the trailer's, those facts are named as coming from the truck.
 */
export function TrailerDetailRoute() {
  const { trailerId } = useParams({ from: '/fleet/trailers/$trailerId' });
  return <TrailerDetailPage trailerId={trailerId} />;
}

export function TrailerDetailPage({ trailerId }: { trailerId: string }) {
  const navigate = useNavigate();
  const fleetQuery = useFleet();
  const [tab, setTab] = useState('overview');
  const [statusAction, setStatusAction] = useState<string | null>(null);
  const [creatingWorkOrder, setCreatingWorkOrder] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const account = useAccount();
  const canEditTrailers =
    account !== null && (account.isOwner || account.permissions.includes('trailers.edit'));

  const row = fleetQuery.data?.byTrailerId.get(trailerId);
  /*
   * The trailer's work orders from both stores: the server's table, where every order created
   * since fleet_v2 lives, and the workspace's older records. Reading the workspace alone hid
   * every new trailer order (Dalton Mattox created one twice, 2026-09-30).
   */
  const unitOrders = useUnitWorkOrders(trailerId, row?.allWorkOrders ?? []);
  const openOrders = unitOrders.rows.filter((o) => o.status === 'open' || o.status === 'scheduled' || o.status === 'in_shop');

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
        title="That trailer is not in the fleet"
        description="It may have been sold, or the link may be out of date."
        action={
          <Button onClick={() => void navigate({ to: '/fleet/trailers' })}>Back to trailers</Button>
        }
      />
    );
  }

  const { trailer, truck, currentLoad, availability } = row;
  const truckRow = truck ? (fleetQuery.data?.byTruckId.get(truck.id) ?? null) : null;
  const location = truck?.location ?? trailer.location;
  const statusActions = actionsFor('trailer', trailer.status).filter(
    (action) => action.kind === 'status',
  );
  // Missing paperwork counts as an issue: a unit with nothing on file is held the same way
  // one with an expired document is, and the chip has to be able to say so.
  const hasDocumentIssue = hasUnitDocumentIssue(row.documents);
  // 'available' and 'assigned' are what the pill already says; the rest add a fact.
  const showStoredStatus = trailer.status !== 'available' && trailer.status !== 'assigned';
  const typeLabel = trailer.lengthFt
    ? `${sentence(trailer.type)} · ${trailer.lengthFt} ft`
    : sentence(trailer.type);

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/fleet/trailers" />}
        title={
          <span className="inline-flex items-center gap-2">
            {`Trailer ${trailer.unitNumber}`}
            {/* Edit beside the name (owner, 2026-10-24): number, model and year. */}
            {canEditTrailers ? (
              <Button variant="ghost" size="sm" icon={<Pencil />} aria-label={`Edit trailer ${trailer.unitNumber}`} onClick={() => setEditingIdentity(true)} />
            ) : null}
          </span>
        }
        meta={
          <UnitStatusCell
            entity="trailer"
            id={trailer.id}
            unitNumber={trailer.unitNumber}
            status={trailer.status}
            tone={AVAILABILITY_TONE[availability.availability]}
            label={AVAILABILITY_LABEL[availability.availability]}
          />
        }
        description={
          unitHeaderLine([trailer.year, trailer.make, trailer.model], trailer.vin) || undefined
        }
        actions={
          <>
            <Button variant="primary" icon={<Wrench />} onClick={() => setCreatingWorkOrder(true)}>
              Create work order
            </Button>
            {statusActions.length > 0 ? (
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
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      {showStoredStatus || hasDocumentIssue || availability.reasons.length > 0 ? (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          {showStoredStatus ? (
            <StatusBadge status={trailer.status} label={trailerStatusLabel(trailer.status)} />
          ) : null}
          <UnitDocumentChip issues={row.documents} onOpen={() => setTab('documents')} />
          <span className="text-sm text-muted">{availability.reasons.join('. ')}</span>
        </div>
      ) : null}

      <UnitExitNotice unitId={trailer.id} entity="trailer" />
      <MissingDetails trailer={trailer} nextInspectionDate={row.nextInspection.date} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile icon={<Container />} label="Type" value={typeLabel} />
        <StatTile icon={<Shield />} label="Ownership" value={sentence(trailer.ownership)} />
        <StatTile
          icon={<Calendar />}
          label="Next inspection"
          value={formatIsoDate(row.nextInspection.date)}
          hint={
            row.nextInspection.source === 'document' ? 'From the certificate on file' : undefined
          }
        />
        <StatTile
          icon={<MapPin />}
          label="Location"
          value={
            location ? (
              `${location.city}, ${location.state}`
            ) : (
              <span className="text-base font-medium text-faint">Not reported</span>
            )
          }
          hint={location && truck ? `Reported by unit ${truck.unitNumber}` : undefined}
          title="A trailer has no telematics of its own; its position is the position of the truck pulling it."
        />
      </div>

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Trailer detail">
        <TabsContent value="overview" className="flex flex-col gap-4 pt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              icon={<Container />}
              title="Trailer information"
              padding="sm"
              actions={
                canEditTrailers ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Pencil />}
                    onClick={() => setEditingIdentity(true)}
                  >
                    Edit
                  </Button>
                ) : undefined
              }
            >
              <FleetFactList
                facts={[
                  { label: 'Trailer', value: trailer.unitNumber },
                  { label: 'VIN', value: <span className="font-mono text-xs">{trailer.vin}</span> },
                  {
                    label: 'Year / make / model',
                    value: unitIdentity([trailer.year, trailer.make, trailer.model]) || 'Not set',
                  },
                  { label: 'Type', value: sentence(trailer.type) },
                  {
                    label: 'Length',
                    value: trailer.lengthFt ? `${trailer.lengthFt} ft` : 'Not set',
                  },
                  {
                    label: 'Plate',
                    value: trailer.plate
                      ? `${trailer.plate}${trailer.plateState ? ` (${trailer.plateState})` : ''}`
                      : 'Not set',
                  },
                  { label: 'Ownership', value: sentence(trailer.ownership) },
                ]}
              />
            </SectionCard>
            <SectionCard icon={<User />} title="Current assignment" padding="sm">
              <div className="flex flex-col gap-3">
                <FleetFactList
                  facts={[
                    {
                      label: 'Truck',
                      value: truck ? (
                        <span className="inline-flex items-center gap-2">
                          <Link
                            to="/fleet/trucks/$truckId"
                            params={{ truckId: truck.id }}
                            className="text-primary-text hover:underline"
                          >
                            Unit {truck.unitNumber}
                          </Link>
                          <Button size="sm" variant="primary" asChild>
                            <Link to="/fleet/trucks/$truckId" params={{ truckId: truck.id }}>
                              <ExternalLink aria-hidden />
                              View truck
                            </Link>
                          </Button>
                        </span>
                      ) : (
                        <span className="text-faint">Unassigned</span>
                      ),
                    },
                    {
                      label: 'Driver',
                      value: truck?.currentDriverName ? (
                        <span className="inline-flex items-center gap-2">
                          <Avatar name={truck.currentDriverName} size="sm" />
                          {truck.currentDriverName}
                        </span>
                      ) : (
                        <span className="text-faint">{DASH}</span>
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
                  ]}
                />
                <FleetInfoBar icon={<Info />}>
                  Assignments are managed from the truck record.
                </FleetInfoBar>
              </div>
            </SectionCard>
          </div>

          {/* Full width beneath: a trailer's position is the pulling truck's, and says so. */}
          <SectionCard icon={<MapPin />} title="Current location" padding="sm">
            {truck?.location ? (
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
                      tone: availability.availability === 'available' ? 'available' : 'active',
                      tracking: truckRow?.tracking.state ?? 'none',
                      label: `Unit ${truck.unitNumber} · pulling ${trailer.unitNumber}`,
                    },
                  ]}
                  selectedUnit={truck.unitNumber}
                  onSelect={() => undefined}
                  unpositioned={0}
                  height={260}
                />
                <FleetFactList
                  facts={[
                    { label: 'Position', value: `${truck.location.city}, ${truck.location.state}` },
                    {
                      label: 'Reported by',
                      value: `Unit ${truck.unitNumber} (the truck pulling this trailer)`,
                    },
                    { label: 'Speed', value: `${formatNumber(truck.location.speedMph)} mph` },
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
                description={
                  truck
                    ? `Unit ${truck.unitNumber} is pulling this trailer but reports no position; a trailer has no telematics of its own.`
                    : 'A trailer has no telematics of its own; its position is the position of the truck pulling it, and none is attached.'
                }
              />
            )}
          </SectionCard>
          {isEnabled('accidents_v2') ? <ProfileAccidents kind="trailer" id={trailerId} /> : null}
        </TabsContent>

        <TabsContent value="assignment" className="pt-4">
          <AssignmentTab row={row} typeLabel={typeLabel} />
        </TabsContent>

        <TabsContent value="maintenance" className="flex flex-col gap-4 pt-4">
          {/* Trailer work under investigation belongs to the trailer (owner, 2026-10-13). */}
          <InvestigationPanel query={{ unitId: trailer.id }} hideUnit emptyHidden />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <SectionCard
              icon={<Calendar />}
              title="Inspection details"
              description="Next scheduled inspection and current status."
              padding="sm"
            >
              <FleetFactList
                facts={[
                  { label: 'Next inspection', value: formatIsoDate(row.nextInspection.date) },
                  {
                    label: 'Equipment status',
                    value: (
                      <StatusBadge
                        status={trailer.status}
                        label={trailerStatusLabel(trailer.status)}
                      />
                    ),
                  },
                  {
                    label: 'Open work orders',
                    value:
                      openOrders.length > 0 ? (
                        <span className="text-warning-text">
                          {openOrders.map((o) => o.number).join(', ')}
                        </span>
                      ) : (
                        'None'
                      ),
                  },
                ]}
              />
            </SectionCard>

            <SectionCard
              icon={<Wrench />}
              title="Trailer work orders"
              description="Maintenance work orders for this trailer."
              padding="none"
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Wrench />}
                  onClick={() => setCreatingWorkOrder(true)}
                >
                  Create work order
                </Button>
              }
              footer={unitOrders.loading ? 'Loading…' : `${unitOrders.rows.length} ${unitOrders.rows.length === 1 ? 'work order' : 'work orders'}`}
            >
              {unitOrders.loading && unitOrders.rows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">Loading…</p>
              ) : unitOrders.rows.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={<Wrench />}
                  title="No work orders on this trailer."
                  description="Every work order raised against this trailer appears here, open or finished."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" aria-label="Trailer work orders">
                    <thead className="bg-surface-muted text-xs text-muted">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">Work order</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-left font-medium">Vendor</th>
                        <th className="px-3 py-2 text-left font-medium">Opened</th>
                        <th className="px-4 py-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-soft">
                      {unitOrders.rows.map((order) => (
                        <tr key={order.id}>
                          <td className="px-4 py-2">
                            {order.source === 'server' ? (
                              <Link
                                to="/fleet/shop/$orderId"
                                params={{ orderId: order.id }}
                                className="font-medium text-primary-text hover:underline"
                              >
                                {order.number}
                              </Link>
                            ) : (
                              <Link
                                to="/fleet/maintenance/$orderId"
                                params={{ orderId: order.id }}
                                className="font-medium text-primary-text hover:underline"
                              >
                                {order.number}
                              </Link>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge status={order.status} size="sm" />
                          </td>
                          <td className="px-3 py-2">{order.summary}</td>
                          <td className="px-3 py-2">
                            {order.vendorName || <span className="text-faint">{DASH}</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {formatDate(order.openedAt)}
                          </td>
                          <td className="tabular px-4 py-2 text-right">
                            {order.total === null ? <span className="text-faint">{DASH}</span> : formatMoney(order.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <UnitDocumentsTab
            ownerType="trailer"
            ownerId={trailer.id}
            ownerLabel={`Trailer ${trailer.unitNumber}`}
          />
        </TabsContent>
      </Tabs>

      <CreateWorkOrderDialog
        open={creatingWorkOrder}
        onOpenChange={setCreatingWorkOrder}
        trucks={[]}
        trailers={[row]}
        defaultUnit={{ kind: 'trailer', id: trailer.id }}
        onDone={() => setCreatingWorkOrder(false)}
      />

      {editingIdentity ? (
        <EditTrailerIdentityDialog trailer={trailer} onClose={() => setEditingIdentity(false)} />
      ) : null}

      <UnitStatusDialog
        entity="trailer"
        id={trailer.id}
        status={trailer.status}
        label={`Trailer ${trailer.unitNumber}`}
        actionKey={statusAction}
        onOpenChange={(open) => {
          if (!open) setStatusAction(null);
        }}
      />
    </div>
  );
}

/** One end of the pairing diagram: an icon over a name and a one-line description. */
function PairTile({
  icon,
  title,
  subtitle,
  muted = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex w-44 flex-col items-center gap-2 rounded-lg border px-4 py-4 text-center',
        muted ? 'border-dashed border-line bg-surface-muted' : 'border-line-soft bg-surface',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-10 items-center justify-center rounded-lg [&_svg]:size-5',
          muted ? 'bg-neutral-soft text-neutral-text' : 'bg-primary-soft text-primary-text',
        )}
      >
        {icon}
      </span>
      <span className={cn('text-sm font-semibold', muted ? 'text-muted' : 'text-ink')}>
        {title}
      </span>
      <span className="text-xs text-muted">{subtitle}</span>
    </div>
  );
}

/**
 * What the trailer is hooked to, drawn as the pairing it is. Attaching and detaching is done from
 * the unit, which owns the pairing, so the two records cannot disagree about what is hooked to
 * what — this tab says so and sends people there.
 */
function AssignmentTab({ row, typeLabel }: { row: FleetTrailer; typeLabel: string }) {
  const { trailer, truck, currentLoad } = row;
  return (
    <SectionCard
      icon={<Link2 />}
      title="Current assignment"
      description={
        truck ? `Attached to unit ${truck.unitNumber}.` : 'This trailer is not attached to a truck.'
      }
      padding="md"
      actions={
        truck ? (
          <Button size="sm" variant="primary" asChild>
            <Link to="/fleet/trucks/$truckId" params={{ truckId: truck.id }}>
              <ExternalLink aria-hidden />
              Manage on truck
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="secondary" asChild>
            <Link to="/fleet/trucks">
              <ExternalLink aria-hidden />
              Open trucks
            </Link>
          </Button>
        )
      }
      footer={
        truck
          ? `Attach or detach this trailer from unit ${truck.unitNumber}.`
          : 'Attach this trailer from the unit that will pull it — the unit owns the pairing.'
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <PairTile
            icon={<Container />}
            title={`Trailer ${trailer.unitNumber}`}
            subtitle={typeLabel}
          />
          <span className="flex w-24 items-center" aria-hidden>
            <span className="h-px flex-1 border-t border-dashed border-line" />
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full border [&_svg]:size-4',
                truck
                  ? 'border-primary-border bg-primary-soft text-primary-text'
                  : 'border-line bg-surface-muted text-muted',
              )}
            >
              <Link2 />
            </span>
            <span className="h-px flex-1 border-t border-dashed border-line" />
          </span>
          {truck ? (
            <PairTile icon={<Truck />} title={`Unit ${truck.unitNumber}`} subtitle="Truck" />
          ) : (
            <PairTile icon={<Truck />} title="No truck" subtitle="Unassigned" muted />
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 sm:divide-x sm:divide-line-soft">
          <div className="flex items-center gap-3 sm:pr-4">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-4"
            >
              <User />
            </span>
            <span className="min-w-0">
              <span className="eyebrow block">Driver</span>
              <span
                className={cn(
                  'block text-sm',
                  truck?.currentDriverName ? 'font-medium text-ink' : 'text-faint',
                )}
              >
                {truck?.currentDriverName ?? 'No driver'}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 sm:pl-4">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-4"
            >
              <Package />
            </span>
            <span className="min-w-0">
              <span className="eyebrow block">Current load</span>
              {currentLoad ? (
                <Link
                  to="/loads/$loadNumber"
                  params={{ loadNumber: currentLoad.loadNumber }}
                  className="block text-sm font-medium text-primary-text hover:underline"
                >
                  {currentLoad.loadNumber}
                </Link>
              ) : (
                <span className="block text-sm text-faint">No load attached</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
