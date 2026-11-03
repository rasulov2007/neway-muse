import { Calendar, ChevronRight, Clock, TriangleAlert, User, type LucideIcon } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import {
  ATTENTION_GROUP_ORDER,
  type AttentionGroup,
  type AttentionItem,
  type AttentionQueue,
} from '@neway/shared';
import { Badge, cn } from '@/design-system';
import { ATTENTION_GROUP_LABEL } from '@/features/operations/operations-ui';
import type { LoadView } from './loads-search';

/**
 * What needs attention, on the page that can do something about it.
 *
 * This is the one thing the Dispatch page had that Loads did not, so it moved here rather than
 * being deleted with it — Loads is now the single load workspace, and late or at-risk freight is
 * exactly what belongs on it (the same reason a compliance expiry does not).
 *
 * The queue itself is not recomputed: it is `buildAttentionQueue` from the shared package, already
 * in the operations bundle. Two sources of truth for "how many loads are at risk" would eventually
 * disagree, and the numbers here have to match the chips below them.
 *
 * Items that Loads can answer filter the table. Items it cannot — a driver held by a qualification
 * gate — hand off to the module that owns the remedy instead of offering a fix that is not here.
 */

/** Only the two groups a load workspace can act on; fleet and financial live in their own modules. */
const GROUPS: readonly AttentionGroup[] = ATTENTION_GROUP_ORDER.filter(
  (group) => group === 'critical' || group === 'high',
);

/**
 * How each finding reads on a card: a short title and the one thing to do about it. Keys the
 * queue can emit but that are not listed here fall back to the sentence the queue itself wrote.
 */
const CARD: Record<string, { title: string; subtitle: string; icon: LucideIcon }> = {
  loads_unassigned: {
    title: 'Missing assignment',
    subtitle: 'Assign a driver or unit.',
    icon: User,
  },
  loads_untracked: {
    title: 'Tracking unavailable',
    subtitle: 'Position too old to verify ETA.',
    icon: Clock,
  },
  appointments_approaching: {
    title: 'Upcoming appointments',
    subtitle: 'Due within 4 hours.',
    icon: Calendar,
  },
  loads_at_risk: {
    title: 'At risk',
    subtitle: 'Projected outside the window.',
    icon: TriangleAlert,
  },
  loads_critical: {
    title: 'Will miss appointment',
    subtitle: 'Projected arrival is already late.',
    icon: TriangleAlert,
  },
};

/** The sweep along an alert card's bottom edge, in the card's own tone. */
const SCAN: Record<AttentionGroup, string> = {
  critical: 'text-nw-urgent-icon',
  high: 'text-nw-warning-icon',
  financial: 'text-violet-text',
  fleet: 'text-primary',
};

/** Round tinted tile holding the finding's icon, in the finding's tone. */
const TILE: Record<AttentionGroup, string> = {
  critical: 'bg-danger-soft text-danger-text ring-danger-border',
  high: 'bg-warning-soft text-warning-text ring-warning-border',
  financial: 'bg-violet-soft text-violet-text ring-line',
  fleet: 'bg-primary-soft text-primary-text ring-line',
};

/** The count pill, in the same tone as the tile. */
const COUNT_TONE: Record<AttentionGroup, 'danger' | 'warning' | 'violet' | 'info'> = {
  critical: 'danger',
  high: 'warning',
  financial: 'violet',
  fleet: 'info',
};

/** How many load numbers a bar names before it says "+N". */
const NAMED = 2;

/** The Loads view an attention item corresponds to, or null when it is another module's job. */
function viewForAttentionItem(item: AttentionItem): LoadView | null {
  if (item.key === 'loads_critical' || item.key === 'loads_at_risk') return 'at_risk';
  if (item.key === 'loads_late') return 'late';
  if (item.key === 'loads_untracked') return 'no_update';
  if (item.key === 'loads_unassigned') return 'unassigned';
  return null;
}

/** "L-100008, L-100011 +2" from the ids behind a count; empty when none are loads on this page. */
function namedLoads(ids: readonly string[], loadNumberById: ReadonlyMap<string, string>): string {
  const numbers = ids.map((id) => loadNumberById.get(id)).filter((n): n is string => Boolean(n));
  if (numbers.length === 0) return '';
  const rest = numbers.length - NAMED;
  return `${numbers.slice(0, NAMED).join(', ')}${rest > 0 ? ` +${rest}` : ''}`;
}

/** Lower-cases a leading word so it reads on after "L-100008 · ", but leaves "ETA" alone. */
function continueSentence(text: string): string {
  const second = text.charAt(1);
  return second && second === second.toLowerCase() ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function NeedsAttentionStrip({
  attention,
  loadNumberById,
  activeView,
  onSelectView,
}: {
  attention: AttentionQueue;
  /** Load id → load number, so a bar can name the loads behind its count. */
  loadNumberById: ReadonlyMap<string, string>;
  activeView: LoadView;
  onSelectView: (view: LoadView) => void;
}) {
  const navigate = useNavigate();
  // The queue only emits a finding with a count, so a zero-count bar never exists to be hidden.
  // Most severe first: the queue's own group order, stable inside a group.
  const items = attention.items
    .filter((item) => GROUPS.includes(item.group) && item.count > 0)
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        ATTENTION_GROUP_ORDER.indexOf(a.item.group) - ATTENTION_GROUP_ORDER.indexOf(b.item.group) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
  // Absence is the all-clear: an empty panel saying "nothing is wrong" is furniture.
  if (items.length === 0) return null;

  const scope = `${GROUPS.map((g) => ATTENTION_GROUP_LABEL[g]).join(' and ')} only. Fleet and financial exceptions live in their own modules.`;

  return (
    <section aria-label="Needs attention" title={scope} className="flex flex-col gap-2">
      {items.map((item) => {
        const view = viewForAttentionItem(item);
        const active = view !== null && view === activeView;
        const card = CARD[item.key];
        const Icon = card?.icon ?? TriangleAlert;
        // Titles from the queue are written to follow a count ("load is late"); capitalise the
        // first letter so they stand on their own as a bar title.
        const title = card?.title ?? item.label.charAt(0).toUpperCase() + item.label.slice(1);
        const subtitle = card?.subtitle ?? `${item.reason}.`;
        const named = namedLoads(item.ids, loadNumberById);
        const description = named ? `${named} · ${continueSentence(subtitle)}` : subtitle;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={view ? active : undefined}
            onClick={() => {
              if (view) onSelectView(active ? 'all' : view);
              else void navigate({ href: item.target.to });
            }}
            className={cn(
              'relative flex w-full items-center gap-3 overflow-hidden rounded-lg border bg-surface px-4 py-3 text-left',
              'transition-colors duration-(--duration-base) hover:border-line hover:bg-surface-hover',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active ? 'border-primary ring-1 ring-primary' : 'border-line-soft',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-inset [&_svg]:size-4.5',
                TILE[item.group],
              )}
            >
              <Icon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-ink">{title}</span>
              <span className="block truncate text-xs text-muted">{description}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <Badge tone={COUNT_TONE[item.group]} size="sm" className="tabular">
                {item.count}
              </Badge>
              <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-muted">
                View
                <ChevronRight aria-hidden className="size-4 text-faint" />
              </span>
            </span>
            {/* Decorative: a thin line sweeping the bottom edge says this is still happening. */}
            <span aria-hidden className={cn('nw-scan-line', SCAN[item.group])} />
          </button>
        );
      })}
    </section>
  );
}
