import { z } from 'zod';

/**
 * Driver Relations (owner brief, 2026-10-06).
 *
 * Every request a driver sends from the public NORTHWIND FREIGHT Driver Care page arrives here, in one
 * canonical record per conversation. The rules the contract holds:
 *
 *   - The company comes from the Driver Care link's slug on the server, never from the browser.
 *   - The red alert is server state (`needsContact`), not an unread flag. Only a recorded contact
 *     with a non-empty note clears it, and only for that request. Viewing, assigning, recording an
 *     attempt or a Telegram notification never does.
 *   - Status is New → Contacted → Resolved. Contacted means somebody spoke with the driver, not
 *     that the issue is solved. A request cannot be resolved while it still needs contact.
 *   - A new message from the driver puts the alert back until somebody contacts them again.
 *   - Activity is append-only: a correction is a new entry pointing at the old one.
 *   - Driver Relations never moves money. A reimbursement or a pay question is handed to the
 *     existing Accounting workflow by a person; nothing here writes a ledger.
 */

// ------------------------------------------------------------------------------------ topics

/** Card order on the Driver Care page and in the TMS, left to right then top to bottom. */
export const DRIVER_RELATION_TOPICS = [
  'referral',
  'complaint_feedback',
  'reimbursement',
  'pay_statement',
  'compliance',
  'management_call',
] as const;
export type DriverRelationTopic = (typeof DRIVER_RELATION_TOPICS)[number];

export const DRIVER_RELATION_TOPIC_LABELS: Readonly<Record<DriverRelationTopic, string>> = {
  referral: 'Driver Referral',
  complaint_feedback: 'Complaint & Feedback',
  reimbursement: 'Reimbursement',
  pay_statement: 'Pay & Statement Help',
  compliance: 'Compliance',
  management_call: 'Management Call Request',
};

/** The line under each topic card in the TMS. */
export const DRIVER_RELATION_TOPIC_HINTS: Readonly<Record<DriverRelationTopic, string>> = {
  referral: 'Driver referrals and sign-on questions',
  complaint_feedback: 'Concerns, feedback and service issues',
  reimbursement: 'Fuel, tolls, scale, lumper and other reimbursements',
  pay_statement: 'Pay questions, statements and adjustments',
  compliance: 'DOT, documentation and compliance support',
  management_call: 'Requests to speak with management',
};

/** The referral bonus the Driver Care page states. Text only: no eligibility or payout rule. */
export const DRIVER_REFERRAL_BONUS_TEXT = '$900';

export const DRIVER_RELATION_STATUSES = ['new', 'contacted', 'resolved'] as const;
export type DriverRelationStatus = (typeof DRIVER_RELATION_STATUSES)[number];

export const CONTACT_METHODS = ['phone', 'sms', 'telegram', 'email', 'in_person', 'other'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export const CONTACT_METHOD_LABELS: Readonly<Record<ContactMethod, string>> = {
  phone: 'Phone',
  sms: 'SMS',
  telegram: 'Telegram',
  email: 'Email',
  in_person: 'In person',
  other: 'Other',
};

export const ACTIVITY_TYPES = [
  'received',
  'driver_message',
  'assigned',
  'attempt',
  'contacted',
  'note',
  'correction',
  'resolved',
  'reopened',
  'linked',
] as const;
export type DriverRelationActivityType = (typeof ACTIVITY_TYPES)[number];

// ---------------------------------------------------------------------- the public page's form

/*
 * The fields follow the owner's approved Driver Care design (Northwind Freight-Driver-Care.html,
 * 2026-10-06), mapped to these names by the page.
 */

/** Management Call Request's topic dropdown, as the design words it. */
export const MANAGEMENT_CALL_TOPICS = ['general_support', 'dispatch_work', 'pay_settlement', 'confidential', 'other'] as const;
export const MANAGEMENT_CALL_TOPIC_LABELS: Readonly<Record<(typeof MANAGEMENT_CALL_TOPICS)[number], string>> = {
  general_support: 'General support',
  dispatch_work: 'Dispatch or work concern',
  pay_settlement: 'Pay or settlement concern',
  confidential: 'Confidential concern',
  other: 'Other',
};

/** Compliance's "What do you need help with?", as the design words it. */
export const COMPLIANCE_SUBJECTS = ['cdl', 'medical_card', 'other'] as const;
export const COMPLIANCE_SUBJECT_LABELS: Readonly<Record<(typeof COMPLIANCE_SUBJECTS)[number], string>> = {
  cdl: 'CDL',
  medical_card: 'Medical card',
  other: 'Other document or safety question',
};

/**
 * Receipts on a reimbursement: photos or PDFs, checked by their bytes on the server (never by the
 * name or the type the browser claims), stored privately and readable only by staff.
 */
export const DRIVER_CARE_MAX_FILES = 3;
export const DRIVER_CARE_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Total per submission, so the whole request stays inside the API's body limit. */
export const DRIVER_CARE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const DRIVER_CARE_FILE_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'] as const;
export type DriverCareFileType = (typeof DRIVER_CARE_FILE_TYPES)[number];

const text = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `Keep ${label.toLowerCase()} under ${max} characters.`);

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((v) => (v ? v : null));

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-06.')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

const name = text('Your name', 100).refine((v) => v.length >= 2, 'Enter your full name.');
const truck = text('Truck number', 30);
const phone = z
  .string({ error: 'Phone number is required.' })
  .trim()
  .min(1, 'Phone number is required.')
  .max(25, 'That number is too long.');
const details = text('Details', 3000);

const common = {
  /** Minted once per filled-in form, in memory; every retry of that form reuses it. */
  submissionId: z.uuid('Missing submission id'),
  /** The honeypot: hidden from people, filled by bots. */
  website: z.string().max(200).optional().default(''),
};

/** One receipt as the page sends it: the name and a `data:` URL (or bare base64) of the bytes. */
export const DriverCareFileSchema = z.object({
  fileName: z.string().trim().min(1, 'A file needs a name.').max(200),
  // 10 MB of bytes is under 14 MB of base64; the server measures the decoded bytes.
  content: z.string().min(1, 'The file is empty.').max(14_500_000, 'Each file can be up to 10 MB.'),
});

export const DriverCareSubmissionSchema = z.discriminatedUnion('topic', [
  z.object({
    ...common,
    topic: z.literal('referral'),
    name,
    truckNumber: truck,
    referralName: text('Referral driver name', 100).refine((v) => v.length >= 2, 'Enter the driver’s full name.'),
    referralPhone: phone,
  }),
  z.object({ ...common, topic: z.literal('complaint_feedback'), name, truckNumber: truck, phone, details }),
  z.object({
    ...common,
    topic: z.literal('reimbursement'),
    name,
    truckNumber: truck,
    phone,
    amount: z
      .number({ error: 'Enter the amount you paid.' })
      .positive('Enter the amount you paid.')
      .max(100_000, 'That amount is too large.'),
    loadNumber: optional(50),
    details,
    attachments: z
      .array(DriverCareFileSchema)
      .max(DRIVER_CARE_MAX_FILES, `Attach up to ${DRIVER_CARE_MAX_FILES} files.`)
      .optional()
      .default([]),
  }),
  z.object({
    ...common,
    topic: z.literal('pay_statement'),
    name,
    truckNumber: truck,
    phone,
    details,
    weekStart: isoDate,
    loadNumber: optional(50),
  }),
  z.object({
    ...common,
    topic: z.literal('compliance'),
    name,
    truckNumber: truck,
    phone,
    subject: z.enum(COMPLIANCE_SUBJECTS, { error: 'Choose what you need help with.' }),
    details,
  }),
  z.object({
    ...common,
    topic: z.literal('management_call'),
    name,
    truckNumber: truck,
    phone,
    callTopic: z.enum(MANAGEMENT_CALL_TOPICS, { error: 'Choose a topic.' }),
    // Free text with the driver's own time zone, as the design asks. A request, never a booking.
    preferredTime: optional(150),
    details,
  }),
]);
export type DriverCareSubmissionInput = z.input<typeof DriverCareSubmissionSchema>;
export type DriverCareSubmission = z.output<typeof DriverCareSubmissionSchema>;

/**
 * Who may read a request: Complaint & Feedback, and a management call about a "Confidential
 * concern", are confidential (owner, 2026-10-06) and are shown only to holders of
 * `driver_relations.confidential` (the Driver Relations role and administrators).
 */
export function isConfidentialSubmission(body: { topic: string; callTopic?: string | null }): boolean {
  return body.topic === 'complaint_feedback' || (body.topic === 'management_call' && body.callTopic === 'confidential');
}

/** Upper bound on a submission's text fields (everything but the receipts), checked before parsing. */
export const DRIVER_CARE_MAX_BODY_BYTES = 16_384;

/** What the public endpoint says back: it was saved, and the reference the driver can quote. */
export const DriverCareReceiptSchema = z.object({
  status: z.literal('received'),
  reference: z.string().nullable(),
});
export type DriverCareReceipt = z.infer<typeof DriverCareReceiptSchema>;

export const DriverCareConfigSchema = z.object({
  companyName: z.string(),
  displayName: z.string(),
});
export type DriverCareConfig = z.infer<typeof DriverCareConfigSchema>;

/**
 * The topic-specific answers stored with a request: the fields the form asked beyond name, truck,
 * phone and details. Nothing here is a bank detail, a medical record or a credential.
 */
export type DriverRelationPayload = Record<string, string | number | null>;

// ---------------------------------------------------------------------------- the TMS side

export const DRIVER_CARE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

export const CareLinkSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  requestCount: z.number().int(),
});
export type CareLink = z.infer<typeof CareLinkSchema>;

export const CreateCareLinkSchema = z.object({
  name: z.string().trim().min(1, 'Give the link a name').max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DRIVER_CARE_SLUG_PATTERN, '3–48 characters: lowercase letters, digits and dashes'),
});
export type CreateCareLinkInput = z.input<typeof CreateCareLinkSchema>;

export const UpdateCareLinkSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
});

export interface DriverRelationRequest {
  id: string;
  requestNumber: string;
  topic: DriverRelationTopic;
  topicLabel: string;
  /** driver_app: sent by the signed-in driver from the driver app (mobile M3); the driver is server-resolved. */
  source: 'driver_care' | 'staff' | 'driver_app';
  /** The team that answers it: driver_relations · accounting · safety (mobile M3 routing). */
  assignedTeam?: string;
  status: DriverRelationStatus;
  needsContact: boolean;
  /** Complaint & Feedback or a confidential call request: Driver Relations staff and administrators only. */
  confidential: boolean;
  attachmentCount: number;
  submittedName: string;
  truckNumber: string | null;
  contactPhone: string | null;
  description: string;
  payload: DriverRelationPayload;
  /** Verified links: set by staff after checking, never from the name the driver typed. */
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckUnit: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  receivedAt: string;
  lastDriverMessageAt: string;
  contactedAt: string | null;
  contactedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  hrLeadId: string | null;
  hrLeadNumber: string | null;
  accountingExpenseId: string | null;
  version: number;
  updatedAt: string;
}

export interface DriverRelationActivity {
  id: string;
  type: DriverRelationActivityType;
  actorType: 'driver' | 'staff' | 'system';
  actorName: string;
  method: ContactMethod | null;
  note: string | null;
  correctsActivityId: string | null;
  detail: Record<string, unknown> | null;
  at: string;
}

export interface DriverRelationDelivery {
  id: string;
  adapter: 'telegram';
  eventType: string;
  /** pending · sent · failed · skipped */
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface DriverRelationAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  /** Authenticated, permission-checked route; never a public address. */
  url: string;
}

export interface DriverRelationDetail {
  request: DriverRelationRequest;
  activities: DriverRelationActivity[];
  deliveries: DriverRelationDelivery[];
  attachments: DriverRelationAttachment[];
}

export interface DriverRelationCounts {
  /** Requests needing contact, all topics: the sidebar badge. */
  needsContact: number;
  byTopic: Record<DriverRelationTopic, { needsContact: number; total: number }>;
  byStatus: { awaitingContact: number; contacted: number; resolved: number; all: number };
  /** True when this viewer cannot see confidential requests; they are left out of every number. */
  confidentialHidden: boolean;
}

export const DRIVER_RELATION_LIST_STATUSES = ['all', 'needs_contact', 'contacted', 'resolved'] as const;

export const DriverRelationListQuerySchema = z.object({
  topic: z.enum(DRIVER_RELATION_TOPICS).optional(),
  status: z.enum(DRIVER_RELATION_LIST_STATUSES).optional().default('all'),
  q: z.string().trim().max(100).optional(),
  assignee: z.string().trim().max(80).optional(),
  sort: z.enum(['received_desc', 'received_asc']).optional().default('received_desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});
export type DriverRelationListQuery = z.input<typeof DriverRelationListQuerySchema>;

export interface DriverRelationPage {
  data: DriverRelationRequest[];
  total: number;
  page: number;
  pageSize: number;
}

const note = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .max(4000, `Keep the ${label.toLowerCase()} under 4000 characters.`)
    .refine((v) => v.trim().length > 0, `${label} is required.`)
    .transform((v) => v.trim());

const version = z.number({ error: 'expectedVersion is required' }).int().min(1);

export const AssignRequestSchema = z.object({
  assigneeUserId: z.string().trim().min(1).max(80).nullable(),
  expectedVersion: version,
});
export const RecordAttemptSchema = z.object({
  method: z.enum(CONTACT_METHODS),
  note: note('Note'),
});
export const RecordContactSchema = z.object({
  method: z.enum(CONTACT_METHODS),
  note: note('Contact note'),
  expectedVersion: version,
});
export const AddNoteSchema = z.object({
  note: note('Note'),
  /** A correction is a new entry pointing at the one it corrects; the old one is kept. */
  correctsActivityId: z.string().trim().min(1).max(80).optional(),
  /**
   * A reply the driver reads in the driver app (mobile M3). Off by default: a note is internal
   * unless the person writing it says it is for the driver.
   */
  shareWithDriver: z.boolean().optional(),
});
export const ResolveRequestSchema = z.object({
  note: note('Resolution note'),
  expectedVersion: version,
});
export const ReopenRequestSchema = z.object({
  note: note('Reason'),
  expectedVersion: version,
});
export const DriverMessageSchema = z.object({
  message: note('Message'),
  method: z.enum(CONTACT_METHODS),
  expectedVersion: version,
});
export const LinkRecordsSchema = z
  .object({
    driverId: z.string().trim().min(1).max(80).nullable().optional(),
    truckId: z.string().trim().min(1).max(80).nullable().optional(),
    accountingExpenseId: z.string().trim().min(1).max(80).nullable().optional(),
    expectedVersion: version,
  })
  .refine(
    (v) => v.driverId !== undefined || v.truckId !== undefined || v.accountingExpenseId !== undefined,
    'Name at least one record to link.',
  );

export interface DriverRelationAssignee {
  userId: string;
  name: string;
}

export interface DriverRelationRosterOption {
  kind: 'driver' | 'truck';
  id: string;
  label: string;
  detail: string | null;
}

export interface DriverRelationIntegrationStatus {
  telegram: {
    enabled: boolean;
    configured: boolean;
    /** What the screen says: "Not connected" until the owner configures and enables it. */
    label: string;
  };
}
