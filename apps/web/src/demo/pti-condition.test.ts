import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PTI_COMPONENTS,
  currentConditions,
  isDueSoon,
  resolutionRating,
  soonest,
  windowClosed,
  worstCondition,
  type PtiComponentDef,
  type PtiComponentRating,
} from './pti-condition';

const components: PtiComponentDef[] = DEFAULT_PTI_COMPONENTS.map((c, i) => ({ ...c, id: `c${i}` }));
const steer = components[0] as PtiComponentDef; // Steer tyres
const drive = components[1] as PtiComponentDef; // Drive tyres
const trailerTyres = components[2] as PtiComponentDef; // trailer only
const brakes = components[3] as PtiComponentDef;

function rating(
  over: Partial<PtiComponentRating> & { componentId: string; weekStart: string },
): PtiComponentRating {
  return {
    id: `r_${over.componentId}_${over.weekStart}_${over.rating ?? 'good'}`,
    recordId: null,
    truckId: 'trk_1',
    rating: 'good',
    windowValue: null,
    windowUnit: null,
    odometerAtRating: null,
    ratedAt: `${over.weekStart}T12:00:00.000Z`,
    ratedById: 'u1',
    ratedByName: 'Reviewer',
    note: null,
    workOrderId: null,
    workOrderNumber: null,
    ...over,
  };
}

const ctx = {
  truckId: 'trk_1',
  weekStart: '2026-09-14',
  today: '2026-09-15',
  odometer: 100_000,
  trailerAttached: false,
};

describe('carry-forward', () => {
  it('carries the latest rating forward into a later week and marks it as carried over', () => {
    const rows = [
      rating({
        componentId: drive.id,
        weekStart: '2026-08-31',
        rating: 'replace_soon',
        windowValue: 2,
        windowUnit: 'weeks',
      }),
      rating({ componentId: brakes.id, weekStart: '2026-08-24', rating: 'good' }),
    ];
    const conditions = currentConditions(rows, components, ctx);
    const driveNow = conditions.find((c) => c.component.id === drive.id);
    expect(driveNow).toMatchObject({ rating: 'replace_soon', carriedOver: true, stale: false });
    expect(driveNow?.closesOn).toBe('2026-09-14');
    expect(conditions.find((c) => c.component.id === steer.id)?.rating).toBeNull();
  });

  it('takes the newest row for a component, never the oldest, and ignores rows from later weeks', () => {
    const rows = [
      rating({
        componentId: drive.id,
        weekStart: '2026-08-31',
        rating: 'replace_soon',
        windowValue: 2,
        windowUnit: 'weeks',
      }),
      rating({ componentId: drive.id, weekStart: '2026-09-07', rating: 'good' }),
      rating({ componentId: drive.id, weekStart: '2026-09-21', rating: 'replace_now' }),
    ];
    const [driveNow] = currentConditions(rows, [drive], ctx);
    expect(driveNow?.rating).toBe('good');
    expect(driveNow?.source?.weekStart).toBe('2026-09-07');
  });

  it('flags a carry-over older than the configured weeks as stale rather than keeping it quietly', () => {
    const rows = [rating({ componentId: drive.id, weekStart: '2026-08-03', rating: 'monitor' })];
    const [fresh] = currentConditions(rows, [drive], { ...ctx, config: { staleAfterWeeks: 8 } });
    const [stale] = currentConditions(rows, [drive], { ...ctx, config: { staleAfterWeeks: 4 } });
    expect(fresh?.stale).toBe(false);
    expect(stale?.stale).toBe(true);
  });

  it('shows trailer-only components only when a trailer is attached', () => {
    expect(
      currentConditions([], components, ctx).some((c) => c.component.id === trailerTyres.id),
    ).toBe(false);
    expect(
      currentConditions([], components, { ...ctx, trailerAttached: true }).some(
        (c) => c.component.id === trailerTyres.id,
      ),
    ).toBe(true);
  });
});

describe('windows', () => {
  it('closes a weeks window on the calendar and a miles window on the odometer', () => {
    const rows = [
      rating({
        componentId: drive.id,
        weekStart: '2026-08-31',
        rating: 'replace_soon',
        windowValue: 1,
        windowUnit: 'weeks',
      }),
      rating({
        componentId: steer.id,
        weekStart: '2026-08-31',
        rating: 'replace_soon',
        windowValue: 8000,
        windowUnit: 'miles',
        odometerAtRating: 90_000,
      }),
    ];
    const conditions = currentConditions(rows, components, ctx);
    const driveNow = conditions.find((c) => c.component.id === drive.id);
    const steerNow = conditions.find((c) => c.component.id === steer.id);
    expect(driveNow?.closesOn).toBe('2026-09-07');
    expect(driveNow?.daysToClose).toBe(-8);
    expect(windowClosed(driveNow!, ctx.today)).toBe(true);
    expect(steerNow?.milesRemaining).toBe(-2000);
    expect(windowClosed(steerNow!, ctx.today)).toBe(true);

    const later = currentConditions(rows, components, { ...ctx, odometer: 95_000 });
    expect(later.find((c) => c.component.id === steer.id)?.milesRemaining).toBe(3000);
  });

  it('calls a component due soon inside 14 days or 1,000 miles, and always for Replace now', () => {
    const rows = [
      rating({
        componentId: drive.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 2,
        windowUnit: 'weeks',
      }),
      rating({
        componentId: brakes.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 6,
        windowUnit: 'weeks',
      }),
      rating({
        componentId: steer.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 900,
        windowUnit: 'miles',
        odometerAtRating: 100_000,
      }),
    ];
    const conditions = currentConditions(rows, components, ctx);
    const by = (id: string) => conditions.find((c) => c.component.id === id)!;
    expect(isDueSoon(by(drive.id), ctx.today)).toBe(true);
    expect(isDueSoon(by(brakes.id), ctx.today)).toBe(false);
    expect(isDueSoon(by(steer.id), ctx.today)).toBe(true);
    const now = currentConditions(
      [rating({ componentId: brakes.id, weekStart: '2026-09-14', rating: 'replace_now' })],
      [brakes],
      ctx,
    );
    expect(isDueSoon(now[0]!, ctx.today)).toBe(true);
  });
});

describe('worst rating', () => {
  it('picks Replace now over Replace soon over Monitor over Good, and the soonest window on a tie', () => {
    const rows = [
      rating({ componentId: steer.id, weekStart: '2026-09-14', rating: 'good' }),
      rating({ componentId: brakes.id, weekStart: '2026-09-14', rating: 'monitor' }),
      rating({
        componentId: drive.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 3,
        windowUnit: 'weeks',
      }),
      rating({
        componentId: components[4]!.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 1,
        windowUnit: 'weeks',
      }),
    ];
    const worst = worstCondition(currentConditions(rows, components, ctx));
    expect(worst?.component.id).toBe(components[4]!.id);
    expect(worst?.rating).toBe('replace_soon');

    const withNow = [
      ...rows,
      rating({
        componentId: steer.id,
        weekStart: '2026-09-14',
        rating: 'replace_now',
        ratedAt: '2026-09-14T13:00:00.000Z',
      }),
    ];
    expect(worstCondition(currentConditions(withNow, components, ctx))?.rating).toBe('replace_now');
    expect(worstCondition(currentConditions([], components, ctx))).toBeNull();
  });

  it('sorts Replace now first, then the closest date window, then miles windows, then the rest', () => {
    const rows = [
      rating({ componentId: steer.id, weekStart: '2026-09-14', rating: 'replace_now' }),
      rating({
        componentId: drive.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 2,
        windowUnit: 'weeks',
      }),
      rating({
        componentId: brakes.id,
        weekStart: '2026-09-14',
        rating: 'replace_soon',
        windowValue: 8000,
        windowUnit: 'miles',
        odometerAtRating: 100_000,
      }),
      rating({ componentId: components[4]!.id, weekStart: '2026-09-14', rating: 'monitor' }),
    ];
    const keys = currentConditions(rows, components, ctx)
      .filter((c) => c.rating)
      .map((c) => [c.component.id, soonest(c)] as const);
    const by = Object.fromEntries(keys);
    expect(by[steer.id]).toBe(-1);
    expect(by[drive.id]).toBe(13);
    expect(by[brakes.id]).toBe(16);
    expect(by[components[4]!.id]).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('closing the loop', () => {
  it('appends a Good rating that names the work order and what was done', () => {
    const open = rating({
      componentId: drive.id,
      weekStart: '2026-09-07',
      rating: 'replace_now',
      workOrderId: 'ro_9',
      workOrderNumber: 'RO-9',
    });
    const resolved = resolutionRating(open, {
      at: '2026-09-16T10:00:00.000Z',
      weekStart: '2026-09-14',
      note: 'RO-9 completed: drive tyres replaced',
      by: { id: null, name: 'Shop' },
    });
    expect(resolved).toMatchObject({
      rating: 'good',
      componentId: drive.id,
      workOrderId: 'ro_9',
      note: 'RO-9 completed: drive tyres replaced',
    });
    const [driveNow] = currentConditions([open, resolved], [drive], {
      ...ctx,
      weekStart: '2026-09-14',
      today: '2026-09-16',
    });
    expect(driveNow?.rating).toBe('good');
  });
});
