import {
  UserCheck,
  Table2,
  ClipboardList,
  Activity,
  BadgeDollarSign,
  BarChart3,
  Bell,
  Bot,
  Landmark,
  Briefcase,
  Building,
  Building2,
  CalendarCheck,
  CarFront,
  CalendarDays,
  CircleDollarSign,
  ClipboardCheck,
  Container,
  FileText,
  Fuel,
  Gauge,
  Palmtree,
  Handshake,
  HeartHandshake,
  History,
  LayoutDashboard,
  MapPin,
  Package,
  Plug,
  Receipt,
  Store,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Truck,
  UserRound,
  Users,
  Wallet,
  Workflow,
  Wrench,
  type LucideIcon,
  IdCard,
  MessagesSquare,
} from 'lucide-react';
import { MESSAGE_OFFICE_PERMISSIONS } from '@neway/shared';

import { isEnabled, type FeatureFlag } from '@/lib/feature-flags';

/**
 * Single source of truth for the sidebar and the page map. Routes in src/routes must match `to`.
 * `phase` marks pages whose real functionality arrives in a later roadmap phase; Phase 2 renders
 * them as designed placeholders.
 */

export interface NavChild {
  label: string;
  to: string;
  /** The permission that shows this child; absent for anyone without it. */
  permission?: string;
  /** Shown to anyone holding at least one of these (a board reachable by several grants). */
  anyPermission?: string[];
  /** Hidden unless this build has the flag on. */
  flag?: FeatureFlag;
  /** Hidden once this build has the flag on: the entry the flagged one replaces. */
  unlessFlag?: FeatureFlag;
}

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Second-level pages shown under the item while it is active. */
  children?: NavChild[];
  /** false: the children guard their pages but are not listed under the item in the sidebar. */
  sidebarChildren?: boolean;
  /** Roadmap phase that delivers the real page (undefined = delivered in Phase 2). */
  phase?: number;
  /** Additional path prefixes that keep this item highlighted (e.g. detail pages). */
  match?: string[];
  /** Hidden unless this build has the flag on. */
  flag?: FeatureFlag;
  /** Hidden once this build has the flag on: the entry the flagged one replaces. */
  unlessFlag?: FeatureFlag;
  /**
   * The permission that shows this page. An account without it does not see the entry, cannot
   * find it in the palette, and is sent to its first page if it types the URL - it should not
   * know the page exists (owner's rule, 2026-09-21). Absent means every signed-in account.
   */
  /** Shown to anyone holding at least one of these. */
  anyPermission?: string[];
  permission?: string;
  /** Only a platform administrator (grand admin) sees it; being a company owner is not enough. */
  platform?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAVIGATION: NavGroup[] = [
  {
    label: 'Company',
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
      // Right under Dashboard (owner, 2026-10-25); the page keeps its /reports/analytics address.
      { label: 'Analytics', to: '/reports/analytics', icon: BarChart3, phase: 12, permission: 'analytics.view' },
      { label: 'NeWay AI', to: '/ai', icon: Bot, permission: 'ai_assistant.use' },
      { label: 'Notifications', to: '/notifications', icon: Bell, phase: 3 },
      // Driver ↔ office conversations by department (mobile M4); a department's threads need its permission.
      { label: 'Inbox', to: '/inbox', icon: MessagesSquare, anyPermission: [...MESSAGE_OFFICE_PERMISSIONS] },
      // The carrier's own profile, papers and broker packet (owner, 2026-10-19).
      { label: 'Company info', to: '/company', icon: Landmark, permission: 'company_profile.view' },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Loads',
        to: '/loads',
        icon: Package,
        phase: 5,
        match: ['/loads/'],
        permission: 'loads.view',
      },
      {
        label: 'Dispatch board',
        to: '/dispatch/daily',
        icon: Table2,
        phase: 6,
        anyPermission: ['dispatch.view', 'board_daily.view', 'board_weekly.view', 'board_performance.view', 'board_claims.view', 'dispatch_pay.view'],
        match: ['/dispatch/daily', '/dispatch/weekly', '/dispatch/commission', '/dispatch/salary', '/dispatch/performance', '/dispatch/claims', '/dispatch/roster-match', '/dispatch/vacations', '/dispatch/at-home', '/dispatch/rotation', '/dispatch/unassigned'],
        // One link in the sidebar: the board pages switch with the tabs at the top of the board
        // (owner, 2026-09-29). The children stay listed because they decide who may open each page.
        sidebarChildren: false,
        children: [
          { label: 'Daily Board', to: '/dispatch/daily', anyPermission: ['dispatch.view', 'board_daily.view'] },
          { label: 'Weekly Board', to: '/dispatch/weekly', anyPermission: ['dispatch.view', 'board_weekly.view'] },
          // The scoreboard is for the people on it, so it takes no more than seeing the board.
          { label: 'Performance', to: '/dispatch/performance', anyPermission: ['dispatch.view', 'board_performance.view'] },
          // The three pay pages. Everybody who dispatches runs the boards and files a detention
          // claim; what dispatchers earn is the administrator's business alone.
          { label: 'Weekly Report', to: '/dispatch/weekly/report', permission: 'dispatch_pay.view' },
          { label: 'Commission', to: '/dispatch/commission', permission: 'dispatch_pay.view' },
          { label: 'Salary Report', to: '/dispatch/salary', permission: 'dispatch_pay.view' },
          { label: 'Detention & Layover', to: '/dispatch/claims', anyPermission: ['dispatch.view', 'board_claims.view'] },
          { label: 'Match rows to drivers', to: '/dispatch/roster-match', permission: 'dispatch.manage' },
          { label: 'On vacation', to: '/dispatch/vacations', anyPermission: ['dispatch.view', 'drivers.view'] },
          { label: 'At home', to: '/dispatch/at-home', anyPermission: ['dispatch.view', 'board_daily.view'] },
          { label: 'Dispatcher rotation', to: '/dispatch/rotation', permission: 'dispatch.manage' },
          { label: 'Unassigned drivers', to: '/dispatch/unassigned', anyPermission: ['dispatch.view', 'board_daily.view'] },
        ],
      },
      { label: 'Tracking', to: '/tracking', icon: MapPin, phase: 6, permission: 'dispatch.view' },
      { label: 'Drivers', to: '/drivers', icon: UserRound, phase: 4, permission: 'drivers.view' },
      // Company policy: drivers back from 30+ days of vacation, tested and cleared (owner, 2026-10-17);
      // listed under Operations since 2026-10-19, beside the drivers it clears.
      { label: 'Vacation returns', to: '/safety/vacation-returns', icon: Palmtree, phase: 8, permission: 'safety.view' },
      {
        label: 'Customers',
        to: '/customers',
        icon: Building2,
        phase: 5,
        permission: 'customers.view',
      },
      { label: 'Brokers', to: '/brokers', icon: Handshake, phase: 5, permission: 'brokers.view' },
    ],
  },
  {
    label: 'Fleet',
    items: [
      /*
       * Two Fleet menus, one flag.
       *
       * With `fleet_v2` off this is the menu production has had since Phase 3: the expense summary
       * first, the maintenance table with its six views. With it on it is the eight items the
       * Fleet specification settles on (Costs moved ahead of Today by the owner): Today near the top, because the question at 8am is which trucks
       * are not earning and who is chasing them, and Repairs, PM & inspections and Costs each
       * with one job. Both are listed here so that neither is a surprise, and the flag decides.
       */
      {
        label: 'Expense summary',
        to: '/fleet',
        icon: Receipt,
        match: [],
        unlessFlag: 'fleet_v2',
        permission: 'maintenance_costs.view',
      },
      // Costs first (owner, 2026-09-29).
      {
        label: 'Costs',
        to: '/fleet',
        permission: 'maintenance_costs.view',
        icon: Receipt,
        flag: 'fleet_v2',
        match: ['/fleet/costs', '/fleet/expenses'],
      },
      // Fleet Expenses folded into Costs and the Repair log (owner, 2026-10-13): no menu entry of
      // its own; Costs' figures still open the expense list at /fleet/expenses/list.
      {
        label: 'Today',
        to: '/fleet/today',
        permission: 'maintenance.view',
        icon: Gauge,
        flag: 'fleet_v2',
        // One page only since Availability left (owner, 2026-09-22): a plain link, no submenu.
        match: ['/fleet/today', '/fleet/shop'],
      },
      // Breakdowns drivers report from the road in the driver app (mobile M3).
      {
        label: 'Breakdowns',
        to: '/fleet/breakdowns',
        permission: 'maintenance.view',
        icon: CarFront,
        flag: 'fleet_v2',
        match: ['/fleet/breakdowns'],
      },
      {
        label: 'Trucks',
        to: '/fleet/trucks',
        icon: Truck,
        phase: 4,
        match: ['/fleet/trucks/'],
        permission: 'trucks.view',
      },
      {
        label: 'Trailers',
        to: '/fleet/trailers',
        permission: 'trailers.view',
        icon: Container,
        phase: 4,
        match: ['/fleet/trailers/'],
      },
      {
        label: 'Maintenance',
        to: '/fleet/maintenance',
        permission: 'maintenance.view',
        icon: Wrench,
        phase: 7,
        match: ['/fleet/maintenance/'],
        unlessFlag: 'fleet_v2',
        children: [
          { label: 'All', to: '/fleet/maintenance' },
          { label: 'Active', to: '/fleet/maintenance?view=active' },
          { label: 'Scheduled', to: '/fleet/maintenance?view=scheduled' },
          { label: 'In progress', to: '/fleet/maintenance?view=in_shop' },
          { label: 'Overdue', to: '/fleet/maintenance?view=overdue' },
          { label: 'Completed', to: '/fleet/maintenance?view=completed' },
        ],
      },
      {
        label: 'Repairs',
        to: '/fleet/maintenance',
        permission: 'maintenance.view',
        icon: Wrench,
        phase: 7,
        flag: 'fleet_v2',
        match: ['/fleet/repairs', '/fleet/maintenance'],
      },
      {
        label: 'Pre-trip (PTI)',
        to: '/fleet/pti',
        permission: 'maintenance.view',
        icon: ClipboardList,
        match: ['/fleet/pti/'],
        unlessFlag: 'fleet_v2',
      },
      {
        label: 'PM & inspections',
        to: '/fleet/oil-change',
        permission: 'maintenance.view',
        icon: ClipboardList,
        flag: 'fleet_v2',
        match: ['/fleet/pm', '/fleet/pti', '/fleet/oil-change'],
        children: [
          { label: 'Oil change / PM', to: '/fleet/oil-change', flag: 'pm_module' },
          { label: 'Pre-trip board', to: '/fleet/pti' },
        ],
      },
      {
        label: 'Fuel',
        to: '/fleet/fuel',
        icon: Fuel,
        phase: 9,
        permission: 'maintenance_costs.view',
      },
      {
        label: 'Vendors',
        to: '/fleet/vendors',
        icon: Store,
        match: ['/fleet/vendors/'],
        permission: 'maintenance.view',
      },
    ],
  },
  {
    label: 'Safety & Compliance',
    items: [
      { label: 'Safety', to: '/safety', icon: ShieldCheck, permission: 'safety.view' },
      {
        label: 'Driver Qualifications',
        to: '/safety/compliance',
        icon: ClipboardCheck,
        permission: 'compliance.view',
      },
      {
        label: 'Inspections',
        to: '/safety/inspections',
        // Everybody who works the fleet reads the truck and trailer inspections (owner, 2026-10-10).
        anyPermission: ['safety.view', 'trucks.view', 'trailers.view'],
        icon: Gauge,
        phase: 8,
        match: ['/safety/inspections/'],
      },
      {
        label: 'Accidents',
        to: '/safety/accidents',
        permission: 'safety.view',
        icon: Siren,
        phase: 8,
        match: ['/safety/accidents/'],
      },
      {
        // Candidates Recruiting sent to Safety, waiting for Qualified / Not qualified (owner, 2026-10-11).
        label: 'Hiring decisions',
        to: '/safety/hiring',
        permission: 'compliance.manage',
        icon: UserCheck,
        phase: 8,
        match: ['/safety/hiring/'],
      },
      {
        // The DOT driver application v2 the drivers submitted (owner brief, 2026-10-27).
        label: 'Applications review',
        to: '/safety/applications',
        permission: 'compliance.manage',
        icon: ClipboardList,
        phase: 8,
        match: ['/safety/applications/'],
      },
      {
        label: 'Safety review',
        to: '/safety/review',
        permission: 'safety.view',
        icon: ClipboardCheck,
        phase: 8,
        match: ['/safety/review/'],
      },
      {
        label: 'Claims',
        to: '/safety/claims',
        permission: 'safety.view',
        icon: ShieldAlert,
        phase: 8,
        match: ['/safety/claims/'],
      },
      {
        label: 'Violations',
        to: '/safety/violations',
        permission: 'safety.view',
        icon: FileText,
        phase: 8,
        match: ['/safety/violations/'],
      },
    ],
  },
  {
    label: 'Accounting',
    items: [
      {
        label: 'Dashboard',
        to: '/accounting',
        icon: CircleDollarSign,
        phase: 10,
        // Its own permission (owner, 2026-10-13): ordinary accounting staff work the pages below.
        permission: 'accounting.overview',
      },
      {
        label: 'Invoices',
        to: '/accounting/invoices',
        icon: Receipt,
        phase: 10,
        permission: 'accounting.view',
      },
      {
        label: 'Accounts Receivable',
        to: '/accounting/receivables',
        permission: 'accounting.view',
        icon: BadgeDollarSign,
        phase: 10,
      },
      {
        label: 'Accounts Payable',
        to: '/accounting/payables',
        icon: Wallet,
        phase: 10,
        permission: 'accounting.view',
      },
      {
        label: 'Expenses',
        to: '/accounting/expenses',
        icon: FileText,
        phase: 10,
        permission: 'accounting.view',
      },
      {
        label: 'Reimbursements',
        to: '/accounting/reimbursements',
        icon: Receipt,
        phase: 10,
        permission: 'accounting.view',
      },
      {
        label: 'Settlements',
        to: '/accounting/settlements',
        icon: Handshake,
        phase: 10,
        permission: 'accounting.view',
      },
      {
        label: 'Payroll',
        to: '/accounting/payroll',
        icon: Briefcase,
        phase: 10,
        permission: 'payroll.view',
      },
    ],
  },
  {
    /*
     * HR is the hiring of drivers and nothing else (owner, 2026-09-29): the dashboard, then every
     * lead and candidate on one Recruiting page (redesign 2026-09-30). Onboarding's checklist is reached from the candidate, not the menu.
     */
    label: 'HR',
    items: [
      {
        label: 'Recruiting',
        to: '/hr/recruiting',
        icon: Users,
        phase: 11,
        permission: 'recruiting.view',
        match: ['/hr/recruiting/', '/hr/hiring'],
      },
    ],
  },
  {
    /*
     * Every request drivers send from the NORTHWIND FREIGHT Driver Care page (owner, 2026-10-06). The
     * sidebar badge is the server's count of requests that still need contact.
     */
    label: 'Driver Support',
    items: [
      {
        label: 'Driver Relations',
        to: '/driver-relations',
        icon: HeartHandshake,
        permission: 'driver_relations.view',
      },
    ],
  },
  {
    // The office's own time and reviews, moved out of HR (owner, 2026-09-29). Addresses unchanged.
    label: 'Quality',
    items: [
      {
        label: 'Attendance',
        to: '/hr/attendance',
        icon: CalendarCheck,
        phase: 11,
        permission: 'attendance.view',
      },
      { label: 'PTO', to: '/hr/pto', icon: CalendarDays, phase: 11, permission: 'pto.view' },
      {
        label: 'Performance',
        to: '/hr/performance',
        icon: Activity,
        phase: 11,
        permission: 'performance.view',
      },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Reports', to: '/reports', icon: FileText, phase: 12, permission: 'reports.view' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', to: '/admin/users', icon: Users, phase: 3, permission: 'users.view' },
      // Moved from HR by the owner (2026-09-29); the page keeps its /hr/employees address.
      {
        label: 'Employees',
        to: '/hr/employees',
        icon: IdCard,
        phase: 3,
        permission: 'employees.view',
      },
      {
        label: 'Roles & Permissions',
        to: '/admin/roles',
        icon: ShieldCheck,
        phase: 3,
        permission: 'roles.view',
      },
      {
        label: 'Departments',
        to: '/admin/departments',
        icon: Building2,
        phase: 3,
        permission: 'departments.view',
      },
      {
        label: 'Integrations',
        to: '/admin/integrations',
        icon: Plug,
        phase: 6,
        permission: 'integrations.view',
      },
      {
        label: 'Workflows',
        to: '/admin/workflows',
        icon: Workflow,
        phase: 13,
        permission: 'workflows.view',
      },
      {
        // Each company's approved legal documents for the DOT driver application (2026-10-27).
        label: 'Document templates',
        to: '/admin/document-templates',
        icon: FileText,
        phase: 3,
        permission: 'application_templates.manage',
      },
      {
        label: 'Audit Logs',
        to: '/admin/audit-logs',
        icon: History,
        phase: 3,
        permission: 'audit.view',
      },
      {
        label: 'Settings',
        to: '/admin/settings',
        icon: Settings,
        phase: 3,
        permission: 'settings.view',
      },
      // The grand admin's page for opening customer companies (owner, 2026-10-01).
      { label: 'Companies', to: '/platform/companies', icon: Building, platform: true },
    ],
  },
];

/** Flat lookup of every navigable page (including children). */
/**
 * Is this entry part of this build?
 *
 * An entry with no flag always is. A flagged one appears only where the flag is on, which is how
 * a half-reviewed feature stays out of the menu of a production build instead of relying on
 * nobody clicking it.
 */
export function navVisible(entry: { flag?: FeatureFlag; unlessFlag?: FeatureFlag }): boolean {
  if (entry.flag !== undefined && !isEnabled(entry.flag)) return false;
  if (entry.unlessFlag !== undefined && isEnabled(entry.unlessFlag)) return false;
  return true;
}

/** What the visibility rules need to know about the signed-in account. */
export interface NavViewer {
  isOwner: boolean;
  permissions: readonly string[];
  isPlatformAdmin?: boolean;
}

/**
 * True when this account may see the page. The owner sees everything; everybody else sees the
 * pages whose permission they hold, and nothing else - not greyed out, not listed: absent.
 */
export function navAllowed(
  entry: { permission?: string; anyPermission?: string[]; platform?: boolean },
  viewer: NavViewer | null,
): boolean {
  if (entry.platform) return viewer?.isPlatformAdmin === true;
  if (entry.anyPermission && entry.anyPermission.length > 0) {
    if (!viewer) return false;
    return viewer.isOwner || entry.anyPermission.some((code) => viewer.permissions.includes(code));
  }
  if (entry.permission === undefined) return true;
  if (!viewer) return false;
  return viewer.isOwner || viewer.permissions.includes(entry.permission);
}

/**
 * Where an item whose children stay out of the sidebar takes this account: its first child the
 * account may open. Accounting, holding only the Weekly Board, lands there rather than on a Daily
 * Board it cannot see.
 */
export function itemTarget(item: NavItem, viewer: NavViewer | null): string {
  if (item.sidebarChildren !== false || !item.children) return item.to;
  return item.children.find((c) => navVisible(c) && navAllowed(c, viewer))?.to ?? item.to;
}

/** The pages this account can open, in menu order, for redirects and the palette. */
export function allowedPages(
  viewer: NavViewer | null,
): { label: string; to: string; group: string; parent?: string }[] {
  return NAVIGATION.flatMap((group) =>
    group.items
      .filter((item) => navVisible(item) && navAllowed(item, viewer))
      .flatMap((item) => [
        { label: item.label, to: itemTarget(item, viewer), group: group.label },
        // A child carries its own permission when it is narrower than its parent's — the pay
        // pages under the dispatch board. Listing one the account may not open would put it in
        // the command palette and in the redirect target, which is the same leak twice.
        ...(item.children ?? [])
          .filter((child) => navVisible(child) && navAllowed(child, viewer))
          .map((child) => ({
            label: child.label,
            to: child.to,
            group: group.label,
            parent: item.label,
          })),
      ]),
  );
}

/** The first page the account may open - their own work before Notifications; where a forbidden URL lands. */
export function homeFor(viewer: NavViewer | null): string {
  const pages = allowedPages(viewer);
  // Notifications and the Inbox are places you visit, not a first page.
  return pages.find((p) => p.to !== '/notifications' && p.to !== '/inbox')?.to ?? pages[0]?.to ?? '/notifications';
}

/**
 * Whether a pathname belongs to a page this account may not see. Unknown paths are allowed.
 *
 * A child's own permission is asked first. `findActiveItem` answers with the *parent* for a
 * child's path — that is what the sidebar highlight wants — so without this a typed URL to a page
 * hidden from the menu opened anyway, which made hiding it decorative.
 */
export function pathForbidden(pathname: string, viewer: NavViewer | null): boolean {
  const child = NAVIGATION.flatMap((g) => g.items)
    .flatMap((item) => item.children ?? [])
    .find((c) => c.to === pathname);
  if (child && !navAllowed(child, viewer)) return true;

  const item = findActiveItem(pathname);
  return item !== undefined && !navAllowed(item, viewer);
}

export const NAV_PAGES: { label: string; to: string; group: string; parent?: string }[] =
  NAVIGATION.flatMap((group) =>
    group.items.filter(navVisible).flatMap((item) => [
      { label: item.label, to: item.to, group: group.label },
      ...(item.children ?? []).filter(navVisible).map((child) => ({
        label: child.label,
        to: child.to,
        group: group.label,
        parent: item.label,
      })),
    ]),
  );

/** Returns the nav item that should be highlighted for a pathname. */
export function findActiveItem(pathname: string): NavItem | undefined {
  const items = NAVIGATION.flatMap((g) => g.items).filter(navVisible);
  const exact = items.find(
    (item) => item.to === pathname || item.children?.some((c) => c.to === pathname),
  );
  if (exact) return exact;
  // Longest prefix match on `to` or `match`, so /fleet/maintenance/overdue → Maintenance, /loads/123 → Loads.
  return [...items]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) =>
      [item.to + '/', ...(item.match ?? [])].some((prefix) => pathname.startsWith(prefix)),
    );
}
