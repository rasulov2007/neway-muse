import { safetyRules as R } from '@neway/shared';
import type { acctBills } from '../../../database/schema/accounting';
import type {
  AccidentFactorRow,
  AccidentFactRow,
  AccidentOtherVehicleRow,
  AccidentQuestionRow,
  AccidentRestrictedRow,
  AccidentReviewItemRow,
  AccidentStatementRow,
  AccidentUnitRow,
  AccidentWitnessRow,
  DowntimePeriodRow,
  SafetyClaimDocumentRow,
  SafetyClaimLogRow,
  SafetyDocumentVersionRow,
  SafetyTaskRow,
  SafetyTaskUpdateRow,
  SafetyTimelineEventRow,
  WorkOrderEstimateRow,
} from '../../../database/schema/accidents-v2';
import type { workOrders } from '../../../database/schema/fleet';
import type { DrugAlcoholTestRow, SafetyAccidentRow, SafetyCaseDocumentRow, SafetyClaimPaymentRow, SafetyClaimRow, SafetyReviewRow } from '../../../database/schema/safety';

/**
 * Rows → the rules' domain model (packages/shared safety-rules). The rules run on what this returns; nothing here
 * decides anything. Unknown stays unknown: a NULL fact maps to null, never to 'no' or 0.
 */

type Tri = R.Tri;

const TRI = new Set(['yes', 'no', 'unknown', 'na']);
export const tri = (v: string | null | undefined): Tri => (v && TRI.has(v) ? (v as Tri) : null);
const prov = (v: string | null | undefined, fallback: R.Provenance): R.Provenance =>
  v === 'verified' || v === 'driver' || v === 'preliminary' ? v : fallback;
const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);

/** Legacy stage → v2 stage, read-time only (the cutover backfill B1 writes it; P1 never does). */
export function v2Stage(stage: string): R.Stage {
  switch (stage) {
    case 'draft':
    case 'initial_response':
    case 'investigation':
    case 'resolution':
    case 'closed':
      return stage;
    case 'testing':
    case 'testing_assessed':
    case 'review':
      return 'investigation';
    case 'repairs_claim':
      return 'resolution';
    default:
      return 'initial_response';
  }
}

/**
 * Legacy fault / preventability vocabulary read as v2 (C3 writes the same at cutover; blank/unknown = not determined).
 * The pages before v2 recorded who was at fault as our_driver / other_party / shared — explicit decisions, so they map
 * to at_fault / not_at_fault / partial (go-live decision, IMPLEMENTATION-PLAN §17); only "undetermined" stays open.
 */
export function v2Fault(v: string): R.FaultValue {
  if (v === 'not_at_fault' || v === 'partial' || v === 'at_fault') return v;
  if (v === 'partially_at_fault' || v === 'shared') return 'partial';
  if (v === 'our_driver') return 'at_fault';
  if (v === 'other_party') return 'not_at_fault';
  return 'not_determined';
}

/**
 * B3 at read time: a record written before v2 (no stored severity) has 0 / false where nobody answered. A positive legacy
 * value is an explicit answer and reads as "yes" with its count; 0 / false stays unknown (null) — never "no".
 * The cutover step B3 writes exactly these values; once written, the stored five-state value wins.
 */
export function legacyFactsOf(row: Pick<SafetyAccidentRow, 'severity' | 'injuries' | 'injuriesTreatedAway' | 'fatalities' | 'disablingTow' | 'citationIssued' | 'policeReportNumber'>): {
  injuries: Tri;
  treatedAway: number | null;
  fatalities: number | null;
  towAway: Tri;
  citation: Tri;
  police: Tri;
} {
  if (row.severity) return { injuries: null, treatedAway: null, fatalities: null, towAway: null, citation: null, police: null };
  const injured = row.injuries > 0 || row.injuriesTreatedAway > 0 || row.fatalities > 0;
  return {
    injuries: injured ? 'yes' : null,
    treatedAway: row.injuriesTreatedAway > 0 ? row.injuriesTreatedAway : null,
    fatalities: row.fatalities > 0 ? row.fatalities : null,
    towAway: row.disablingTow ? 'yes' : null,
    citation: row.citationIssued ? 'yes' : null,
    // A police report number on file means police responded.
    police: row.policeReportNumber?.trim() ? 'yes' : null,
  };
}
export function v2Preventability(v: string): R.PreventValue {
  if (v === 'preventable') return 'preventable';
  if (v === 'non_preventable' || v === 'not_preventable') return 'non_preventable';
  return 'not_determined';
}

/** The incident zone: stored, else the state's default, else Eastern. */
export function zoneOf(row: Pick<SafetyAccidentRow, 'occurredTz' | 'state'>): string {
  return row.occurredTz || (row.state ? R.STATE_TZ[row.state.toUpperCase()] : undefined) || R.EASTERN;
}

const LEGACY_KIND_CATEGORY: Record<string, R.EvidenceCategory> = {
  police_report: 'Police report',
  photos: 'Scene photo',
  driver_statement: 'Driver statement',
  witness_statement: 'Witness statement',
  repair_estimate: 'Repair estimate',
  invoice: 'Invoice',
  insurer_correspondence: 'Insurance document',
  test_record: 'Test record (restricted)',
};
const CATEGORIES = new Set<string>([
  'Scene photo', 'Damage photo', 'Dashcam / video', 'Police report', 'Driver statement', 'Witness statement',
  'Third-party correspondence', 'Insurance document', 'Repair estimate', 'Invoice', 'Medical (restricted)',
  'Legal (restricted)', 'Settlement', 'Test record (restricted)', 'Other',
]);

export function evidenceCategory(doc: Pick<SafetyCaseDocumentRow, 'category' | 'kind'>): R.EvidenceCategory {
  if (doc.category && CATEGORIES.has(doc.category)) return doc.category as R.EvidenceCategory;
  return LEGACY_KIND_CATEGORY[doc.kind] ?? 'Other';
}

export function evidenceOf(doc: SafetyCaseDocumentRow, versions: SafetyDocumentVersionRow[] = []): R.Evidence {
  const category = evidenceCategory(doc);
  const kind: R.Evidence['kind'] = doc.contentType.startsWith('image/')
    ? 'photo'
    : doc.contentType.startsWith('video/')
      ? 'video'
      : doc.contentType === 'application/pdf'
        ? 'pdf'
        : 'doc';
  const at = doc.uploadedAt.toISOString();
  return {
    id: doc.id,
    caseId: doc.caseId,
    category,
    name: doc.title,
    description: doc.description ?? '',
    kind,
    uploadedAt: at,
    uploadedBy: doc.uploadedBy,
    sizeKb: Math.round(doc.sizeBytes / 1024),
    versions: versions.length
      ? [...versions].sort((a, b) => a.version - b.version).map((v) => ({ v: v.version, at: v.uploadedAt.toISOString(), by: v.uploadedBy, note: v.note ?? (v.version === 1 ? 'Original upload' : '') }))
      : [{ v: 1, at, by: doc.uploadedBy, note: 'Original upload' }],
    restricted: doc.restricted || category.endsWith('(restricted)'),
    ...(doc.voidedAt ? { removed: { at: doc.voidedAt.toISOString(), by: doc.voidedBy ?? '', reason: doc.voidReason ?? '' } } : {}),
  };
}

function equipmentOf(u: AccidentUnitRow | undefined): R.EquipmentState | undefined {
  if (!u) return undefined;
  return {
    condition: (u.conditionAtScene as R.EquipmentState['condition']) ?? 'unknown',
    status: u.status as R.EquipmentState['status'],
    damage: u.damage ?? '',
    ...(u.towCompany ? { towCompany: u.towCompany } : {}),
    ...(u.towedTo ? { towedTo: u.towedTo } : {}),
    ...(u.storageRateCents !== null ? { storageRatePerDayCents: u.storageRateCents } : {}),
    ...(u.storageSince ? { storageSince: u.storageSince.toISOString() } : {}),
    ...(u.returnedToServiceAt ? { rtsAt: u.returnedToServiceAt.toISOString() } : {}),
  };
}

const CA_KINDS = new Set(['Coaching', 'Retraining', 'Ride-along evaluation', 'Disciplinary review', 'Equipment fix', 'Policy / bulletin']);

export function correctiveActionOf(r: SafetyReviewRow): R.CorrectiveAction {
  const kind = (r.actionKind && CA_KINDS.has(r.actionKind) ? r.actionKind : r.kind === 'coaching' ? 'Coaching' : 'Retraining') as R.CorrectiveAction['kind'];
  const status: R.CorrectiveAction['status'] =
    r.voidedAt ? 'Waived' : r.status === 'completed' ? 'Completed' : r.status === 'in_progress' || r.status === 'scheduled' ? 'In progress' : 'Open';
  return {
    id: r.id,
    kind,
    title: r.reason,
    ...(r.driverId ? { driverId: r.driverId } : {}),
    assigneeId: r.assigneeId ?? r.ownerId ?? '',
    due: (r.dueAt ?? r.createdAt).toISOString(),
    status,
    ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
    ...(r.evidenceNote ? { evidence: r.evidenceNote } : {}),
    restricted: r.restricted || kind === 'Disciplinary review',
  };
}

function testOf(substance: 'alcohol' | 'drug', t: DrugAlcoholTestRow | undefined): R.TestRecord {
  if (!t) return { substance, decision: 'auto' };
  return {
    substance,
    decision: t.postAccidentDecision === 'required' ? 'required' : 'auto',
    ...(t.collectedAt ? { administeredAt: t.collectedAt.toISOString() } : {}),
    ...(t.result && t.result !== 'pending' ? { resultRestricted: t.result } : {}),
    ...(t.notCompletedReason ? { notAdministeredReason: t.notCompletedReason } : {}),
    ...(t.lateReason ? { delayReason: t.lateReason } : {}),
  };
}

export interface CaseParts {
  row: SafetyAccidentRow;
  units: AccidentUnitRow[];
  restricted?: AccidentRestrictedRow;
  tests: DrugAlcoholTestRow[];
  actions: SafetyReviewRow[];
  /** P4 investigation records and parties (empty for a case written before P4). */
  inv?: {
    vehicles: AccidentOtherVehicleRow[];
    witnesses: AccidentWitnessRow[];
    facts: AccidentFactRow[];
    questions: AccidentQuestionRow[];
    statements: AccidentStatementRow[];
    factors: AccidentFactorRow[];
    review: AccidentReviewItemRow[];
  };
}

/** One stored accident as the rules see it (unredacted — redaction happens on the way out). */
export function caseOf(p: CaseParts): R.AccidentCase {
  const { row } = p;
  const truckUnit = p.units.find((u) => u.unitKind === 'truck' && (!row.truckId || u.unitId === row.truckId));
  const trailerUnit = p.units.find((u) => u.unitKind === 'trailer' && (!row.trailerId || u.unitId === row.trailerId));
  const legacy = legacyFactsOf(row);
  const injuries = tri(row.injuriesStatus) ?? legacy.injuries;
  const c: R.AccidentCase = {
    id: row.id,
    number: row.number,
    stage: v2Stage(row.stage),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
    isTest: row.isTest,
    occurredAt: row.occurredAt.toISOString(),
    tz: zoneOf(row),
    timeProvenance: prov(row.timeProvenance, 'preliminary'),
    location: {
      ...(row.locationRoad ? { road: row.locationRoad } : {}),
      ...(row.locationDetail ? { detail: row.locationDetail } : {}),
      city: row.city ?? '',
      state: row.state ?? '',
      ...(row.latitude !== null ? { lat: Number(row.latitude) } : {}),
      ...(row.longitude !== null ? { lng: Number(row.longitude) } : {}),
      publicRoad: tri(row.publicRoad),
    },
    locationProvenance: prov(row.locationProvenance, 'preliminary'),
    type: row.accidentType || 'Other',
    description: row.description,
    descriptionProvenance: prov(row.descriptionProvenance, 'driver'),
    severity: (row.severity as R.Severity | null) ?? 'minor',
    ...(row.severityManualReason ? { severityManual: { reason: row.severityManualReason, by: row.severityManualBy ?? '' } } : {}),
    ...(row.driverId ? { driverId: row.driverId } : {}),
    ...(row.truckId ? { truckId: row.truckId } : {}),
    ...(row.trailerId ? { trailerId: row.trailerId } : {}),
    ...(row.loadId ? { loadId: row.loadId } : {}),
    ...(row.assignmentSource ? { assignmentSource: row.assignmentSource } : {}),
    injuries: {
      status: injuries,
      treatedAway: injuries === 'no' ? 0 : (row.treatedAwayCount ?? legacy.treatedAway),
      fatalities: injuries === 'no' ? 0 : (row.fatalitiesCount ?? legacy.fatalities),
      ourDriver: tri(row.ourDriverInjured),
      ...(p.restricted?.medicalDetails ? { detailsRestricted: p.restricted.medicalDetails } : {}),
      provenance: prov(row.injuriesProvenance, 'preliminary'),
    },
    towAway: tri(row.towAway) ?? legacy.towAway,
    towProvenance: prov(row.towProvenance, 'preliminary'),
    citation: {
      status: tri(row.citationStatus) ?? legacy.citation,
      ...(row.citationAt ? { issuedAt: row.citationAt.toISOString() } : {}),
      ...(row.citationNote ? { note: row.citationNote } : {}),
    },
    hazmat: tri(row.hazmatReleased),
    ...(row.excludedOccurrence ? { excludedOccurrence: row.excludedOccurrence as R.AccidentCase['excludedOccurrence'] } : {}),
    police: {
      responded: tri(row.policeResponded) ?? legacy.police,
      ...(row.policeDepartment ? { dept: row.policeDepartment } : {}),
      ...(row.policeReportNumber ? { reportNumber: row.policeReportNumber } : {}),
    },
    conditions: {
      ...(row.weather ? { weather: row.weather } : {}),
      ...(row.roadSurface ? { road: row.roadSurface } : {}),
      ...(row.lightCondition ? { light: row.lightCondition } : {}),
    },
    vehicles: (p.inv?.vehicles ?? []).map((v) => ({
      id: v.id,
      description: v.description,
      owner: v.ownerName ?? '',
      ...(v.driverName ? { driver: v.driverName } : {}),
      ...(v.insurer ? { insurer: v.insurer } : {}),
      ...(v.policyNo ? { policyNo: v.policyNo } : {}),
      damage: v.damage ?? '',
      towed: tri(v.towed),
      ...(v.plate ? { plate: v.plate } : {}),
    })),
    witnesses: (p.inv?.witnesses ?? []).map((w) => ({ id: w.id, name: w.name, contact: w.contact ?? '', ...(w.note ? { note: w.note } : {}), ...(w.statementDocumentId ? { statementEvidenceId: w.statementDocumentId } : {}) })),
    equipment: {
      truck: equipmentOf(truckUnit) ?? { condition: 'unknown', status: 'unknown', damage: '' },
      ...(trailerUnit ? { trailer: equipmentOf(trailerUnit) } : {}),
    },
    cargo: {
      status: (row.cargoStatus as R.CargoState['status'] | null) ?? 'unknown',
      ...(row.cargoPlan ? { plan: row.cargoPlan as NonNullable<R.CargoState['plan']> } : {}),
      ...(row.cargoNotes ? { notes: row.cargoNotes } : {}),
      ...(row.cargoDeliveryImpact ? { deliveryImpact: row.cargoDeliveryImpact } : {}),
      brokerNotified: tri(row.brokerNotified),
    },
    immediate: Array.isArray(row.immediateActions) ? (row.immediateActions as R.AccidentCase['immediate']) : [],
    investigation: {
      status: row.investigationStatus as R.AccidentCase['investigation']['status'],
      ...(row.investigationOwnerId ? { ownerId: row.investigationOwnerId } : {}),
      facts: (p.inv?.facts ?? []).map((f) => ({ id: f.id, text: f.text, source: f.source, provenance: prov(f.provenance, 'preliminary'), by: f.createdBy, at: f.createdAt.toISOString() })),
      questions: (p.inv?.questions ?? []).map((q) => ({
        id: q.id,
        text: q.text,
        ...(q.ownerId ? { ownerId: q.ownerId } : {}),
        ...(q.answer ? { answer: q.answer } : {}),
        ...(q.resolvedAt ? { resolvedAt: q.resolvedAt.toISOString() } : {}),
        ...(q.resolvedBy ? { resolvedBy: q.resolvedBy } : {}),
        createdAt: q.createdAt.toISOString(),
      })),
      statements: (p.inv?.statements ?? []).map((s) => ({ id: s.id, party: s.party, kind: s.kind as R.Statement['kind'], takenAt: s.takenAt.toISOString(), takenBy: s.takenBy, summary: s.summary, ...(s.documentId ? { evidenceId: s.documentId } : {}) })),
      checklist: (p.inv?.review ?? []).map((i) => ({ key: i.key, label: i.label, state: i.state as R.ChecklistItem['state'], ...(i.note ? { note: i.note } : {}), ...(i.restricted ? { restricted: true } : {}) })),
      factors: (p.inv?.factors ?? []).map((f) => ({ id: f.id, category: f.category as R.Factor['category'], label: f.label, level: f.level as R.Factor['level'] })),
      ...(row.investigationConclusion ? { conclusion: row.investigationConclusion } : {}),
      ...(row.investigationSubmittedBy ? { submittedBy: row.investigationSubmittedBy } : {}),
      ...(row.investigationSubmittedAt ? { submittedAt: row.investigationSubmittedAt.toISOString() } : {}),
      ...(row.investigationApprovedBy ? { approvedBy: row.investigationApprovedBy } : {}),
      ...(row.investigationCompletedAt ? { completedAt: row.investigationCompletedAt.toISOString() } : {}),
    },
    determinations: {
      fault: { value: v2Fault(row.fault), ...(row.faultBasis ? { basis: row.faultBasis } : {}), ...(row.faultBy ? { by: row.faultBy } : {}), ...(row.faultAt ? { at: iso(row.faultAt) } : {}) },
      preventability: {
        value: v2Preventability(row.preventability),
        ...(row.preventabilityNote ? { basis: row.preventabilityNote } : {}),
        ...(row.preventabilityBy ? { by: row.preventabilityBy } : {}),
        ...(row.preventabilityAt ? { at: iso(row.preventabilityAt) } : {}),
      },
      cpdp: {
        value: (row.cpdpStatus as R.CpdpValue | null) ?? 'not_applicable',
        ...(row.cpdpRdr ? { rdr: row.cpdpRdr } : {}),
        ...(row.cpdpBasis ? { basis: row.cpdpBasis } : {}),
        ...(row.cpdpBy ? { by: row.cpdpBy } : {}),
        ...(row.cpdpAt ? { at: iso(row.cpdpAt) } : {}),
      },
      legal: {
        value: (p.restricted?.legalLiability as R.LegalValue | null | undefined) ?? 'unknown',
        ...(p.restricted?.legalBasis ? { basis: p.restricted.legalBasis } : {}),
        ...(p.restricted?.legalBy ? { by: p.restricted.legalBy } : {}),
        ...(p.restricted?.legalAt ? { at: iso(p.restricted.legalAt) } : {}),
      },
    },
    correctiveActions: p.actions.map(correctiveActionOf),
    testing: {
      alcohol: testOf('alcohol', p.tests.find((t) => t.substance === 'alcohol')),
      drug: testOf('drug', p.tests.find((t) => t.substance === 'drug')),
    },
    ownerId: row.ownerId ?? '',
    ...(row.summaryOverrideText
      ? { summaryOverride: { text: row.summaryOverrideText, by: row.summaryOverrideBy ?? '', at: iso(row.summaryOverrideAt) ?? '', factsHash: row.summaryFactsHash ?? '' } }
      : {}),
    ...(row.initialEstimateCents !== null ? { initialEstimateCents: row.initialEstimateCents } : {}),
    ...(row.claimDecisionText ? { claimDecision: { text: row.claimDecisionText, by: row.claimDecisionBy ?? '', at: iso(row.claimDecisionAt) ?? '' } } : {}),
    ...(row.legalHoldSince ? { legalHold: { since: row.legalHoldSince.toISOString(), by: row.legalHoldBy ?? '', reason: row.legalHoldReason ?? '' } } : {}),
    ...(row.closedAt && v2Stage(row.stage) === 'closed'
      ? {
          closure: {
            at: row.closedAt.toISOString(),
            by: row.closedBy ?? '',
            ...(row.closeOverrideReason ? { override: { reason: row.closeOverrideReason, by: row.closeOverrideBy ?? '' } } : {}),
            outcome: row.closeOutcome ?? row.closeReason ?? '',
            prevention: row.closePrevention ?? '',
          },
        }
      : {}),
  };
  // A case written before v2 has no stored severity: it shows the suggested one (never stored by a read).
  if (!row.severity) c.severity = R.suggestedSeverity(c).value;
  return c;
}

const DEPTS = new Set(['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Management', 'Driver Relations']);

export function taskOf(t: SafetyTaskRow, updates: SafetyTaskUpdateRow[]): R.Task {
  return {
    id: t.id,
    ...(t.accidentId ? { caseId: t.accidentId } : {}),
    ...(t.claimId ? { claimId: t.claimId } : {}),
    title: t.title,
    dept: (DEPTS.has(t.dept) ? t.dept : 'Safety') as R.Dept,
    ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
    due: t.dueAt.toISOString(),
    status: t.status as R.TaskStatus,
    priority: t.priority === 'high' ? 'high' : 'normal',
    ...(t.instructions ? { instructions: t.instructions } : {}),
    updates: updates.map((u) => ({ id: u.id, at: u.at.toISOString(), by: u.byName, text: u.text })),
    createdAt: t.createdAt.toISOString(),
    createdBy: t.createdBy,
    ...(t.completedAt ? { completedAt: t.completedAt.toISOString() } : {}),
    ...(t.completedBy ? { completedBy: t.completedBy } : {}),
    ...(t.autoRule ? { auto: t.autoRule } : {}),
    ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
  };
}

export function downtimeOf(d: DowntimePeriodRow): R.DowntimePeriod {
  return {
    id: d.id,
    caseId: d.accidentId,
    unitKind: d.unitKind as 'truck' | 'trailer',
    unitId: d.unitId,
    start: d.startedAt.toISOString(),
    ...(d.endedAt ? { end: d.endedAt.toISOString() } : {}),
    source: d.source === 'daily_board' ? 'Daily board status' : d.source === 'work_order' ? 'Work order' : 'Entered by Safety',
    ...(d.verifiedBy ? { verifiedBy: d.verifiedBy } : {}),
    ...(d.note ? { note: d.note } : {}),
  };
}

export function eventOf(e: SafetyTimelineEventRow): R.TimelineEvent {
  return {
    id: e.id,
    ...(e.accidentId ? { caseId: e.accidentId } : {}),
    ...(e.claimId ? { claimId: e.claimId } : {}),
    at: e.occurredAt.toISOString(),
    loggedAt: e.loggedAt.toISOString(),
    by: e.actorName,
    source: e.source as R.EventSource,
    text: e.text,
    kind: e.kind === 'access' ? 'note' : (e.kind as NonNullable<R.TimelineEvent['kind']>),
    restricted: e.restricted,
  };
}

/* ------------------------------------------------------------------------------------------- claims (P2) */

/** Legacy claim kind → v2 coverage, read-time only for rows written before v2 (the cutover C2 writes it). */
export function v2ClaimType(row: Pick<SafetyClaimRow, 'claimType' | 'kind'>): R.ClaimType {
  if (row.claimType) return row.claimType as R.ClaimType;
  switch (row.kind) {
    case 'liability':
      return 'auto_liability';
    case 'cargo':
      return 'cargo';
    case 'workers_comp':
      return 'workers_comp';
    default:
      return 'physical_damage';
  }
}

/** Legacy claim line kind (0061) → v2 coverage (the same map as cutover C2). */
export const LINE_TYPE: Record<string, R.ClaimType> = {
  own_physical_damage: 'physical_damage',
  third_party_liability: 'auto_liability',
  cargo_against_us: 'cargo',
  recovery_against_other: 'recovery',
  workers_comp: 'workers_comp',
};

/** Did the accident injure or kill anyone (legacy counts or the v2 five-state answer)? */
export const accidentInjured = (a: Pick<SafetyAccidentRow, 'injuries' | 'injuriesTreatedAway' | 'fatalities' | 'injuriesStatus'>): boolean =>
  a.injuries > 0 || a.injuriesTreatedAway > 0 || a.fatalities > 0 || a.injuriesStatus === 'yes';

/**
 * A claim written before v2 (no claim_type), read the way cutover C2 step 1 writes it: coverage from its first live line
 * (else its legacy kind), reserve and insurer from that line when the claim has none, and restricted when it is workers'
 * comp or auto liability on an accident that injured someone (SPEC G10). Read-time only; the first v2 write stores it.
 */
export interface LegacyClaimView {
  claimType: R.ClaimType;
  restricted: boolean;
  reserveCents: number | null;
  insurer: string | null;
}
export function legacyClaimView(
  row: Pick<SafetyClaimRow, 'claimType' | 'kind' | 'restricted' | 'reserveCents' | 'insurer'>,
  firstLine: { kind: string; reserveCents: number | null; insurer: string | null } | undefined,
  injured: boolean,
): LegacyClaimView | null {
  if (row.claimType) return null;
  const claimType = (firstLine && LINE_TYPE[firstLine.kind]) || v2ClaimType(row);
  return {
    claimType,
    restricted: row.restricted || claimType === 'workers_comp' || (claimType === 'auto_liability' && injured),
    reserveCents: row.reserveCents ?? firstLine?.reserveCents ?? null,
    insurer: row.insurer ?? firstLine?.insurer ?? null,
  };
}

/** v2 coverage → the legacy `kind` (NOT NULL, read by the existing Claims v2 pages and the driver-charge flow). */
export const LEGACY_KIND: Record<R.ClaimType, string> = {
  physical_damage: 'physical_damage',
  auto_liability: 'liability',
  cargo: 'cargo',
  recovery: 'physical_damage',
  workers_comp: 'workers_comp',
};

/** Legacy stage/decision → v2 status, read-time only for rows written before v2 (owner to confirm at cutover, C2). */
export function v2ClaimStatus(row: Pick<SafetyClaimRow, 'status' | 'stage' | 'decision'>): R.ClaimStatus {
  if (row.status) return row.status as R.ClaimStatus;
  switch (row.stage) {
    case 'closed':
      return row.decision === 'denied' ? 'Denied' : 'Closed';
    case 'insurer_review':
      return 'Under review';
    case 'decision':
      return row.decision === 'denied' ? 'Denied' : 'Negotiating';
    case 'payment':
      return 'Negotiating';
    default:
      return 'Open';
  }
}

const TERMINAL = new Set(['Settled', 'Denied', 'Closed']);
/** The legacy stage a v2 status mirrors to (one-way, new → legacy), so the old pages and the driver-charge flow agree. */
export const legacyStageFor = (status: R.ClaimStatus, current: string): string => (TERMINAL.has(status) ? 'closed' : current === 'closed' ? 'opened' : current);

const undef = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export interface ClaimParts {
  row: SafetyClaimRow;
  payments: SafetyClaimPaymentRow[];
  docs: SafetyClaimDocumentRow[];
  log: SafetyClaimLogRow[];
  /** false when the linked accident is voided: the claim then counts as standalone nowhere and in no ledger. */
  liveAccident: boolean;
  /** A claim written before v2, read as cutover C2 would write it (legacyClaimView). */
  legacy?: LegacyClaimView | null;
}

/** One stored claim as the rules see it (unredacted — redaction happens on the way out). */
export function claimOf(p: ClaimParts): R.Claim {
  const row = p.legacy ? { ...p.row, ...p.legacy } : p.row;
  const type = v2ClaimType(row);
  return {
    id: row.id,
    number: row.number,
    ...(row.accidentId && p.liveAccident ? { caseId: row.accidentId } : {}),
    type,
    status: v2ClaimStatus(row),
    isTest: row.isTest,
    title: row.title || row.description || R.CLAIM_TYPE_LABEL[type],
    ...(row.standaloneKind ? { standaloneKind: row.standaloneKind } : {}),
    insurer: row.insurer ?? '',
    ...(row.insurerReference ? { insurerClaimNo: row.insurerReference } : {}),
    ...(row.adjusterName || row.adjusterPhone || row.adjusterEmail
      ? { adjuster: { name: row.adjusterName ?? '', phone: row.adjusterPhone ?? '', email: row.adjusterEmail ?? '' } }
      : {}),
    ...(row.claimant ? { claimant: row.claimant } : {}),
    ...(row.responsibleParty ? { responsibleParty: row.responsibleParty } : {}),
    ...(row.unitLabel ? { unitLabel: row.unitLabel } : {}),
    ...(row.loadId ? { loadId: row.loadId } : {}),
    openedAt: (row.openedAt ?? row.createdAt).toISOString(),
    ...(row.reportedToInsurerAt ? { reportedToInsurerAt: row.reportedToInsurerAt.toISOString() } : {}),
    claimedCents: undef(row.claimedCents),
    reserveCents: undef(row.reserveCents),
    deductibleCents: undef(row.deductibleCents),
    settlementCents: undef(row.settlementCents),
    payments: p.payments
      .filter((x) => !x.voidedAt)
      .map((x) => ({
        id: x.id,
        at: (x.paidAt ?? new Date(`${x.receivedOn}T12:00:00Z`)).toISOString(),
        amountCents: x.amountCents,
        direction: (x.direction ?? 'to_us') as R.ClaimPayment['direction'],
        party: x.party ?? '',
        ...(x.note ? { note: x.note } : {}),
      })),
    docs: p.docs.map((d) => ({ id: d.id, label: d.label, received: d.received })),
    log: p.log.map((l) => ({ id: l.id, at: l.at.toISOString(), by: l.byName, channel: l.channel as R.Claim['log'][number]['channel'], text: l.text })),
    ...(row.nextFollowUpAt ? { nextFollowUp: { at: row.nextFollowUpAt.toISOString(), assigneeId: row.nextFollowUpAssigneeId ?? '', what: row.nextFollowUpWhat ?? '' } } : {}),
    ownerId: row.ownerId ?? '',
    restricted: row.restricted,
    lastUpdateAt: row.lastActivityAt.toISOString(),
    ...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
    disputed: row.disputed,
  };
}

/* ------------------------------------------------------------------------------------- work orders + bills (P3) */

export type WorkOrderRow = typeof workOrders.$inferSelect;
export type AcctBillRow = typeof acctBills.$inferSelect;

const IN_REPAIR_STAGES = new Set(['in_repair', 'quality_check', 'ready']);

/** A Fleet work order's v2 status, from Fleet's own columns plus the approval (0071). */
export function woStatus(w: Pick<WorkOrderRow, 'status' | 'shopStage' | 'approvedAt'>, estimates: number): R.WOStatus {
  if (w.status === 'completed') return 'Completed';
  if (w.approvedAt) return w.shopStage && IN_REPAIR_STAGES.has(w.shopStage) ? 'In repair' : 'Approved';
  return estimates > 0 ? 'Waiting for approval' : 'Awaiting estimate';
}

const numericToCents = (v: string | null | undefined): number | undefined => (v === null || v === undefined ? undefined : Math.round(Number(v) * 100));

/** A work order as the rules see it; its costs stay the work order's (never copied onto the case). */
export function workOrderOf(w: WorkOrderRow, estimates: WorkOrderEstimateRow[], billId: string | undefined, settings: Partial<R.SafetyRuleSettings>): R.WorkOrder {
  const est: R.Estimate[] = estimates.map((e) => ({ id: e.id, vendor: e.vendor, amountCents: e.amountCents, at: e.receivedAt.toISOString(), ...(e.selected ? { selected: true } : {}) }));
  return {
    id: w.id,
    number: w.number,
    unitKind: w.assetType === 'truck' ? 'truck' : 'trailer',
    unitId: w.unitId,
    ...(w.accidentId ? { caseId: w.accidentId } : {}),
    type: w.workType === 'accident_repair' ? 'Accident repair' : 'Repair',
    title: w.title || (w.workType === 'accident_repair' ? 'Accident repair' : w.workType.replace(/_/g, ' ')),
    shop: w.vendorName || 'Shop not set',
    status: woStatus(w, est.length),
    estimates: est,
    estimatesRequired: w.estimatesRequired ?? R.estimatesRequiredFor({ estimates: est, estimatesRequired: 1 }, settings),
    ...(w.approvedCents !== null ? { approvedAmountCents: w.approvedCents } : {}),
    ...(w.approvedBy ? { approvedBy: w.approvedBy } : {}),
    ...(w.invoiceNumber ? { invoiceNumber: w.invoiceNumber } : {}),
    ...(w.invoiceTotal !== null ? { invoiceTotalCents: numericToCents(w.invoiceTotal) } : {}),
    ...(billId ? { billId } : {}),
    openedAt: w.createdAt.toISOString(),
    shopInAt: w.shopInAt.toISOString(),
    ...(w.eta ? { eta: w.eta.toISOString() } : {}),
    ...(w.completedAt ? { completedAt: w.completedAt.toISOString() } : {}),
    createdBy: w.createdBy,
  };
}

const BILL_CATEGORIES = new Set(['Towing', 'Storage', 'Tractor repair', 'Trailer repair', 'Transload / recovery', 'Rental equipment', 'Deductible', 'Cargo', 'Other']);

/** An AP bill as the rules see it: on a case directly, through a claim, or through its work order. */
export function billOf(b: AcctBillRow, wos: Map<string, WorkOrderRow>): R.Bill {
  const rec = (b.record ?? {}) as { vendorName?: string; issuedOn?: string; status?: string; notes?: string | null };
  const woId = b.sourceKey.startsWith('repair_order:') ? b.sourceKey.slice('repair_order:'.length) : undefined;
  const wo = woId ? wos.get(woId) : undefined;
  const caseId = b.accidentId ?? wo?.accidentId ?? undefined;
  const category = (
    b.accidentCostCategory && BILL_CATEGORIES.has(b.accidentCostCategory) ? b.accidentCostCategory : wo ? (wo.assetType === 'truck' ? 'Tractor repair' : 'Trailer repair') : 'Other'
  ) as R.BillCategory;
  const st = rec.status ?? b.status;
  return {
    id: b.id,
    number: b.billNumber,
    vendor: rec.vendorName ?? '',
    amountCents: b.amountCents,
    date: rec.issuedOn ?? b.createdAt.toISOString().slice(0, 10),
    status: st === 'paid' ? 'Paid' : st === 'approved' || st === 'scheduled' ? 'Approved' : 'Open',
    category,
    ...(caseId ? { caseId } : {}),
    ...(b.claimId ? { claimId: b.claimId } : {}),
    ...(woId ? { woId } : {}),
    memo: rec.notes ?? '',
  };
}
