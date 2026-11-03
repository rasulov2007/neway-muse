import { componentKeyFromName } from '@neway/shared';
import type { IsoDate, IsoDateTime } from './types';

/**
 * What the walk-around video said about each part of the truck.
 *
 * The weekly inspection used to record one bit — issue or no issue — and threw away the middle
 * ground where the money is: tyres that are fine today and visibly close to the wear bars, a mud
 * flap hanging, brakes that look good. A rating per component keeps that observation, and the one
 * that pays for the whole feature is the **window** on "Replace soon": it turns "getting worn" into
 * a date or a mileage the fleet team can plan a shop visit against.
 *
 * Ratings are append-only. Each week's review adds rows; nothing is edited in place, so the history
 * of a component is readable straight down the list. The *current* condition of a component is the
 * latest row for it, and it carries forward until somebody rates it again — a video that did not
 * mention the drive tyres does not make last week's "Replace soon" go away.
 */

export const PTI_RATINGS = ['good', 'monitor', 'replace_soon', 'replace_now'] as const;
export type PtiRating = (typeof PTI_RATINGS)[number];

export const PTI_RATING_LABEL: Record<PtiRating, string> = {
  good: 'Good',
  monitor: 'Monitor',
  replace_soon: 'Replace soon',
  replace_now: 'Replace now',
};

/** Worst last; the board shows the worst current rating on a unit. */
export const PTI_RATING_RANK: Record<PtiRating, number> = {
  good: 0,
  monitor: 1,
  replace_soon: 2,
  replace_now: 3,
};

export type PtiWindowUnit = 'weeks' | 'miles';

/** One item on the walk-around catalog. Admin-editable; the defaults below seed it. */
export interface PtiComponentDef {
  id: string;
  /**
   * The stable key a defect stores: `lights_reflectors`, `fifth_wheel_coupling`. Derived from the
   * name once (`componentKeyFromName`) and kept through renames, so a defect raised on "Lights &
   * reflectors" still points at the same component after somebody retitles it. Absent on rows
   * written before the key existed; `withKey()` fills it on read.
   */
  key?: string;
  name: string;
  /** e.g. "Steer tyres usually last 60–80k miles" — shown beside the control, never applied. */
  defaultLifeHint: string | null;
  /**
   * What is usually wrong with this component, as chips in the issue card ("out of stroke",
   * "marker lamp dark"). Editable in Settings; seeded from what recurred in the live data. Absent
   * on rows written before the field existed; `withKey()` fills it from the seed.
   */
  quickPicks?: string[];
  active: boolean;
  sortOrder: number;
  /** Only rated when a trailer is attached to the unit. */
  trailerOnly: boolean;
}

/** One observation of one component from one week's video. Never edited after it is written. */
export interface PtiComponentRating {
  id: string;
  recordId: string | null;
  weekStart: IsoDate;
  truckId: string;
  componentId: string;
  rating: PtiRating;
  /** The "Replace soon" window: `2` weeks or `8000` miles. Null for every other rating. */
  windowValue: number | null;
  windowUnit: PtiWindowUnit | null;
  /** The unit's odometer when the rating was made, so a miles window can be counted down. */
  odometerAtRating: number | null;
  ratedAt: IsoDateTime;
  ratedById: string | null;
  ratedByName: string | null;
  note: string | null;
  /** The work order this rating opened, when one was opened from it. */
  workOrderId: string | null;
  workOrderNumber: string | null;
}

export interface PtiConditionConfig {
  /** A carried-over rating older than this many weeks is flagged for a re-check. */
  staleAfterWeeks: number;
}

export const DEFAULT_PTI_CONDITION_CONFIG: PtiConditionConfig = { staleAfterWeeks: 4 };

/** "Closes within the next 14 days" — the due-soon tile's horizon, and the queue's. */
export const DUE_SOON_DAYS = 14;
/** A miles window with this much or less left is treated the same as one closing in 14 days. */
export const DUE_SOON_MILES = 1000;

/** What a walk-around actually covers. Tyres are split by position because that is where the money is. */
export const DEFAULT_PTI_COMPONENTS: Omit<PtiComponentDef, 'id'>[] = [
  {
    name: 'Steer tyres',
    defaultLifeHint: '60–80k miles',
    active: true,
    sortOrder: 0,
    trailerOnly: false,
  },
  {
    name: 'Drive tyres',
    defaultLifeHint: '150–200k miles',
    active: true,
    sortOrder: 1,
    trailerOnly: false,
  },
  { name: 'Trailer tyres', defaultLifeHint: null, active: true, sortOrder: 2, trailerOnly: true },
  {
    name: 'Brakes',
    defaultLifeHint: 'Linings 150–250k miles',
    active: true,
    sortOrder: 3,
    trailerOnly: false,
  },
  {
    name: 'Lights & reflectors',
    defaultLifeHint: null,
    active: true,
    sortOrder: 4,
    trailerOnly: false,
  },
  { name: 'Leaks & fluids', defaultLifeHint: null, active: true, sortOrder: 5, trailerOnly: false },
  {
    name: 'Suspension / airbags',
    defaultLifeHint: null,
    active: true,
    sortOrder: 6,
    trailerOnly: false,
  },
  { name: 'Belts & hoses', defaultLifeHint: null, active: true, sortOrder: 7, trailerOnly: false },
  {
    name: 'Battery & electrical',
    defaultLifeHint: '3–5 years',
    active: true,
    sortOrder: 8,
    trailerOnly: false,
  },
  {
    name: 'Windshield & mirrors',
    defaultLifeHint: null,
    active: true,
    sortOrder: 9,
    trailerOnly: false,
  },
  {
    name: 'Body & mud flaps',
    defaultLifeHint: null,
    active: true,
    sortOrder: 10,
    trailerOnly: false,
  },
  {
    name: '5th wheel / coupling',
    defaultLifeHint: null,
    active: true,
    sortOrder: 11,
    trailerOnly: false,
  },
  {
    name: 'Trailer condition',
    defaultLifeHint: null,
    active: true,
    sortOrder: 12,
    trailerOnly: true,
  },
];

/**
 * The quick-picks the catalog is seeded with, by component key: what actually recurred on the
 * board (brief §6.3). A component not listed here starts with none and gets them in Settings.
 */
export const DEFAULT_QUICK_PICKS: Record<string, string[]> = {
  brakes: ['Out of stroke', 'Lining worn', 'Air leak', 'Drum cracked'],
  lights_reflectors: ['Marker lamp dark', 'Clearance lamp dark', 'Reflector missing / damaged'],
  body_mudflaps: ['Door seal torn', 'Mud flap torn'],
  leaks_fluids: ['Oil film', 'Coolant', 'Fuel weep'],
};

/** The key for a catalog entry, from the row when it has one and from the name when it does not. */
export function componentKeyOf(component: Pick<PtiComponentDef, 'key' | 'name'>): string {
  return component.key ?? componentKeyFromName(component.name);
}

/** A catalog entry with its key and quick-picks present, for rows written before either existed. */
export function withKey(component: PtiComponentDef): PtiComponentDef {
  const key = component.key ?? componentKeyFromName(component.name);
  const quickPicks = component.quickPicks ?? DEFAULT_QUICK_PICKS[key] ?? [];
  return component.key && component.quickPicks ? component : { ...component, key, quickPicks };
}

// ---------------------------------------------------------------------------------------------
// Current condition
// ---------------------------------------------------------------------------------------------

/** A component's condition as of a given week: the latest rating, and what it means today. */
export interface ComponentCondition {
  component: PtiComponentDef;
  rating: PtiRating | null;
  /** The row the condition comes from; null when the component has never been rated. */
  source: PtiComponentRating | null;
  /** True when the rating was made in an earlier week than the one being looked at. */
  carriedOver: boolean;
  /** True when a carried-over rating is older than the configured number of weeks. */
  stale: boolean;
  /** For a weeks window: the calendar date it closes. */
  closesOn: IsoDate | null;
  /** For a miles window: miles left before it closes, from the unit's odometer now. Negative = past. */
  milesRemaining: number | null;
  /** Days until `closesOn`, negative when it has passed. Null without a date window. */
  daysToClose: number | null;
}

export interface ConditionContext {
  truckId: string;
  /** The week being looked at; a rating from an earlier week is carried over. */
  weekStart: IsoDate;
  today: IsoDate;
  /** The unit's odometer now, for miles windows. */
  odometer: number | null;
  /** Whether a trailer is attached, so trailer-only components are shown. */
  trailerAttached: boolean;
  config?: PtiConditionConfig;
}

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Every rating that could apply, newest first. Rows from after the week are not "current" for it. */
function latestFor(
  ratings: readonly PtiComponentRating[],
  truckId: string,
  componentId: string,
  weekStart: IsoDate,
): PtiComponentRating | null {
  let latest: PtiComponentRating | null = null;
  for (const row of ratings) {
    if (row.truckId !== truckId || row.componentId !== componentId) continue;
    // Weeks ran Monday-start until 2026-10-18 and run Sunday-start since; a Monday key belongs
    // to the Sunday week that holds it.
    if (row.weekStart > addDays(weekStart, 1)) continue;
    if (!latest || row.ratedAt > latest.ratedAt) latest = row;
  }
  return latest;
}

/**
 * The current condition of every active component on a unit.
 *
 * A rating carries forward between weeks until it is re-rated, so last week's "Replace soon" is
 * still on the board this week — marked as carried over, and flagged as stale once it is older
 * than the configured number of weeks, rather than silently persisting forever.
 */
export function currentConditions(
  ratings: readonly PtiComponentRating[],
  components: readonly PtiComponentDef[],
  ctx: ConditionContext,
): ComponentCondition[] {
  const config = ctx.config ?? DEFAULT_PTI_CONDITION_CONFIG;
  return [...components]
    .filter((c) => c.active && (ctx.trailerAttached || !c.trailerOnly))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((component) => {
      const source = latestFor(ratings, ctx.truckId, component.id, ctx.weekStart);
      if (!source) {
        return {
          component,
          rating: null,
          source: null,
          carriedOver: false,
          stale: false,
          closesOn: null,
          milesRemaining: null,
          daysToClose: null,
        };
      }
      const carriedOver = source.weekStart < ctx.weekStart;
      const ageWeeks = daysBetween(source.weekStart, ctx.weekStart) / 7;
      const closesOn =
        source.rating === 'replace_soon' &&
        source.windowUnit === 'weeks' &&
        source.windowValue !== null
          ? addDays(source.ratedAt.slice(0, 10), Math.round(source.windowValue * 7))
          : null;
      const milesRemaining =
        source.rating === 'replace_soon' &&
        source.windowUnit === 'miles' &&
        source.windowValue !== null &&
        source.odometerAtRating !== null &&
        ctx.odometer !== null
          ? Math.round(source.odometerAtRating + source.windowValue - ctx.odometer)
          : null;
      return {
        component,
        rating: source.rating,
        source,
        carriedOver,
        stale: carriedOver && ageWeeks > config.staleAfterWeeks,
        closesOn,
        milesRemaining,
        daysToClose: closesOn ? daysBetween(ctx.today, closesOn) : null,
      };
    });
}

/** The worst rating on a unit and the component driving it — what the board's pill shows. */
export function worstCondition(
  conditions: readonly ComponentCondition[],
): ComponentCondition | null {
  let worst: ComponentCondition | null = null;
  for (const condition of conditions) {
    if (condition.rating === null) continue;
    if (
      !worst ||
      PTI_RATING_RANK[condition.rating] > PTI_RATING_RANK[worst.rating as PtiRating] ||
      (condition.rating === worst.rating && soonest(condition) < soonest(worst))
    ) {
      worst = condition;
    }
  }
  return worst;
}

/** True when the window has closed: the date has passed, or the miles have been driven. */
export function windowClosed(condition: ComponentCondition, today: IsoDate): boolean {
  if (condition.rating !== 'replace_soon') return false;
  if (condition.closesOn) return condition.closesOn < today;
  if (condition.milesRemaining !== null) return condition.milesRemaining <= 0;
  return false;
}

/** Replace now, or Replace soon whose window closes within the horizon (or has closed). */
export function isDueSoon(condition: ComponentCondition, today: IsoDate): boolean {
  if (condition.rating === 'replace_now') return true;
  if (condition.rating !== 'replace_soon') return false;
  if (condition.closesOn) return condition.closesOn <= addDays(today, DUE_SOON_DAYS);
  if (condition.milesRemaining !== null) return condition.milesRemaining <= DUE_SOON_MILES;
  return false;
}

/**
 * A sort key: how soon the component needs the shop. Replace now sorts first, then the closest
 * date window, then miles windows by miles left, then everything without a window.
 */
export function soonest(condition: ComponentCondition): number {
  if (condition.rating === 'replace_now') return -1;
  if (condition.daysToClose !== null) return condition.daysToClose;
  // A miles window has no date; 500 miles a day is a working truck's pace and keeps the two
  // scales comparable without pretending to know the calendar.
  if (condition.milesRemaining !== null) return condition.milesRemaining / 500;
  return Number.POSITIVE_INFINITY;
}

/** "2 weeks" / "8,000 mi" / null. */
export function windowLabel(
  rating: Pick<PtiComponentRating, 'windowValue' | 'windowUnit'>,
): string | null {
  if (rating.windowValue === null || rating.windowUnit === null) return null;
  return rating.windowUnit === 'weeks'
    ? `${rating.windowValue} week${rating.windowValue === 1 ? '' : 's'}`
    : `${rating.windowValue.toLocaleString('en-US')} mi`;
}

/** One line for the board: the component and where its window stands. */
export function conditionCaption(condition: ComponentCondition, today: IsoDate): string {
  const parts = [condition.component.name];
  if (condition.rating === 'replace_soon' && condition.source) {
    if (condition.closesOn) {
      const days = condition.daysToClose ?? 0;
      parts.push(
        days < 0 ? `window closed ${-days}d ago` : days === 0 ? 'closes today' : `${days}d left`,
      );
    } else if (condition.milesRemaining !== null) {
      parts.push(
        condition.milesRemaining <= 0
          ? `${Math.abs(condition.milesRemaining).toLocaleString('en-US')} mi over`
          : `${condition.milesRemaining.toLocaleString('en-US')} mi left`,
      );
    } else {
      const label = windowLabel(condition.source);
      if (label) parts.push(label);
    }
  }
  void today;
  return parts.join(' · ');
}

/**
 * The rating that closes the loop when a work order on the component is finished: a fresh
 * "Good" row saying what was done, appended like any other rating rather than edited into the old.
 */
export function resolutionRating(
  open: PtiComponentRating,
  input: {
    at: IsoDateTime;
    weekStart: IsoDate;
    note: string;
    by: { id: string | null; name: string | null };
  },
): PtiComponentRating {
  return {
    id: `ptr_${input.at.replace(/\D/g, '')}_${open.componentId}_${open.truckId}`,
    recordId: null,
    weekStart: input.weekStart,
    truckId: open.truckId,
    componentId: open.componentId,
    rating: 'good',
    windowValue: null,
    windowUnit: null,
    odometerAtRating: null,
    ratedAt: input.at,
    ratedById: input.by.id,
    ratedByName: input.by.name,
    note: input.note,
    workOrderId: open.workOrderId,
    workOrderNumber: open.workOrderNumber,
  };
}
