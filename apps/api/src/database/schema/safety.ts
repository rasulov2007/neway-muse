import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Safety cases (migration 0041, Safety v2 — owner plan 2026-10-02).
 *
 * Accidents, claims, violations, roadside inspections, safety reviews and drug & alcohol tests,
 * each a row the server owns. They used to live in the browser's workspace snapshot, where a
 * refresh could lose them and nothing was audited. The rules every table here follows:
 *
 *  - `company_id` on every row, and every query filters by it.
 *  - `version` on every row; a write names the version it read, and a stale one is refused (409).
 *  - Nothing is deleted. A record is voided with a reason, a person and a time, and stays.
 *  - A human number per company per kind (`ACC-001`), from `safety_counters`.
 *  - Links between cases are ids (and the number, denormalised for display), never copies.
 *    A claim is opened once per accident, a review once per linked case, a post-accident test
 *    once per accident and substance: unique indexes hold it, so a double click cannot make two.
 */

/** Columns every case carries. A function, so every table gets its own builders. */
function caseColumns() {
  return {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    ownerId: text('owner_id'),
    ownerName: text('owner_name'),
    nextAction: text('next_action'),
    nextActionDueOn: date('next_action_due_on'),
    /** Test data: kept, never counted in a live total. */
    isTest: boolean('is_test').notNull().default(false),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  };
}

/** The last number handed out, per company and per kind of case. */
export const safetyCounters = pgTable(
  'safety_counters',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    last: integer('last').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.kind] })],
);

export const safetyAccidents = pgTable(
  'safety_accidents',
  {
    ...caseColumns(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    location: text('location').notNull(),
    city: text('city'),
    state: text('state'),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    truckId: text('truck_id'),
    truckNumber: text('truck_number'),
    trailerId: text('trailer_id'),
    trailerNumber: text('trailer_number'),
    loadId: text('load_id'),
    loadNumber: text('load_number'),
    description: text('description').notNull().default(''),
    fatalities: integer('fatalities').notNull().default(0),
    injuries: integer('injuries').notNull().default(0),
    injuriesTreatedAway: integer('injuries_treated_away').notNull().default(0),
    disablingTow: boolean('disabling_tow').notNull().default(false),
    citationIssued: boolean('citation_issued').notNull().default(false),
    citationAt: timestamp('citation_at', { withTimezone: true }),
    citationNote: text('citation_note'),
    policeReportNumber: text('police_report_number'),
    /** reported · evidence · testing · repairs_claim · review · closed */
    stage: text('stage').notNull().default('reported'),
    fault: text('fault').notNull().default('undetermined'),
    preventability: text('preventability').notNull().default('undetermined'),
    preventabilityNote: text('preventability_note'),
    notes: text('notes'),
    damageEstimateCents: bigint('damage_estimate_cents', { mode: 'number' }),
    companyDeductibleCents: bigint('company_deductible_cents', { mode: 'number' }),
    /** The repair, by reference. The work order stays in Fleet. */
    workOrderId: text('work_order_id'),
    workOrderNumber: text('work_order_number'),
    claimId: text('claim_id'),
    claimNumber: text('claim_number'),
    reviewId: text('review_id'),
    reviewNumber: text('review_number'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    /** normal · administrative */
    closeKind: text('close_kind'),
    closeReason: text('close_reason'),
    // ---- Accident & Claims v2 (0069). Read and written only by the accidents_v2 endpoints. ----------------
    // Five-state facts: 'yes' | 'no' | 'unknown' | 'na', NULL = not reported yet. The v2 counts are nullable
    // (NULL = not known yet); the legacy counts above keep their NOT NULL DEFAULT 0 for the old pages.
    occurredTz: text('occurred_tz'),
    timeProvenance: text('time_provenance'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    legacyStage: text('legacy_stage'),
    legacyFault: text('legacy_fault'),
    legacyPreventability: text('legacy_preventability'),
    locationRoad: text('location_road'),
    locationDetail: text('location_detail'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    publicRoad: text('public_road'),
    locationProvenance: text('location_provenance'),
    accidentType: text('accident_type'),
    descriptionProvenance: text('description_provenance'),
    severity: text('severity'),
    severityManualReason: text('severity_manual_reason'),
    severityManualBy: text('severity_manual_by'),
    severityManualAt: timestamp('severity_manual_at', { withTimezone: true }),
    assignmentSource: text('assignment_source'),
    injuriesStatus: text('injuries_status'),
    injuriesProvenance: text('injuries_provenance'),
    ourDriverInjured: text('our_driver_injured'),
    treatedAwayCount: integer('treated_away_count'),
    fatalitiesCount: integer('fatalities_count'),
    towAway: text('tow_away'),
    towProvenance: text('tow_provenance'),
    citationStatus: text('citation_status'),
    hazmatReleased: text('hazmat_released'),
    excludedOccurrence: text('excluded_occurrence'),
    policeResponded: text('police_responded'),
    policeDepartment: text('police_department'),
    weather: text('weather'),
    roadSurface: text('road_surface'),
    lightCondition: text('light_condition'),
    cargoStatus: text('cargo_status'),
    cargoPlan: text('cargo_plan'),
    cargoNotes: text('cargo_notes'),
    cargoDeliveryImpact: text('cargo_delivery_impact'),
    brokerNotified: text('broker_notified'),
    initialEstimateCents: bigint('initial_estimate_cents', { mode: 'number' }),
    immediateActions: jsonb('immediate_actions'),
    investigationStatus: text('investigation_status').notNull().default('not_started'),
    investigationOwnerId: text('investigation_owner_id'),
    investigationConclusion: text('investigation_conclusion'),
    investigationSubmittedBy: text('investigation_submitted_by'),
    investigationSubmittedAt: timestamp('investigation_submitted_at', { withTimezone: true }),
    investigationApprovedBy: text('investigation_approved_by'),
    investigationCompletedAt: timestamp('investigation_completed_at', { withTimezone: true }),
    faultBasis: text('fault_basis'),
    faultBy: text('fault_by'),
    faultAt: timestamp('fault_at', { withTimezone: true }),
    preventabilityBy: text('preventability_by'),
    preventabilityAt: timestamp('preventability_at', { withTimezone: true }),
    cpdpStatus: text('cpdp_status'),
    cpdpRdr: text('cpdp_rdr'),
    cpdpBasis: text('cpdp_basis'),
    cpdpBy: text('cpdp_by'),
    cpdpAt: timestamp('cpdp_at', { withTimezone: true }),
    summaryOverrideText: text('summary_override_text'),
    summaryOverrideBy: text('summary_override_by'),
    summaryOverrideAt: timestamp('summary_override_at', { withTimezone: true }),
    summaryFactsHash: text('summary_facts_hash'),
    claimDecisionText: text('claim_decision_text'),
    claimDecisionBy: text('claim_decision_by'),
    claimDecisionAt: timestamp('claim_decision_at', { withTimezone: true }),
    legalHoldSince: timestamp('legal_hold_since', { withTimezone: true }),
    legalHoldBy: text('legal_hold_by'),
    legalHoldReason: text('legal_hold_reason'),
    closeOutcome: text('close_outcome'),
    closePrevention: text('close_prevention'),
    closeOverrideReason: text('close_override_reason'),
    closeOverrideBy: text('close_override_by'),
    closeSkippedBlockers: jsonb('close_skipped_blockers'),
    migratedDefaultsPending: boolean('migrated_defaults_pending').notNull().default(false),
    idempotencyKey: text('idempotency_key'),
  },
  (t) => [
    uniqueIndex('safety_accidents_company_number_key').on(t.companyId, t.number),
    index('safety_accidents_company_stage_idx').on(t.companyId, t.stage),
    index('safety_accidents_driver_idx').on(t.companyId, t.driverId),
  ],
);

export const safetyClaims = pgTable(
  'safety_claims',
  {
    ...caseColumns(),
    kind: text('kind').notNull(),
    accidentId: text('accident_id'),
    accidentNumber: text('accident_number'),
    loadId: text('load_id'),
    loadNumber: text('load_number'),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    truckId: text('truck_id'),
    truckNumber: text('truck_number'),
    description: text('description').notNull().default(''),
    insurer: text('insurer'),
    policyNumber: text('policy_number'),
    insurerReference: text('insurer_reference'),
    adjusterName: text('adjuster_name'),
    adjusterPhone: text('adjuster_phone'),
    adjusterEmail: text('adjuster_email'),
    openedOn: date('opened_on').notNull(),
    submittedOn: date('submitted_on'),
    decisionOn: date('decision_on'),
    /** approved · partially_approved · denied */
    decision: text('decision'),
    /** opened · submitted · insurer_review · decision · payment · closed */
    stage: text('stage').notNull().default('opened'),
    /** What we asked for, what the insurer approved: separate facts, never one number. */
    claimedCents: bigint('claimed_cents', { mode: 'number' }),
    approvedCents: bigint('approved_cents', { mode: 'number' }),
    deductibleCents: bigint('deductible_cents', { mode: 'number' }),
    /** A proposal for Accounting to decide; nothing deducts it. */
    driverDeductionProposedCents: bigint('driver_deduction_proposed_cents', { mode: 'number' }),
    driverDeductionNote: text('driver_deduction_note'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    /** Claims v2 (0059): who is responsible - our_driver · other_party · shared · none · undetermined. */
    liabilityParty: text('liability_party'),
    liabilityPct: integer('liability_pct'),
    /** Any event on the claim or its charge; drives "No update in N days". */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    // ---- Accident & Claims v2 (0070): one claim per coverage line, many per accident. Read and written only by
    // the accidents_v2 endpoints. insurer / insurerReference / adjuster* / claimedCents / deductibleCents / closedAt /
    // lastActivityAt / owner* above are the same facts for v2 (one column per fact).
    /** physical_damage · auto_liability · cargo · recovery · workers_comp (legacy `kind` keeps its own values). */
    claimType: text('claim_type'),
    /** Draft · Open · Under review · Awaiting documents · Negotiating · Settled · Denied · Closed */
    status: text('status'),
    title: text('title'),
    standaloneKind: text('standalone_kind'),
    whatWasLost: text('what_was_lost'),
    claimant: text('claimant'),
    responsibleParty: text('responsible_party'),
    unitLabel: text('unit_label'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    reportedToInsurerAt: timestamp('reported_to_insurer_at', { withTimezone: true }),
    reserveCents: bigint('reserve_cents', { mode: 'number' }),
    settlementCents: bigint('settlement_cents', { mode: 'number' }),
    disputed: boolean('disputed').notNull().default(false),
    /** Bodily injury: money, payments, claimant, adjuster, log, attachments and follow-up text only for accidents.restricted. */
    restricted: boolean('restricted').notNull().default(false),
    restrictedReason: text('restricted_reason'),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
    nextFollowUpAssigneeId: text('next_follow_up_assignee_id'),
    nextFollowUpAssigneeName: text('next_follow_up_assignee_name'),
    nextFollowUpWhat: text('next_follow_up_what'),
    idempotencyKey: text('idempotency_key'),
    legacyRef: text('legacy_ref'),
    legacyPayload: jsonb('legacy_payload'),
  },
  (t) => [
    uniqueIndex('safety_claims_company_number_key').on(t.companyId, t.number),
    // One live claim per accident: "Create claim" twice reuses the first. Accident & Claims v2 (owner Q1, Option A)
    // replaces it with the non-unique index below AT CUTOVER (apps/api/src/database/cutover/accidents-v2/C1); until then it stays.
    uniqueIndex('safety_claims_accident_key')
      .on(t.companyId, t.accidentId)
      .where(sql`${t.accidentId} is not null and ${t.voidedAt} is null`),
    index('safety_claims_company_stage_idx').on(t.companyId, t.stage),
    index('safety_claims_accident_idx').on(t.companyId, t.accidentId).where(sql`${t.accidentId} is not null`),
  ],
);

/** Money actually received on a claim, one row per payment. Received is their sum. */
export const safetyClaimPayments = pgTable(
  'safety_claim_payments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => safetyClaims.id, { onDelete: 'restrict' }),
    receivedOn: date('received_on').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    method: text('method'),
    reference: text('reference'),
    note: text('note'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    /** Accident & Claims v2 (0070): to_us · by_insurer_to_claimant · by_us; NULL = a legacy row (money received). */
    direction: text('direction'),
    party: text('party'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [index('safety_claim_payments_claim_idx').on(t.companyId, t.claimId)],
);

/**
 * A claim's money, put in front of Accounting to confirm or reject.
 *
 * The accounting module's own rule (acct_completions): a candidate is keyed on its source, so a
 * retry or a second save lands on the same row; it is a suggestion, and only a person with
 * `accounting.edit` turns it into a decision. Safety never posts and never deducts.
 */
export const safetyAccountingEntries = pgTable(
  'safety_accounting_entries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => safetyClaims.id, { onDelete: 'restrict' }),
    claimNumber: text('claim_number').notNull(),
    kind: text('kind').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** pending_review · confirmed · rejected · superseded */
    state: text('state').notNull().default('pending_review'),
    sourceKey: text('source_key').notNull(),
    memo: text('memo').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewNote: text('review_note'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('safety_accounting_entries_source_key').on(t.companyId, t.sourceKey),
    index('safety_accounting_entries_state_idx').on(t.companyId, t.state),
  ],
);

export const safetyRoadsideInspections = pgTable(
  'safety_roadside_inspections',
  {
    ...caseColumns(),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }).notNull(),
    level: integer('level').notNull(),
    reportNumber: text('report_number'),
    agency: text('agency').notNull(),
    location: text('location'),
    state: text('state'),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    truckId: text('truck_id'),
    truckNumber: text('truck_number'),
    trailerId: text('trailer_id'),
    trailerNumber: text('trailer_number'),
    oos: boolean('oos').notNull().default(false),
    oosNote: text('oos_note'),
    correctionDueOn: date('correction_due_on'),
    returnRequired: boolean('return_required').notNull().default(false),
    /** received · reviewed · defects_corrected · certified · returned */
    stage: text('stage').notNull().default('received'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    certifiedAt: timestamp('certified_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    workOrderId: text('work_order_id'),
    workOrderNumber: text('work_order_number'),
  },
  (t) => [
    uniqueIndex('safety_roadside_company_number_key').on(t.companyId, t.number),
    index('safety_roadside_company_stage_idx').on(t.companyId, t.stage),
  ],
);

export const safetyViolations = pgTable(
  'safety_violations',
  {
    ...caseColumns(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** roadside · manual */
    source: text('source').notNull(),
    inspectionId: text('inspection_id').references(() => safetyRoadsideInspections.id, {
      onDelete: 'restrict',
    }),
    inspectionNumber: text('inspection_number'),
    reportNumber: text('report_number'),
    code: text('code'),
    description: text('description').notNull(),
    category: text('category'),
    /** Who received it: driver · carrier; null on a warning that does not say (0065). */
    issuedTo: text('issued_to'),
    /** Who issued it; '' when not recorded (optional since 0053). */
    agency: text('agency').notNull(),
    /** inspection · citation · warning (0053) */
    violationType: text('violation_type'),
    /** The paper carries no fine (0053). */
    fineNotApplicable: boolean('fine_not_applicable').notNull().default(false),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    truckId: text('truck_id'),
    truckNumber: text('truck_number'),
    oos: boolean('oos').notNull().default(false),
    // Track 1: the correction.
    correctionStatus: text('correction_status').notNull().default('not_required'),
    correctionDueOn: date('correction_due_on'),
    correctionNote: text('correction_note'),
    // Track 2: the citation and the court.
    fineCents: bigint('fine_cents', { mode: 'number' }),
    courtDate: date('court_date'),
    citationDisposition: text('citation_disposition').notNull().default('none'),
    // Track 3: DataQs.
    dataqsStatus: text('dataqs_status').notNull().default('not_filed'),
    dataqsFiledOn: date('dataqs_filed_on'),
    dataqsReference: text('dataqs_reference'),
    dataqsNote: text('dataqs_note'),
    reviewId: text('review_id'),
    reviewNumber: text('review_number'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    // Follow-up on the row (0055, owner 2026-10-13): citation and court, lawyer, training,
    // the charge or bonus sent to Accounting, and the notes.
    citationNumber: text('citation_number'),
    state: text('state'),
    inspectionLevel: integer('inspection_level'),
    dispute: boolean('dispute').notNull().default(false),
    lawyerName: text('lawyer_name'),
    lawyerPhone: text('lawyer_phone'),
    lawyerFeeCents: bigint('lawyer_fee_cents', { mode: 'number' }),
    lawyerPaid: boolean('lawyer_paid').notNull().default(false),
    /** not_required · pending · in_progress · completed */
    trainingStatus: text('training_status').notNull().default('pending'),
    trainingCompletedOn: date('training_completed_on'),
    trainerName: text('trainer_name'),
    trainingProofFileId: text('training_proof_file_id'),
    /** undecided · not_charged · charge_pending · bonus_pending (charged / bonus received come from Accounting) */
    followupStatus: text('followup_status').notNull().default('undecided'),
    /** charge · bonus */
    moneyKind: text('money_kind'),
    moneyCents: bigint('money_cents', { mode: 'number' }),
    moneyParty: text('money_party'),
    moneyReason: text('money_reason'),
    moneyTxId: text('money_tx_id'),
    moneySentAt: timestamp('money_sent_at', { withTimezone: true }),
    notes: jsonb('notes').notNull().default(sql`'[]'::jsonb`),
    /** One paper, one case (0068, owner 2026-10-21): rows entered together share it; null = a case of its own. */
    caseId: text('case_id'),
  },
  (t) => [
    uniqueIndex('safety_violations_company_number_key').on(t.companyId, t.number),
    index('safety_violations_inspection_idx').on(t.companyId, t.inspectionId),
    index('safety_violations_driver_idx').on(t.companyId, t.driverId),
    index('safety_violations_case_idx').on(t.companyId, t.caseId),
  ],
);

export const safetyReviews = pgTable(
  'safety_reviews',
  {
    ...caseColumns(),
    /** driver_review · coaching · corrective_action */
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    linkedType: text('linked_type'),
    linkedId: text('linked_id'),
    linkedNumber: text('linked_number'),
    /** not_started · scheduled · in_progress · completed */
    status: text('status').notNull().default('not_started'),
    scheduledFor: date('scheduled_for'),
    preventabilityRequired: boolean('preventability_required').notNull().default(false),
    preventability: text('preventability').notNull().default('undetermined'),
    requiredTraining: text('required_training'),
    trainingCompletedOn: date('training_completed_on'),
    notes: text('notes'),
    outcome: text('outcome'),
    followUpOn: date('follow_up_on'),
    evidenceNote: text('evidence_note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: text('completed_by'),
    /** An existing Accounting expense this review's cost was attributed to (0063); nothing posts from here. */
    accountingExpenseId: text('accounting_expense_id'),
    /** Accident & Claims v2 (0069): a corrective action on an accident - many per accident. */
    accidentId: text('accident_id'),
    actionKind: text('action_kind'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    restricted: boolean('restricted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('safety_reviews_company_number_key').on(t.companyId, t.number),
    // One live review of each kind per linked case: re-running the link reuses it.
    uniqueIndex('safety_reviews_linked_key')
      .on(t.companyId, t.kind, t.linkedType, t.linkedId)
      .where(sql`${t.linkedId} is not null and ${t.voidedAt} is null`),
    index('safety_reviews_company_status_idx').on(t.companyId, t.status),
    index('safety_reviews_driver_idx').on(t.companyId, t.driverId),
  ],
);

/**
 * Drug and alcohol tests. Results are restricted: the server returns them only to a caller with
 * `safety_testing.view`, whatever the screen asks for.
 */
export const drugAlcoholTests = pgTable(
  'drug_alcohol_tests',
  {
    ...caseColumns(),
    /** pre_employment · random · post_accident · reasonable_suspicion · return_to_duty · follow_up */
    testType: text('test_type').notNull(),
    /** alcohol · drug */
    substance: text('substance').notNull(),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    accidentId: text('accident_id').references(() => safetyAccidents.id, { onDelete: 'restrict' }),
    accidentNumber: text('accident_number'),
    required: boolean('required').notNull().default(true),
    requiredReason: text('required_reason'),
    /** The accident time the post-accident clock runs from. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    /** pending · negative · positive · refused · cancelled */
    result: text('result').notNull().default('pending'),
    resultAt: timestamp('result_at', { withTimezone: true }),
    notCompletedReason: text('not_completed_reason'),
    lateReason: text('late_reason'),
    exceptionReviewedAt: timestamp('exception_reviewed_at', { withTimezone: true }),
    exceptionReviewedBy: text('exception_reviewed_by'),
    exceptionNote: text('exception_note'),
    /** Accident & Claims v2 (0069): 'auto' follows the rule; Safety may only escalate to 'required'. */
    postAccidentDecision: text('post_accident_decision'),
    decisionBy: text('decision_by'),
    decisionAt: timestamp('decision_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('drug_alcohol_tests_company_number_key').on(t.companyId, t.number),
    // One live post-accident test per accident and substance.
    uniqueIndex('drug_alcohol_tests_accident_key')
      .on(t.companyId, t.accidentId, t.substance)
      .where(sql`${t.accidentId} is not null and ${t.voidedAt} is null`),
    index('drug_alcohol_tests_driver_idx').on(t.companyId, t.driverId),
  ],
);

/** Files attached to a case. The bytes are in `stored_files`; this is the link and its label. */
export const safetyCaseDocuments = pgTable(
  'safety_case_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    caseType: text('case_type').notNull(),
    caseId: text('case_id').notNull(),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    title: text('title').notNull(),
    kind: text('kind').notNull().default('other'),
    uploadedBy: text('uploaded_by').notNull().default(''),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    /** Accident & Claims v2 (0069): evidence category (SPEC §1.4), description, restricted. */
    category: text('category'),
    description: text('description'),
    restricted: boolean('restricted').notNull().default(false),
    /** Accident & Claims v2 (0072): the latest version number (versions in safety_document_versions) and the original's hash. */
    currentVersion: integer('current_version').notNull().default(1),
    sha256: text('sha256'),
  },
  (t) => [index('safety_case_documents_case_idx').on(t.companyId, t.caseType, t.caseId)],
);

export type SafetyAccidentRow = typeof safetyAccidents.$inferSelect;
export type SafetyClaimRow = typeof safetyClaims.$inferSelect;
export type SafetyClaimPaymentRow = typeof safetyClaimPayments.$inferSelect;
export type SafetyAccountingEntryRow = typeof safetyAccountingEntries.$inferSelect;
export type SafetyRoadsideRow = typeof safetyRoadsideInspections.$inferSelect;
export type SafetyViolationRow = typeof safetyViolations.$inferSelect;
export type SafetyReviewRow = typeof safetyReviews.$inferSelect;
export type DrugAlcoholTestRow = typeof drugAlcoholTests.$inferSelect;
export type SafetyCaseDocumentRow = typeof safetyCaseDocuments.$inferSelect;

/**
 * A driver charge (Claims v2, 0059): the workflow around a deductible or chargeback - notice,
 * Accounting's checklist, disputes, Management exceptions. The money is Accounting's driver
 * transaction (`driverTxId`), created on approval and recovered by the settlement engine.
 */
export const safetyDriverCharges = pgTable(
  'safety_driver_charges',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    sourceType: text('source_type').notNull().default('claim'),
    sourceId: text('source_id').notNull(),
    claimId: text('claim_id'),
    claimNumber: text('claim_number'),
    driverId: text('driver_id').notNull(),
    driverName: text('driver_name').notNull().default(''),
    driverKind: text('driver_kind').notNull().default('company'),
    basis: text('basis').notNull(),
    policyCents: bigint('policy_cents', { mode: 'number' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    adjustReason: text('adjust_reason'),
    state: text('state').notNull(),
    stateBeforeHold: text('state_before_hold'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
    notifiedOn: date('notified_on'),
    notifiedBy: text('notified_by'),
    notifyMethod: text('notify_method'),
    driverResponse: text('driver_response'),
    noticeFileId: text('notice_file_id'),
    authorizationFileId: text('authorization_file_id'),
    leaseClause: text('lease_clause'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: text('rejected_by'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    recoveryMethod: text('recovery_method'),
    installmentCents: bigint('installment_cents', { mode: 'number' }),
    installmentsTotal: integer('installments_total'),
    driverTxId: text('driver_tx_id'),
    disputeText: text('dispute_text'),
    disputeRaisedBy: text('dispute_raised_by'),
    disputeResolution: text('dispute_resolution'),
    pendingChange: jsonb('pending_change'),
    waiveReason: text('waive_reason'),
    waivedBy: text('waived_by'),
    waivedAt: timestamp('waived_at', { withTimezone: true }),
    history: jsonb('history').notNull().default([]),
    isTest: boolean('is_test').notNull().default(false),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('safety_driver_charges_company_number_key').on(t.companyId, t.number),
    uniqueIndex('safety_driver_charges_active_key')
      .on(t.companyId, t.sourceType, t.sourceId, t.driverId, t.basis)
      .where(sql`${t.state} not in ('rejected', 'waived', 'recovered', 'cancelled')`),
    index('safety_driver_charges_driver_idx').on(t.companyId, t.driverId),
    index('safety_driver_charges_claim_idx').on(t.companyId, t.claimId),
  ],
);
export type SafetyDriverChargeRow = typeof safetyDriverCharges.$inferSelect;

/** Claim lines (0061): one incident, many claims - each kind ticked on New claim is a line. */
export const safetyClaimLines = pgTable(
  'safety_claim_lines',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => safetyClaims.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('not_filed'),
    insurer: text('insurer'),
    reserveCents: bigint('reserve_cents', { mode: 'number' }),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [uniqueIndex('safety_claim_lines_kind_key').on(t.companyId, t.claimId, t.kind).where(sql`${t.voidedAt} is null`)],
);
export type SafetyClaimLineRow = typeof safetyClaimLines.$inferSelect;
