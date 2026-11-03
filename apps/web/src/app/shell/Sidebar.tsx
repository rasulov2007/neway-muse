import { useLocation } from '@tanstack/react-router';
import { ChevronDown, ChevronsLeft, ChevronsRight, Truck } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { NAVIGATION, findActiveItem, navAllowed, itemTarget, navVisible, type NavItem } from '@/app/navigation';
import { useAccount } from '@/features/auth/auth-context';
import { useCanSeeDriverRelations, useDriverRelationCounts } from '@/features/driver-relations/api';
import { useUncontactedLeads } from '@/features/hr/useHiring';
import { useNotificationAttention } from './notification-count';
import { useAccidentCounts } from '@/features/accidents/api';
import { isEnabled } from '@/lib/feature-flags';
import { IconButton, Tooltip, cn } from '@/design-system';
import { RouterLink } from './RouterLink';
import { useShellState } from './shellState';

/**
 * A count shown on a nav item (SPEC §7 "Counters in nav items"). Plain counts are informational;
 * urgent and warning counts carry that status's pill colours and its symbol, so the tone is never
 * colour alone.
 */
export interface NavCount {
  value: number;
  tone?: 'plain' | 'urgent' | 'warning';
}

/** Status symbols from design/porcelain/icons, inlined so the theme colours apply. */
function UrgentSymbol({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path fill="currentColor" d="M5.1 .8h5.8l4.3 4.3v5.8l-4.3 4.3H5.1L.8 10.9V5.1z" />
      <rect x="7.1" y="3.7" width="1.8" height="5.4" rx=".9" className="fill-nw-status-glyph" />
      <circle cx="8" cy="11.6" r="1.1" className="fill-nw-status-glyph" />
    </svg>
  );
}

function WarningSymbol({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path fill="currentColor" d="M8 .3l7.7 7.7L8 15.7.3 8z" />
      <rect x="7.15" y="4.2" width="1.7" height="4.8" rx=".85" className="fill-nw-status-glyph" />
      <circle cx="8" cy="11.1" r="1.05" className="fill-nw-status-glyph" />
    </svg>
  );
}

const counterTone = {
  plain: 'bg-nw-accent-tint text-nw-accent-ink',
  urgent: 'border border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text',
  warning: 'border border-nw-warning-border bg-nw-warning-bg text-nw-warning-text',
} as const;

/** 20px counter, radius 6, 11/700 (SPEC `.nw-type-counter`). */
export function NavCounter({ value, tone = 'plain' }: NavCount) {
  return (
    <span
      className={cn(
        'tabular inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-sm px-1.5 text-eyebrow leading-none font-bold',
        counterTone[tone],
      )}
    >
      {tone === 'urgent' ? <UrgentSymbol className="size-[13px] text-nw-urgent-icon" /> : null}
      {tone === 'warning' ? <WarningSymbol className="size-[13px] text-nw-warning-icon" /> : null}
      {value > 99 ? '99+' : value}
    </span>
  );
}

/**
 * Counts the sidebar fetches itself: the Driver Relations badge is the server's number of requests
 * that still need contact (polled, refetched on focus), shown only to accounts that may open it.
 */
function useLiveNavCounts(): Record<string, NavCount> {
  const account = useAccount();
  const allowed = useCanSeeDriverRelations();
  const driverRelations = useDriverRelationCounts(allowed);
  const waiting = allowed ? (driverRelations.data?.needsContact ?? 0) : 0;
  // Recruiting: leads nobody has contacted yet, red until each is marked contacted (2026-10-06).
  const recruiting = Boolean(account && (account.isOwner || account.permissions.includes('recruiting.view')));
  const leads = useUncontactedLeads(recruiting);
  // …plus DOT applications a driver submitted through the link that wait for review (2026-10-07).
  const uncontacted = recruiting ? (leads.data?.uncontacted ?? 0) + (leads.data?.dotReviews ?? 0) : 0;
  const attention = useNotificationAttention();
  // Accidents (accidents_v2): urgent attention items, the board's own number (prototype "Urgent items").
  const accidentsAllowed = isEnabled('accidents_v2') && Boolean(account && (account.isOwner || account.permissions.includes('accidents.view')));
  const accidentCounts = useAccidentCounts(accidentsAllowed);
  const accidentsUrgent = accidentsAllowed ? (accidentCounts.data?.urgent ?? 0) : 0;
  const counts: Record<string, NavCount> = {};
  if (accidentsUrgent > 0) counts['/safety/accidents'] = { value: accidentsUrgent, tone: 'urgent' };
  // Notifications: unread or still needing action, the same number as the bell (2026-10-06).
  if (attention > 0) counts['/notifications'] = { value: attention, tone: 'urgent' };
  if (waiting > 0) counts['/driver-relations'] = { value: waiting, tone: 'urgent' };
  if (uncontacted > 0) counts['/hr/recruiting'] = { value: uncontacted, tone: 'urgent' };
  return counts;
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/** Arrow Up/Down, Home and End move focus between navigation links. */
function handleNavKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!NAV_KEYS.has(event.key)) return;
  const links = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[data-nav-item]'),
  );
  if (links.length === 0) return;
  const current = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (current === -1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) return;
  event.preventDefault();
  const last = links.length - 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowDown'
          ? Math.min(current + 1, last)
          : Math.max(current - 1, 0);
  links[next]?.focus();
}

interface SidebarNavProps {
  collapsed: boolean;
  /** Called after a link is chosen (the mobile sheet closes itself). */
  onNavigate?: () => void;
  /** Renders the collapse toggle at the bottom when provided. */
  onToggleCollapse?: () => void;
  /** Counts to show beside items, keyed by the item's `to`. */
  counts?: Readonly<Record<string, NavCount>>;
  className?: string;
}

/** The navigation landmark itself; shared by the fixed desktop sidebar and the mobile sheet. */
const CLOSED_GROUPS_KEY = 'nw.sidebar.closedGroups';

/** Which sidebar groups this person closed; a convenience kept in this browser only. */
function useClosedGroups(): [Set<string>, (label: string) => void] {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(CLOSED_GROUPS_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (label: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        window.localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify([...next]));
      } catch {
        // Storage refused (private window): the groups still open and close for this visit.
      }
      return next;
    });
  return [closed, toggle];
}

export function SidebarNav({
  collapsed,
  onNavigate,
  onToggleCollapse,
  counts,
  className,
}: SidebarNavProps) {
  const { pathname, searchStr } = useLocation();
  const active = findActiveItem(pathname);
  const account = useAccount();
  const live = useLiveNavCounts();
  const allCounts = { ...live, ...counts };
  // A group with nothing this account may open is not shown either: no heading over nothing.
  const groups = NAVIGATION.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => navVisible(item) && navAllowed(item, account))
      .map((item) => (item.children ? { ...item, to: itemTarget(item, account), children: item.children.filter((c) => navAllowed(c, account)) } : item)),
  })).filter((group) => group.items.length > 0);
  const [closedGroups, toggleGroup] = useClosedGroups();

  return (
    <nav
      aria-label="Main navigation"
      data-collapsed={collapsed ? 'true' : 'false'}
      onKeyDown={handleNavKeyDown}
      className={cn('app-sidebar flex flex-col border-r border-nw-border bg-nw-sidebar', className)}
    >
      <Brand collapsed={collapsed} onNavigate={onNavigate} />

      <div className="scroll-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
        {groups.map((group, index) => (
          <div key={group.label} className="mb-3 last:mb-0">
            {collapsed ? (
              index > 0 ? (
                <div aria-hidden className="mx-2 my-2 h-px bg-nw-border" />
              ) : null
            ) : (
              // Each heading opens and closes its group (owner, 2026-10-12); remembered per browser.
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={!closedGroups.has(group.label)}
                className="eyebrow flex w-full items-center justify-between gap-2 rounded-md px-2.5 pt-2 pb-1 text-left text-nw-text-3 hover:text-nw-text-2"
                data-testid={`nav-group-${group.label}`}
              >
                <span className="truncate">{group.label}</span>
                <ChevronDown aria-hidden className={cn('size-3.5 shrink-0 transition-transform', closedGroups.has(group.label) && '-rotate-90')} />
              </button>
            )}
            <ul role="list" className={cn('flex flex-col gap-0.5', !collapsed && closedGroups.has(group.label) && 'hidden')}>
              {group.items.map((item) => (
                <SidebarItem
                  key={item.to}
                  item={item}
                  active={active?.to === item.to}
                  pathname={pathname}
                  href={`${pathname}${searchStr ?? ''}`}
                  collapsed={collapsed}
                  count={allCounts[item.to]}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {onToggleCollapse ? (
        <div
          className={cn(
            'flex shrink-0 border-t border-nw-border p-2',
            collapsed ? 'justify-center' : 'justify-end',
          )}
        >
          <Tooltip content={collapsed ? 'Expand sidebar ([)' : 'Collapse sidebar ([)'} side="right">
            <IconButton
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={undefined}
              aria-keyshortcuts="["
              aria-expanded={!collapsed}
              onClick={onToggleCollapse}
              className="text-nw-text-3"
            >
              {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
            </IconButton>
          </Tooltip>
        </div>
      ) : null}
    </nav>
  );
}

function Brand({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <div
      className={cn(
        // Same height as the top bar, so the two bottom borders meet (SPEC §7 "App frame").
        'flex h-(--topbar-height) shrink-0 items-center border-b border-nw-border',
        collapsed ? 'justify-center' : 'px-4',
      )}
    >
      <RouterLink
        to="/dashboard"
        aria-label="NeWay TMS home"
        onClick={onNavigate}
        className="flex min-w-0 items-center gap-2.5 rounded-md"
      >
        {/* Logo: a 28px accent square, radius 8, mark in on-accent (SPEC §7 "Icons and logo"). */}
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-nw-accent text-nw-on-accent"
        >
          <Truck className="size-4" strokeWidth={2} />
        </span>
        {/* The wordmark is "NeWay" — a brand decision, approved 2026-09-11. Name 17/700, company 11px. */}
        {!collapsed ? (
          <span
            aria-hidden
            className="text-xl leading-none font-bold whitespace-nowrap text-nw-text"
          >
            NeWay
          </span>
        ) : null}
      </RouterLink>
    </div>
  );
}

interface SidebarItemProps {
  item: NavItem;
  active: boolean;
  pathname: string;
  /** The full current location, path and query. */
  href: string;
  collapsed: boolean;
  count?: NavCount;
  onNavigate?: () => void;
}

// Nav item (SPEC §7): 32px, radius 8, 0×10px padding, 9px gap, 13/500 in text-2, icon in text-3.
const itemBase =
  'relative flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-nw-text-2 ' +
  'transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:bg-nw-hover hover:text-nw-text ' +
  '[&>svg]:text-nw-text-3';

// The filled pill is the whole active signal. The rail that used to sit beside it was a second
// marker for the same state, and two markers read as two states.
const itemActive =
  'bg-nw-accent-tint font-bold text-nw-accent-ink hover:bg-nw-accent-tint hover:text-nw-accent-ink [&>svg]:text-nw-accent';

// Collapsed menu: 40×40, radius 9; selected keeps the tint and an accent icon.
const itemCollapsed = 'mx-auto size-10 justify-center rounded-[9px] px-0';

function SidebarItem({
  item,
  active,
  pathname,
  href,
  collapsed,
  count,
  onNavigate,
}: SidebarItemProps) {
  const Icon = item.icon;
  // Flagged children are absent from a build without the flag, not merely disabled.
  const children = item.sidebarChildren === false ? [] : (item.children ?? []).filter(navVisible);
  const hasChildren = children.length > 0;
  const listId = useId();

  /**
   * Whether the operator has overridden the default for this section. `null` means "follow the
   * default", which is open while the section is active.
   */
  const [override, setOverride] = useState<boolean | null>(null);
  // Leaving the section forgets the override, so coming back opens the section again rather than
  // silently keeping a collapse the operator made minutes ago somewhere else. Adjusting state
  // during render (rather than in an effect) is the documented way to reset on a prop change.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    setOverride(null);
  }

  const expanded = hasChildren && active && (override ?? true);
  const showChildren = expanded && !collapsed;
  /**
   * True when the row's own link would navigate nowhere, so the click is free to mean "collapse".
   * Compared on the full location, not the path: a section whose children are query-param views
   * (`/fleet/maintenance?view=overdue`) shares its path with the parent, and from one of those the
   * click still has somewhere to go — back to the unfiltered list.
   */
  const isCurrentPage = href === item.to;

  const link = (
    <RouterLink
      to={item.to}
      exact
      data-nav-item
      aria-current={active ? 'page' : undefined}
      aria-expanded={hasChildren && !collapsed ? expanded : undefined}
      aria-controls={showChildren ? listId : undefined}
      onClick={(event) => {
        // Already here: the navigation is a no-op, so the click collapses the section instead of
        // doing nothing at all, which is what it looked like it was doing.
        if (hasChildren && !collapsed && isCurrentPage) {
          event.preventDefault();
          setOverride(!expanded);
          return;
        }
        onNavigate?.();
      }}
      className={cn(
        itemBase,
        collapsed ? itemCollapsed : 'gap-[9px]',
        hasChildren && !collapsed && 'pr-1',
        active && itemActive,
      )}
    >
      <Icon
        aria-hidden
        className={cn('shrink-0', collapsed ? 'size-[18px]' : 'size-4')}
        strokeWidth={1.6}
      />
      <span className={cn('flex-1 truncate', collapsed && 'sr-only')}>{item.label}</span>
      {count && count.value > 0 ? (
        collapsed ? (
          // Collapsed: a bubble in the corner, urgent-icon fill with the glyph colour on top.
          <span
            aria-hidden
            className="tabular absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-nw-urgent-icon px-1 text-[10px] leading-none font-bold text-nw-status-glyph"
          >
            {count.value > 99 ? '99+' : count.value}
          </span>
        ) : (
          <NavCounter value={count.value} tone={count.tone} />
        )
      ) : null}
      {hasChildren && !collapsed ? (
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 transition-transform duration-(--duration-fast)',
            !expanded && '-rotate-90',
          )}
          strokeWidth={1.6}
        />
      ) : null}
    </RouterLink>
  );

  return (
    <li>
      {collapsed ? (
        <Tooltip content={item.label} side="right" sideOffset={8}>
          {link}
        </Tooltip>
      ) : (
        link
      )}
      {showChildren ? (
        <ul id={listId} role="list" className="relative mt-0.5 mb-1 flex flex-col gap-0.5">
          <span aria-hidden className="absolute top-1 bottom-1 left-4 w-px bg-nw-border" />
          {children.map((child) => {
            const childActive = child.to === pathname;
            return (
              <li key={child.to}>
                <RouterLink
                  to={child.to}
                  exact
                  data-nav-item
                  aria-current={childActive ? 'page' : undefined}
                  onClick={onNavigate}
                  className={cn(
                    'relative flex h-7 items-center rounded-md pr-2.5 pl-10 text-sm font-medium text-nw-text-2',
                    'transition-colors duration-(--duration-fast) hover:bg-nw-hover hover:text-nw-text',
                    childActive && 'bg-nw-accent-tint font-bold text-nw-accent-ink hover:bg-nw-accent-tint hover:text-nw-accent-ink',
                  )}
                >
                  {childActive ? (
                    <span
                      aria-hidden
                      className="absolute top-1/2 left-4 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-nw-accent"
                    />
                  ) : null}
                  <span className="truncate">{child.label}</span>
                </RouterLink>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** Fixed desktop sidebar (hidden below `lg`, where the mobile sheet takes over). */
export function Sidebar() {
  const { collapsed, toggleCollapsed } = useShellState();
  return (
    <SidebarNav
      collapsed={collapsed}
      onToggleCollapse={toggleCollapsed}
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden w-(--shell-sidebar-width) lg:flex',
        'transition-[width] duration-200 ease-in-out',
      )}
    />
  );
}
