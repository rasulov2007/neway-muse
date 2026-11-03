import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Safety & compliance: the qualification file.
 *
 * Shapes follow `docs/DATABASE.md` §3.10–3.11, committed before any of this was persisted. Until
 * Phase 13 these rows were generated in the browser on every page load; they now live here, and
 * the generator that made them became the once-only seed.
 *
 * The rule the whole module is built on, repeated from the shared contract: **status is never
 * stored**. A qualification item carries dates and verification facts; the engine derives
 * missing / pending / verified / expiring / expired from those and the clock. The verification
 * case likewise stores the handful of human facts (opened, reviewed, decided) and its steps are
 * derived from the items and consents on every read. Nothing here can go stale.
 *
 * Entity ids are text with no foreign key on purpose: items belong to drivers, trucks, trailers
 * and the company, and trailers are not persisted yet. A qualification file must be able to
 * exist for a unit the fleet module has not caught up with.
 */

export const qualificationItems = pgTable(
  'qualification_items',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    requirementCode: text('requirement_code').notNull(),
    /** driver · truck · trailer · company */
    scope: text('scope').notNull(),
    entityId: text('entity_id').notNull(),
    /** Denormalized for display only; the entity record stays the source of truth. */
    entityLabel: text('entity_label').notNull(),
    documentId: text('document_id'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    verificationFailed: boolean('verification_failed').notNull().default(false),
    verificationNote: text('verification_note'),
    waivedUntil: date('waived_until'),
    waivedReason: text('waived_reason'),
    notApplicable: boolean('not_applicable').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One item per requirement per entity. An upload against an existing requirement supersedes
    // the document; it never creates a second item.
    uniqueIndex('qualification_items_entity_requirement_key').on(
      table.companyId,
      table.scope,
      table.entityId,
      table.requirementCode,
    ),
    index('qualification_items_entity_idx').on(table.companyId, table.scope, table.entityId),
    index('qualification_items_expires_idx').on(table.companyId, table.expiresOn),
  ],
);

export const complianceDocuments = pgTable(
  'compliance_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    ownerLabel: text('owner_label').notNull(),
    requirementCode: text('requirement_code').notNull(),
    title: text('title').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    /**
     * Where the bytes live, once a storage driver stores them. Null today: this deployment
     * records that a document exists and what it evidences; the file itself is not yet kept.
     */
    storageKey: text('storage_key'),
    /**
     * What was read off the document, structured.
     *
     * Kept here rather than on the driver so the extract and the photograph cannot drift apart:
     * replacing the card replaces both.
     */
    extracted: jsonb('extracted'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    /** pending_review · verified · rejected · expired */
    status: text('status').notNull().default('pending_review'),
    /** staff · driver_portal · public_link · integration · email */
    source: text('source').notNull().default('staff'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: text('uploaded_by').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    rejectionReason: text('rejection_reason'),
    version: integer('version').notNull().default(1),
    supersedesDocumentId: text('supersedes_document_id'),
    containsPii: boolean('contains_pii').notNull().default(false),
    /**
     * Which system this document was imported out of, and its key there.
     *
     * `source` above says how it arrived; this says where from. Together they let a second import
     * run recognise its own work instead of filing every file twice.
     */
    sourceSystem: text('source_system'),
    externalId: text('external_id'),
  },
  (table) => [
    index('compliance_documents_owner_idx').on(
      table.companyId,
      table.ownerType,
      table.ownerId,
      table.requirementCode,
    ),
    index('compliance_documents_status_idx').on(table.companyId, table.status),
  ],
);

export const consentRequests = pgTable(
  'consent_requests',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    driverName: text('driver_name').notNull(),
    purpose: text('purpose').notNull(),
    requirementCode: text('requirement_code').notNull(),
    /** Who it is addressed to when a purpose has several: the employer being asked. */
    subject: text('subject'),
    /** draft · sent · viewed · signed · declined · expired · cancelled */
    status: text('status').notNull().default('draft'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestedBy: text('requested_by').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    signerName: text('signer_name'),
    signerChannel: text('signer_channel'),
    signedDocumentId: text('signed_document_id'),
  },
  (table) => [
    index('consent_requests_driver_idx').on(table.companyId, table.driverId),
    index('consent_requests_status_idx').on(table.companyId, table.status),
  ],
);

/** Every consent transition, oldest first. Append-only. */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: text('id').primaryKey(),
    consentRequestId: text('consent_request_id')
      .notNull()
      .references(() => consentRequests.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    sortOrder: integer('sort_order').notNull(),
  },
  (table) => [index('consent_events_request_idx').on(table.consentRequestId, table.sortOrder)],
);

/**
 * A driver's path from applicant to active driver.
 *
 * Only the human facts are stored. The steps (CDL on file, MVR consent, …) are derived from the
 * qualification items and consents every time the case is read; see the shared
 * `deriveVerificationCase`.
 */
export const verificationCases = pgTable(
  'verification_cases',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    driverName: text('driver_name').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    ownerId: text('owner_id').notNull(),
    ownerName: text('owner_name').notNull(),
    /** not_started · in_progress · complete */
    safetyReviewStatus: text('safety_review_status').notNull().default('not_started'),
    safetyReviewAt: timestamp('safety_review_at', { withTimezone: true }),
    safetyReviewBy: text('safety_review_by'),
    /** approved · conditional · rejected */
    decision: text('decision'),
    decisionAt: timestamp('decision_at', { withTimezone: true }),
    decisionBy: text('decision_by'),
    conditions: jsonb('conditions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    decisionNote: text('decision_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One open case per driver. A re-hire opens a new case after the old one is decided.
    uniqueIndex('verification_cases_open_driver_key')
      .on(table.companyId, table.driverId)
      .where(sql`${table.decision} is null`),
    index('verification_cases_driver_idx').on(table.companyId, table.driverId),
  ],
);

export type QualificationItemRow = typeof qualificationItems.$inferSelect;
export type ComplianceDocumentRow = typeof complianceDocuments.$inferSelect;
export type ConsentRequestRow = typeof consentRequests.$inferSelect;
export type ConsentEventRow = typeof consentEvents.$inferSelect;
export type VerificationCaseRow = typeof verificationCases.$inferSelect;
