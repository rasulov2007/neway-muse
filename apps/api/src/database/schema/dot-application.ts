import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './roster';

/**
 * The DOT driver application, v2 (owner brief 2026-10-27, docs/driver-application).
 *
 * Two companies, two separate applications: every row carries `company_id`, the legal documents a
 * driver reads and signs are per-company template rows (`application_document_templates`), and an
 * application freezes the template versions it was opened with. Nothing here is ever hard-deleted:
 * a revoked link, a superseded signature, a removed upload keep their row with who / when / why.
 */

/** One legal document of one company, one version. The driver signs only an `approved` version. */
export const applicationDocumentTemplates = pgTable(
  'application_document_templates',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The document's key in the application (psp, fcra_disclosure, ic_ack …). */
    docKey: text('doc_key').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    /** The legal content as structured HTML fragments, verbatim from the company's approved source. */
    content: jsonb('content').notNull(),
    /** The approved source file (PDF) in private storage, and its digest. */
    sourceFileName: text('source_file_name'),
    sourceStorageKey: text('source_storage_key'),
    sourceSha256: text('source_sha256'),
    contentSha256: text('content_sha256').notNull(),
    /** draft · approved · retired */
    status: text('status').notNull().default('draft'),
    note: text('note'),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedByUserId: text('approved_by_user_id'),
    approvedByName: text('approved_by_name'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredByName: text('retired_by_name'),
  },
  (t) => [
    uniqueIndex('application_document_templates_version_uq').on(t.companyId, t.docKey, t.version),
    // At most one approved version per document per company at a time.
    uniqueIndex('application_document_templates_approved_uq')
      .on(t.companyId, t.docKey)
      .where(sql`status = 'approved'`),
    index('application_document_templates_company_idx').on(t.companyId),
  ],
);

/** One application per candidate per company (reused, never duplicated). */
export const dotDriverApplications = pgTable(
  'dot_driver_applications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The recruiting subject: the lead id, or the hiring case id for a candidate without a lead. */
    subjectKey: text('subject_key').notNull(),
    leadId: text('lead_id'),
    hiringCaseId: text('hiring_case_id'),
    /** The reserved driver id (DriversService.reserveDriverIdFor), reused at hire. */
    driverId: text('driver_id'),
    candidateName: text('candidate_name').notNull(),
    candidateEmail: text('candidate_email'),
    /** sent · opened · in_progress · submitted · under_review · changes_requested · approved · rejected · hired */
    status: text('status').notNull().default('sent'),
    /** { docKey: version } frozen when the application was created. */
    templateVersions: jsonb('template_versions').notNull().default(sql`'{}'::jsonb`),
    /** The driver's answers (no SSN in here: that is sealed below). */
    answers: jsonb('answers').notNull().default(sql`'{}'::jsonb`),
    /** What the Consent Form prefilled, kept so Safety sees the source. */
    prefill: jsonb('prefill').notNull().default(sql`'{}'::jsonb`),
    ssnSealed: jsonb('ssn_sealed'),
    ssnLast4: text('ssn_last4'),
    /** ACH debit routing + account numbers (0080), sealed like the SSN; never in the answers. */
    bankSealed: jsonb('bank_sealed'),
    bankLast4: text('bank_last4'),
    /** Optimistic lock: every save sends the version it read. */
    version: integer('version').notNull().default(1),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastSavedAt: timestamp('last_saved_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submitCount: integer('submit_count').notNull().default(0),
    reviewStartedAt: timestamp('review_started_at', { withTimezone: true }),
    reviewStartedByName: text('review_started_by_name'),
    /** Completed by the motor carrier only; never returned to the driver. */
    employerForms: jsonb('employer_forms').notNull().default(sql`'{}'::jsonb`),
    onboarding: jsonb('onboarding').notNull().default(sql`'{}'::jsonb`),
    internalNote: text('internal_note'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: text('approved_by_user_id'),
    approvedByName: text('approved_by_name'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedByName: text('rejected_by_name'),
    rejectedReason: text('rejected_reason'),
    hiredAt: timestamp('hired_at', { withTimezone: true }),
    hiredByName: text('hired_by_name'),
    /** The Fleet → Drivers row the hire created or activated. */
    rosterDriverId: text('roster_driver_id'),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dot_driver_applications_subject_uq').on(t.companyId, t.subjectKey),
    index('dot_driver_applications_status_idx').on(t.companyId, t.status),
  ],
);

/** A one-time link the recruiter sends. The token is never stored, only its SHA-256. */
export const dotApplicationLinks = pgTable(
  'dot_application_links',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => dotDriverApplications.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    /** Where the 6-digit code goes. */
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByName: text('revoked_by_name'),
    revokedReason: text('revoked_reason'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    copiedAt: timestamp('copied_at', { withTimezone: true }),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    codeFailures: integer('code_failures').notNull().default(0),
    /** Five wrong codes pause the link until recruiting sends a new one. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').notNull(),
    createdByName: text('created_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dot_application_links_token_uq').on(t.tokenHash),
    // One live link per application.
    uniqueIndex('dot_application_links_live_uq').on(t.applicationId).where(sql`revoked_at IS NULL`),
    index('dot_application_links_app_idx').on(t.applicationId),
  ],
);

/** A verified device: after the code, the driver resumes anywhere until the link expires. */
export const dotApplicationSessions = pgTable(
  'dot_application_sessions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    linkId: text('link_id')
      .notNull()
      .references(() => dotApplicationLinks.id, { onDelete: 'restrict' }),
    applicationId: text('application_id').notNull(),
    sessionHash: text('session_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('dot_application_sessions_hash_uq').on(t.sessionHash), index('dot_application_sessions_link_idx').on(t.linkId)],
);

/** Signature evidence: one row per document per signing. Never reused across documents. */
export const dotApplicationSignatures = pgTable(
  'dot_application_signatures',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => dotDriverApplications.id, { onDelete: 'restrict' }),
    /** The document signed (psp, emergency, sph_e0, emp_annual …). */
    docKey: text('doc_key').notNull(),
    /** The template version shown when it was signed. */
    docVersion: text('doc_version').notNull(),
    /** driver · employer */
    signerRole: text('signer_role').notNull(),
    signerName: text('signer_name').notNull(),
    signerUserId: text('signer_user_id'),
    signerTitle: text('signer_title'),
    typedName: text('typed_name').notNull(),
    esignConsent: boolean('esign_consent').notNull(),
    imageStorageKey: text('image_storage_key').notNull(),
    imageSha256: text('image_sha256').notNull(),
    /** SHA-256 over doc key, version, content digest, signer, typed name, time and image digest. */
    evidenceSha256: text('evidence_sha256').notNull(),
    contentSha256: text('content_sha256'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededReason: text('superseded_reason'),
  },
  (t) => [
    index('dot_application_signatures_app_idx').on(t.applicationId),
    uniqueIndex('dot_application_signatures_current_uq')
      .on(t.applicationId, t.docKey)
      .where(sql`superseded_at IS NULL`),
  ],
);

/** The driver's uploads (CDL, medical card, TWIC, registration, other), in private storage. */
export const dotApplicationFiles = pgTable(
  'dot_application_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => dotDriverApplications.id, { onDelete: 'restrict' }),
    /** cdl_front · cdl_back · med_card · twic · registration · other · employer_* */
    slot: text('slot').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    /** driver · consent · employer */
    source: text('source').notNull().default('driver'),
    uploadedByName: text('uploaded_by_name'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedReason: text('removed_reason'),
  },
  (t) => [index('dot_application_files_app_idx').on(t.applicationId, t.slot)],
);

/** Safety asks the driver to change sections; the driver re-signs and resubmits. */
export const dotApplicationChangeRequests = pgTable(
  'dot_application_change_requests',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => dotDriverApplications.id, { onDelete: 'restrict' }),
    sections: jsonb('sections').notNull(),
    message: text('message').notNull(),
    requestedByUserId: text('requested_by_user_id').notNull(),
    requestedByName: text('requested_by_name').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('dot_application_change_requests_app_idx').on(t.applicationId)],
);

/**
 * Every email the product sends through the shared email module, with its delivery status as the
 * provider reports it (Resend webhook): sent · delivered · bounced · complained · failed · skipped.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** application_link · application_code · application_changes · statement · … */
    kind: text('kind').notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    /** resend · file · none */
    provider: text('provider').notNull(),
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** What the email is about (dot_application, settlement …) — for the record's activity. */
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    events: jsonb('events').notNull().default(sql`'[]'::jsonb`),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    complainedAt: timestamp('complained_at', { withTimezone: true }),
  },
  (t) => [
    index('email_messages_entity_idx').on(t.companyId, t.entityType, t.entityId),
    uniqueIndex('email_messages_provider_uq').on(t.providerMessageId).where(sql`provider_message_id IS NOT NULL`),
  ],
);

export type ApplicationDocumentTemplateRow = typeof applicationDocumentTemplates.$inferSelect;
export type DotDriverApplicationRow = typeof dotDriverApplications.$inferSelect;
export type DotApplicationLinkRow = typeof dotApplicationLinks.$inferSelect;
export type DotApplicationSessionRow = typeof dotApplicationSessions.$inferSelect;
export type DotApplicationSignatureRow = typeof dotApplicationSignatures.$inferSelect;
export type DotApplicationFileRow = typeof dotApplicationFiles.$inferSelect;
export type DotApplicationChangeRequestRow = typeof dotApplicationChangeRequests.$inferSelect;
export type EmailMessageRow = typeof emailMessages.$inferSelect;
