// Accident & Claims v2 — API contract for phase P1 (docs/accidents/API.md, adapted; deviations in the P1 report of
// docs/accidents/IMPLEMENTATION-PLAN.md). Exported from the package root as the `accidentsV2` namespace.
//
// Conventions: money in integer cents; instants ISO 8601 UTC; incident zone IANA; five-state facts
// 'yes' | 'no' | 'unknown' | 'na' | null (null = not reported yet); counts null = not known yet (never coerced to 0).
// Every write to an existing record names the `version` it read; a stale one is refused with 409.
import { z } from 'zod';
import type {
  AccidentCase,
  Attention,
  Blocker,
  Determ,
  SummaryPart,
  TestDet,
  Track,
  Severity,
  Stage,
  Dept,
  TaskStatus,
  EventSource,
  ReportPrompt,
} from '../safety-rules/index.js';
import type { CaseClaimCard } from './claims.js';
import type { InvestigationBlock } from './investigation.js';
import type { CaseMoneyBlock } from './money.js';

export const TRI_VALUES = ['yes', 'no', 'unknown', 'na'] as const;
export const PROVENANCES = ['verified', 'driver', 'preliminary'] as const;
export const STAGES = ['draft', 'initial_response', 'investigation', 'resolution', 'closed'] as const;
export const SEVERITIES = ['minor', 'moderate', 'serious', 'critical'] as const;
export const DEPTS = ['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Management', 'Driver Relations'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const CARGO_STATUSES = ['na', 'unknown', 'no_damage', 'damaged', 'loss'] as const;
export const CARGO_PLANS = ['none_needed', 'transload', 'repower', 'delivered_as_is', 'rejected', 'salvage'] as const;
export const TRUCK_CONDITIONS = ['drivable', 'not_drivable', 'unknown'] as const;
export const UNIT_STATUSES = ['unknown', 'operational', 'at_scene', 'towed_storage', 'at_shop', 'in_repair', 'returned', 'total_loss', 'not_involved'] as const;
export const EVENT_SOURCES = ['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Telematics', 'Driver', 'System', 'Management'] as const;
export const REQUEST_KINDS = ['unit_unavailable', 'repower_transload', 'notify_broker'] as const;
export const EVIDENCE_CATEGORIES = [
  'Scene photo', 'Damage photo', 'Dashcam / video', 'Police report', 'Driver statement', 'Witness statement',
  'Third-party correspondence', 'Insurance document', 'Repair estimate', 'Invoice', 'Settlement',
  'Medical (restricted)', 'Legal (restricted)', 'Test record (restricted)', 'Other',
] as const;
/** Board chips (SPEC §1.2). */
export const BOARD_CHIPS = ['open', 'serious', 'attention', 'drafts', 'closed', 'all', 'register'] as const;
export type BoardChip = (typeof BOARD_CHIPS)[number];
export const RANGE_KEYS = ['30d', '90d', '12m', 'ytd', 'custom'] as const;
export type RangeKeyV2 = (typeof RANGE_KEYS)[number];

export type TriValue = (typeof TRI_VALUES)[number];
export type RequestKind = (typeof REQUEST_KINDS)[number];

const tri = z.enum(TRI_VALUES).nullable().optional();
const id = z.string().trim().min(1).max(120);
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const count = z.number().int().min(0).max(999).nullable().optional();
const version = z.number().int().min(1);
const isoInstant = z.string().datetime({ offset: true });
/** 'YYYY-MM-DDTHH:mm' wall time in the incident zone (the server converts it DST-safely, SPEC §7.15). */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm');
const zone = z.string().trim().min(3).max(64);

/** Intake facts shared by the quick report, Save draft and Edit facts. */
const intake = {
  truckId: id.nullable().optional(),
  driverId: id.nullable().optional(),
  trailerId: id.nullable().optional(),
  loadId: id.nullable().optional(),
  assignmentSource: optText(200),
  occurredAtLocal: localTime.nullable().optional(),
  occurredTz: zone.optional(),
  /** For a fall-back time that occurs twice: 'earlier' | 'later' | the abbreviation the user picked (CDT / CST). */
  occurredChoice: z.string().trim().max(10).optional(),
  publicRoad: tri,
  road: optText(200),
  locationDetail: optText(200),
  city: optText(120),
  state: z.string().trim().toUpperCase().length(2).nullable().optional(),
  accidentType: optText(80),
  description: optText(4000),
  injuries: tri,
  treatedAway: count,
  fatalities: count,
  ourDriverInjured: tri,
  towAway: tri,
  truckCondition: z.enum(TRUCK_CONDITIONS).optional(),
  cargo: z.enum(CARGO_STATUSES).optional(),
  hazmat: tri,
  police: tri,
  citation: tri,
};

export const ReportSchema = z.object({
  submit: z.boolean(),
  /** Test-data flag kept from today (records kept, never counted in a total). */
  isTest: z.boolean().optional(),
  ...intake,
  uploads: z.array(z.object({ fileId: id, category: z.enum(EVIDENCE_CATEGORIES).optional() })).max(30).optional(),
  prompts: z.array(z.object({ key: z.string().max(20), create: z.boolean(), done: z.boolean().optional() })).max(20).optional(),
  /**
   * "Post-accident alcohol and drug test required?" (owner, 2026-10-24). Yes → the submission (a test record file,
   * stored as restricted evidence, and the results, restricted: accidents.restricted) or, when nothing is submitted,
   * why the test was not done. Stored on the case's two post-accident test records (alcohol and drug). Optional for
   * API callers; the report form always sends it on submit.
   */
  postAccidentTest: z
    .object({
      required: z.enum(['yes', 'no']),
      fileId: id.nullable().optional(),
      alcoholResult: z.enum(['pending', 'negative', 'positive', 'refused', 'cancelled']).optional(),
      drugResult: z.enum(['pending', 'negative', 'positive', 'refused', 'cancelled']).optional(),
      notDoneReason: optText(1000),
    })
    .optional(),
});
export type ReportInput = z.infer<typeof ReportSchema>;
export type PostAccidentTestInput = NonNullable<ReportInput['postAccidentTest']>;

/** Live check for the report rail: same body, no writes. */
export const ReportPreviewSchema = ReportSchema.partial({ submit: true });
export type ReportPreviewInput = z.infer<typeof ReportPreviewSchema>;

/** Finish a draft: optional facts to save first, then submit (one transaction). */
export const SubmitDraftSchema = z.object({
  version,
  report: ReportSchema.omit({ submit: true, isTest: true }).optional(),
});
export type SubmitDraftInput = z.infer<typeof SubmitDraftSchema>;

export const PatchAccidentSchema = z.object({
  version,
  ...intake,
  timeProvenance: z.enum(PROVENANCES).optional(),
  locationProvenance: z.enum(PROVENANCES).optional(),
  descriptionProvenance: z.enum(PROVENANCES).optional(),
  injuriesProvenance: z.enum(PROVENANCES).optional(),
  towProvenance: z.enum(PROVENANCES).optional(),
  /** Restricted: needs accidents.restricted. */
  medicalDetails: optText(4000),
  citationAt: isoInstant.nullable().optional(),
  citationNote: optText(500),
  policeDepartment: optText(160),
  policeReportNumber: optText(80),
  excludedOccurrence: z.enum(['boarding_alighting', 'loading_unloading']).nullable().optional(),
  weather: optText(80),
  roadSurface: optText(80),
  lightCondition: optText(80),
  cargoPlan: z.enum(CARGO_PLANS).nullable().optional(),
  cargoNotes: optText(2000),
  cargoDeliveryImpact: optText(500),
  brokerNotified: tri,
  initialEstimateCents: z.number().int().min(0).nullable().optional(),
});
export type PatchAccidentInput = z.infer<typeof PatchAccidentSchema>;

export const VersionSchema = z.object({ version });
export type VersionInput = z.infer<typeof VersionSchema>;

export const ReasonSchema = z.object({ version, reason: text(1000).min(3, 'Give a reason') });
export type ReasonInput = z.infer<typeof ReasonSchema>;

export const StageSchema = z.object({
  version,
  to: z.enum(['initial_response', 'investigation', 'resolution', 'closed']),
  overrideReason: optText(1000),
  outcome: optText(2000),
  prevention: optText(2000),
});
export type StageInput = z.infer<typeof StageSchema>;

export const SeveritySchema = z.union([
  z.object({ version, auto: z.literal(true) }),
  z.object({ version, severity: z.enum(SEVERITIES), reason: text(1000).min(3, 'Give a reason') }),
]);
export type SeverityInput = z.infer<typeof SeveritySchema>;

export const OwnerSchema = z.object({ version, ownerId: id });
export type OwnerInput = z.infer<typeof OwnerSchema>;

export const LegalHoldSchema = z.object({ version, on: z.boolean(), reason: text(1000).min(3, 'Give a reason') });
export type LegalHoldInput = z.infer<typeof LegalHoldSchema>;

export const SummaryOverrideSchema = z.object({ version, text: z.string().trim().min(1).max(8000).nullable() });
export type SummaryOverrideInput = z.infer<typeof SummaryOverrideSchema>;

export const TestRecordSchema = z.object({
  version,
  decision: z.enum(['auto', 'required']).optional(),
  administeredAt: isoInstant.nullable().optional(),
  delayReason: optText(1000),
  notAdministeredReason: optText(1000),
  /** Restricted: needs accidents.restricted. */
  result: z.enum(['pending', 'negative', 'positive', 'refused', 'cancelled']).optional(),
});
export type TestRecordInput = z.infer<typeof TestRecordSchema>;

export const UnitPatchSchema = z.object({
  version,
  status: z.enum(UNIT_STATUSES).optional(),
  /** Condition at the scene: Safety only, never changed by a repair. */
  conditionAtScene: z.enum(TRUCK_CONDITIONS).optional(),
  damage: optText(2000),
  towCompany: optText(160),
  towedTo: optText(200),
  storageRateCents: z.number().int().min(0).nullable().optional(),
  storageSince: isoInstant.nullable().optional(),
});
export type UnitPatchInput = z.infer<typeof UnitPatchSchema>;

export const RequestSchema = z.object({ kind: z.enum(REQUEST_KINDS), note: text(1000).min(3, 'Say what Dispatch should do') });
export type RequestInput = z.infer<typeof RequestSchema>;

export const LogEventSchema = z.object({
  text: text(2000).min(3),
  /** Incident-local wall time; omitted = now. */
  occurredAtLocal: localTime.optional(),
  source: z.enum(EVENT_SOURCES),
  restricted: z.boolean().optional(),
});
export type LogEventInput = z.infer<typeof LogEventSchema>;

export const CreateTaskSchema = z
  .object({
    /** A task belongs to a case or (P2) to a claim. */
    accidentId: id.optional(),
    claimId: id.optional(),
    /** P3: a task about one work order completes only with that work order (never by title). */
    workOrderId: id.optional(),
    title: text(300).min(3),
    dept: z.enum(DEPTS),
    assigneeId: id.nullable().optional(),
    dueAt: isoInstant,
    instructions: optText(4000),
    priority: z.enum(['normal', 'high']).optional(),
  })
  .refine((v) => Boolean(v.accidentId) !== Boolean(v.claimId), { message: 'A task belongs to one accident or one claim', path: ['accidentId'] });
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const PatchTaskSchema = z.object({
  version,
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: id.nullable().optional(),
  dueAt: isoInstant.optional(),
  priority: z.enum(['normal', 'high']).optional(),
  blockedReason: optText(1000),
});
export type PatchTaskInput = z.infer<typeof PatchTaskSchema>;

export const TaskUpdateSchema = z.object({ text: text(2000).min(1) });
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;

export const ConfirmRequestSchema = z.object({ version, note: optText(1000) });
export type ConfirmRequestInput = z.infer<typeof ConfirmRequestSchema>;

export const BoardQuerySchema = z.object({
  chip: z.enum(BOARD_CHIPS).optional(),
  range: z.enum(RANGE_KEYS).optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
  q: z.string().trim().max(120).optional(),
  driverId: z.string().max(120).optional(),
  truckId: z.string().max(120).optional(),
  severity: z.enum(SEVERITIES).optional(),
  stage: z.enum(STAGES).optional(),
  type: z.string().max(80).optional(),
  ownerId: z.string().max(120).optional(),
  nextDept: z.enum(DEPTS).optional(),
  investigation: z.enum(['not_started', 'in_progress', 'in_review', 'complete']).optional(),
  truckDown: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});
export type BoardQuery = z.infer<typeof BoardQuerySchema>;

export const RangeQuerySchema = z.object({
  range: z.enum(RANGE_KEYS).optional(),
  from: isoInstant.optional(),
  to: isoInstant.optional(),
});
export type RangeQuery = z.infer<typeof RangeQuerySchema>;

export const TaskListQuerySchema = z.object({
  accidentId: z.string().max(120).optional(),
  claimId: z.string().max(120).optional(),
  assigneeId: z.string().max(120).optional(),
  status: z.enum(['open', 'overdue', 'done', 'all']).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

// ------------------------------------------------------------------------------------------------ responses

export interface PersonRef {
  id: string;
  name: string;
}

export interface BoardRow {
  id: string;
  number: string;
  stage: Stage;
  isNew: boolean;
  isDraft: boolean;
  isTest: boolean;
  occurredAt: string;
  occurredTz: string;
  truck: { id: string; unit: string } | null;
  trailer: { id: string; unit: string } | null;
  driver: { id: string; name: string } | null;
  location: { city: string; state: string; road: string | null };
  severity: Severity;
  accidentType: string;
  investigationStatus: AccidentCase['investigation']['status'];
  equipment: { truckDownNow: boolean; truckDownMs: number; wasDownMs: number };
  /** Claims linked to the case (P2): open count, total, and whether every one is settled/closed. */
  claims: { open: number; total: number; allSettled: boolean };
  /** Projected net cost from the one ledger (P3); `basis` says what the number rests on. */
  money: { projectedNetCents: number; actualCents: number; finalized: boolean; basis: 'final' | 'spent' | 'estimate' } | null;
  next: { title: string; dept: Dept; assignee: PersonRef | null; dueAt: string; overdue: boolean } | { closedNote: string } | null;
  urgent: boolean;
}

export interface BoardResponse {
  items: BoardRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Drafts chip shows only when drafts exist. */
  draftsCount: number;
  range: { key: RangeKeyV2; from: string; to: string };
}

export interface AttentionItem extends Attention {
  caseNumber?: string;
  truckUnit?: string;
  assigneeName?: string;
}

export interface BoardSummaryResponse {
  range: { key: RangeKeyV2; from: string; to: string };
  kpis: {
    openCases: { value: number; serious: number; awaitingInvestigation: number };
    reported: { value: number; prior: number; delta: number };
    trucksDownNow: { value: number; truckDaysInRange: number };
    needsAttention: { value: number; overdueTasks: number; urgent: number };
    /** Open claims (all, incl. standalone; restricted ones counted). Money parts exclude restricted claims for a viewer without accidents.restricted. */
    openClaims: { value: number; ourCostToComeCents: number; insurerReservesCents: number };
    /** Σ projected net of cases occurred in range (P3); lost revenue is shown apart and never added. null until P3. */
    netCost: { projectedNetCents: number; spentCents: number; recoveredCents: number; lostRevenueCents: number } | null;
    /** Restricted claims left out of the money for this viewer ("Excludes N restricted claim(s)"). */
    restrictedClaimsExcluded: number;
  };
  attention: AttentionItem[];
  trucksDown: {
    truckId: string;
    unit: string;
    accidentId: string;
    number: string;
    downMs: number;
    location: string;
    downSince: string;
    /** The open repair on the truck (P3), with its estimates policy. */
    workOrder: { id: string; number: string; status: string; estimates: number; estimatesRequired: number } | null;
  }[];
  /** Sources the P1 attention list reads: claims and work orders join it in P2/P3. */
  attentionSources: string[];
}

export interface RegisterRow {
  accidentId: string;
  caseNumber: string;
  date: string;
  cityOrNearest: string;
  state: string;
  driverName: string;
  injuriesTreatedAway: number | null;
  fatalities: number | null;
  hazmatReleased: 'Yes' | 'No' | 'Not answered';
}

export interface TaskView {
  id: string;
  accidentId: string | null;
  caseNumber: string | null;
  claimId: string | null;
  workOrderId: string | null;
  title: string;
  dept: Dept;
  assignee: PersonRef | null;
  dueAt: string;
  status: TaskStatus;
  priority: 'normal' | 'high';
  instructions: string | null;
  blockedReason: string | null;
  autoRule: string | null;
  requestKind: RequestKind | 'unit_ready' | 'other' | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  overdue: boolean;
  version: number;
  updates: { id: string; at: string; by: string; text: string }[];
}

export interface TimelineEntry {
  id: string;
  occurredAt: string;
  loggedAt: string;
  actorName: string;
  source: EventSource;
  kind: 'milestone' | 'change' | 'note' | 'task' | 'access';
  /** "Restricted entry" for a viewer without accidents.restricted. */
  text: string;
  restricted: boolean;
}

export interface DowntimeView {
  id: string;
  unitKind: 'truck' | 'trailer';
  unitId: string;
  unit: string;
  startedAt: string;
  endedAt: string | null;
  ms: number;
  ongoing: boolean;
  source: 'daily_board' | 'work_order' | 'entered';
  verifiedBy: string | null;
  note: string | null;
  /** For Fleet's verify / correct (P3). */
  version: number;
}

export interface UnitView {
  id: string;
  unitKind: 'truck' | 'trailer';
  unitId: string;
  unit: string;
  conditionAtScene: 'drivable' | 'not_drivable' | 'unknown';
  status: (typeof UNIT_STATUSES)[number];
  damage: string | null;
  towCompany: string | null;
  towedTo: string | null;
  storageRateCents: number | null;
  storageSince: string | null;
  returnedToServiceAt: string | null;
  version: number;
}

export interface CaseDetailResponse {
  /** The case in the rules' domain model (redacted for the viewer). */
  case: AccidentCase;
  version: number;
  /** Fields the viewer may not see (API.md §0). */
  redacted: string[];
  display: {
    truck: { id: string; unit: string } | null;
    trailer: { id: string; unit: string } | null;
    driver: { id: string; name: string } | null;
    load: { id: string; number: string; customer: string | null; broker: string | null; origin: string | null; destination: string | null } | null;
    owner: PersonRef | null;
    reportedBy: string;
    closedBy: string | null;
    voided: boolean;
  };
  units: UnitView[];
  people: PersonRef[];
  computed: {
    dotRecordable: Determ;
    testing: { alcohol: TestDet; drug: TestDet };
    suggestedSeverity: { value: Severity; why: string };
    tracks: Track[];
    advanceBlockers: Blocker[];
    closeBlockers: Blocker[];
    nextAction: { taskId: string; title: string; dept: Dept; assignee: PersonRef | null; dueAt: string; overdue: boolean; moreOpen: number } | null;
    downtime: { periods: DowntimeView[]; truckMs: number; trailerMs: number; ongoing: boolean };
    expectedEvidence: { label: string; ok: boolean; why: string }[];
    repeatSignals: { sameDriver: { id: string; number: string }[]; sameTruck: { id: string; number: string }[] };
    summaryParts: SummaryPart[];
    factsHash: string;
    summaryStale: boolean;
    attention: AttentionItem[];
    openTasks: number;
    overdueTasks: number;
    evidenceCount: number;
    /** Claims linked to the case (P2), redacted per claim for the viewer. */
    claims: CaseClaimCard[];
    /** Restricted claims on the case the viewer cannot see the money of. */
    restrictedClaims: number;
    /** P3: the one ledger (AP bills, work orders, claim payments), work orders with estimates, unit status history. */
    money: CaseMoneyBlock;
    /** P4: parties, corrective actions, questions with owners, the evidence-reviewed checklist (redacted for the viewer). */
    investigation: InvestigationBlock;
  };
  permissions: { edit: boolean; editCargo: boolean; restricted: boolean; override: boolean; confirm: boolean; claimMoney: boolean; fleet: boolean; editUnits: boolean; bills: boolean; seeMoney: boolean; determine: boolean; legal: boolean; approve: boolean; discipline: boolean };
}

export interface ReportPreviewResponse {
  dotRecordable: Determ;
  testing: { alcohol: TestDet; drug: TestDet };
  suggestedSeverity: { value: Severity; why: string };
  prompts: (ReportPrompt & { defaultCreate: boolean })[];
  zone: { tz: string | null; confirmHint: string | null };
  occurredAt: { ok: true; iso: string; abbr: string } | { ok: false; error: string; message: string; options?: { iso: string; abbr: string }[] } | null;
  hazmatPrefill: { value: 'no'; hint: string } | null;
}

export interface ReportResponse {
  id: string;
  number: string;
  stage: Stage;
  version: number;
  tasksCreated: number;
  requestsCreated: number;
}

export interface AssignmentLookup {
  truckId: string | null;
  driverId: string | null;
  trailerId: string | null;
  loadId: string | null;
  source: 'current assignment' | 'assignment history' | null;
  note: string | null;
}

export interface ReportPickers {
  trucks: { id: string; unit: string; driverId: string | null; driverName: string | null; status: string; trailerId: string | null; loadId: string | null }[];
  drivers: { id: string; name: string; truckId: string | null }[];
  trailers: { id: string; unit: string }[];
  loads: { id: string; number: string; truckId: string | null; customer: string | null; broker: string | null; commodity: string | null; origin: string | null; destination: string | null; hazmat: boolean | null }[];
  people: (PersonRef & { dept: Dept | null })[];
}
