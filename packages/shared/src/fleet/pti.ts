import { z } from 'zod';

/**
 * The weekly walk-around, rebuilt around a record that can be owned.
 *
 * A PTI defect used to be three columns on an inspection row — category, issue text, action text
 * — so it could not be owned, dated, aged, assigned, verified or referenced by anything else.
 * That is why the board and Truck Health could state opposite facts about one truck. Here a
 * defect is a record with a life of its own; an inspection is the event that found it; the
 * unit's service status is derived from the open defects and never typed in.
 *
 * Four things that used to be one column are four fields: whether the video arrived (receipt),
 * whether anybody watched it (review state), what they concluded (review result), and what is
 * wrong with the truck (defects). None of them implies another.
 */

// ------------------------------------------------------------------------------ vocabulary

export const PTI_RECEIPT_STATUSES = [
  'not_due',
  'awaiting',
  'received',
  'late',
  'missing',
  'exempt_in_shop',
] as const;
export type PtiReceiptStatus = (typeof PTI_RECEIPT_STATUSES)[number];

export const PTI_RECEIPT_LABEL: Record<PtiReceiptStatus, string> = {
  not_due: 'Not due yet',
  awaiting: 'Awaiting video',
  received: 'Received',
  late: 'Late',
  missing: 'Missing',
  exempt_in_shop: 'In shop — exempt',
};

export const PTI_REVIEW_STATES = ['unreviewed', 'in_review', 'reviewed'] as const;
export type PtiReviewState = (typeof PTI_REVIEW_STATES)[number];

export const PTI_REVIEW_RESULTS = ['no_issues', 'issues_found'] as const;
export type PtiReviewResult = (typeof PTI_REVIEW_RESULTS)[number];

/** Worst last. `oos_risk` is the only one that blocks dispatch outright (§9.1). */
export const PTI_DEFECT_SEVERITIES = [
  'monitor',
  'replace_soon',
  'replace_now',
  'oos_risk',
] as const;
export type PtiDefectSeverity = (typeof PTI_DEFECT_SEVERITIES)[number];

export const PTI_DEFECT_SEVERITY_LABEL: Record<PtiDefectSeverity, string> = {
  monitor: 'Monitor',
  replace_soon: 'Replace soon',
  replace_now: 'Replace now',
  oos_risk: 'Out-of-service risk',
};

export const PTI_DEFECT_SEVERITY_RANK: Record<PtiDefectSeverity, number> = {
  monitor: 1,
  replace_soon: 2,
  replace_now: 3,
  oos_risk: 4,
};

export const PTI_DEFECT_STATES = [
  'open',
  'assigned',
  'scheduled',
  'in_repair',
  'fixed_pending_verify',
  'verified',
  'dismissed',
] as const;
export type PtiDefectState = (typeof PTI_DEFECT_STATES)[number];

export const PTI_DEFECT_STATE_LABEL: Record<PtiDefectState, string> = {
  open: 'Open',
  assigned: 'Assigned',
  scheduled: 'Scheduled',
  in_repair: 'In repair',
  fixed_pending_verify: 'Fixed — awaiting verify',
  verified: 'Verified',
  dismissed: 'Dismissed',
};

/** The two terminal states. A defect in either is closed; nothing reopens it but a new defect. */
export const CLOSED_DEFECT_STATES: readonly PtiDefectState[] = ['verified', 'dismissed'];

export function isOpenDefectState(state: PtiDefectState): boolean {
  return !CLOSED_DEFECT_STATES.includes(state);
}

/**
 * Where a defect may go from where it is.
 *
 * `verified` is reachable only from `fixed_pending_verify`, and only by a person's explicit
 * action: a shop closing a work order and a reviewer seeing a repair both *propose* closure. The
 * hold lifts when somebody confirms, and at no other moment.
 */
export const PTI_DEFECT_TRANSITIONS: Record<PtiDefectState, readonly PtiDefectState[]> = {
  open: ['assigned', 'scheduled', 'in_repair', 'fixed_pending_verify', 'dismissed'],
  assigned: ['scheduled', 'in_repair', 'fixed_pending_verify', 'dismissed', 'open'],
  scheduled: ['in_repair', 'fixed_pending_verify', 'dismissed', 'assigned'],
  in_repair: ['fixed_pending_verify', 'dismissed', 'scheduled'],
  fixed_pending_verify: ['verified', 'in_repair', 'open', 'dismissed'],
  verified: [],
  dismissed: [],
};

export function canTransition(from: PtiDefectState, to: PtiDefectState): boolean {
  return PTI_DEFECT_TRANSITIONS[from].includes(to);
}

export const UNIT_SERVICE_STATUSES = ['cleared', 'watch', 'restricted', 'out_of_service'] as const;
export type UnitServiceStatus = (typeof UNIT_SERVICE_STATUSES)[number];

export const UNIT_SERVICE_STATUS_LABEL: Record<UnitServiceStatus, string> = {
  cleared: 'Cleared',
  watch: 'Watch',
  restricted: 'Restricted',
  out_of_service: 'Out of service',
};

export const DEFECT_DISPOSITIONS = ['still_present', 'looks_fixed', 'not_visible'] as const;
export type DefectDisposition = (typeof DEFECT_DISPOSITIONS)[number];

export const DEFECT_DISPOSITION_LABEL: Record<DefectDisposition, string> = {
  still_present: 'Still present',
  looks_fixed: 'Looks fixed — propose for verify',
  not_visible: 'Not visible in this video',
};

export const FIXED_VIA = ['work_order', 'yard', 'roadside', 'no_action_needed'] as const;
export type FixedVia = (typeof FIXED_VIA)[number];

// ---------------------------------------------------------------------------------- rules

/** Severity → hours until due, on creation. Editable afterwards; re-proposed on a severity change. */
export const DEFECT_DUE_HOURS: Record<PtiDefectSeverity, number> = {
  monitor: 30 * 24,
  replace_soon: 14 * 24,
  replace_now: 48,
  oos_risk: 0,
};

export function defectDueAt(severity: PtiDefectSeverity, from: Date): Date {
  const hours = DEFECT_DUE_HOURS[severity];
  if (hours === 0) {
    // Same day: the end of the day it was found, in the caller's clock.
    const end = new Date(from);
    end.setHours(23, 59, 0, 0);
    return end;
  }
  return new Date(from.getTime() + hours * 3_600_000);
}

/**
 * §9.1: `oos_risk` blocks dispatch outright. `replace_now` restricts — the screen warns and the
 * override is a named, logged decision. Neither is a status somebody types.
 */
export const BLOCKING_SEVERITIES: readonly PtiDefectSeverity[] = ['oos_risk'];

/**
 * §3.3 asked for a screenshot at `replace_now` and above. The owner lifted it (2026-10-05): a
 * screenshot is welcome on any defect, but no defect is ever refused for lacking one.
 */
export const SCREENSHOT_REQUIRED_FROM: PtiDefectSeverity = 'replace_now';

export function screenshotRequired(_severity: PtiDefectSeverity): boolean {
  return false;
}

/** A screenshot is a still from a phone video; anything past this is not one. */
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Why a file cannot be a screenshot, in words for the person who chose it, or null when it can.
 * The browser checks before uploading and the server checks the stored row; same rule, same words.
 */
export function describeScreenshotProblem(file: {
  contentType: string;
  sizeBytes: number;
}): string | null {
  if (!file.contentType.startsWith('image/'))
    return 'A screenshot has to be an image (PNG or JPG), not a document';
  if (file.sizeBytes > SCREENSHOT_MAX_BYTES)
    return `A screenshot has to be under ${SCREENSHOT_MAX_BYTES / (1024 * 1024)} MB`;
  return null;
}

/**
 * The unit's service status, from its open defects and nothing else (§4.2).
 *
 * One verdict, one reason, one release condition — so the header can say "Out of service —
 * hold: DEF-4417 — released when DEF-4417 is verified" instead of three badges that disagree.
 */
export interface UnitServiceVerdict {
  status: UnitServiceStatus;
  /** True when a load may not be assigned without a logged override. */
  dispatchBlocked: boolean;
  /** The defects that set the status; the first is the one the reason names. */
  defectIds: string[];
  reason: string | null;
  releaseCondition: string | null;
}

export function unitServiceStatus(
  defects: {
    id: string;
    defectNumber: string;
    severity: PtiDefectSeverity;
    state: PtiDefectState;
  }[],
): UnitServiceVerdict {
  const open = defects.filter((d) => isOpenDefectState(d.state));
  const worstFirst = [...open].sort(
    (a, b) => PTI_DEFECT_SEVERITY_RANK[b.severity] - PTI_DEFECT_SEVERITY_RANK[a.severity],
  );

  const blocking = worstFirst.filter((d) => BLOCKING_SEVERITIES.includes(d.severity));
  if (blocking.length > 0) {
    const named = blocking[0] as (typeof blocking)[number];
    return {
      status: 'out_of_service',
      dispatchBlocked: true,
      defectIds: blocking.map((d) => d.id),
      reason: `hold: ${named.defectNumber}`,
      releaseCondition: `released when ${blocking.map((d) => d.defectNumber).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} verified`,
    };
  }
  const restricted = worstFirst.filter((d) => d.severity === 'replace_now');
  if (restricted.length > 0) {
    const named = restricted[0] as (typeof restricted)[number];
    return {
      status: 'restricted',
      dispatchBlocked: false,
      defectIds: restricted.map((d) => d.id),
      reason: `${named.defectNumber} needs replacing now`,
      releaseCondition: `released when ${restricted.map((d) => d.defectNumber).join(', ')} ${restricted.length === 1 ? 'is' : 'are'} verified`,
    };
  }
  if (worstFirst.length > 0) {
    const named = worstFirst[0] as (typeof worstFirst)[number];
    return {
      status: 'watch',
      dispatchBlocked: false,
      defectIds: worstFirst.map((d) => d.id),
      reason: `${worstFirst.length} open ${worstFirst.length === 1 ? 'defect' : 'defects'}, worst ${named.defectNumber} (${PTI_DEFECT_SEVERITY_LABEL[named.severity].toLowerCase()})`,
      releaseCondition: null,
    };
  }
  return {
    status: 'cleared',
    dispatchBlocked: false,
    defectIds: [],
    reason: null,
    releaseCondition: null,
  };
}

// ------------------------------------------------------------------- the lists' "PTI issue" sign

/**
 * The states in which a defect is still waiting on its repair: found, owned, booked or in the shop.
 * `fixed_pending_verify` is not here - the shop says it is fixed - and `verified` / `dismissed`
 * are closed.
 */
export const UNFIXED_DEFECT_STATES: readonly PtiDefectState[] = [
  'open',
  'assigned',
  'scheduled',
  'in_repair',
];

/** How loud the sign beside a unit's status is. `oos` and `urgent` both draw the octagon. */
export const PTI_ISSUE_LEVELS = ['oos', 'urgent', 'warning'] as const;
export type PtiIssueLevel = (typeof PTI_ISSUE_LEVELS)[number];

export interface PtiIssueDefect {
  id: string;
  defectNumber: string;
  component: string;
  componentName: string;
  description: string;
  severity: PtiDefectSeverity;
  state: PtiDefectState;
}

/** One unit's PTI issues, as the Trucks list and the dispatch board show them (owner, 2026-10-21). */
export interface PtiUnitIssues {
  /** How many defects count. */
  open: number;
  worst: PtiIssueLevel;
  /** One line per defect, worst first, for the tooltip. */
  summary: string;
  defects: PtiIssueDefect[];
  /** The unit number the defects were recorded on, for screens keyed by number (the dispatch board). */
  unitNumber?: string;
}

/**
 * Whether a defect puts the "PTI issue" sign on its unit (owner, 2026-10-21: a truck that reads
 * "Available" must not hide a PTI problem from dispatch).
 *
 * Every defect not yet fixed counts, owned or not. A fixed one that is still awaiting verification
 * counts only while it holds the unit out of service (§9.1): the hold has not lifted, so dispatch
 * still has to see it.
 */
export function isPtiIssue(defect: { severity: PtiDefectSeverity; state: PtiDefectState }): boolean {
  if (UNFIXED_DEFECT_STATES.includes(defect.state)) return true;
  return defect.state === 'fixed_pending_verify' && BLOCKING_SEVERITIES.includes(defect.severity);
}

export function ptiIssueLevel(severity: PtiDefectSeverity): PtiIssueLevel {
  if (severity === 'oos_risk') return 'oos';
  if (severity === 'replace_now') return 'urgent';
  return 'warning';
}

function shortText(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A unit's PTI issues from its defects, or null when nothing counts. */
export function summarizePtiIssues(defects: readonly PtiIssueDefect[]): PtiUnitIssues | null {
  const issues = defects
    .filter(isPtiIssue)
    .sort(
      (a, b) =>
        PTI_DEFECT_SEVERITY_RANK[b.severity] - PTI_DEFECT_SEVERITY_RANK[a.severity] ||
        a.defectNumber.localeCompare(b.defectNumber),
    );
  const first = issues[0];
  if (!first) return null;
  return {
    open: issues.length,
    worst: ptiIssueLevel(first.severity),
    summary: issues
      .map(
        (d) =>
          `${d.componentName || d.component}: ${shortText(d.description)} (${PTI_DEFECT_SEVERITY_LABEL[d.severity]}, ${PTI_DEFECT_STATE_LABEL[d.state].toLowerCase()})`,
      )
      .join('\n'),
    defects: issues,
  };
}

/** The issues of every unit that has any, keyed by unit id. */
export function ptiIssuesByUnit(
  defects: readonly (PtiIssueDefect & { unitId: string; unitNumber?: string })[],
): Record<string, PtiUnitIssues> {
  const byUnit = new Map<string, { unitNumber: string; list: PtiIssueDefect[] }>();
  for (const { unitId, unitNumber, ...defect } of defects) {
    const entry = byUnit.get(unitId) ?? { unitNumber: '', list: [] };
    entry.list.push(defect);
    if (!entry.unitNumber && unitNumber) entry.unitNumber = unitNumber;
    byUnit.set(unitId, entry);
  }
  const out: Record<string, PtiUnitIssues> = {};
  for (const [unitId, { unitNumber, list }] of byUnit) {
    const issues = summarizePtiIssues(list);
    if (issues) out[unitId] = { ...issues, unitNumber };
  }
  return out;
}

/**
 * What a description must be to count as one (WP7).
 *
 * At least eight characters, not only digits and punctuation, not one character repeated. The
 * five strings that were live on the board — `65`, `.+6.`, `111111111111`, `2222222222222222222`,
 * `65464` — all fail here, and a backfilled legacy row that fails is kept with a flag, never
 * invented into something readable.
 */
export function describeDescriptionProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return 'Say what is wrong in at least eight characters';
  if (!/[a-z]/i.test(trimmed)) return 'A description needs words, not just numbers or symbols';
  if (/^(.)\1+$/.test(trimmed.replace(/\s/g, ''))) return 'That is one character repeated';
  return null;
}

export function isValidDescription(text: string): boolean {
  return describeDescriptionProblem(text) === null;
}

/** Only a Telegram message link, checked by shape. Never fetched (§3.3). */
export function isTelegramMessageUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 't.me' || host === 'telegram.me' || host === 'www.t.me';
  } catch {
    return false;
  }
}

/**
 * The cycle: a week starting Sunday and ending Saturday (owner, 2026-10-18; Monday-start before),
 * with the video still due by the end of Wednesday.
 */
export const PTI_WEEK_STARTS_ON = 0;
export const PTI_DUE_DAY_OFFSET = 3;

/** The Sunday of the week a date falls in, as YYYY-MM-DD. */
export function ptiWeekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const back = (day - PTI_WEEK_STARTS_ON + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function ptiDueDateOf(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + PTI_DUE_DAY_OFFSET);
  return d.toISOString().slice(0, 10);
}

/**
 * Receipt, from the facts (§4.6). Received beats everything; a unit in the shop is exempt; before
 * the due day nothing is owed; after it the video is missing, and a late arrival stays "late".
 */
export function receiptStatusFor(input: {
  weekStart: string;
  today: string;
  receivedOn: string | null;
  inShop: boolean;
}): PtiReceiptStatus {
  const due = ptiDueDateOf(input.weekStart);
  if (input.receivedOn) return input.receivedOn > due ? 'late' : 'received';
  if (input.inShop) return 'exempt_in_shop';
  if (input.today <= due) return input.today < input.weekStart ? 'not_due' : 'awaiting';
  return 'missing';
}

// ------------------------------------------------------------------------ the catalog key

/**
 * The stable key for a catalog component, from its name.
 *
 * The catalog (`ws2-pticomponents`) is admin-editable data keyed by id, and names can be
 * retyped. A defect must survive a rename, so it stores this key, derived once from the name
 * the way the specification spells it: `Lights & reflectors` → `lights_reflectors`,
 * `5th wheel / coupling` → `fifth_wheel_coupling`.
 */
export function componentKeyFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/^5th/, 'fifth')
    .replace(/[&/]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return COMPONENT_KEY_OVERRIDES[slug] ?? slug;
}

const COMPONENT_KEY_OVERRIDES: Record<string, string> = {
  body_mud_flaps: 'body_mudflaps',
  '5th_wheel_coupling': 'fifth_wheel_coupling',
};

/** The thirteen keys the default catalog yields; a custom component adds its own. */
export const DEFAULT_PTI_COMPONENT_KEYS = [
  'steer_tyres',
  'drive_tyres',
  'trailer_tyres',
  'brakes',
  'lights_reflectors',
  'leaks_fluids',
  'suspension_airbags',
  'belts_hoses',
  'battery_electrical',
  'windshield_mirrors',
  'body_mudflaps',
  'fifth_wheel_coupling',
  'trailer_condition',
] as const;

/**
 * The seven legacy issue categories, mapped onto the catalog (§5.1).
 *
 * `Tires / Wheels` cannot say steer or drive, so it lands on drive and is flagged; `Mounting` and
 * `Other` have no target at all and go to the review bucket rather than to a wrong component.
 */
export const LEGACY_CATEGORY_MAP: Record<string, { key: string; flag: boolean } | null> = {
  Lights: { key: 'lights_reflectors', flag: false },
  'Tires / Wheels': { key: 'drive_tyres', flag: true },
  Brakes: { key: 'brakes', flag: false },
  Leaks: { key: 'leaks_fluids', flag: false },
  Body: { key: 'body_mudflaps', flag: false },
  Mounting: null,
  Other: null,
};

// ------------------------------------------------------------------------------- records

export const TelegramSourceSchema = z.object({
  chatTitle: z.string().trim().min(1).max(120),
  messageUrl: z.string().trim().refine(isTelegramMessageUrl, 'Paste a t.me message link'),
  messageId: z.string().trim().max(40).nullable().default(null),
  senderName: z.string().trim().max(120).nullable().default(null),
  sentAt: z.string().nullable().default(null),
  capturedBy: z.enum(['manual', 'bot']).default('manual'),
});
export type TelegramSource = z.infer<typeof TelegramSourceSchema>;

export const ScreenshotSchema = z.object({
  /** The `stored_files` row; the bytes are fetched through `/files/:id`. */
  fileId: z.string().min(1),
  fileName: z.string(),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;

export const DefectEvidenceSchema = z.object({
  /** A label a human typed — "04:18". Not a seek target. */
  clipTime: z.string().trim().max(20).nullable().default(null),
  screenshots: z.array(ScreenshotSchema).default([]),
});
export type DefectEvidence = z.infer<typeof DefectEvidenceSchema>;

export const DefectResolutionSchema = z.object({
  fixedAt: z.string().nullable().default(null),
  fixedVia: z.enum(FIXED_VIA).nullable().default(null),
  verifiedAt: z.string().nullable().default(null),
  verifiedBy: z.string().nullable().default(null),
  dismissedReason: z.string().nullable().default(null),
});
export type DefectResolution = z.infer<typeof DefectResolutionSchema>;

export const DefectHistoryEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  byId: z.string(),
  byName: z.string(),
  from: z.enum(PTI_DEFECT_STATES).nullable(),
  to: z.enum(PTI_DEFECT_STATES),
  note: z.string().nullable(),
});
export type DefectHistoryEntry = z.infer<typeof DefectHistoryEntrySchema>;

export const PtiDefectSchema = z.object({
  id: z.string(),
  /** Human-facing: DEF-0001. */
  defectNumber: z.string(),
  unitId: z.string(),
  unitNumber: z.string(),
  foundOnInspectionId: z.string().nullable(),
  /** A key from the component catalog (`PtiComponentDef.key`). Never free text. */
  component: z.string(),
  componentName: z.string(),
  description: z.string(),
  quickPick: z.string().nullable(),
  severity: z.enum(PTI_DEFECT_SEVERITIES),
  state: z.enum(PTI_DEFECT_STATES),
  evidence: DefectEvidenceSchema,
  ownerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  dueAt: z.string().nullable(),
  workOrderId: z.string().nullable(),
  workOrderNumber: z.string().nullable(),
  resolution: DefectResolutionSchema,
  /** Set by the backfill on a row whose legacy text could not be trusted; cleared by a person. */
  needsReview: z.boolean(),
  legacyRecordId: z.string().nullable(),
  history: z.array(DefectHistoryEntrySchema),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type PtiDefect = z.infer<typeof PtiDefectSchema>;

export const OpenDefectDispositionSchema = z.object({
  defectId: z.string(),
  seen: z.enum(DEFECT_DISPOSITIONS),
});
export type OpenDefectDisposition = z.infer<typeof OpenDefectDispositionSchema>;

// ------------------------------------------------------------- the driver app's walk-around (0081)

/** What the driver says about each checklist item. */
export const DRIVER_PTI_RESULTS = ['good', 'attention', 'defect'] as const;
export type DriverPtiResult = (typeof DRIVER_PTI_RESULTS)[number];
export const DRIVER_PTI_RESULT_LABEL: Record<DriverPtiResult, string> = {
  good: 'Good',
  attention: 'Needs attention',
  defect: 'Defect',
};

export const DriverPtiChecklistItemSchema = z.object({
  /** A component key from the walk-around catalog (the same keys a defect uses). */
  key: z.string().min(1).max(80),
  result: z.enum(DRIVER_PTI_RESULTS),
  note: z.string().trim().max(1000).nullable().default(null),
  /** stored_files ids the driver uploaded through POST /driver/files. */
  photoFileIds: z.array(z.string().min(1)).max(10).default([]),
});
export type DriverPtiChecklistItem = z.infer<typeof DriverPtiChecklistItemSchema>;

/** One submission, as kept on the inspection (`pti_inspections.source`, kind `driver_app`). */
export const DriverPtiSubmissionSchema = z.object({
  kind: z.literal('driver_app'),
  submissionNumber: z.number().int().positive(),
  submittedAt: z.string(),
  driverId: z.string(),
  driverName: z.string(),
  truckId: z.string(),
  truckUnit: z.string(),
  trailerId: z.string().nullable(),
  trailerUnit: z.string().nullable(),
  checklist: z.array(DriverPtiChecklistItemSchema),
  photos: z.array(z.string()),
  notes: z.string().nullable(),
  odometer: z.number().int().nonnegative().nullable(),
  /** The defects this submission raised (ids), so the history can say which. */
  defectIds: z.array(z.string()),
});
export type DriverPtiSubmission = z.infer<typeof DriverPtiSubmissionSchema>;

/** A correction Safety asked for, and when the driver answered it. */
export const PtiCorrectionSchema = z.object({
  requestedAt: z.string(),
  requestedBy: z.string(),
  reason: z.string(),
  answeredAt: z.string().nullable(),
});
export type PtiCorrection = z.infer<typeof PtiCorrectionSchema>;

/** Safety → PTI drawer: send the walk-around back to the driver with a reason (0081). */
export const RequestPtiCorrectionSchema = z.object({
  version: z.number().int(),
  reason: z.string().trim().min(3, 'Say what the driver should redo').max(500),
});
export type RequestPtiCorrectionInput = z.infer<typeof RequestPtiCorrectionSchema>;

export const PtiInspectionSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  unitNumber: z.string(),
  weekStart: z.string(),
  dueAt: z.string(),
  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  driverType: z.string().nullable(),
  dispatcherId: z.string().nullable(),
  dispatcherName: z.string().nullable(),
  receiptStatus: z.enum(PTI_RECEIPT_STATUSES),
  receivedAt: z.string().nullable(),
  source: TelegramSourceSchema.nullable(),
  reviewState: z.enum(PTI_REVIEW_STATES),
  reviewerId: z.string().nullable(),
  reviewerName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewResult: z.enum(PTI_REVIEW_RESULTS).nullable(),
  inReviewBy: z.string().nullable(),
  inReviewByName: z.string().nullable(),
  inReviewSince: z.string().nullable(),
  openDefectDispositions: z.array(OpenDefectDispositionSchema),
  legacyRecordId: z.string().nullable(),
  /**
   * The driver app's submission (0081): the latest one, its earlier versions in `driverHistory`.
   * `source` stays the Telegram pointer; a walk-around sent from the app has none.
   */
  driverSubmission: DriverPtiSubmissionSchema.nullable().optional(),
  driverHistory: z.array(DriverPtiSubmissionSchema).optional(),
  /** The open correction request, when Safety sent the walk-around back to the driver. */
  correction: PtiCorrectionSchema.nullable().optional(),
  /** Every correction asked for this week, oldest first (answered ones included). */
  corrections: z.array(PtiCorrectionSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type PtiInspection = z.infer<typeof PtiInspectionSchema>;

/** One past week of a unit, as the review's history card lists it (owner's form, 2026-09-22). */
export const PtiUnitHistoryEntrySchema = z.object({
  id: z.string(),
  weekStart: z.string(),
  receiptStatus: z.enum(PTI_RECEIPT_STATUSES),
  receivedAt: z.string().nullable(),
  reviewState: z.enum(PTI_REVIEW_STATES),
  reviewResult: z.enum(PTI_REVIEW_RESULTS).nullable(),
  reviewerName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  /** Defects raised on that week's review. */
  defectCount: z.number().int(),
});
export type PtiUnitHistoryEntry = z.infer<typeof PtiUnitHistoryEntrySchema>;

// -------------------------------------------------------------------------------- inputs

const description = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const problem = describeDescriptionProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** A defect raised on its own — from the truck page or the shop — or inside a review. */
export const CreateDefectSchema = z.object({
  unitId: z.string().min(1),
  foundOnInspectionId: z.string().nullable().default(null),
  component: z.string().min(1, 'Pick the component'),
  description,
  quickPick: z.string().trim().max(60).nullable().default(null),
  severity: z.enum(PTI_DEFECT_SEVERITIES),
  evidence: DefectEvidenceSchema.default({ clipTime: null, screenshots: [] }),
  ownerId: z.string().nullable().default(null),
  /** Absent: proposed from the severity. Present: the person's own date. */
  dueAt: z.string().nullable().default(null),
});
export type CreateDefectInput = z.infer<typeof CreateDefectSchema>;
/** What a caller sends: the defaults may be left out. */
export type CreateDefectRequest = z.input<typeof CreateDefectSchema>;

export const UpdateDefectSchema = z.object({
  version: z.number().int(),
  description: description.optional(),
  component: z.string().min(1).optional(),
  severity: z.enum(PTI_DEFECT_SEVERITIES).optional(),
  evidence: DefectEvidenceSchema.optional(),
  ownerId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  needsReview: z.boolean().optional(),
});
export type UpdateDefectInput = z.infer<typeof UpdateDefectSchema>;
export type UpdateDefectRequest = z.input<typeof UpdateDefectSchema>;

export const TransitionDefectSchema = z
  .object({
    version: z.number().int(),
    to: z.enum(PTI_DEFECT_STATES),
    note: z.string().trim().max(2000).nullable().default(null),
    /** Required to dismiss. */
    reason: z.string().trim().max(500).nullable().default(null),
    fixedVia: z.enum(FIXED_VIA).nullable().default(null),
    workOrderId: z.string().nullable().default(null),
    workOrderNumber: z.string().nullable().default(null),
    ownerId: z.string().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.to === 'dismissed' && !value.reason?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why this is not a defect' });
    }
  });
export type TransitionDefectInput = z.infer<typeof TransitionDefectSchema>;
export type TransitionDefectRequest = z.input<typeof TransitionDefectSchema>;

/**
 * Dispatching over a hold (§9.1). The block is the rule; the override is a named, logged decision
 * with a reason that has to be one, recorded on every defect it drives over.
 */
export const DispatchOverrideSchema = z.object({
  /** The load being assigned: its number, so the defect's history says which one. */
  loadRef: z.string().trim().min(1).max(60),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this unit is being dispatched over its hold')
    .max(500)
    .superRefine((value, ctx) => {
      const problem = describeDescriptionProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
});
export type DispatchOverrideInput = z.infer<typeof DispatchOverrideSchema>;

export interface DispatchOverrideResult {
  /** False when the unit was not blocked, so nothing was logged. */
  overridden: boolean;
  verdict: UnitServiceVerdict;
}

/** Marks the walk-around as arrived, with where it lives. */
export const ReceiptSchema = z.object({
  version: z.number().int(),
  receivedAt: z.string(),
  source: TelegramSourceSchema.nullable().default(null),
});
export type ReceiptInput = z.infer<typeof ReceiptSchema>;
export type ReceiptRequest = z.input<typeof ReceiptSchema>;

/**
 * The drawer's save: what the reviewer concluded, what they said about defects already open, and
 * the defects this video found. The "no issues" path carries no new defects and must disposition
 * every open one; the "issues found" path carries at least one.
 */
export const ReviewSchema = z
  .object({
    version: z.number().int(),
    result: z.enum(PTI_REVIEW_RESULTS),
    receivedAt: z.string().nullable().default(null),
    source: TelegramSourceSchema.nullable().default(null),
    dispositions: z.array(OpenDefectDispositionSchema).default([]),
    defects: z
      .array(CreateDefectSchema.omit({ unitId: true, foundOnInspectionId: true }))
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'issues_found' && value.defects.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['defects'],
        message: 'Issue found needs at least one issue',
      });
    }
    if (value.result === 'no_issues' && value.defects.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['defects'],
        message: 'A clean review cannot carry defects',
      });
    }
  });
export type ReviewInput = z.infer<typeof ReviewSchema>;
export type ReviewRequest = z.input<typeof ReviewSchema>;

export const LockSchema = z.object({ version: z.number().int() });

// ------------------------------------------------------------------------------ the board

/** What the board renders per unit for a week: the inspection, the unit's open defects, the verdict. */
export const PtiBoardRowSchema = z.object({
  inspection: PtiInspectionSchema,
  /** The most recent *reviewed* inspection for the unit, which may be a previous week. */
  latestReviewed: z
    .object({
      id: z.string(),
      weekStart: z.string(),
      reviewedAt: z.string(),
      reviewResult: z.enum(PTI_REVIEW_RESULTS),
    })
    .nullable(),
  openDefects: z.array(PtiDefectSchema),
  verdict: z.object({
    status: z.enum(UNIT_SERVICE_STATUSES),
    dispatchBlocked: z.boolean(),
    defectIds: z.array(z.string()),
    reason: z.string().nullable(),
    releaseCondition: z.string().nullable(),
  }),
  /** Days since the oldest open defect was found; 0 with none. A real number, so it sorts. */
  ageDays: z.number().int(),
  inShop: z.boolean(),
});
export type PtiBoardRow = z.infer<typeof PtiBoardRowSchema>;

export const PTI_QUEUES = ['chase', 'review', 'defects', 'verify'] as const;
export type PtiQueue = (typeof PTI_QUEUES)[number];

export const PTI_QUEUE_LABEL: Record<PtiQueue, { label: string; owner: string }> = {
  chase: { label: 'Chase a missing video', owner: 'Dispatch' },
  review: { label: 'Awaiting review', owner: 'Safety' },
  defects: { label: 'Open defects', owner: 'Maintenance' },
  verify: { label: 'Fixed — awaiting verify', owner: 'Safety' },
};

export const PtiBoardSchema = z.object({
  weekStart: z.string(),
  dueAt: z.string(),
  today: z.string(),
  rows: z.array(PtiBoardRowSchema),
  queues: z.object({
    chase: z.number().int(),
    review: z.number().int(),
    defects: z.number().int(),
    verify: z.number().int(),
  }),
  quiet: z.object({
    cleanAndClosed: z.number().int(),
    inShopExempt: z.number().int(),
    dueSoon: z.number().int(),
  }),
});
export type PtiBoard = z.infer<typeof PtiBoardSchema>;

/** Which queues a row belongs to. A row can be in more than one; the counts are of rows. */
export function queuesFor(row: {
  inspection: { receiptStatus: PtiReceiptStatus; reviewState: PtiReviewState };
  openDefects: { state: PtiDefectState }[];
}): PtiQueue[] {
  const out: PtiQueue[] = [];
  // "Late" here means it arrived after the due day - there is a video to watch, nothing to chase.
  // Chasing is for a video that has not come at all.
  if (row.inspection.receiptStatus === 'missing') out.push('chase');
  if (
    (row.inspection.receiptStatus === 'received' || row.inspection.receiptStatus === 'late') &&
    row.inspection.reviewState !== 'reviewed'
  ) {
    out.push('review');
  }
  if (row.openDefects.some((d) => d.state !== 'fixed_pending_verify')) out.push('defects');
  if (row.openDefects.some((d) => d.state === 'fixed_pending_verify')) out.push('verify');
  return out;
}
