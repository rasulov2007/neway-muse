/**
 * Requirements shown as one item with several slots, and the age of a fixed-term report.
 *
 * Owner, 2026-10-24: "CDL front and back in one place" — the licence is one item on the driver's
 * documents with a Front and a Back slot side by side, and the item is incomplete until both are
 * on file. Each side keeps its own requirement code (`cdl`, `cdl_back`), documents and
 * verification, so nothing already filed moves: the pairing is read from the catalog
 * (`partOf` / `partLabel`), never migrated.
 *
 * Pure. The web Documents tab and any API reader run the same functions.
 */
import { SYSTEM_REQUIREMENTS } from './catalog.js';
import { daysBetween } from './engine.js';
import type { ComplianceStatus } from './item.js';
import type { QualificationRequirement } from './requirement.js';

/** Statuses that mean the slot has nothing usable in it: nothing filed, or the file was rejected. */
const EMPTY_SLOT: readonly ComplianceStatus[] = ['missing', 'verification_failed'];

export interface CombinedSlot<T> {
  code: string;
  label: string;
  item: T | null;
  /** True when a document is on file for this slot and was not rejected. */
  filled: boolean;
}

export interface CombinedItem<T> {
  /** The parent requirement's code (`cdl`). */
  code: string;
  slots: CombinedSlot<T>[];
  /** True only when every slot is filled. */
  complete: boolean;
  /** The labels of the slots still to collect, in slot order ("Back"). */
  missing: string[];
}

/** The parts of `code` in slot order: the parent first, then each requirement with `partOf = code`. */
export function partsOf(
  code: string,
  catalog: readonly QualificationRequirement[] = SYSTEM_REQUIREMENTS,
): QualificationRequirement[] {
  const parent = catalog.find((r) => r.code === code);
  const children = catalog.filter((r) => r.partOf === code && r.active);
  if (!parent || children.length === 0) return parent ? [parent] : [];
  return [parent, ...children];
}

/**
 * One parent requirement and its parts, read from per-code items (evaluated items, or anything with
 * a `requirementCode` and a `status`). Complete only when every slot holds a document that was not
 * rejected — a CDL with only a front, or only a back, is incomplete.
 */
export function combineParts<T extends { requirementCode: string; status: ComplianceStatus }>(
  code: string,
  items: readonly T[],
  catalog: readonly QualificationRequirement[] = SYSTEM_REQUIREMENTS,
): CombinedItem<T> {
  const byCode = new Map(items.map((i) => [i.requirementCode, i]));
  const slots = partsOf(code, catalog).map<CombinedSlot<T>>((r) => {
    const item = byCode.get(r.code) ?? null;
    return {
      code: r.code,
      label: r.partLabel ?? r.name,
      item,
      filled: item !== null && !EMPTY_SLOT.includes(item.status),
    };
  });
  const missing = slots.filter((s) => !s.filled).map((s) => s.label);
  return { code, slots, complete: slots.length > 0 && missing.length === 0, missing };
}

/** Codes that are shown inside another item rather than as a row of their own. */
export function partCodes(
  catalog: readonly QualificationRequirement[] = SYSTEM_REQUIREMENTS,
): Set<string> {
  return new Set(catalog.filter((r) => r.partOf && r.active).map((r) => r.code));
}

/**
 * How old a dated report is, for the fixed-term reviews (MVR, PSP: 6 months). `datedOn` is the
 * report date, else the day it was received; `today` is the Eastern business date.
 */
export function reportAge(datedOn: string, today: string): { days: number; months: number; label: string } | null {
  const days = daysBetween(datedOn, today);
  if (days === null) return null;
  const [y1, m1, d1] = datedOn.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = today.split('-').map(Number) as [number, number, number];
  let months = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) months -= 1;
  months = Math.max(0, months);
  const label =
    days < 0
      ? 'Dated in the future'
      : days === 0
        ? 'Dated today'
        : months === 0
          ? `${days} ${days === 1 ? 'day' : 'days'} old`
          : `${months} ${months === 1 ? 'month' : 'months'} old`;
  return { days, months, label };
}
