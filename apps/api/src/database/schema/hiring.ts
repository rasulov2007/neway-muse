import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { applicants } from './hr';
import { employees } from './people';
import { companies } from './roster';
import { verificationCases } from './compliance';

/**
 * The driver hiring funnel: one record per person from lead to active driver.
 *
 * A hiring case is a *wrapper*. Its middle — Checks and Safety review — is the verification case
 * it points at, and it holds no copy of any consent, document or decision. Its front (lead,
 * prequalification, application) arrives in later steps and points at the recruiting applicant.
 *
 * The state is stored on the case for querying, but the truth is the event table: every move is
 * an appended `hiring_stage_events` row, and `state` is always the `to_state` of the latest one.
 * That is what makes days-in-stage, funnel conversion and a disqualified candidate's history free.
 */

export const hiringCases = pgTable(
  'hiring_cases',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicantId: text('applicant_id').references(() => applicants.id),
    /** The driver record, once one exists. No FK: the driver may be a text id from the roster. */
    driverId: text('driver_id'),
    verificationCaseId: text('verification_case_id').references(() => verificationCases.id),
    candidateName: text('candidate_name').notNull(),
    /** A live stage or a terminal state; see the shared HIRING_STATES. */
    state: text('state').notNull(),
    stateSince: timestamp('state_since', { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    endReason: text('end_reason'),
    endNote: text('end_note'),
    recruiterId: text('recruiter_id'),
    recruiterName: text('recruiter_name'),
    /** The driver offer, on the recruiting offers table. */
    offerId: text('offer_id'),
    /** Set by the hire event, once: the employee the person became. */
    employeeId: text('employee_id').references(() => employees.id),
    hiredAt: timestamp('hired_at', { withTimezone: true }),
    /** The first time the roster reported this driver dispatched or driving. */
    firstDispatchAt: timestamp('first_dispatch_at', { withTimezone: true }),
    /** Test data (owner, 2026-10-07): kept and audited, left out of the pipeline, counts and analytics. */
    isTest: boolean('is_test').notNull().default(false),
    testMarkedAt: timestamp('test_marked_at', { withTimezone: true }),
    testMarkedBy: text('test_marked_by'),
    testReason: text('test_reason'),
    /** The candidate's current follow-up date (0048), set by a note; the note is the audit record. */
    nextFollowUpOn: date('next_follow_up_on', { mode: 'string' }),
    followUpSetAt: timestamp('follow_up_set_at', { withTimezone: true }),
    followUpSetBy: text('follow_up_set_by'),
    /** Recruiting asked Safety to review the file (0048): who, when, with what note. Once. */
    safetyRequestedAt: timestamp('safety_requested_at', { withTimezone: true }),
    safetyRequestedBy: text('safety_requested_by'),
    safetyRequestNote: text('safety_request_note'),
    /** Journey v2 (0050): a recruiter reviewed the received application, then started onboarding. */
    applicationReviewedAt: timestamp('application_reviewed_at', { withTimezone: true }),
    applicationReviewedBy: text('application_reviewed_by'),
    onboardingStartedAt: timestamp('onboarding_started_at', { withTimezone: true }),
    onboardingStartedBy: text('onboarding_started_by'),
    /** On hold before the hire (0050): kept in the pipeline, nothing moves until it is released. */
    onHoldAt: timestamp('on_hold_at', { withTimezone: true }),
    onHoldBy: text('on_hold_by'),
    onHoldReason: text('on_hold_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_cases_verification_case_key')
      .on(table.verificationCaseId)
      .where(sql`${table.verificationCaseId} is not null`),
    uniqueIndex('hiring_cases_applicant_key')
      .on(table.applicantId)
      .where(sql`${table.applicantId} is not null`),
    index('hiring_cases_state_idx').on(table.companyId, table.state),
  ],
);

/** Append-only. There is no update path and no delete path for this table anywhere in the API. */
export const hiringStageEvents = pgTable(
  'hiring_stage_events',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    caseId: text('case_id')
      .notNull()
      .references(() => hiringCases.id, { onDelete: 'cascade' }),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    byId: text('by_id'),
    byName: text('by_name').notNull(),
    reason: text('reason'),
    note: text('note'),
    /** user · system · verification */
    source: text('source').notNull().default('user'),
  },
  (table) => [index('hiring_stage_events_case_idx').on(table.caseId, table.at)],
);

export type HiringCaseRow = typeof hiringCases.$inferSelect;
export type HiringStageEventRow = typeof hiringStageEvents.$inferSelect;

/**
 * A lead: the front of the funnel. Less than an applicant on purpose — a name, a phone number,
 * what they said on the first call, and what the company's rules made of it. Converting it is what
 * creates the applicant and the hiring case; the lead row then points at both.
 *
 * `prequalification` holds the answers as given. `prequal_result` holds the verdict against the
 * rules in force when it was last evaluated, with the rule that failed named — a lead is never
 * flagged "does not qualify" without saying why.
 */
export const hiringLeads = pgTable(
  'hiring_leads',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leadNumber: text('lead_number').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    cdlClass: text('cdl_class'),
    state: text('state'),
    yearsExperience: numeric('years_experience', { precision: 4, scale: 1 }),
    source: text('source').notNull(),
    /** The campaign arrives with the cost ledger; nullable text until then, never a fake FK. */
    campaignId: text('campaign_id'),
    recruiterEmployeeId: text('recruiter_employee_id').references(() => employees.id),
    notes: text('notes'),
    /** new · contacted · prequalified · converted · dead */
    status: text('status').notNull().default('new'),
    prequalification: jsonb('prequalification'),
    prequalResult: jsonb('prequal_result'),
    applicantId: text('applicant_id').references(() => applicants.id),
    hiringCaseId: text('hiring_case_id').references(() => hiringCases.id),
    deadReason: text('dead_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    prequalifiedAt: timestamp('prequalified_at', { withTimezone: true }),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    /** The latest online application. Never moves `status`: applying again is not progress. */
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    /**
     * Test data (owner, 2026-10-07): kept, never deleted, but out of every list, count, dedupe
     * and analytics. Who marked it, when and why sit beside it and in the audit log.
     */
    isTest: boolean('is_test').notNull().default(false),
    testMarkedAt: timestamp('test_marked_at', { withTimezone: true }),
    testMarkedBy: text('test_marked_by'),
    testReason: text('test_reason'),
    /** The lead's current follow-up date (0048), set by a note; the note is the audit record. */
    nextFollowUpOn: date('next_follow_up_on', { mode: 'string' }),
    followUpSetAt: timestamp('follow_up_set_at', { withTimezone: true }),
    followUpSetBy: text('follow_up_set_by'),
    /** The driver who referred this person from the driver app (0082); the driver sees the stage only. */
    referredByDriverId: text('referred_by_driver_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_leads_number_key').on(table.companyId, table.leadNumber),
    index('hiring_leads_status_idx').on(table.companyId, table.status),
    index('hiring_leads_phone_idx').on(table.companyId, table.phone),
  ],
);

export type HiringLeadRow = typeof hiringLeads.$inferSelect;

/**
 * The DOT employment application (49 CFR 391.21) behind a hiring case.
 *
 * Holds the answers and points at what they became: the qualification-file document the PDF was
 * filed as, the driver id the file was keyed by, the verification case that opened, the consents
 * drafted to the employers listed. None of those are copied here. The social security number is
 * sealed with the same vault integration credentials use and is read back only to print the PDF.
 */
export const hiringDotApplications = pgTable(
  'hiring_dot_applications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => applicants.id),
    /** draft · submitted */
    status: text('status').notNull().default('draft'),
    form: jsonb('form').notNull(),
    ssnSealed: jsonb('ssn_sealed'),
    ssnLast4: text('ssn_last4'),
    documentId: text('document_id'),
    consentIds: jsonb('consent_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedBy: text('submitted_by'),
    /** 'driver_link' when the driver certified it through the link; null when the desk submitted. */
    submittedVia: text('submitted_via'),
    /** The driver's certification, frozen at Submit: when, the typed name, and the exact answers. */
    certifiedAt: timestamp('certified_at', { withTimezone: true }),
    certifiedName: text('certified_name'),
    certifiedSnapshot: jsonb('certified_snapshot'),
    /** Earlier certifications a recruiter returned to the driver. Appended, never rewritten. */
    certificationHistory: jsonb('certification_history')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Who accepted a driver's submission into the qualification file, and when. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedBy: text('returned_by'),
    returnNote: text('return_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('hiring_dot_applications_case_key').on(table.hiringCaseId)],
);

export type HiringDotApplicationRow = typeof hiringDotApplications.$inferSelect;

/** The travel booked to bring a candidate to orientation; one per case, the cost ledger reads it. */
export const hiringTickets = pgTable(
  'hiring_tickets',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** bus · flight · rental_car · own_vehicle · company_shuttle */
    travelMode: text('travel_mode').notNull(),
    carrier: text('carrier'),
    bookingReference: text('booking_reference'),
    departAt: timestamp('depart_at', { withTimezone: true }).notNull(),
    arriveAt: timestamp('arrive_at', { withTimezone: true }),
    travelCost: numeric('travel_cost', { precision: 12, scale: 2 }),
    lodgingNights: integer('lodging_nights').notNull().default(0),
    lodgingCost: numeric('lodging_cost', { precision: 12, scale: 2 }),
    bookedById: text('booked_by_id'),
    bookedByName: text('booked_by_name').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('hiring_tickets_case_key').on(table.hiringCaseId)],
);

/** Orientation attendance and the road test; the certificate itself is in the qualification file. */
export const hiringOrientations = pgTable(
  'hiring_orientations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    startDate: date('start_date').notNull(),
    days: integer('days').notNull(),
    perDayPay: numeric('per_day_pay', { precision: 10, scale: 2 }),
    /** scheduled · attended · no_show */
    attendance: text('attendance').notNull().default('scheduled'),
    roadTest: jsonb('road_test'),
    roadTestDocumentId: text('road_test_document_id'),
    completedOn: date('completed_on'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('hiring_orientations_case_key').on(table.hiringCaseId)],
);

export type HiringTicketRow = typeof hiringTickets.$inferSelect;
export type HiringOrientationRow = typeof hiringOrientations.$inferSelect;

/** Where leads come from and what was spent to get them. */
export const hiringCampaigns = pgTable(
  'hiring_campaigns',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** job_board · referral · social · website · agency · radio · billboard · event · other */
    channel: text('channel').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end'),
    /**
     * The single spend total of before 0038. Spend is now dated (`hiring_campaign_spend`) and is
     * never read from here; the server keeps this equal to the live entries' sum only so that a
     * rollback to the older code still shows the right total.
     */
    spend: numeric('spend', { precision: 12, scale: 2 }).notNull().default('0'),
    ownerEmployeeId: text('owner_employee_id').references(() => employees.id),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('hiring_campaigns_company_idx').on(table.companyId, table.active)],
);

/**
 * The cost ledger: one amount against one lead or one case. Auto entries name the record they
 * were priced from in `source_ref`, unique, which is what keeps a report from being charged twice.
 */
export const hiringCostEntries = pgTable(
  'hiring_cost_entries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id').references(() => hiringCases.id),
    leadId: text('lead_id').references(() => hiringLeads.id),
    campaignId: text('campaign_id').references(() => hiringCampaigns.id),
    type: text('type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    incurredOn: date('incurred_on').notNull(),
    /** manual · auto */
    source: text('source').notNull().default('manual'),
    sourceRef: text('source_ref'),
    note: text('note'),
    recordedBy: text('recorded_by').notNull(),
    /** The receipt in stored_files (0037). */
    receiptFileId: text('receipt_file_id'),
    /** The Accounting expense this cost was attributed from; one live cost per expense (0037). */
    accountingExpenseId: text('accounting_expense_id'),
    /** Voided entries are kept and left out of every total (0037); nothing is deleted. */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    /**
     * Set when the expense in `accounting_expense_id` was created by posting this cost (0038);
     * null when the cost was attributed from an expense Accounting already had.
     */
    accountingPostedAt: timestamp('accounting_posted_at', { withTimezone: true }),
    accountingPostedBy: text('accounting_posted_by'),
    /** Why the last attempt to post, update or void in Accounting did not happen (0038). */
    accountingPostNote: text('accounting_post_note'),
    /**
     * Journey v2 (0050): who paid (company · driver) and whose cost it is (company · driver), which
     * decide where it goes in Accounting; approval and payment are separate from booking.
     */
    paidBy: text('paid_by').notNull().default('company'),
    costOwner: text('cost_owner').notNull().default('company'),
    vendor: text('vendor'),
    /** planned · approved · rejected */
    approvalStatus: text('approval_status').notNull().default('approved'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    /** unpaid · paid — paid only when the payment itself is recorded. */
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    travelItemId: text('travel_item_id'),
    refundAmount: numeric('refund_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    nonrefundableFee: numeric('nonrefundable_fee', { precision: 12, scale: 2 }),
    /** A company-paid cost the driver owes needs the recorded agreement before it is charged. */
    driverAgreementNote: text('driver_agreement_note'),
    driverAgreementAt: timestamp('driver_agreement_at', { withTimezone: true }),
    driverTransactionId: text('driver_transaction_id'),
    reimbursementExpenseId: text('reimbursement_expense_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_cost_entries_expense_key')
      .on(table.companyId, table.accountingExpenseId)
      .where(sql`${table.accountingExpenseId} is not null and ${table.voidedAt} is null`),
    uniqueIndex('hiring_cost_entries_source_ref_key')
      .on(table.sourceRef)
      .where(sql`${table.sourceRef} is not null`),
    index('hiring_cost_entries_case_idx').on(table.hiringCaseId),
    index('hiring_cost_entries_lead_idx').on(table.leadId),
    index('hiring_cost_entries_campaign_idx').on(table.campaignId),
  ],
);

/**
 * Dated campaign spend (0038): one row per payment. A campaign's spend is its live rows added up
 * on read; a reporting period takes the rows dated inside it. Voided, never deleted; every edit
 * names the version it read.
 */
export const hiringCampaignSpend = pgTable(
  'hiring_campaign_spend',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => hiringCampaigns.id, { onDelete: 'restrict' }),
    spentOn: date('spent_on').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    recordedBy: text('recorded_by').notNull(),
    /** The client's retry key, so a resent save finds the first row. */
    clientKey: text('client_key'),
    version: integer('version').notNull().default(1),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hiring_campaign_spend_campaign_idx').on(table.companyId, table.campaignId, table.spentOn),
    uniqueIndex('hiring_campaign_spend_client_key')
      .on(table.companyId, table.clientKey)
      .where(sql`${table.clientKey} is not null`),
  ],
);

export type HiringCampaignSpendRow = typeof hiringCampaignSpend.$inferSelect;
export type HiringCampaignRow = typeof hiringCampaigns.$inferSelect;
export type HiringCostEntryRow = typeof hiringCostEntries.$inferSelect;

/**
 * A public application link: `/apply/<slug>`, shared in an ad or a post.
 *
 * The link is how the server knows the company. The slug is unique across the whole deployment so
 * that it alone resolves to one company, and the browser never names a company at all. The consent
 * wording and privacy policy address are the company's own and are required: a link with no
 * approved wording cannot be created, so NeWay never shows a driver legal text it made up.
 */
export const hiringApplyLinks = pgTable(
  'hiring_apply_links',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Shown as 'Drive with …' on the page; the company name when null. Up to 12 characters. */
    shortName: text('short_name'),
    /** One of APPLICANT_SOURCES; what a lead from this link is recorded as. */
    source: text('source').notNull().default('social'),
    campaignId: text('campaign_id').references(() => hiringCampaigns.id),
    logoUrl: text('logo_url'),
    consentText: text('consent_text').notNull(),
    privacyPolicyUrl: text('privacy_policy_url').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_apply_links_slug_key').on(table.slug),
    index('hiring_apply_links_company_idx').on(table.companyId),
  ],
);

/**
 * One online application: what the driver answered, through which link and campaign, and the
 * consent wording as it read when they agreed. Many per lead — a driver who applies twice has two
 * rows and one lead, and nothing about the lead's stage changes.
 *
 * `submission_key` is minted by the browser once per filled-in form. Unique per company, it is what
 * turns a double tap or a retry after a dropped connection into the same row instead of a second.
 * `ip_hash` is a keyed hash, never the address: it exists for rate limiting and nothing else.
 */
export const hiringLeadApplications = pgTable(
  'hiring_lead_applications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => hiringLeads.id),
    applyLinkId: text('apply_link_id')
      .notNull()
      .references(() => hiringApplyLinks.id),
    submissionKey: text('submission_key').notNull(),
    /** new_lead · existing_lead */
    outcome: text('outcome').notNull(),
    source: text('source').notNull(),
    campaignId: text('campaign_id').references(() => hiringCampaigns.id),
    answers: jsonb('answers').notNull(),
    attribution: jsonb('attribution').notNull(),
    consentText: text('consent_text').notNull(),
    privacyPolicyUrl: text('privacy_policy_url').notNull(),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    phoneKey: text('phone_key').notNull(),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_lead_applications_submission_key').on(table.companyId, table.submissionKey),
    index('hiring_lead_applications_lead_idx').on(table.companyId, table.leadId),
    index('hiring_lead_applications_link_idx').on(table.applyLinkId),
    index('hiring_lead_applications_ip_idx').on(table.ipHash, table.receivedAt),
    index('hiring_lead_applications_phone_idx').on(
      table.companyId,
      table.phoneKey,
      table.receivedAt,
    ),
  ],
);

export type HiringApplyLinkRow = typeof hiringApplyLinks.$inferSelect;
export type HiringLeadApplicationRow = typeof hiringLeadApplications.$inferSelect;

/**
 * A private link that sends the DOT application to the driver (owner, 2026-10-07). Only the
 * SHA-256 digest of the token is kept; the raw token is shown to the recruiter once. One live link
 * per case: making a new one sets `revoked_at` on the old one. Never deleted.
 */
export const hiringDotLinks = pgTable(
  'hiring_dot_links',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    tokenHash: text('token_hash').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    lastSavedAt: timestamp('last_saved_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    cdlUploadedAt: timestamp('cdl_uploaded_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hiring_dot_links_token_key').on(table.tokenHash),
    uniqueIndex('hiring_dot_links_live_key')
      .on(table.hiringCaseId)
      .where(sql`${table.revokedAt} IS NULL`),
    index('hiring_dot_links_case_idx').on(table.companyId, table.hiringCaseId, table.createdAt),
  ],
);

export type HiringDotLinkRow = typeof hiringDotLinks.$inferSelect;

/**
 * CDL files a driver sends through the link before a recruiter accepts the application. Kept in
 * private storage against the case — not in the qualification file — and filed there on Accept.
 * A newer file of the same kind supersedes the older one; nothing is deleted.
 */
export const hiringDotLinkFiles = pgTable(
  'hiring_dot_link_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    linkId: text('link_id')
      .notNull()
      .references(() => hiringDotLinks.id),
    /** cdl · cdl_back */
    code: text('code').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    filedDocumentId: text('filed_document_id'),
  },
  (table) => [index('hiring_dot_link_files_case_idx').on(table.companyId, table.hiringCaseId)],
);

export type HiringDotLinkFileRow = typeof hiringDotLinkFiles.$inferSelect;

/**
 * The HR rotation (0048): one row per recruiter account in a company, in turn order. Keyed by the
 * account (user id) and carrying the employee leads are assigned to. Excluding keeps the row and
 * its place; nothing is deleted.
 */
export const hiringRotationMembers = pgTable(
  'hiring_rotation_members',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    employeeId: text('employee_id').notNull(),
    position: integer('position').notNull(),
    excluded: boolean('excluded').notNull().default(false),
    excludedAt: timestamp('excluded_at', { withTimezone: true }),
    excludedBy: text('excluded_by'),
    excludeReason: text('exclude_reason'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** seed_legacy · auto_join */
    joinedVia: text('joined_via').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_rotation_members_user_key').on(table.companyId, table.userId),
    index('hiring_rotation_members_order_idx').on(table.companyId, table.position),
  ],
);

/** The rotation cursor (0048): who took the last turn and at which place. */
export const hiringRotationState = pgTable('hiring_rotation_state', {
  companyId: text('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'restrict' }),
  lastUserId: text('last_user_id'),
  lastEmployeeId: text('last_employee_id'),
  lastPosition: integer('last_position'),
  lastLeadId: text('last_lead_id'),
  lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
  seededAt: timestamp('seeded_at', { withTimezone: true }).notNull().defaultNow(),
  /** What the first order and cursor were derived from. */
  seededFrom: text('seeded_from').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type HiringRotationMemberRow = typeof hiringRotationMembers.$inferSelect;
export type HiringRotationStateRow = typeof hiringRotationState.$inferSelect;

/**
 * An application received through the external intake adapter (0048), resolved to its candidate by
 * the private link token. One per link; a retry with the same submission key is the same row.
 */
export const hiringExternalApplications = pgTable(
  'hiring_external_applications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    dotLinkId: text('dot_link_id')
      .notNull()
      .references(() => hiringDotLinks.id),
    provider: text('provider').notNull(),
    submissionKey: text('submission_key').notNull(),
    reference: text('reference').notNull(),
    answers: jsonb('answers').notNull(),
    authorizations: jsonb('authorizations').notNull().default(sql`'{}'::jsonb`),
    ssnSealed: jsonb('ssn_sealed'),
    ssnLast4: text('ssn_last4'),
    fileIds: jsonb('file_ids').notNull().default(sql`'[]'::jsonb`),
    origin: text('origin'),
    ipHash: text('ip_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_external_applications_key').on(table.companyId, table.provider, table.submissionKey),
    uniqueIndex('hiring_external_applications_link_key').on(table.dotLinkId),
    index('hiring_external_applications_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);

export type HiringExternalApplicationRow = typeof hiringExternalApplications.$inferSelect;

/**
 * The personal driver application (0049, owner 2026-10-08): one private link per lead or
 * candidate. Only the SHA-256 digest of the token is kept. One live session per person
 * (`subject_key` is the lead id, or the case id for a candidate without a lead); issuing a new one
 * revokes the old. A session is used once: its submission is the application.
 */
export const hiringApplicationSessions = pgTable(
  'hiring_application_sessions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leadId: text('lead_id').references(() => hiringLeads.id),
    hiringCaseId: text('hiring_case_id').references(() => hiringCases.id),
    subjectKey: text('subject_key').notNull(),
    tokenHash: text('token_hash').notNull(),
    schemaVersion: text('schema_version').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    linkCopiedAt: timestamp('link_copied_at', { withTimezone: true }),
    linkCopiedBy: text('link_copied_by'),
    markedSentAt: timestamp('marked_sent_at', { withTimezone: true }),
    markedSentBy: text('marked_sent_by'),
    markedSentChannel: text('marked_sent_channel'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submissionId: text('submission_id'),
    /** The device the link was first opened on (0054): it opens on that device only. */
    boundDeviceHash: text('bound_device_hash'),
    boundAt: timestamp('bound_at', { withTimezone: true }),
    /** Storage keys written for an attempt that has not committed yet; cleared on commit or cleanup. */
    stagingKeys: jsonb('staging_keys').notNull().default(sql`'[]'::jsonb`),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_application_sessions_token_key').on(table.tokenHash),
    uniqueIndex('hiring_application_sessions_live_key')
      .on(table.companyId, table.subjectKey)
      .where(sql`${table.revokedAt} IS NULL`),
    index('hiring_application_sessions_case_idx').on(table.companyId, table.hiringCaseId),
    index('hiring_application_sessions_lead_idx').on(table.companyId, table.leadId),
  ],
);

export type HiringApplicationSessionRow = typeof hiringApplicationSessions.$inferSelect;

/** The application received through a session (0049): the answers as given, the SSN sealed. */
export const hiringDriverApplications = pgTable(
  'hiring_driver_applications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => hiringApplicationSessions.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    leadId: text('lead_id').references(() => hiringLeads.id),
    applicantId: text('applicant_id'),
    /** The reserved driver id the qualification file is keyed by (Safety and Hire reuse it). */
    driverId: text('driver_id').notNull(),
    reference: text('reference').notNull(),
    submissionKey: text('submission_key').notNull(),
    schemaVersion: text('schema_version').notNull(),
    answers: jsonb('answers').notNull(),
    ssnSealed: jsonb('ssn_sealed').notNull(),
    ssnLast4: text('ssn_last4').notNull(),
    consentStatement: text('consent_statement').notNull(),
    /** same_origin · forwarder */
    via: text('via').notNull(),
    ipHash: text('ip_hash'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_driver_applications_session_key').on(table.sessionId),
    uniqueIndex('hiring_driver_applications_submission_key').on(table.companyId, table.submissionKey),
    uniqueIndex('hiring_driver_applications_reference_key').on(table.companyId, table.reference),
    index('hiring_driver_applications_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);

export type HiringDriverApplicationRow = typeof hiringDriverApplications.$inferSelect;

/** A document the driver attached (0049): bytes in private storage, filed for Safety's review. */
export const hiringDriverApplicationFiles = pgTable(
  'hiring_driver_application_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => hiringDriverApplications.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** cdl · cdl_back · medical_card */
    code: text('code').notNull(),
    fileName: text('file_name').notNull(),
    /** What the bytes are (magic bytes), not what the browser said. */
    contentType: text('content_type').notNull(),
    declaredType: text('declared_type'),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    filedDocumentId: text('filed_document_id'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hiring_driver_application_files_code_key').on(table.applicationId, table.code),
    index('hiring_driver_application_files_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);

export type HiringDriverApplicationFileRow = typeof hiringDriverApplicationFiles.$inferSelect;

/**
 * One report authorization (0049): MVR and PSP are separate rows, never one combined consent.
 * A signed row keeps the drawn signature image (private storage), the printed name, the client's
 * claimed time, the server's receipt time and the canonical disclosure text the server holds.
 */
export const hiringDriverAuthorizations = pgTable(
  'hiring_driver_authorizations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => hiringDriverApplications.id),
    sessionId: text('session_id').notNull(),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** mvr · psp */
    documentType: text('document_type').notNull(),
    /** signed · declined */
    decision: text('decision').notNull(),
    signerName: text('signer_name'),
    printedSignature: text('printed_signature'),
    signatureMethod: text('signature_method'),
    electronicSignature: boolean('electronic_signature'),
    disclosureOpenedClaim: boolean('disclosure_opened_claim'),
    clientSignedAt: text('client_signed_at'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    disclosureVersion: text('disclosure_version'),
    disclosureSha256: text('disclosure_sha256'),
    disclosureText: text('disclosure_text'),
    signatureStorageKey: text('signature_storage_key'),
    signatureSha256: text('signature_sha256'),
    signatureBytes: integer('signature_bytes'),
    signatureWidth: integer('signature_width'),
    signatureHeight: integer('signature_height'),
  },
  (table) => [
    uniqueIndex('hiring_driver_authorizations_type_key').on(table.applicationId, table.documentType),
    index('hiring_driver_authorizations_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);

export type HiringDriverAuthorizationRow = typeof hiringDriverAuthorizations.$inferSelect;

// ===================================================================== recruiting journey (0050)

/**
 * The candidate consent link (0050, owner brief 2026-10-11): one live per person, token digest
 * only. Creating, emailing, marking sent, opening and completing are kept apart, because an opened
 * link is not a read disclosure and a copied link is not a sent one.
 */
export const hiringConsentSessions = pgTable(
  'hiring_consent_sessions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leadId: text('lead_id').references(() => hiringLeads.id),
    hiringCaseId: text('hiring_case_id').references(() => hiringCases.id),
    subjectKey: text('subject_key').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokeReason: text('revoke_reason'),
    linkCopiedAt: timestamp('link_copied_at', { withTimezone: true }),
    linkCopiedBy: text('link_copied_by'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    emailedTo: text('emailed_to'),
    emailedBy: text('emailed_by'),
    markedSentAt: timestamp('marked_sent_at', { withTimezone: true }),
    markedSentBy: text('marked_sent_by'),
    markedSentChannel: text('marked_sent_channel'),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    openCount: integer('open_count').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    consentId: text('consent_id'),
    /** The device the link was first opened on (0054): it opens on that device only. */
    boundDeviceHash: text('bound_device_hash'),
    boundAt: timestamp('bound_at', { withTimezone: true }),
    stagingKeys: jsonb('staging_keys').notNull().default(sql`'[]'::jsonb`),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_consent_sessions_token_key').on(table.tokenHash),
    uniqueIndex('hiring_consent_sessions_live_key')
      .on(table.companyId, table.subjectKey)
      .where(sql`${table.revokedAt} IS NULL`),
    index('hiring_consent_sessions_lead_idx').on(table.companyId, table.leadId),
    index('hiring_consent_sessions_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);
export type HiringConsentSessionRow = typeof hiringConsentSessions.$inferSelect;

/** The signed consent (0050): who signed, how, when the server received it; the IP sealed. */
export const hiringConsents = pgTable(
  'hiring_consents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => hiringConsentSessions.id),
    leadId: text('lead_id').references(() => hiringLeads.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    driverId: text('driver_id').notNull(),
    reference: text('reference').notNull(),
    submissionKey: text('submission_key').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone').notNull(),
    email: text('email').notNull(),
    confirmationStatement: text('confirmation_statement').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    /** typed · drawn */
    signatureMethod: text('signature_method').notNull(),
    signatureText: text('signature_text'),
    signatureStorageKey: text('signature_storage_key'),
    signatureSha256: text('signature_sha256'),
    signatureBytes: integer('signature_bytes'),
    signatureWidth: integer('signature_width'),
    signatureHeight: integer('signature_height'),
    clientSignedAt: text('client_signed_at'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** The server-observed client IP, sealed; staff-only, never on the driver's PDF. */
    ipSealed: jsonb('ip_sealed'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    /** The safety questions as answered (0056); null before they were asked. */
    safetyAnswers: jsonb('safety_answers'),
    safetyDisqualified: boolean('safety_disqualified').notNull().default(false),
  },
  (table) => [
    uniqueIndex('hiring_consents_session_key').on(table.sessionId),
    uniqueIndex('hiring_consents_submission_key').on(table.companyId, table.submissionKey),
    uniqueIndex('hiring_consents_reference_key').on(table.companyId, table.reference),
    index('hiring_consents_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);
export type HiringConsentRow = typeof hiringConsents.$inferSelect;

/** Each disclosure exactly as signed (0050): MVR, PSP and Clearinghouse are separate documents. */
export const hiringConsentDocuments = pgTable(
  'hiring_consent_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    consentId: text('consent_id')
      .notNull()
      .references(() => hiringConsents.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    documentType: text('document_type').notNull(),
    disclosureVersion: text('disclosure_version').notNull(),
    disclosureSha256: text('disclosure_sha256').notNull(),
    disclosureText: text('disclosure_text').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    /** What the consent allows (0051): the Clearinghouse limited consent's company scope. */
    scope: text('scope'),
    validUntil: timestamp('valid_until', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hiring_consent_documents_type_key').on(table.consentId, table.documentType),
    index('hiring_consent_documents_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);
export type HiringConsentDocumentRow = typeof hiringConsentDocuments.$inferSelect;

/** A file the consent carried (0050): the CDL front, original bytes in private storage. */
export const hiringConsentFiles = pgTable(
  'hiring_consent_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    consentId: text('consent_id')
      .notNull()
      .references(() => hiringConsents.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    code: text('code').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    declaredType: text('declared_type'),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    filedDocumentId: text('filed_document_id'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hiring_consent_files_code_key').on(table.consentId, table.code),
    index('hiring_consent_files_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);
export type HiringConsentFileRow = typeof hiringConsentFiles.$inferSelect;

/** The candidate's Safety review (0050): one per case; only Safety decides it. */
export const hiringSafetyReviews = pgTable(
  'hiring_safety_reviews',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** pending · in_review · needs_follow_up · approved · declined */
    status: text('status').notNull().default('pending'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openedByUserId: text('opened_by_user_id').notNull(),
    openedByName: text('opened_by_name').notNull(),
    requestNote: text('request_note'),
    /** The FMCSA full-query consent, given by the driver in the Clearinghouse itself (not this TMS). */
    fmcsaFullQueryStatus: text('fmcsa_full_query_status').notNull().default('not_requested'),
    fmcsaFullQueryAt: timestamp('fmcsa_full_query_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: text('decided_by_user_id'),
    decidedByName: text('decided_by_name'),
    decisionNote: text('decision_note'),
    /** Insurance check (0054): pending · approved · declined; null when never asked. */
    insuranceStatus: text('insurance_status'),
    insuranceNote: text('insurance_note'),
    insuranceRequestedAt: timestamp('insurance_requested_at', { withTimezone: true }),
    insuranceRequestedBy: text('insurance_requested_by'),
    insuranceRespondedAt: timestamp('insurance_responded_at', { withTimezone: true }),
    insuranceRespondedBy: text('insurance_responded_by'),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_safety_reviews_case_key').on(table.companyId, table.hiringCaseId),
    index('hiring_safety_reviews_status_idx').on(table.companyId, table.status),
  ],
);
export type HiringSafetyReviewRow = typeof hiringSafetyReviews.$inferSelect;

/** A report Safety received for the review (0050); the file lives in the qualification file. */
export const hiringSafetyReports = pgTable(
  'hiring_safety_reports',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    reviewId: text('review_id')
      .notNull()
      .references(() => hiringSafetyReviews.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** mvr · psp · clearinghouse_limited · clearinghouse_full · drug_test · other */
    kind: text('kind').notNull(),
    /** pending · clear · findings · prohibited */
    result: text('result').notNull().default('pending'),
    /** received · reviewed */
    status: text('status').notNull().default('received'),
    documentId: text('document_id'),
    fileName: text('file_name'),
    receivedOn: date('received_on', { mode: 'string' }),
    note: text('note'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedByUserId: text('uploaded_by_user_id').notNull(),
    uploadedByName: text('uploaded_by_name').notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedByName: text('reviewed_by_name'),
    reviewNote: text('review_note'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
  },
  (table) => [index('hiring_safety_reports_review_idx').on(table.companyId, table.reviewId)],
);
export type HiringSafetyReportRow = typeof hiringSafetyReports.$inferSelect;

/**
 * A consent or application link the TMS itself sent (0051): by SMS through the company's Twilio
 * account or by email through SMTP. One row per attempt; a resend is a new row (and a new link,
 * since a link is shown once). `sent` means the provider accepted it; `delivered` only when the
 * carrier says so; `failed` keeps the provider's reason.
 */
export const hiringLinkDeliveries = pgTable(
  'hiring_link_deliveries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leadId: text('lead_id').references(() => hiringLeads.id),
    hiringCaseId: text('hiring_case_id').references(() => hiringCases.id),
    subjectKey: text('subject_key').notNull(),
    /** consent · application */
    linkKind: text('link_kind').notNull(),
    sessionId: text('session_id').notNull(),
    /** sms · email */
    channel: text('channel').notNull(),
    recipient: text('recipient').notNull(),
    /** sending · sent · delivered · failed */
    status: text('status').notNull().default('sending'),
    /** twilio · smtp · file */
    provider: text('provider').notNull(),
    integrationAccountId: text('integration_account_id'),
    providerMessageId: text('provider_message_id'),
    providerStatus: text('provider_status'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    resendOfId: text('resend_of_id'),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    statusCheckedAt: timestamp('status_checked_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('hiring_link_deliveries_subject_idx').on(table.companyId, table.subjectKey),
    index('hiring_link_deliveries_case_idx').on(table.companyId, table.hiringCaseId),
    uniqueIndex('hiring_link_deliveries_provider_key')
      .on(table.provider, table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
  ],
);
export type HiringLinkDeliveryRow = typeof hiringLinkDeliveries.$inferSelect;

/**
 * Texting consent per phone number (0051): the opt-in staff recorded (how the person agreed), and
 * the person's own STOP / START replies, which always win. Nobody opted out is texted.
 */
export const smsPreferences = pgTable(
  'sms_preferences',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    phone: text('phone').notNull(),
    /** opted_in · opted_out */
    status: text('status').notNull(),
    optedInAt: timestamp('opted_in_at', { withTimezone: true }),
    optedInBy: text('opted_in_by'),
    optedInSource: text('opted_in_source'),
    optedInNote: text('opted_in_note'),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    /** reply_stop · carrier · staff */
    optedOutSource: text('opted_out_source'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (table) => [primaryKey({ name: 'sms_preferences_pk', columns: [table.companyId, table.phone] })],
);
export type SmsPreferenceRow = typeof smsPreferences.$inferSelect;

/**
 * One Safety check on a candidate (0051): MVR, PSP, Clearinghouse limited or full query, moving
 * Requested → Pending → Received → Reviewed, each step with who and when. A signed consent is not a
 * check, and a received report is not a reviewed one.
 */
export const hiringSafetyChecks = pgTable(
  'hiring_safety_checks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    reviewId: text('review_id')
      .notNull()
      .references(() => hiringSafetyReviews.id),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** mvr · psp · clearinghouse_limited · clearinghouse_full */
    kind: text('kind').notNull(),
    /** requested · pending · received · reviewed */
    status: text('status').notNull().default('requested'),
    /** manual, or the provider that ran it */
    provider: text('provider').notNull().default('manual'),
    orderRef: text('order_ref'),
    note: text('note'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    requestedByUserId: text('requested_by_user_id'),
    requestedByName: text('requested_by_name'),
    pendingAt: timestamp('pending_at', { withTimezone: true }),
    pendingByName: text('pending_by_name'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedByName: text('received_by_name'),
    reportId: text('report_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedByName: text('reviewed_by_name'),
    result: text('result'),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('hiring_safety_checks_review_kind_key').on(table.reviewId, table.kind),
    index('hiring_safety_checks_case_idx').on(table.companyId, table.hiringCaseId),
  ],
);
export type HiringSafetyCheckRow = typeof hiringSafetyChecks.$inferSelect;

/** A pre-hire onboarding task (0050): status, owner, dates and the evidence behind it. */
export const hiringOnboardingTasks = pgTable(
  'hiring_onboarding_tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    code: text('code').notNull(),
    label: text('label').notNull(),
    required: boolean('required').notNull().default(true),
    /** pending · in_progress · done · failed · waived */
    status: text('status').notNull().default('pending'),
    ownerEmployeeId: text('owner_employee_id'),
    ownerName: text('owner_name'),
    dueOn: date('due_on', { mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByName: text('completed_by_name'),
    /** A short outcome, e.g. "Negative" for a drug test. */
    result: text('result'),
    evidenceDocumentId: text('evidence_document_id'),
    evidenceFileId: text('evidence_file_id'),
    note: text('note'),
    sort: integer('sort').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('hiring_onboarding_tasks_code_key').on(table.companyId, table.hiringCaseId, table.code)],
);
export type HiringOnboardingTaskRow = typeof hiringOnboardingTasks.$inferSelect;

/** A travel booking for a candidate (0050): flight, hotel or ground transport. */
export const hiringTravelItems = pgTable(
  'hiring_travel_items',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    hiringCaseId: text('hiring_case_id')
      .notNull()
      .references(() => hiringCases.id),
    /** flight · hotel · ground */
    kind: text('kind').notNull(),
    /** booked · rescheduled · cancelled */
    status: text('status').notNull().default('booked'),
    vendor: text('vendor'),
    routeFrom: text('route_from'),
    routeTo: text('route_to'),
    bookingReference: text('booking_reference'),
    departAt: timestamp('depart_at', { withTimezone: true }),
    arriveAt: timestamp('arrive_at', { withTimezone: true }),
    checkInOn: date('check_in_on', { mode: 'string' }),
    checkOutOn: date('check_out_on', { mode: 'string' }),
    notes: text('notes'),
    confirmationFileId: text('confirmation_file_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByName: text('updated_by_name'),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('hiring_travel_items_case_idx').on(table.companyId, table.hiringCaseId)],
);
export type HiringTravelItemRow = typeof hiringTravelItems.$inferSelect;
