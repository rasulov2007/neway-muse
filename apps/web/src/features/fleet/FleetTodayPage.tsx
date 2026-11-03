import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Container,
  Droplet,
  FileWarning,
  Gauge,
  Package,
  Search,
  Truck,
  User,
  VideoOff,
  Wrench,
  ArrowRight,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { SHOP_STAGE_LABEL, queuesFor, type InShopRow, type PtiBoardRow } from '@neway/shared';
import { listTrailers, listTrucks } from '@/demo';
import {
  Badge,
  Button,
  Card,
  PageHeader,
  StatusSymbol,
  cn,
  type StatusSymbolFamily,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useCompliance } from '@/features/safety/useCompliance';
import { entityKey } from '@/features/safety/compliance-ui';
import { nowMs } from '@/lib/clock';
import { isEnabled } from '@/lib/feature-flags';
import { formatDate, formatMoney } from '@/lib/format';
import { usePmBoard } from './pm/api';
import { isOverdue } from './pm/board-model';
import { usePtiBoard } from './pti/api';
import { useFleetExpense } from './useFleetExpense';
import { CreateWorkOrderDialog } from './components/CreateWorkOrderDialog';
import { useFleetToday } from './useFleetToday';

const n = (v: number) => v.toLocaleString('en-US');
const PAGE = 8;

type Category = 'oil' | 'shop' | 'documents' | 'pti';
const CATEGORY_LABEL: Record<Category, string> = {
  oil: 'Oil',
  shop: 'Shop',
  documents: 'Documents',
  pti: 'PTI',
};

interface Decision {
  key: string;
  category: Category;
  unitLabel: string;
  unitLink: { to: '/fleet/trucks/$truckId'; params: { truckId: string } } | null;
  secondary: string;
  icon: 'truck' | 'trailer' | 'driver';
  issue: string;
  detail: string;
  /** Lower sorts first. */
  rank: number;
  priorityLabel: string;
  priorityFamily: StatusSymbolFamily;
  action: string;
  onAction: () => void;
}

/**
 * Fleet today as the owner drew it (2026-09-20): eight numbers, one decision list, the shop and
 * this month's spend. Nothing here is computed on this page - each number is a board's own count
 * (the PM engine, the pre-trip board, the compliance engine, the shop's orders, the spend
 * summary) and the list under them is those boards' rows, worst first, each with the one action
 * that clears it.
 */
export function FleetTodayPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const seesCost = account?.permissions.includes('maintenance_costs.view') ?? false;
  const pmOn = isEnabled('pm_module');

  const today = useFleetToday();
  const pm = usePmBoard();
  const pti = usePtiBoard();
  const compliance = useCompliance();
  const spend = useFleetExpense({ period: 'month', unitType: 'all', units: [] });
  const trucks = useQuery({
    queryKey: ['roster', 'count', 'trucks'],
    queryFn: () => listTrucks({ pageSize: 1 }),
  });
  const trailers = useQuery({
    queryKey: ['roster', 'count', 'trailers'],
    queryFn: () => listTrailers({ pageSize: 1 }),
  });

  const [category, setCategory] = useState<Category | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  // The company clock, read once per visit: a promised date is late against it, not the browser's.
  const [now] = useState(() => nowMs());

  // ---- the numbers, each from the board that owns it ------------------------------------
  const pmRows = useMemo(() => pm.data?.rows ?? [], [pm.data]);
  const ptiRows = useMemo(() => pti.data?.rows ?? [], [pti.data]);
  const inShop = useMemo(() => today.data?.workOrdersInShop ?? [], [today.data]);
  const held = useMemo(
    () => (compliance.data?.entities ?? []).filter((e) => !e.dispatchable),
    [compliance.data],
  );
  const oilOverdue = pmOn
    ? pm.data
      ? pm.data.summary.overdue
      : undefined
    : today.data?.counts.oilOverdue;
  const oilDueSoon = pmOn
    ? pm.data
      ? pm.data.summary.dueSoon
      : undefined
    : today.data?.counts.oilDueSoon;
  const ptiUnresolved = pti.data
    ? ptiRows.filter((r) => r.openDefects.some(unactioned)).length
    : undefined;
  const walkMissing = pti.data
    ? ptiRows.filter((r) => queuesFor(r).includes('chase')).length
    : undefined;
  const walkPending = ptiRows.filter((r) => queuesFor(r).includes('review')).length;
  const waitingParts = today.data
    ? inShop.filter((w) => w.shopStage === 'waiting_parts').length
    : undefined;
  const pastPromised = inShop.filter(
    (w) => w.scheduledFor && Date.parse(w.scheduledFor) < now,
  ).length;
  const docsHolding = compliance.data ? held.length : undefined;
  const docsExpired = compliance.data?.summary.expired ?? 0;
  const docsMissing = compliance.data?.summary.missing ?? 0;
  const dotSoon = today.data
    ? today.data.inspections.filter(
        (i) => i.inspectionType === 'annual_inspection' && i.status !== 'ok',
      ).length
    : undefined;

  // ---- the decision list --------------------------------------------------------------------
  const decisions = useMemo<Decision[]>(() => {
    const out: Decision[] = [];
    for (const e of held) {
      const blocker = e.items.find((i) => i.blocksDispatch);
      const scopeWord =
        e.scope === 'driver' ? 'driver' : e.scope === 'trailer' ? 'trailer' : 'unit';
      out.push({
        key: `doc:${entityKey(e.scope, e.entityId)}`,
        category: 'documents',
        unitLabel: e.scope === 'truck' ? `Unit ${e.entityLabel}` : e.entityLabel,
        unitLink:
          e.scope === 'truck'
            ? { to: '/fleet/trucks/$truckId', params: { truckId: e.entityId } }
            : null,
        secondary: e.scope === 'driver' ? 'Driver' : e.scope === 'trailer' ? 'Trailer' : 'Truck',
        icon: e.scope === 'driver' ? 'driver' : e.scope === 'trailer' ? 'trailer' : 'truck',
        issue: blocker?.requirementName ?? 'Compliance hold',
        detail: `${blocker?.reasons[0] ?? e.gateReasons[0] ?? 'Hold'} — ${scopeWord} cannot be dispatched`,
        rank: 0,
        priorityLabel: 'Dispatch held',
        priorityFamily: 'urgent',
        action: 'Attach document',
        onAction: () =>
          void navigate({
            to: '/safety',
            search: { group: 'entity', entity: entityKey(e.scope, e.entityId) } as never,
          }),
      });
    }
    for (const r of pmRows) {
      if (!isOverdue(r)) continue;
      const over =
        r.dueStatus === 'overdue'
          ? Math.max(0, -(r.milesRemaining ?? 0))
          : (r.milesOverAtReading ?? 0);
      out.push({
        key: `oil:${r.unitId}`,
        category: 'oil',
        unitLabel: `Unit ${r.unitNumber}`,
        unitLink: { to: '/fleet/trucks/$truckId', params: { truckId: r.unitId } },
        secondary: r.driverName ?? 'No driver',
        icon: 'truck',
        issue: 'Oil change',
        detail: `${n(over)} mi past the ${r.intervalMiles ? n(r.intervalMiles) : '—'} mi interval${r.appointment ? ` · booked ${formatDate(r.appointment.scheduledFor)}` : ''}`,
        rank: 1,
        priorityLabel: 'Overdue',
        priorityFamily: 'warning',
        action: r.appointment ? 'Log oil change' : 'Book oil service',
        onAction: () =>
          void navigate({
            to: '/fleet/oil-change',
            search: { sheet: r.appointment ? 'record' : 'schedule', unit: r.unitId } as never,
          }),
      });
    }
    for (const r of ptiRows) {
      const defect = r.openDefects.find(unactioned);
      if (!defect) continue;
      out.push({
        key: `pti:${r.inspection.unitId}`,
        category: 'pti',
        unitLabel: `Unit ${r.inspection.unitNumber}`,
        unitLink: { to: '/fleet/trucks/$truckId', params: { truckId: r.inspection.unitId } },
        secondary: r.inspection.driverName ?? 'No driver',
        icon: 'truck',
        issue: defect.componentName,
        detail: `${defect.defectNumber} · open ${r.ageDays}d — no action recorded`,
        rank: defect.severity === 'oos_risk' ? 0 : 1,
        priorityLabel: defect.severity === 'oos_risk' ? 'Out of service' : 'Open defect',
        priorityFamily: defect.severity === 'oos_risk' ? 'urgent' : 'warning',
        action: 'Assign owner',
        onAction: () =>
          void navigate({ to: '/fleet/pti', search: { review: r.inspection.unitId } as never }),
      });
    }
    for (const w of inShop) {
      const late = w.scheduledFor && Date.parse(w.scheduledFor) < now;
      if (w.shopStage !== 'waiting_parts' && !late) continue;
      out.push({
        key: `shop:${w.workOrderId}`,
        category: 'shop',
        unitLabel: w.assetType === 'trailer' ? w.unitNumber : `Unit ${w.unitNumber}`,
        unitLink:
          w.assetType === 'truck'
            ? { to: '/fleet/trucks/$truckId', params: { truckId: w.unitId } }
            : null,
        secondary: w.vendorName ?? 'No shop named',
        icon: w.assetType === 'trailer' ? 'trailer' : 'truck',
        issue: w.label,
        detail: late
          ? `Promised ${formatDate(w.scheduledFor as string)} — past the date`
          : `${SHOP_STAGE_LABEL[w.shopStage as keyof typeof SHOP_STAGE_LABEL]} · ${w.number}`,
        rank: late ? 1 : 2,
        priorityLabel: late ? 'Past promised' : 'Waiting on parts',
        priorityFamily: late ? 'warning' : 'neutral',
        action: 'Open order',
        onAction: () =>
          void navigate({ to: '/fleet/shop/$orderId', params: { orderId: w.workOrderId } }),
      });
    }
    return out.sort(
      (a, b) =>
        a.rank - b.rank || a.unitLabel.localeCompare(b.unitLabel, undefined, { numeric: true }),
    );
  }, [held, pmRows, ptiRows, inShop, navigate, now]);

  const counts = useMemo(() => {
    const c: Record<Category | 'all', number> = {
      all: decisions.length,
      oil: 0,
      shop: 0,
      documents: 0,
      pti: 0,
    };
    for (const d of decisions) c[d.category] += 1;
    return c;
  }, [decisions]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return decisions.filter(
      (d) =>
        (category === 'all' || d.category === category) &&
        (!q || `${d.unitLabel} ${d.secondary} ${d.issue} ${d.detail}`.toLowerCase().includes(q)),
    );
  }, [decisions, category, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PAGE, current * PAGE);

  const loadingCounts =
    today.isPending || pti.isPending || compliance.isPending || (pmOn && pm.isPending);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Fleet today"
        description={
          trucks.data && trailers.data
            ? `${trucks.data.total} trucks · ${trailers.data.total} trailers`
            : 'Loading…'
        }
        actions={
          <>
            {/* Breakdowns drivers reported from the road (mobile M3): the open count, the new ones called out. */}
            {today.data?.counts.breakdownsOpen ? (
              <Link to="/fleet/breakdowns" aria-label={`${today.data.counts.breakdownsOpen} breakdowns open`} className="rounded-sm focus-visible:outline-2 focus-visible:outline-nw-accent">
                <Badge tone={today.data.counts.breakdownsNew ? 'warning' : 'info'} size="sm" dot data-testid="breakdowns-badge">
                  {today.data.counts.breakdownsOpen} breakdown{today.data.counts.breakdownsOpen === 1 ? '' : 's'} open
                  {today.data.counts.breakdownsNew ? ` · ${today.data.counts.breakdownsNew} new` : ''}
                </Badge>
              </Link>
            ) : null}
            {compliance.data && compliance.data.summary.notDispatchable > 0 ? (
              <Badge tone="danger" size="sm">
                <StatusSymbol family="urgent" size={12} className="text-nw-urgent-icon" />
                {compliance.data.summary.notDispatchable} cannot be dispatched
              </Badge>
            ) : null}
            <Button
              variant="secondary"
              icon={<ClipboardList />}
              onClick={() => void navigate({ to: '/fleet/pti' })}
            >
              Pre-trip board
            </Button>
            <Button
              variant="primary"
              icon={<Wrench />}
              onClick={() => setCreating(true)}
            >
              New repair order
            </Button>
          </>
        }
      />

      {/* Eight numbers, each a board's own count */}
      <section aria-label="Today's numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Oil change overdue"
          value={oilOverdue}
          hint={`past the ${today.data ? n(today.data.defaults.oilChangeIntervalMiles) : '—'} mi interval`}
          icon={<Droplet />}
          family="urgent"
          onClick={() => void navigate({ to: '/fleet/oil-change' })}
        />
        <Tile
          label={`Oil due ≤ ${today.data ? n(today.data.defaults.oilChangeDueSoonMiles) : '—'} mi`}
          value={oilDueSoon}
          hint="book before the next load"
          icon={<Gauge />}
          family="warning"
          onClick={() => void navigate({ to: '/fleet/oil-change' })}
        />
        <Tile
          label="PTI issues unresolved"
          value={ptiUnresolved}
          hint="no action recorded"
          icon={<ClipboardList />}
          family="urgent"
          onClick={() => void navigate({ to: '/fleet/pti' })}
        />
        <Tile
          label="Walk-arounds missing"
          value={walkMissing}
          hint={pti.data ? `due ${shortDate(pti.data.dueAt)} · ${walkPending} pending review` : ''}
          icon={<VideoOff />}
          family="warning"
          onClick={() => void navigate({ to: '/fleet/pti' })}
        />
        <Tile
          label="Waiting on parts"
          value={waitingParts}
          hint="in a bay, part on back order"
          icon={<Package />}
          family="urgent"
          onClick={() => void navigate({ to: '/fleet/maintenance' })}
        />
        <Tile
          label="Documents holding dispatch"
          value={docsHolding}
          hint={
            compliance.data
              ? `${docsExpired} expired · ${docsMissing} missing`
              : 'not readable for your role'
          }
          icon={<FileWarning />}
          family="urgent"
          onClick={() => void navigate({ to: '/safety' })}
        />
        <Tile
          label="In the shop now"
          value={today.data ? today.data.counts.inShop : undefined}
          hint={
            today.data ? `${inShop.length} open orders · ${pastPromised} past promised date` : ''
          }
          icon={<Building2 />}
          family="warning"
          onClick={() => void navigate({ to: '/fleet/maintenance' })}
        />
        <Tile
          label="DOT inspections within 30 days"
          value={dotSoon}
          hint="annual inspection renewals"
          icon={<Calendar />}
          family="warning"
          onClick={() => void navigate({ to: '/fleet/trucks' })}
        />
      </section>

      <div className="grid items-start gap-4 min-[1200px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* Needs a decision today */}
        <Card padding="none" className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
            <div>
              <h2 className="text-sm font-bold text-nw-text">Needs a decision today</h2>
              <p className="text-[11.5px] text-nw-text-3">
                {loadingCounts ? 'Loading…' : `${decisions.length} items · highest priority first`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex gap-0.5 rounded-lg bg-nw-segment p-0.5"
                role="group"
                aria-label="Category"
              >
                {(['all', 'oil', 'shop', 'documents', 'pti'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={category === c}
                    onClick={() => {
                      setCategory(c);
                      setPage(1);
                    }}
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-semibold text-nw-text-2',
                      category === c && 'bg-nw-accent text-nw-on-accent',
                    )}
                  >
                    {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
                    {c === 'all' ? <span className="tabular opacity-80">{counts.all}</span> : null}
                  </button>
                ))}
              </div>
              <label className="flex h-8 w-[180px] items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-xs text-nw-text-3 focus-within:border-nw-accent">
                <Search className="size-3.5 shrink-0" aria-hidden />
                <input
                  type="search"
                  aria-label="Search units or issues"
                  placeholder="Search units or issues…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
                />
              </label>
            </div>
          </div>
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col style={{ width: 170 }} />
              <col />
              <col style={{ width: 128 }} />
              <col style={{ width: 150 }} />
            </colgroup>
            <thead>
              <tr className="border-b border-nw-border text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                <th className="h-[34px] px-4 font-bold">Unit / driver</th>
                <th className="h-[34px] px-3 font-bold">Issue</th>
                <th className="h-[34px] px-3 font-bold">Priority</th>
                <th className="h-[34px] px-3 font-bold">Action</th>
              </tr>
            </thead>
            <tbody>
              {loadingCounts && decisions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    Loading…
                  </td>
                </tr>
              ) : shown.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-nw-text-3">
                    {decisions.length === 0
                      ? 'Nothing needs a decision today.'
                      : 'Nothing matches.'}
                  </td>
                </tr>
              ) : (
                shown.map((d) => (
                  <tr
                    key={d.key}
                    className="border-b border-nw-border last:border-b-0 hover:bg-nw-hover"
                  >
                    <td className="px-4 py-2 align-middle">
                      <span className="flex items-center gap-2.5">
                        {d.icon === 'trailer' ? (
                          <Container className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                        ) : d.icon === 'driver' ? (
                          <User className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                        ) : (
                          <Truck className="size-4 shrink-0 text-nw-text-3" aria-hidden />
                        )}
                        <span className="min-w-0">
                          {d.unitLink ? (
                            <Link
                              to={d.unitLink.to}
                              params={d.unitLink.params}
                              className="block truncate font-bold text-nw-text hover:underline"
                            >
                              {d.unitLabel}
                            </Link>
                          ) : (
                            <span className="block truncate font-bold text-nw-text">
                              {d.unitLabel}
                            </span>
                          )}
                          <span className="block truncate text-[11.5px] text-nw-text-3">
                            {d.secondary}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <span className="block truncate font-semibold text-nw-text">{d.issue}</span>
                      <span className="block truncate text-[11.5px] text-nw-text-3">
                        {d.detail}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <span
                        className={cn(
                          'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-semibold whitespace-nowrap ring-1 ring-inset',
                          PILL[d.priorityFamily],
                        )}
                      >
                        <StatusSymbol
                          family={d.priorityFamily}
                          size={12}
                          className={ICON[d.priorityFamily]}
                        />
                        {d.priorityLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <Button variant="secondary" size="sm" onClick={d.onAction}>
                        {d.action}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 border-t border-nw-border px-4 py-2 text-xs text-nw-text-3">
            <span>
              {filtered.length === 0
                ? 'Showing 0'
                : `Showing ${(current - 1) * PAGE + 1}–${Math.min(current * PAGE, filtered.length)} of ${filtered.length}`}
            </span>
            {pages > 1 ? (
              <nav className="flex items-center gap-1" aria-label="Pages">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                  className="grid size-7 place-items-center rounded-md border border-nw-border text-nw-text-2 disabled:opacity-40"
                >
                  <ChevronLeft className="size-3.5" aria-hidden />
                </button>
                {Array.from({ length: Math.min(pages, 5) }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-current={p === current ? 'page' : undefined}
                    onClick={() => setPage(p)}
                    className={cn(
                      'tabular grid size-7 place-items-center rounded-md border text-xs font-semibold',
                      p === current
                        ? 'border-nw-accent bg-nw-accent text-nw-on-accent'
                        : 'border-nw-border text-nw-text-2',
                    )}
                  >
                    {p}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                  className="grid size-7 place-items-center rounded-md border border-nw-border text-nw-text-2 disabled:opacity-40"
                >
                  <ChevronRight className="size-3.5" aria-hidden />
                </button>
              </nav>
            ) : null}
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {/* In the shop */}
          <Card padding="none" className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-nw-text">In the shop</h2>
                <p className="text-[11.5px] text-nw-text-3">
                  {today.data
                    ? `${inShop.length} ${inShop.length === 1 ? 'unit' : 'units'} out of service`
                    : 'Loading…'}
                </p>
              </div>
              <Link
                to="/fleet/maintenance"
                className="inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline"
              >
                View all
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <colgroup>
                <col style={{ width: 112 }} />
                <col />
                <col style={{ width: 128 }} />
                <col style={{ width: 88 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-nw-border text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                  <th className="h-[32px] px-4 font-bold">Unit</th>
                  <th className="h-[32px] px-2 font-bold">Service provider</th>
                  <th className="h-[32px] px-2 font-bold">Status</th>
                  <th className="h-[32px] px-3 font-bold">Due date</th>
                </tr>
              </thead>
              <tbody>
                {today.isPending ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-nw-text-3">
                      Loading…
                    </td>
                  </tr>
                ) : inShop.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-nw-text-3">
                      Nothing is in the shop.
                    </td>
                  </tr>
                ) : (
                  inShop.slice(0, 8).map((w) => <ShopRow key={w.workOrderId} row={w} now={now} />)
                )}
              </tbody>
            </table>
          </Card>

          {/* This month's spend */}
          <Card padding="none" className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
              <div>
                <h2 className="text-sm font-bold text-nw-text">This month's spend</h2>
                <p className="text-[11.5px] text-nw-text-3">Full breakdown lives on Spending</p>
              </div>
              <Link
                to="/fleet"
                className="inline-flex items-center gap-1 text-xs font-semibold text-nw-accent-ink hover:underline"
              >
                View spending
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
            {!seesCost ? (
              <p className="px-4 py-6 text-center text-xs text-nw-text-3">
                Money is not shown for your role.
              </p>
            ) : (
              <div className="grid grid-cols-2 divide-x divide-nw-border">
                <Money
                  label="Maintenance"
                  value={
                    spend.data
                      ? spend.data.kpis.totalSpend.value === null
                        ? '—'
                        : formatMoney(spend.data.kpis.totalSpend.value)
                      : undefined
                  }
                />
                <Money
                  label="Cost per mile"
                  value={
                    spend.data
                      ? spend.data.kpis.costPerMile.value === null
                        ? '—'
                        : `$${spend.data.kpis.costPerMile.value.toFixed(3)}`
                      : undefined
                  }
                />
              </div>
            )}
          </Card>
        </div>
      </div>
      <CreateWorkOrderDialog
        open={creating}
        onOpenChange={setCreating}
        onDone={() => setCreating(false)}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------ pieces

/** A defect that has been found and nobody has picked up: no owner, not yet fixed. */
function unactioned(d: PtiBoardRow['openDefects'][number]): boolean {
  return !d.ownerId && !d.workOrderId && d.state !== 'fixed_pending_verify';
}

const PILL: Record<StatusSymbolFamily, string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border',
  warning: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  done: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border',
  moving: 'bg-nw-moving-bg text-nw-moving-text ring-nw-moving-border',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
  inShop: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border',
  info: 'bg-nw-neutral-bg text-nw-neutral-text ring-nw-neutral-border',
};
const ICON: Record<StatusSymbolFamily, string> = {
  urgent: 'text-nw-urgent-icon',
  warning: 'text-nw-warning-icon',
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  neutral: 'text-nw-neutral-icon',
  inShop: 'text-nw-warning-icon',
  info: 'text-nw-neutral-icon',
};
const TILE_ICON: Record<'urgent' | 'warning', string> = {
  urgent: 'bg-nw-urgent-bg text-nw-urgent-icon',
  warning: 'bg-nw-warning-bg text-nw-warning-icon',
};

function Tile({
  label,
  value,
  hint,
  icon,
  family,
  onClick,
}: {
  label: string;
  value: number | undefined;
  hint: string;
  icon: ReactNode;
  family: 'urgent' | 'warning';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start justify-between gap-3 rounded-xl border border-nw-border bg-nw-panel px-4 py-3 text-left transition-colors hover:bg-nw-hover"
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-bold tracking-[.07em] text-nw-text-3 uppercase">
          {label}
        </span>
        <span className="tabular block text-[26px] leading-[1.15] font-bold tracking-[-0.02em] text-nw-text">
          {value === undefined ? (
            <span className="text-sm font-medium text-nw-text-3">Loading…</span>
          ) : (
            value
          )}
        </span>
        <span className="block truncate text-xs text-nw-text-3">{hint}</span>
      </span>
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4',
          value ? TILE_ICON[family] : 'bg-nw-segment text-nw-text-2',
        )}
        aria-hidden
      >
        {icon}
      </span>
    </button>
  );
}

function ShopRow({ row, now }: { row: InShopRow; now: number }) {
  const late = row.scheduledFor && Date.parse(row.scheduledFor) < now;
  const stage = row.shopStage;
  const family: StatusSymbolFamily =
    stage === 'waiting_parts' ? 'urgent' : stage ? 'warning' : 'neutral';
  const label =
    stage === 'waiting_parts' ? 'Waiting on parts' : stage ? 'In shop' : 'No repair order';
  return (
    <tr className="border-b border-nw-border last:border-b-0">
      <td className="px-4 py-2 align-middle">
        <span className="flex items-center gap-1.5 font-bold text-nw-text">
          {row.assetType === 'trailer' ? (
            <Container className="size-3.5 text-nw-text-3" aria-hidden />
          ) : (
            <Truck className="size-3.5 text-nw-text-3" aria-hidden />
          )}
          <Link
            to="/fleet/shop/$orderId"
            params={{ orderId: row.workOrderId }}
            className="truncate hover:underline"
          >
            {row.assetType === 'trailer' ? row.unitNumber : `Unit ${row.unitNumber}`}
          </Link>
        </span>
      </td>
      <td className="truncate px-2 py-2 align-middle text-nw-text-2">{row.vendorName ?? '—'}</td>
      <td className="px-2 py-2 align-middle">
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-semibold whitespace-nowrap ring-1 ring-inset',
            PILL[family],
          )}
        >
          <StatusSymbol
            family={family === 'neutral' ? 'info' : family}
            size={12}
            className={ICON[family]}
          />
          {label}
        </span>
      </td>
      <td
        className={cn(
          'px-3 py-2 align-middle whitespace-nowrap',
          late ? 'text-nw-urgent-text' : 'text-nw-text-2',
        )}
      >
        {row.scheduledFor ? `${late ? 'Promised ' : ''}${shortDate(row.scheduledFor)}` : '—'}
      </td>
    </tr>
  );
}

function Money({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="px-4 py-5 text-center">
      <span className="tabular block text-[22px] font-bold tracking-[-0.02em] text-nw-text">
        {value ?? <span className="text-sm font-medium text-nw-text-3">Loading…</span>}
      </span>
      <span className="block text-xs text-nw-text-3">{label}</span>
    </div>
  );
}

function shortDate(iso: string): string {
  return formatDate(iso).replace(/, \d{4}$/, '');
}
