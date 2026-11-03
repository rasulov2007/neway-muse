import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { LEASE_PLAN_LABEL, ageOn, isRestrictedDriverProfileViewer, type AuthAccount, type EmployeePage } from '@neway/shared';
import { today } from '@/lib/clock';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  cn,
  Breadcrumb,
  Button,
  Card,
  DropdownMenu,
  ErrorState,
  IconButton,
  MenuItem,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
} from '@/design-system';
import {
  Banknote,
  ChevronRight,
  EllipsisVertical,
  IdCard,
  Palmtree,
  Pencil,
  ShieldCheck,
  Truck,
  Unlink,
  User,
  UserPlus,
  Wallet,
} from 'lucide-react';
import { apiGet } from '@/lib/api-client';
import { useAccount } from '@/features/auth/auth-context';
import { hrefs } from '@/features/dashboard/links';
import { formatIsoDate, formatMoney, formatPhone } from '@/lib/format';

const SECONDARY_PHONE_LABEL: Record<string, string> = {
  cell: 'Cell',
  home: 'Home',
  spouse: 'Spouse',
  dispatch_only: 'Dispatch only',
};
import { DRIVER_AVAILABILITY_LABEL, DRIVER_AVAILABILITY_TONE } from './operations-ui';
import { AssignTruckDialog } from './AssignTruckDialog';
import { LoadsTab, PerformanceTab } from './DriverSections';
import { DriverDocumentsTab } from './DriverDocumentsTab';
import { DriverCdlDocument } from './DriverCdlDocument';
import { DriverCostsTab, DriverOnboardingTab, DriverSafetyTab } from './DriverHiringTabs';
import { DriverPaymentCard } from './DriverPaymentCard';
import { DriverAppAccessCard } from './DriverAppAccessCard';
import { EditDriverDialog, canSeeDateOfBirth } from './EditDriverDialog';
import { DRIVER_TYPE_LABEL } from './operations-ui';
import { DriverEscrowPanel } from './DriverEscrowPanel';
import { useOperations, type OperationalDriver } from './useOperations';
import { DriverFinancialAccountTab, planLabel } from './DriverFinancialAccountTab';
import { DispatcherFact } from './DriverDispatcherButton';
import { BoardDispatcherFact, canSeeBoardDispatcher } from './DriverBoardDispatcher';
import { InvestigationPanel } from '@/features/fleet/expenses/investigations';
import { DriverChargesPanel } from '@/features/safety/v2/claims/DriverChargesPanel';
import { fetchDriverAccount } from '@/demo';
import { ManageVacationModal, SendOnVacationModal, VacationBanner, VacationSection } from './DriverVacation';
import { currentVacation, useCanManageVacations, useDriverVacations } from './vacation-api';
import { PairDriverModal, TeamBadge, TeamHistory, UnpairDriverModal } from './DriverTeam';
import { teamsByDriver, useCanManageTeams, useDriverTeam, useDriverTeams } from './team-api';

const TABS = [
  { value: 'profile', label: 'Profile' },
  { value: 'performance', label: 'Performance' },
  { value: 'documents', label: 'Documents' },
  // The hiring record the driver came through (owner brief, 2026-10-11).
  { value: 'safety', label: 'Safety' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'costs', label: 'Costs' },
  { value: 'loads', label: 'Loads' },
  { value: 'financial', label: 'Financial account' },
];

/**
 * The restricted view (owner, 2026-10-26): only Accounting and the Administrator (drivers.view_pay)
 * see the full profile; everybody else sees the three profile cards and the CDL, nothing else.
 * The rule lives in `@neway/shared`.
 */
function seesRestrictedDriverProfile(account: AuthAccount | null): boolean {
  return account ? isRestrictedDriverProfileViewer(account.permissions) : false;
}

export function DriverProfileRoute() {
  const { driverId } = useParams({ from: '/drivers/$driverId' });
  return <DriverProfilePage driverId={driverId} />;
}

/**
 * One driver, whole, on a page rather than in a drawer: who they are, what licence and medical
 * standing lets them run, what they are assigned to, and how their work is paid and organised.
 *
 * Nothing here is a second copy. The licence and medical dates come from the driver record, the
 * requirement verdicts from Safety, and the pay plan from the driver's own plan — the employee
 * record is linked, never duplicated, so a rate can never disagree with itself.
 */
/**
 * The unit this driver came out of, from the audit trail.
 *
 * Not a field on the driver: the trail already records every assignment with the unit it replaced,
 * and a second copy of that fact is one that goes stale the first time somebody edits the other.
 */
function usePreviousUnit(driverId: string): string | null {
  const history = useQuery({
    queryKey: ['audit', 'driver', driverId, 'truck'],
    queryFn: () =>
      apiGet<{ data: Array<{ summary: string; changes?: Array<Record<string, unknown>> }> }>(
        `/admin/audit?entityType=driver&entityId=${encodeURIComponent(driverId)}&pageSize=20`,
      ).catch(() => ({ data: [] })),
  });
  for (const entry of history.data?.data ?? []) {
    const change = (entry.changes ?? []).find((c) => c.field === 'currentTruckUnit');
    const old = change?.old;
    if (typeof old === 'string' && old.trim() !== '') return old;
  }
  return null;
}

export function DriverProfilePage({ driverId }: { driverId: string }) {
  const navigate = useNavigate();
  const query = useOperations();
  const searchTab = (useSearch({ strict: false }) as { tab?: unknown }).tab;
  const [tab, setTab] = useState(typeof searchTab === 'string' && TABS.some((t) => t.value === searchTab) ? searchTab : 'profile');

  const row = query.data?.byDriverId.get(driverId) ?? null;
  // Vacation (owner mockup, 2026-10-17): the overflow menu starts it, the banner and Manage vacation run it.
  const vacations = useDriverVacations(driverId);
  const away = currentVacation(vacations.data);
  const canVacation = useCanManageVacations();
  const viewer = useAccount();
  const canSeeSafety = viewer?.permissions.includes('safety.view') ?? false;
  // A hidden tab named in the URL (?tab=costs) still draws the dispatch view: there are no tabs.
  const restricted = seesRestrictedDriverProfile(viewer);
  const [vacationDialog, setVacationDialog] = useState<'send' | 'manage' | null>(null);
  // Team or Solo (owner, 2026-10-25): Pair / Unpair from the overflow menu.
  const team = useDriverTeam(driverId);
  const canTeam = useCanManageTeams();
  const [teamDialog, setTeamDialog] = useState<'pair' | 'unpair' | null>(null);
  // Only fetched for the Pair dialog: who is already in a team.
  const allTeams = useDriverTeams(teamDialog === 'pair');

  if (query.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title="This driver could not be loaded"
        description="Please try again."
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!row) {
    return (
      <ErrorState
        title="No such driver"
        description="This driver is not in the roster. They may have been archived."
        onRetry={() => void navigate({ to: '/drivers' })}
        retrying={false}
      />
    );
  }

  const d = row.driver;
  const availability = row.availability;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <Breadcrumb
        items={[{ label: 'Operations' }, { label: 'Drivers', href: '/drivers' }, { label: d.name }]}
      />
      <PageHeader
        title={d.name}
        meta={away ? <StatusBadge status="vacation" label="On vacation" /> : undefined}
        description={`Driver ${d.driverNumber} · ${DRIVER_TYPE_LABEL[d.driverType] ?? d.driverType}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {row.currentLoad ? (
              <Button
                size="sm"
                onClick={() => void navigate({ to: hrefs.load(row.currentLoad!.loadNumber) })}
              >
                Open current load
              </Button>
            ) : null}
            {restricted ? null : (
              <Button variant="secondary" size="sm" onClick={() => void navigate({ to: '/safety' })}>
                Open safety
              </Button>
            )}
            {(canVacation && (away || ['available', 'off_duty'].includes(d.status))) || (canTeam && team.isSuccess) ? (
              <DropdownMenu
                trigger={
                  <IconButton label="More actions" variant="secondary" size="sm" data-testid="driver-more">
                    <EllipsisVertical />
                  </IconButton>
                }
              >
                {canVacation && away ? (
                  <MenuItem icon={<Palmtree />} onSelect={() => setVacationDialog('manage')}>Manage vacation</MenuItem>
                ) : canVacation && ['available', 'off_duty'].includes(d.status) ? (
                  <MenuItem icon={<Palmtree />} onSelect={() => setVacationDialog('send')}>Send on vacation</MenuItem>
                ) : null}
                {canTeam && team.isSuccess ? (
                  team.data.current ? (
                    <MenuItem icon={<Unlink />} onSelect={() => setTeamDialog('unpair')} data-testid="driver-unpair">Unpair</MenuItem>
                  ) : (
                    <MenuItem icon={<UserPlus />} onSelect={() => setTeamDialog('pair')} data-testid="driver-pair">Pair</MenuItem>
                  )
                ) : null}
              </DropdownMenu>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {restricted ? null : (
          <>
            <span className="text-xs text-muted">Employment</span>
            <StatusBadge status={d.status} size="sm" />
          </>
        )}
        <span className={cn('text-xs text-muted', !restricted && 'ml-2')}>Dispatch</span>
        <Badge tone={DRIVER_AVAILABILITY_TONE[availability.state]} size="sm">
          {DRIVER_AVAILABILITY_LABEL[availability.state]}
        </Badge>
        <span className="text-sm text-secondary">
          {availability.assignable ? 'Can take a load now' : 'Cannot take a load now'}
        </span>
      </div>

      {away ? <VacationBanner vacation={away} canManage={canVacation} onManage={() => setVacationDialog('manage')} /> : null}
      {restricted ? null : <VacationSection
        driverId={d.id}
        dispatcherName={d.dispatcherName ?? null}
        safetySlot={(v) =>
          v.drugTestRequired && canSeeSafety ? (
            <Link to="/safety/vacation-returns" search={{ vacation: v.id } as never} className="mt-2 inline-block text-sm font-semibold text-nw-accent-ink underline">
              Open Safety review →
            </Link>
          ) : null
        }
      />}
      {vacationDialog === 'send' ? <SendOnVacationModal driverId={d.id} driverName={d.name} onClose={() => setVacationDialog(null)} /> : null}
      {vacationDialog === 'manage' && away ? <ManageVacationModal driverId={d.id} driverName={d.name} vacation={away} onClose={() => setVacationDialog(null)} /> : null}

      {teamDialog === 'pair' ? (
        allTeams.isSuccess ? (
          <PairDriverModal
            driverId={d.id}
            driverName={d.name}
            drivers={(query.data?.drivers ?? []).map((r) => r.driver)}
            pairedIds={new Set(teamsByDriver(allTeams.data).keys())}
            onClose={() => setTeamDialog(null)}
          />
        ) : null
      ) : null}
      {teamDialog === 'unpair' && team.data?.current ? (
        <UnpairDriverModal driverId={d.id} driverName={d.name} team={team.data.current} onClose={() => setTeamDialog(null)} />
      ) : null}

      <FactStrip
        row={row}
        restricted={restricted}
        team={team.isError ? <span className="text-xs text-nw-text-3">Not available</span> : <TeamBadge team={team.data?.current ?? null} pending={team.isPending} />}
      />
      {restricted ? (
        <>
          <ProfileTab row={row} restricted />
          <DriverCdlDocument row={row} />
        </>
      ) : (
        <FullProfileSections row={row} tab={tab} setTab={setTab} teamHistory={team.data ? <TeamHistory history={team.data.history} /> : null} />
      )}
    </div>
  );
}

/** Everything past the facts that only the back office sees: history, panels and the tabs. */
function FullProfileSections({
  row,
  tab,
  setTab,
  teamHistory,
}: {
  row: OperationalDriver;
  tab: string;
  setTab: (tab: string) => void;
  teamHistory: ReactNode;
}) {
  return (
    <>
      {teamHistory}

      {/* Repairs and expenses held under investigation with this driver named (owner, 2026-10-13): nothing deducted yet. */}
      <InvestigationPanel query={{ driverId: row.driver.id }} hideDriver emptyHidden title="Under investigation with this driver" />

      {/* Claim charges with this driver (Claims v2): deductibles and chargebacks, open and recovered. */}
      <DriverChargesPanel driverId={row.driver.id} />

      <Tabs items={TABS} value={tab} onValueChange={setTab} aria-label="Driver">
        <TabsContent value="profile" className="pt-4">
          <ProfileTab row={row} />
        </TabsContent>
        <TabsContent value="performance" className="pt-4">
          <PerformanceTab row={row} />
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <DriverDocumentsTab row={row} />
        </TabsContent>
        <TabsContent value="safety" className="pt-4">
          <DriverSafetyTab driverId={row.driver.id} />
        </TabsContent>
        <TabsContent value="onboarding" className="pt-4">
          <DriverOnboardingTab driverId={row.driver.id} />
        </TabsContent>
        <TabsContent value="costs" className="pt-4">
          <DriverCostsTab driverId={row.driver.id} />
        </TabsContent>
        <TabsContent value="loads" className="pt-4">
          <LoadsTab row={row} />
        </TabsContent>
        <TabsContent value="financial" className="pt-4">
          <DriverFinancialAccountTab driverId={row.driver.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/** The four answers a dispatcher wants before reading anything else. */
function FactStrip({ row, team, restricted }: { row: OperationalDriver; team: ReactNode; restricted: boolean }) {
  const d = row.driver;
  if (restricted) {
    // No pay plan, no hire date, nothing else (owner, 2026-10-26).
    return (
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Fact label="Current truck" value={d.currentTruckUnit ?? 'Unassigned'} />
        <Fact label="Team" value={team} />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <Fact label="Current truck" value={d.currentTruckUnit ?? 'Unassigned'} />
      <Fact label="Team" value={team} />
      <Fact label="Driver type" value={DRIVER_TYPE_LABEL[d.driverType] ?? d.driverType} />
      <Fact label="Pay plan" value={<PayPlanFact driverId={d.id} fallback={payPlanLabel(d.payPlan)} />} />
      <Fact label="Hired" value={formatIsoDate(d.hireDate)} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

/** The roster's own words for the plan, used only until the canonical account answers. */
function payPlanLabel(plan: { kind: 'per_mile' | 'percent_of_linehaul' | 'lease_owner' | 'lease_to_own' | 'owner_truck'; rate: number }): string {
  if (plan.kind === 'lease_owner' || plan.kind === 'lease_to_own' || plan.kind === 'owner_truck') return `${LEASE_PLAN_LABEL[plan.kind]} · gross less lease charges`;
  return plan.kind === 'per_mile'
    ? `${formatMoney(plan.rate)} / mile`
    : `${plan.rate}% of linehaul`;
}

/**
 * Date of birth (owner, 2026-10-25): the calendar day as recorded, never shifted by a zone, and
 * the age on the server's Eastern today. Personal data; the API masks it with the licence group.
 */
function DateOfBirthFact({ value, restricted = false }: { value: string | null; restricted?: boolean }) {
  // A masked date is not a missing one: say which (owner, 2026-10-26).
  if (!value && restricted) return <span className="text-muted">Restricted</span>;
  if (!value) return <span className="text-muted">Not recorded</span>;
  const age = ageOn(value, today());
  return (
    <>
      {formatIsoDate(value)}
      {age !== null ? <span className="block text-xs text-muted">{age} years old</span> : null}
    </>
  );
}

/**
 * The pay plan as the one driver finance account reads it (corrective brief, section 5): the
 * same plan, basis and reading the settlement uses. An ambiguous roster figure says so here
 * instead of being shown as a confident percent.
 */
function PayPlanFact({ driverId, fallback }: { driverId: string; fallback: string }) {
  const account = useQuery({ queryKey: ['accounting', 'driver-account', driverId], queryFn: () => fetchDriverAccount(driverId) });
  if (account.isPending) return <>Loading…</>;
  if (account.isError || !account.data.profile.current) return <>{fallback}</>;
  const a = account.data;
  const current = a.profile.current!;
  const label = planLabel(current.loadedPlan);
  if (a.rate && a.rate.ambiguous && !a.rate.confirmed) {
    return <span title={`Roster figure ${a.rate.percent}: ${a.rate.asPercent} as a percent, ${a.rate.asMultiplier} as a multiplier`}>{label} <Badge tone="warning" size="sm">Unconfirmed</Badge></span>;
  }
  return <>{label}</>;
}

/** The profile itself: identity, licence, assignment, and where the money and the org chart run. */
function ProfileTab({ row, restricted = false }: { row: OperationalDriver; restricted?: boolean }) {
  const d = row.driver;
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState<'contact' | 'cdl' | null>(null);
  const previousUnit = usePreviousUnit(d.id);
  // Unknown (no account yet) reads as allowed: the server decides, the screen only explains.
  const account = useAccount();
  const canSeeBirth = account ? canSeeDateOfBirth(account.permissions) : true;

  return (
    <div className="flex flex-col gap-4">
      {/* Three cards across, each with its Edit: the owner's profile (2026-09-21). */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ProfileCard
          icon={<User />}
          title="Contact information"
          onEdit={() => setEditing('contact')}
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Definition label="Phone">{formatPhone(d.phone)}</Definition>
            <Definition label="Email">{d.email}</Definition>
            {d.secondaryPhone ? (
              <Definition label="Secondary phone">
                {formatPhone(d.secondaryPhone)}
                {d.secondaryPhoneLabel ? (
                  <span className="block text-xs text-muted">
                    {SECONDARY_PHONE_LABEL[d.secondaryPhoneLabel]}
                  </span>
                ) : null}
              </Definition>
            ) : null}
            <Definition label="Home terminal">
              {d.homeCity}, {d.homeState}
            </Definition>
            <Definition label="Preferred language">{d.preferredLanguage.toUpperCase()}</Definition>
            <Definition label="Date of birth">
              <DateOfBirthFact value={d.dateOfBirth ?? null} restricted={!canSeeBirth} />
            </Definition>
          </dl>
        </ProfileCard>
        <ProfileCard
          icon={<Truck />}
          title="Assignment and equipment"
          onEdit={() => setAssigning(true)}
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Definition label="Truck">
              <span className="flex flex-wrap items-center gap-2">
                {d.currentTruckUnit ? (
                  <Link
                    to={hrefs.truck(d.currentTruckUnit)}
                    className="text-primary-text hover:underline"
                  >
                    {d.currentTruckUnit}
                  </Link>
                ) : (
                  <span className="text-muted">Unassigned</span>
                )}
                <Button size="sm" variant="link" onClick={() => setAssigning(true)}>
                  {d.currentTruckUnit ? 'Change' : 'Assign'}
                </Button>
              </span>
              {previousUnit ? (
                // What they came out of, read from the audit trail rather than kept as a second copy.
                <span className="mt-0.5 block text-xs text-muted">
                  Previously unit {previousUnit}
                </span>
              ) : null}
            </Definition>
            {account && canSeeBoardDispatcher(account.permissions) ? (
              <Definition label="Dispatcher">
                <BoardDispatcherFact driverId={d.id} driverName={d.name} />
              </Definition>
            ) : null}
            <Definition label="Trailer">
              {row.currentLoad?.trailerUnit ?? <span className="text-muted">None</span>}
            </Definition>
            <Definition label="Current load">
              {row.currentLoad ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to={hrefs.load(row.currentLoad.loadNumber)}
                    className="text-primary-text hover:underline"
                  >
                    {row.currentLoad.loadNumber}
                  </Link>
                  <StatusBadge status={row.currentLoad.status} size="sm" />
                </span>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Definition>
            <Definition label="Lane">
              {row.currentLoad ? (
                <span className="whitespace-nowrap">
                  {row.currentLoad.origin.city}, {row.currentLoad.origin.state}
                  <span className="text-faint"> → </span>
                  {row.currentLoad.destination.city}, {row.currentLoad.destination.state}
                </span>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Definition>
          </dl>
        </ProfileCard>
        <ProfileCard icon={<IdCard />} title="CDL information" onEdit={() => setEditing('cdl')}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Definition label="Class">{d.cdlClass}</Definition>
            <Definition label="State">{d.cdlState}</Definition>
            <Definition label="Expires">
              <span className="flex flex-wrap items-center gap-2">
                {formatIsoDate(d.cdlExpiresOn)}
                <StatusBadge status={d.cdlStatus} size="sm" />
              </span>
            </Definition>
            <Definition label="Medical card">
              <span className="flex flex-wrap items-center gap-2">
                {formatIsoDate(d.medicalCardExpiresOn)}
                <StatusBadge status={d.medicalCardStatus} size="sm" />
              </span>
            </Definition>
            <Definition label="Endorsements">
              {d.cdlEndorsements.length > 0 ? (
                <span className="flex flex-wrap gap-1">
                  {d.cdlEndorsements.map((code) => (
                    <Badge key={code} tone="neutral" size="sm">
                      {code}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Definition>
          </dl>
        </ProfileCard>
      </div>

      {restricted ? null : <DriverAppAccessCard driverId={d.id} driverName={d.name} />}

      {assigning ? <AssignTruckDialog driver={d} onClose={() => setAssigning(false)} /> : null}
      {editing ? (
        <EditDriverDialog
          driver={d}
          section={editing}
          canEditBirth={canSeeBirth}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {restricted ? null : <BackOfficeProfileCards row={row} />}
    </div>
  );
}

/** Pay, escrow, organization and availability: the back office's part of the profile. */
function BackOfficeProfileCards({ row }: { row: OperationalDriver }) {
  const d = row.driver;
  const employee = useLinkedEmployee(d.id, d.name);
  return (
    <>
      <DriverPaymentCard driverId={d.id} />

      <Card
        padding="md"
        title={
          <span className="flex items-center gap-2">
            <Wallet className="size-4 text-primary" aria-hidden />
            Escrow and employment
          </span>
        }
      >
        <DriverEscrowPanel
          driverId={d.id}
          driverName={d.name}
          terminated={d.status === 'terminated'}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionRow
          icon={<Banknote />}
          title="Pay and organization"
          description="Where this driver's money goes and who they report to"
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Definition label="Pay plan"><PayPlanFact driverId={d.id} fallback={payPlanLabel(d.payPlan)} /></Definition>
            <Definition label="Paid through">Driver settlements</Definition>
            <Definition label="Dispatcher">
              <DispatcherFact driverId={d.id} dispatcherId={d.dispatcherId} dispatcherName={d.dispatcherName} />
            </Definition>
            <Definition label="Employment">
              {DRIVER_TYPE_LABEL[d.driverType] ?? d.driverType}
            </Definition>
            {employee.record ? (
              <>
                <Definition label="Department">{employee.record.department}</Definition>
                <Definition label="Manager">{employee.record.managerName ?? 'None'}</Definition>
                <Definition label="Employee ID">{employee.record.employeeNumber}</Definition>
                <Definition label="Location">
                  {employee.record.location ?? 'Not recorded'}
                </Definition>
              </>
            ) : null}
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Link
              to="/accounting/settlements"
              search={{ driver: d.id } as never}
              className="text-sm text-primary-text hover:underline"
            >
              Open settlements
            </Link>
            {employee.record ? (
              <Link
                to="/hr/employees/$employeeId"
                params={{ employeeId: employee.record.id }}
                className="text-sm text-primary-text hover:underline"
              >
                Open employee record
              </Link>
            ) : employee.isPending ? (
              <span className="text-sm text-faint">Looking for the employee record…</span>
            ) : (
              <span className="text-sm text-faint">
                No employee record is linked to this driver, so department and manager cannot be
                shown.
              </span>
            )}
          </div>
        </SectionRow>
        <SectionRow icon={<ShieldCheck />} title="Availability">
          {row.availability.blocker ? (
            <p className="mb-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-text">
              {row.availability.blocker}
            </p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {row.availability.reasons.map((reason) => (
              <li key={reason} className="text-xs text-muted">
                · {reason}
              </li>
            ))}
          </ul>
        </SectionRow>
      </div>
    </>
  );
}

/** A profile card: icon, title, Edit on the right, the facts underneath. Always open. */
function ProfileCard({
  icon,
  title,
  onEdit,
  children,
}: {
  icon: ReactNode;
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-nw-border px-5 py-3">
        <span className="flex size-5 shrink-0 items-center justify-center text-primary [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{title}</span>
        <Button variant="link" size="sm" icon={<Pencil />} onClick={onEdit}>
          Edit
        </Button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

/**
 * One collapsible section of the profile, drawn as a row: icon, title, chevron. Closed it is a
 * single line, which is what makes a long profile readable; open it shows the facts underneath.
 */
function SectionRow({
  icon,
  title,
  description,
  defaultOpen = false,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card padding="none" className={cn('overflow-hidden', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors duration-(--duration-fast) hover:bg-surface-hover"
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-primary [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          {description ? <span className="block text-xs text-muted">{description}</span> : null}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted transition-transform duration-(--duration-base)',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? <div className="border-t border-line-soft px-5 py-4">{children}</div> : null}
    </Card>
  );
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * The employee record behind a driver. The people API has no driver-id filter, so the driver's
 * name narrows the search and the `driverId` link decides the match — a name alone is never
 * treated as proof.
 */
function useLinkedEmployee(driverId: string, name: string) {
  const query = useQuery({
    queryKey: ['employees', 'by-driver', driverId, name],
    // The people search matches one name column at a time, so the surname is the widest net that
    // still returns a short list; the `driverId` link is what actually decides the match.
    queryFn: () =>
      apiGet<EmployeePage>('/employees', {
        search: name.trim().split(/\s+/).at(-1) ?? name,
        pageSize: 50,
      }),
  });
  const record = useMemo(
    () => query.data?.data.find((person) => person.driverId === driverId) ?? null,
    [query.data, driverId],
  );
  return { record, isPending: query.isPending };
}
