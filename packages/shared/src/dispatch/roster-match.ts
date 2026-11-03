import { z } from 'zod';

/**
 * Matching a board row to a driver file.
 *
 * The board's roster carries rows the company's sheet ran for years: a name, a truck number, a
 * phone. Some of those people have a driver file in the system and some do not, and only a row
 * that carries `driverId` can ever see a load. This module says which driver file a row is
 * probably about - and it only ever *suggests*. Nothing here writes, nothing merges, and a
 * candidate is never applied without a person confirming it, because the cost of a wrong match
 * is a driver looking at another driver's freight.
 *
 * Deliberately not clever: no fuzzy edit distance, no phonetics. The signals are the ones a
 * dispatcher would use - the same truck, the same phone, the same name in either order - and
 * each one is named in the answer so the person confirming can see why.
 */

/** What a candidate is worth. `exact` may be offered as a default; nothing else may. */
export const MATCH_CONFIDENCES = ['exact', 'strong', 'possible'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];

export interface MatchDriver {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  /** The unit the driver file has them on, when it has one. */
  truckUnit: string | null;
  status: string;
  /** True when this driver already holds a board row: linking means merging two rows. */
  hasRosterRow: boolean;
}

export interface MatchRow {
  id: string;
  name: string;
  coDriver: string | null;
  truckUnit: string | null;
  phone: string;
}

export interface MatchCandidate {
  driverId: string;
  driverName: string;
  score: number;
  confidence: MatchConfidence;
  /** Why, in the words the screen shows: "same truck 2785", "name matches". */
  reasons: string[];
  hasRosterRow: boolean;
  driverStatus: string;
}

export interface RowMatch {
  row: MatchRow;
  candidates: MatchCandidate[];
  /**
   * Two or more candidates worth taking seriously. The screen must not preselect one; a person
   * picks. This is the case that produces a wrong match if anything is automatic.
   */
  ambiguous: boolean;
  /** No candidate at all: this person has no driver file, and a match cannot be made up. */
  none: boolean;
}

/** Digits only, so `(773) 555-8525` and `773-555-8525` are the same number. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D+/g, '').replace(/^1(\d{10})$/, '$1');
}

/**
 * A truck number as the board and the fleet both mean it: `# 0053`, `0053` and `53` are one unit.
 * Leading zeros are decoration in the sheet and meaning in the fleet, so both are stripped for
 * the comparison only - never for display.
 */
export function unitKey(unit: string | null | undefined): string {
  if (!unit) return '';
  const trimmed = unit.trim().toUpperCase().replace(/^#\s*/, '');
  if (!trimmed) return '';
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

/** Lower case, no punctuation, single spaces. Accents are kept: they are part of the name. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/[-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a name, ignoring the team's second driver ("NAME // CO-DRIVER"). */
export function nameTokens(name: string): string[] {
  const first = name.split('//')[0] ?? name;
  return normalizeName(first).split(' ').filter(Boolean);
}

/**
 * How much two names agree: 1 when the same words are present in any order, 0 when they share
 * nothing. "Dorian Fenwick" and "Fenwick Dorian" are the same person written by two people.
 */
export function nameAgreement(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return 0;
  const shared = left.filter((token) => right.includes(token));
  return shared.length / Math.max(left.length, right.length);
}

const SCORE = {
  nameExact: 60,
  namePartial: 34,
  truck: 30,
  phone: 25,
} as const;

/** One driver weighed against one row. Exported for the tests and for a single-row re-check. */
export function scoreCandidate(row: MatchRow, driver: MatchDriver): MatchCandidate | null {
  const driverName = `${driver.firstName} ${driver.lastName}`.trim();
  const agreement = nameAgreement(row.name, driverName);
  const sameTruck = unitKey(row.truckUnit) !== '' && unitKey(row.truckUnit) === unitKey(driver.truckUnit);
  const samePhone = phoneDigits(row.phone) !== '' && phoneDigits(row.phone) === phoneDigits(driver.phone);

  const reasons: string[] = [];
  let score = 0;
  if (agreement === 1) {
    score += SCORE.nameExact;
    reasons.push('name matches');
  } else if (agreement >= 0.5) {
    score += Math.round(SCORE.namePartial * agreement);
    reasons.push('part of the name matches');
  }
  if (sameTruck) {
    score += SCORE.truck;
    reasons.push(`same truck ${row.truckUnit?.trim()}`);
  }
  if (samePhone) {
    score += SCORE.phone;
    reasons.push('same phone number');
  }
  // A truck number on its own is not a person: trucks change hands. It supports a name, never
  // replaces one.
  if (score === 0 || (agreement === 0 && !samePhone)) return null;

  const confidence: MatchConfidence =
    agreement === 1 && (sameTruck || samePhone) ? 'exact' : score >= 60 ? 'strong' : 'possible';
  return {
    driverId: driver.id,
    driverName,
    score,
    confidence,
    reasons,
    hasRosterRow: driver.hasRosterRow,
    driverStatus: driver.status,
  };
}

/**
 * The candidates for one row, best first.
 *
 * `ambiguous` is the answer that matters: when two people could be meant, the screen says so and
 * offers neither. Only a single `exact` candidate may be shown as a default, and even that one
 * is confirmed by hand.
 */
export function suggestMatches(row: MatchRow, drivers: MatchDriver[], limit = 4): RowMatch {
  const candidates = drivers
    .map((driver) => scoreCandidate(row, driver))
    .filter((c): c is MatchCandidate => c !== null)
    .sort((a, b) => b.score - a.score || a.driverName.localeCompare(b.driverName))
    .slice(0, limit);
  const serious = candidates.filter((c) => c.confidence !== 'possible');
  const ambiguous =
    serious.length > 1 && serious[0]!.score - serious[1]!.score < 15;
  return { row, candidates, ambiguous, none: candidates.length === 0 };
}

// ------------------------------------------------------------------------------- the write

/**
 * Confirming one match. `expectedVersion` is the roster row the person was looking at; a row
 * that moved underneath them is refused rather than linked to the wrong file.
 */
/** Which side of a disagreement to keep: the driver's own row, or the imported one. */
export const MERGE_CHOICES = ['keep', 'take'] as const;
export type MergeChoice = (typeof MERGE_CHOICES)[number];

export const LinkRosterRowSchema = z.object({
  driverId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  /**
   * The driver already has a board row, so confirming this match merges two rows into one. The
   * screen has to say that in words and the person has to have seen it.
   */
  mergeAcknowledged: z.boolean().default(false),
  /**
   * What to do where the two rows disagree, keyed as the preview lists them: `field:truckUnit`,
   * `cell:2026-09-24|status`. Every conflict the preview reported has to have an answer - a
   * merge that silently took the newer value is how a load number ends up on the wrong driver.
   */
  resolutions: z.record(z.string(), z.enum(MERGE_CHOICES)).default({}),
});
export type LinkRosterRowInput = z.infer<typeof LinkRosterRowSchema>;

export const MatchCandidateSchema = z.object({
  driverId: z.string(),
  driverName: z.string(),
  score: z.number(),
  confidence: z.enum(MATCH_CONFIDENCES),
  reasons: z.array(z.string()),
  hasRosterRow: z.boolean(),
  driverStatus: z.string(),
});

export const RowMatchSchema = z.object({
  row: z.object({
    id: z.string(),
    name: z.string(),
    coDriver: z.string().nullable(),
    truckUnit: z.string().nullable(),
    phone: z.string(),
    dispatcherName: z.string(),
    /** The row as the screen saw it; a confirm that arrives against an older one is refused. */
    version: z.number().int(),
    /** What the row would lose sight of: typed cells that travel with it on a merge. */
    typedCells: z.number().int(),
    lastTypedAt: z.string().nullable(),
  }),
  candidates: z.array(MatchCandidateSchema),
  ambiguous: z.boolean(),
  none: z.boolean(),
});
export type RowMatchView = z.infer<typeof RowMatchSchema>;

export const RosterMatchReportSchema = z.object({
  /** Rows with no driver file, newest typed first. */
  rows: z.array(RowMatchSchema),
  linkedCount: z.number().int(),
  unlinkedCount: z.number().int(),
  driverFileCount: z.number().int(),
});
export type RosterMatchReport = z.infer<typeof RosterMatchReportSchema>;

// ------------------------------------------------------------------- the merge preview

/** One disagreement between the two rows, with both values as they stand. */
export const MergeConflictSchema = z.object({
  /** `field:truckUnit` or `cell:2026-09-24|status`. */
  key: z.string(),
  kind: z.enum(['field', 'cell']),
  /** What a person calls it: "Truck number", "Status on Sep 24". */
  label: z.string(),
  keepValue: z.string().nullable(),
  takeValue: z.string().nullable(),
  keepDetail: z.string().nullable(),
  takeDetail: z.string().nullable(),
  /** Load numbers, statuses and assignments are operational: a wrong answer moves freight. */
  operational: z.boolean(),
});
export type MergeConflict = z.infer<typeof MergeConflictSchema>;

export const MergePreviewSchema = z.object({
  /** The imported row being matched. */
  from: z.object({ id: z.string(), name: z.string(), truckUnit: z.string().nullable(), phone: z.string(), coDriver: z.string().nullable(), payTag: z.string().nullable(), dispatcherName: z.string(), comment: z.string(), version: z.number().int() }),
  /** The driver's own row, when they have one; null means the row simply takes the driver id. */
  into: z.object({ id: z.string(), name: z.string(), truckUnit: z.string().nullable(), phone: z.string(), coDriver: z.string().nullable(), payTag: z.string().nullable(), dispatcherName: z.string(), comment: z.string(), version: z.number().int() }).nullable(),
  /** Cells that move with nobody disagreeing. */
  movingCells: z.number().int(),
  /** Cells only the driver's row has: untouched, listed so the screen can say so. */
  keptCells: z.number().int(),
  conflicts: z.array(MergeConflictSchema),
});
export type MergePreview = z.infer<typeof MergePreviewSchema>;
