import { z } from 'zod';
import type { SettlementPeriod } from './settlement-rules.js';

/**
 * The pay week (owner, 2026-10-21): a driver is paid for the loads completed inside the pay
 * period, which runs from Monday 12:00 noon US Eastern to the next Monday 12:00 noon Eastern.
 * 11:59 on the Monday still belongs to the week that is ending; 12:00 starts the new one.
 *
 * A load counts at the moment it was completed (delivered). Accounting can set a different
 * moment for pay only - "Counts for pay on" - with a reason; the delivery facts stay as they
 * are. One source of truth: the statement builder reads `loadPayTime` and nothing else.
 */

/** Accounting's pay-date override on a load, kept on the load record (`payDateOverride`). */
export interface PayDateOverride {
  /** The instant the load counts for pay at (ISO, UTC). */
  at: string;
  reason: string;
  by: string;
  byName: string;
  changedAt: string;
  /** What the load counted at before this change: an earlier override or its delivered time. */
  previousAt: string | null;
}

export const SetPayDateSchema = z.object({
  /** The instant the load counts for pay at; null takes the override off (back to the delivered time). */
  at: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500),
  /** The load's `updatedAt` as the screen read it: a stale save is a conflict, never an overwrite. */
  expectedUpdatedAt: z.string().min(1),
});
export type SetPayDateInput = z.infer<typeof SetPayDateSchema>;

type PayLoad = { deliveredAt?: string | null; updatedAt: string } & Record<string, unknown>;

/** The override on a load record, when there is a usable one. */
export function payDateOverrideOf(load: PayLoad): PayDateOverride | null {
  const o = load['payDateOverride'] as PayDateOverride | null | undefined;
  return o && typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o : null;
}

/** The moment the load completed, by the company's cutoff basis: its delivery, or its last status change. */
export function loadCompletedTime(load: PayLoad, basis: 'delivered_at' | 'status_updated_at' | null): string {
  return basis === 'status_updated_at' ? load.updatedAt : (load.deliveredAt ?? load.updatedAt);
}

/** When the load counts for pay: Accounting's override, else the moment it completed. */
export function loadPayTime(load: PayLoad, basis: 'delivered_at' | 'status_updated_at' | null): { at: string; source: 'override' | 'completed' } {
  const o = payDateOverrideOf(load);
  return o ? { at: o.at, source: 'override' } : { at: loadCompletedTime(load, basis), source: 'completed' };
}

/** The instant the period opens: the cutoff on its own first Monday. Older records without it fall back to its first day. */
export function periodStartsAt(period: Pick<SettlementPeriod, 'start' | 'startsAt'>): string {
  return period.startsAt ?? `${period.start}T00:00:00.000Z`;
}

/**
 * Whether an instant falls inside the pay period: on or after the opening Monday noon, and
 * before the closing Monday noon.
 */
export function inPayPeriod(at: string, period: Pick<SettlementPeriod, 'start' | 'startsAt' | 'cutoffAt'>): boolean {
  const t = Date.parse(at);
  return t >= Date.parse(periodStartsAt(period)) && t < Date.parse(period.cutoffAt);
}

/**
 * The period as a person reads it: "Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET". The zone
 * is always US Eastern in this product; the abbreviation says so without naming DST.
 */
export function payPeriodLabel(period: Pick<SettlementPeriod, 'start' | 'end' | 'cutoffAt' | 'timezone'> & { startsAt?: string | null }): string {
  const tz = period.timezone || 'America/New_York';
  const fmt = (iso: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('weekday')} ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
  };
  if (!period.startsAt) return `${period.start} – ${period.end}`;
  const zone = tz === 'America/New_York' ? 'ET' : tz;
  return `${fmt(period.startsAt)} – ${fmt(period.cutoffAt)} ${zone}`;
}
