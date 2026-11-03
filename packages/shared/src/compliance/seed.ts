import { SYSTEM_REQUIREMENTS } from './catalog.js';
import type { QualificationItem } from './item.js';
import {
  CONSENT_PURPOSE_BY_REQUIREMENT,
  CONSENT_TTL_DAYS,
  PII_REQUIREMENTS,
  type ComplianceAuditEntry,
  type ComplianceDocument,
  type ComplianceOwnerType,
  type ConsentEvent,
  type ConsentRequest,
  type ConsentStatus,
  type DocumentSource,
  type EntityRef,
  type VerificationCase,
  type VerificationCaseRecord,
  type VerificationDecision,
} from './records.js';
import type { QualificationRequirement } from './requirement.js';
import type { Rng } from './rng.js';
import { deriveVerificationCase } from './verification.js';

/**
 * The compliance seed: a full qualification file for a fleet, deterministically.
 *
 * Everything here is derived from real driver, truck and trailer records (`cdlExpiresOn`,
 * `inServiceDate`, `nextInspectionDate`, `hireDate`…) plus a seeded `Rng`, so the same seed always
 * yields the same items, documents, consents, verification cases and audit trail. Nothing is
 * stored that the engine derives: items carry dates and verification facts only.
 *
 * This ran in the browser for a year as the demo layer. It moved here — unchanged in what it
 * produces — when compliance storage moved to PostgreSQL, so the API seed and the web test fixture
 * are one generator rather than two that agree today.
 *
 * Inputs are structural: the four record shapes below name only the fields the generator reads,
 * so the API can pass its seed rows and the web can pass its fixture without an adapter.
 */

export interface SeedDriver {
  id: string;
  driverNumber: string;
  firstName: string;
  name: string;
  hireDate: string;
  cdlStatus: string;
  cdlExpiresOn: string;
  medicalCardStatus: string;
  /** Null when the driver has no certificate on file; then no medical-card item is seeded. */
  medicalCardExpiresOn: string | null;
}

export interface SeedTruck {
  id: string;
  unitNumber: string;
  status: string;
  inServiceDate: string;
}

export interface SeedTrailer {
  id: string;
  unitNumber: string;
  status: string;
  nextInspectionDate: string;
}

export interface SeedPerson {
  id: string;
  name: string;
  department: string;
}

export interface ComplianceSeedInput {
  drivers: SeedDriver[];
  trucks: SeedTruck[];
  trailers: SeedTrailer[];
  people: SeedPerson[];
  now: Date;
}

export interface ComplianceSeedOutput {
  requirements: QualificationRequirement[];
  items: QualificationItem[];
  documents: ComplianceDocument[];
  consents: ConsentRequest[];
  /** What is stored. */
  caseRecords: VerificationCaseRecord[];
  /** The same cases as every screen reads them, derived once here for tests and fixtures. */
  verificationCases: VerificationCase[];
  audit: ComplianceAuditEntry[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CHICAGO_OFFSET = 5 * HOUR; // CDT

/** A driver hired within this many days has an open (or freshly closed) verification case. */
export const RECENT_HIRE_DAYS = 60;

/** Fleet-wide policy documents share one expiry across every power unit. */
export const FLEET_POLICY_DATES: Readonly<Record<'insurance' | 'irp' | 'ifta', string>> = {
  insurance: '2027-02-01',
  irp: '2027-03-31',
  ifta: '2026-12-31',
};

export const WAIVER_REASON = 'Renewal receipt on file; new card in the mail';
export const CLEARINGHOUSE_FAILURE_NOTE =
  'Query returned a pending violation; awaiting driver follow-up';

// ---------------------------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`compliance seed: missing ${what}`);
  return value;
}

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoDate(ms: number): string {
  return new Date(ms - CHICAGO_OFFSET).toISOString().slice(0, 10);
}

function parseDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(must(y), must(m) - 1, must(d));
}

function addDays(date: string, days: number): string {
  return new Date(parseDate(date) + days * DAY).toISOString().slice(0, 10);
}

/** Shifts by whole months; an explicit `day` is clamped to 28 so it exists in every month. */
function addMonths(date: string, months: number, day?: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dayOfMonth = day === undefined ? must(d) : Math.min(28, day);
  return new Date(Date.UTC(must(y), must(m) - 1 + months, dayOfMonth)).toISOString().slice(0, 10);
}

function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to`; negative once `to` is in the past. */
function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY);
}

/** A timestamp at `hour:minute` company-local time on `date`. */
function at(date: string, hour: number, minute = 0): number {
  return parseDate(date) + hour * HOUR + minute * MINUTE + CHICAGO_OFFSET;
}

/** The next calendar anniversary of `date` on or after `today`. */
function nextAnniversary(date: string, today: string): string {
  const monthDay = date.slice(5);
  const thisYear = `${today.slice(0, 4)}-${monthDay}`;
  return thisYear >= today ? thisYear : `${Number(today.slice(0, 4)) + 1}-${monthDay}`;
}

function ref(type: EntityRef['type'], id: string, label: string): EntityRef {
  return { type, id, label };
}

// ---------------------------------------------------------------------------------------------
// Generation context
// ---------------------------------------------------------------------------------------------

interface Owner {
  type: ComplianceOwnerType;
  id: string;
  label: string;
  /** Short tag used in file names: `D-2031`, `2785`, `T-5301`. */
  tag: string;
}

interface Ctx {
  rng: Rng;
  now: number;
  today: string;
  safety: SeedPerson;
  recruiter: SeedPerson;
  management: SeedPerson;
  byCode: Map<string, QualificationRequirement>;
  items: QualificationItem[];
  documents: ComplianceDocument[];
  consents: ConsentRequest[];
  audit: ComplianceAuditEntry[];
}

type Outcome = 'verified' | 'pending' | 'failed';

interface RecordSpec {
  req: QualificationRequirement;
  owner: Owner;
  issuedOn: string | null;
  expiresOn: string | null;
  outcome: Outcome;
  uploadedAt: number;
  /** Review time for `verified` / `failed`; ignored for `pending`. */
  reviewedAt?: number;
  source: DocumentSource;
  note?: string;
}

/** Nothing in the seed happened in the future, or in the last half hour. */
function clampPast(ctx: Ctx, ms: number): number {
  return Math.min(ms, ctx.now - 30 * MINUTE);
}

function workHour(ctx: Ctx): number {
  return ctx.rng.int(8, 17);
}

function audit(ctx: Ctx, entry: Omit<ComplianceAuditEntry, 'id'>): ComplianceAuditEntry {
  const row: ComplianceAuditEntry = { ...entry, id: `aud_${pad(ctx.audit.length + 1)}` };
  ctx.audit.push(row);
  return row;
}

function entityRef(owner: Owner): EntityRef {
  return ref(owner.type, owner.id, owner.label);
}

/** One item with its evidencing document, plus the audit row the document's review produced. */
function record(ctx: Ctx, spec: RecordSpec): QualificationItem {
  const { req, owner } = spec;
  const uploadedAt = clampPast(ctx, spec.uploadedAt);
  const reviewedAt =
    spec.outcome === 'pending' ? null : clampPast(ctx, spec.reviewedAt ?? uploadedAt + 4 * HOUR);
  const expired = spec.expiresOn !== null && spec.expiresOn < ctx.today;
  const status: ComplianceDocument['status'] =
    spec.outcome === 'failed'
      ? 'rejected'
      : spec.outcome === 'pending'
        ? 'pending_review'
        : expired
          ? 'expired'
          : 'verified';
  const portal = spec.source === 'driver_portal';
  const document: ComplianceDocument = {
    id: `doc_${pad(ctx.documents.length + 1)}`,
    ownerType: owner.type,
    ownerId: owner.id,
    ownerLabel: owner.label,
    // Seeded paperwork predates the reader; nothing was extracted from it.
    extracted: null,
    requirementCode: req.code,
    title: req.name,
    fileName: `${req.code.replace(/_/g, '-')}-${owner.tag}.${portal && ctx.rng.chance(0.35) ? 'jpg' : 'pdf'}`,
    contentType: 'application/pdf',
    sizeBytes: ctx.rng.int(60_000, 900_000),
    issuedOn: spec.issuedOn,
    expiresOn: spec.expiresOn,
    status,
    source: spec.source,
    uploadedAt: iso(uploadedAt),
    uploadedBy: portal ? 'Driver portal' : ctx.safety.name,
    verifiedAt: spec.outcome === 'verified' && reviewedAt !== null ? iso(reviewedAt) : null,
    verifiedBy: spec.outcome === 'verified' ? ctx.safety.name : null,
    rejectionReason: spec.outcome === 'failed' ? (spec.note ?? null) : null,
    version: 1,
    supersedesDocumentId: null,
    containsPii: PII_REQUIREMENTS.has(req.code),
    hasFile: false,
  };
  if (document.fileName.endsWith('.jpg')) document.contentType = 'image/jpeg';
  ctx.documents.push(document);

  const item: QualificationItem = {
    id: `qi_${pad(ctx.items.length + 1)}`,
    requirementCode: req.code,
    scope: req.scope,
    entityId: owner.id,
    entityLabel: owner.label,
    documentId: document.id,
    issuedOn: spec.issuedOn,
    expiresOn: spec.expiresOn,
    verifiedAt: document.verifiedAt,
    verifiedBy: document.verifiedBy,
    verificationFailed: spec.outcome === 'failed',
    verificationNote: spec.outcome === 'failed' ? (spec.note ?? null) : null,
    waivedUntil: null,
    waivedReason: null,
    notApplicable: false,
    notes: null,
  };
  ctx.items.push(item);

  if (spec.outcome === 'verified' && reviewedAt !== null) {
    audit(ctx, {
      at: iso(reviewedAt),
      actorId: ctx.safety.id,
      actorName: ctx.safety.name,
      action: 'document_verified',
      entity: entityRef(owner),
      subject: req.code,
      before: 'pending_review',
      after: 'verified',
      reason: null,
      source: 'user',
    });
  } else if (spec.outcome === 'failed' && reviewedAt !== null) {
    audit(ctx, {
      at: iso(reviewedAt),
      actorId: ctx.safety.id,
      actorName: ctx.safety.name,
      action: 'document_rejected',
      entity: entityRef(owner),
      subject: req.code,
      before: 'pending_review',
      after: 'rejected',
      reason: spec.note ?? null,
      source: 'user',
    });
  } else {
    audit(ctx, {
      at: iso(uploadedAt),
      actorId: portal ? owner.id : ctx.safety.id,
      actorName: portal ? owner.label : ctx.safety.name,
      action: 'document_uploaded',
      entity: entityRef(owner),
      subject: req.code,
      before: null,
      after: 'pending_review',
      reason: null,
      source: 'user',
    });
  }
  return item;
}

function recordNotApplicable(
  ctx: Ctx,
  req: QualificationRequirement,
  owner: Owner,
  notes: string,
): QualificationItem {
  const item: QualificationItem = {
    id: `qi_${pad(ctx.items.length + 1)}`,
    requirementCode: req.code,
    scope: req.scope,
    entityId: owner.id,
    entityLabel: owner.label,
    documentId: null,
    issuedOn: null,
    expiresOn: null,
    verifiedAt: null,
    verifiedBy: null,
    verificationFailed: false,
    verificationNote: null,
    waivedUntil: null,
    waivedReason: null,
    notApplicable: true,
    notes,
  };
  ctx.items.push(item);
  return item;
}

// ---------------------------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------------------------

interface ConsentSpec {
  driver: SeedDriver;
  req: QualificationRequirement;
  status: ConsentStatus;
  /** When the request was drafted. */
  requestedAt: number;
  requestedBy: SeedPerson;
}

function makeConsent(ctx: Ctx, spec: ConsentSpec): ConsentRequest {
  const { driver, req, status, requestedBy } = spec;
  const rng = ctx.rng;
  const purpose = must(CONSENT_PURPOSE_BY_REQUIREMENT[req.code], `consent purpose ${req.code}`);
  const requestedAt = clampPast(ctx, spec.requestedAt);
  const expiresAt = requestedAt + CONSENT_TTL_DAYS * DAY;
  const entity = ref('driver', driver.id, driver.name);
  const history: ConsentEvent[] = [
    { at: iso(requestedAt), status: 'draft', actor: requestedBy.name, note: null },
  ];
  let sentAt: number | null = null;
  let viewedAt: number | null = null;
  let signedAt: number | null = null;
  let declinedAt: number | null = null;
  let signerChannel: ConsentRequest['signerChannel'] = null;

  if (status !== 'draft') {
    sentAt = clampPast(ctx, requestedAt + rng.int(3, 90) * MINUTE);
    history.push({ at: iso(sentAt), status: 'sent', actor: requestedBy.name, note: null });
    audit(ctx, {
      at: iso(sentAt),
      actorId: requestedBy.id,
      actorName: requestedBy.name,
      action: 'consent_sent',
      entity,
      subject: req.code,
      before: 'draft',
      after: 'sent',
      reason: null,
      source: 'user',
    });
  }
  const inPerson = status === 'signed' && rng.chance(0.25);
  const viewed =
    sentAt !== null &&
    (status === 'viewed' || status === 'declined' || (status === 'signed' && !inPerson));
  if (viewed && sentAt !== null) {
    viewedAt = clampPast(ctx, sentAt + rng.int(1, 48) * HOUR);
    history.push({ at: iso(viewedAt), status: 'viewed', actor: driver.name, note: null });
  }
  if (status === 'signed' && sentAt !== null) {
    signedAt = clampPast(ctx, (viewedAt ?? sentAt) + rng.int(5, 120) * MINUTE);
    signerChannel = inPerson ? 'in_person' : 'driver_portal';
    history.push({
      at: iso(signedAt),
      status: 'signed',
      actor: driver.name,
      note: inPerson ? 'Signed on paper at the terminal; scanned by safety' : null,
    });
    audit(ctx, {
      at: iso(signedAt),
      actorId: driver.id,
      actorName: driver.name,
      action: 'consent_signed',
      entity,
      subject: req.code,
      before: viewedAt !== null ? 'viewed' : 'sent',
      after: 'signed',
      reason: null,
      source: 'user',
    });
  }
  if (status === 'declined' && viewedAt !== null) {
    declinedAt = clampPast(ctx, viewedAt + rng.int(5, 60) * MINUTE);
    const note = 'Driver declined: wants to supply the record himself rather than authorize a pull';
    history.push({ at: iso(declinedAt), status: 'declined', actor: driver.name, note });
    audit(ctx, {
      at: iso(declinedAt),
      actorId: driver.id,
      actorName: driver.name,
      action: 'consent_declined',
      entity,
      subject: req.code,
      before: 'viewed',
      after: 'declined',
      reason: note,
      source: 'user',
    });
  }
  if (status === 'expired') {
    history.push({
      at: iso(expiresAt),
      status: 'expired',
      actor: 'System',
      note: `Link lapsed unsigned after ${CONSENT_TTL_DAYS} days`,
    });
  }

  const consent: ConsentRequest = {
    id: `cns_${pad(ctx.consents.length + 1)}`,
    driverId: driver.id,
    driverName: driver.name,
    purpose,
    requirementCode: req.code,
    subject: null,
    status,
    requestedAt: iso(requestedAt),
    requestedBy: requestedBy.name,
    sentAt: sentAt === null ? null : iso(sentAt),
    viewedAt: viewedAt === null ? null : iso(viewedAt),
    signedAt: signedAt === null ? null : iso(signedAt),
    declinedAt: declinedAt === null ? null : iso(declinedAt),
    expiresAt: iso(expiresAt),
    signerName: signedAt === null ? null : driver.name,
    signerChannel,
    signedDocumentId: null,
    history,
  };
  ctx.consents.push(consent);
  return consent;
}

/**
 * The signed application every driver's file opens with: dated at the case opening for a recent
 * hire, at the hire date for a veteran, and reviewed within the day.
 */
function buildApplication(ctx: Ctx, driver: SeedDriver, recent: RecentHire | undefined): void {
  const owner: Owner = {
    type: 'driver',
    id: driver.id,
    label: driver.name,
    tag: driver.driverNumber,
  };
  const receivedAt = recent?.openedAt ?? parseDate(driver.hireDate) + 9 * HOUR;
  record(ctx, {
    req: must(ctx.byCode.get('dot_application'), 'requirement dot_application'),
    owner,
    issuedOn: isoDate(receivedAt),
    expiresOn: null,
    outcome: 'verified',
    uploadedAt: receivedAt,
    reviewedAt: receivedAt + ctx.rng.int(1, 8) * HOUR,
    source: 'staff',
  });
}

// ---------------------------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------------------------

type AnnualRole = 'current' | 'expiring' | 'in_grace' | 'past_grace';

interface VeteranRoles {
  mvr: AnnualRole;
  clearinghouse: AnnualRole;
  clearinghouseFailed: boolean;
}

type ScreeningState = 'verified' | 'pending' | 'missing';

/**
 * How far along a recent hire is. Assigned to the drivers hired within `RECENT_HIRE_DAYS`, most
 * recent first, so the pipeline view has one case at every interesting stage.
 */
interface RecentPlan {
  kind: 'consent' | 'screening' | 'safety_review' | 'conditional' | 'approved';
  consents: Record<string, ConsentStatus>;
  screening: Record<string, ScreeningState>;
  safetyReview: 'not_started' | 'in_progress' | 'complete';
  decision: {
    decision: VerificationDecision;
    conditions: string[];
    note: string | null;
  } | null;
}

const ALL_SIGNED: Record<string, ConsentStatus> = {
  mvr_review: 'signed',
  psp_review: 'signed',
  background_check: 'signed',
  clearinghouse_query: 'signed',
  employment_verification: 'signed',
};

const ALL_VERIFIED: Record<string, ScreeningState> = {
  mvr_review: 'verified',
  psp_review: 'verified',
  background_check: 'verified',
  clearinghouse_query: 'verified',
  pre_employment_drug_test: 'verified',
  employment_verification: 'verified',
};

const RECENT_PLANS: readonly RecentPlan[] = [
  {
    // Stuck at consent: one declined, one still only viewed.
    kind: 'consent',
    consents: {
      mvr_review: 'declined',
      psp_review: 'signed',
      background_check: 'signed',
      clearinghouse_query: 'viewed',
      employment_verification: 'signed',
    },
    screening: {
      mvr_review: 'missing',
      psp_review: 'pending',
      background_check: 'missing',
      clearinghouse_query: 'missing',
      pre_employment_drug_test: 'pending',
      employment_verification: 'missing',
    },
    safetyReview: 'not_started',
    decision: null,
  },
  {
    // Stuck at consent: a link lapsed, one never left draft.
    kind: 'consent',
    consents: {
      mvr_review: 'signed',
      psp_review: 'expired',
      background_check: 'sent',
      clearinghouse_query: 'draft',
      employment_verification: 'sent',
    },
    screening: {
      mvr_review: 'pending',
      psp_review: 'missing',
      background_check: 'missing',
      clearinghouse_query: 'missing',
      pre_employment_drug_test: 'verified',
      employment_verification: 'missing',
    },
    safetyReview: 'not_started',
    decision: null,
  },
  {
    // Consents done; reports trickling in.
    kind: 'screening',
    consents: ALL_SIGNED,
    screening: {
      mvr_review: 'verified',
      psp_review: 'pending',
      background_check: 'missing',
      clearinghouse_query: 'verified',
      pre_employment_drug_test: 'verified',
      employment_verification: 'pending',
    },
    safetyReview: 'not_started',
    decision: null,
  },
  {
    // Everything on file and verified; waiting on the safety manager.
    kind: 'safety_review',
    consents: ALL_SIGNED,
    screening: ALL_VERIFIED,
    safetyReview: 'in_progress',
    decision: null,
  },
  {
    kind: 'conditional',
    consents: ALL_SIGNED,
    screening: ALL_VERIFIED,
    safetyReview: 'complete',
    decision: {
      decision: 'conditional',
      conditions: [
        'Ride-along with a trainer for the first 30 days',
        'Re-pull MVR at 90 days: two speeding convictions in the last 24 months',
      ],
      note: 'Clean PSP and background; MVR history is the only concern.',
    },
  },
  {
    kind: 'approved',
    consents: ALL_SIGNED,
    screening: ALL_VERIFIED,
    safetyReview: 'complete',
    decision: {
      decision: 'approved',
      conditions: [],
      note: null,
    },
  },
];

interface RecentHire {
  driver: SeedDriver;
  plan: RecentPlan;
  /** When the application was received (the case's `openedAt`). */
  openedAt: number;
  daysSinceHire: number;
}

function planRecentHires(ctx: Ctx, drivers: SeedDriver[]): Map<string, RecentHire> {
  const recent = drivers
    .map((driver) => ({ driver, daysSinceHire: -daysBetween(ctx.today, driver.hireDate) }))
    .filter((r) => r.daysSinceHire <= RECENT_HIRE_DAYS)
    .sort((a, b) => a.daysSinceHire - b.daysSinceHire || a.driver.id.localeCompare(b.driver.id));
  const out = new Map<string, RecentHire>();
  recent.forEach((entry, index) => {
    const plan = must(RECENT_PLANS[index % RECENT_PLANS.length]);
    // Decided cases opened well before the hire date; open ones a few days before it.
    const lead = plan.decision ? ctx.rng.int(12, 16) : ctx.rng.int(2, 5);
    out.set(entry.driver.id, {
      driver: entry.driver,
      plan,
      openedAt: at(entry.driver.hireDate, 9, ctx.rng.int(0, 45)) - lead * DAY,
      daysSinceHire: entry.daysSinceHire,
    });
  });
  return out;
}

function assignVeteranRoles(ctx: Ctx, veterans: SeedDriver[]): Map<string, VeteranRoles> {
  const roles = new Map<string, VeteranRoles>(
    veterans.map((d) => [
      d.id,
      { mvr: 'current', clearinghouse: 'current', clearinghouseFailed: false },
    ]),
  );
  const expiringCount = Math.max(1, Math.round(veterans.length * 0.15));
  const setRole = (ids: string[], key: 'mvr' | 'clearinghouse') => {
    ids.forEach((id, index) => {
      const role = must(roles.get(id));
      role[key] =
        index === 0
          ? 'past_grace'
          : index <= 2
            ? 'in_grace'
            : index <= 2 + expiringCount
              ? 'expiring'
              : 'current';
    });
  };
  setRole(ctx.rng.shuffle(veterans.map((d) => d.id)), 'mvr');
  const clearinghouseOrder = ctx.rng.shuffle(veterans.map((d) => d.id));
  const failedId = must(clearinghouseOrder[0]);
  setRole(clearinghouseOrder.slice(1), 'clearinghouse');
  must(roles.get(failedId)).clearinghouseFailed = true;
  return roles;
}

/** Issue date for an annual review in the given role, relative to today. */
function annualIssuedOn(ctx: Ctx, role: AnnualRole): string {
  const rng = ctx.rng;
  const daysAgo =
    role === 'past_grace'
      ? rng.int(385, 425)
      : role === 'in_grace'
        ? rng.int(366, 378)
        : role === 'expiring'
          ? rng.int(305, 362)
          : rng.int(3, 300);
  return addDays(ctx.today, -daysAgo);
}

function buildDriver(
  ctx: Ctx,
  driver: SeedDriver,
  recent: RecentHire | undefined,
  roles: VeteranRoles | undefined,
  state: { nonCitizens: number; waiverDriverId: string },
): void {
  const rng = ctx.rng;
  const owner: Owner = {
    type: 'driver',
    id: driver.id,
    label: driver.name,
    tag: driver.driverNumber,
  };
  const hireMs = parseDate(driver.hireDate);
  const plan = recent?.plan ?? null;
  const openedAt = recent?.openedAt ?? hireMs;
  const req = (code: string) => must(ctx.byCode.get(code), `requirement ${code}`);

  // ----- licence-type documents: cdl, medical_card ------------------------------------------
  const licence = (
    code: 'cdl' | 'medical_card',
    status: string,
    expiresOn: string,
    validityYears: number,
  ): QualificationItem | null => {
    if (status === 'missing') return null;
    const issuedOn = addYears(expiresOn, -validityYears);
    const base = Math.max(parseDate(issuedOn), recent ? openedAt : hireMs);
    const uploadedAt = base + rng.int(0, 3) * DAY + workHour(ctx) * HOUR + rng.int(0, 59) * MINUTE;
    return record(ctx, {
      req: req(code),
      owner,
      issuedOn,
      expiresOn,
      outcome: 'verified',
      uploadedAt,
      reviewedAt: uploadedAt + rng.int(2, 48) * HOUR,
      source: recent || rng.chance(0.4) ? 'driver_portal' : 'staff',
    });
  };
  const cdl = licence('cdl', driver.cdlStatus, driver.cdlExpiresOn, 4);
  if (driver.medicalCardExpiresOn) licence('medical_card', driver.medicalCardStatus, driver.medicalCardExpiresOn, 2);

  // The rest of the file a qualified driver carries: the back of the licence and a photograph.
  // Neither expires, and both arrive with the licence itself. They were missing, and because the
  // verification rung needs EVERY driver requirement verified, their absence held every case at
  // "verification" - no seeded case could reach safety review, which the seed is supposed to show.
  if (cdl) {
    // The driver photograph was retired on 2026-10-24; only the back of the licence remains.
    for (const code of ['cdl_back'] as const) {
      const uploadedAt = Math.max(parseDate(driver.cdlExpiresOn) - 4 * 365 * DAY, recent ? openedAt : hireMs) + workHour(ctx) * HOUR;
      record(ctx, {
        req: req(code),
        owner,
        issuedOn: null,
        expiresOn: null,
        outcome: 'verified',
        uploadedAt,
        reviewedAt: uploadedAt + rng.int(2, 48) * HOUR,
        source: recent || rng.chance(0.4) ? 'driver_portal' : 'staff',
      });
    }
  }

  if (cdl && driver.id === state.waiverDriverId) {
    cdl.waivedUntil = addDays(ctx.today, 21);
    cdl.waivedReason = WAIVER_REASON;
    audit(ctx, {
      at: iso(ctx.now - 2 * DAY - 3 * HOUR),
      actorId: ctx.management.id,
      actorName: ctx.management.name,
      action: 'item_waived',
      entity: entityRef(owner),
      subject: 'cdl',
      before: `Expires ${driver.cdlExpiresOn}`,
      after: `Waived until ${cdl.waivedUntil}`,
      reason: WAIVER_REASON,
      source: 'user',
    });
  }

  // ----- work authorization -----------------------------------------------------------------
  if (rng.chance(0.7)) {
    recordNotApplicable(ctx, req('work_authorization'), owner, 'US citizen');
  } else {
    state.nonCitizens += 1;
    const expiring = !recent && (state.nonCitizens === 2 || state.nonCitizens === 7);
    const expiresOn = expiring
      ? addDays(ctx.today, rng.int(8, 28))
      : addDays(ctx.today, rng.int(365, 1460));
    // A permit about to lapse is a 2-year EAD; anything longer-lived is a 10-year resident card.
    const validityYears = expiring ? 2 : 10;
    const issuedOn = addYears(expiresOn, -validityYears);
    const base = Math.max(parseDate(issuedOn), recent ? openedAt : hireMs);
    const uploadedAt = base + rng.int(0, 2) * DAY + workHour(ctx) * HOUR;
    record(ctx, {
      req: req('work_authorization'),
      owner,
      issuedOn,
      expiresOn,
      outcome: 'verified',
      uploadedAt,
      reviewedAt: uploadedAt + rng.int(2, 30) * HOUR,
      source: recent ? 'driver_portal' : 'staff',
    });
  }

  // ----- consent-gated checks ---------------------------------------------------------------
  const consented = (
    code: string,
    kind: 'annual' | 'one_time',
    role: AnnualRole,
    failed: boolean,
  ) => {
    const requirement = req(code);
    // A retired requirement (background check, 2026-10-24) is no longer asked for.
    if (!requirement.active) return;
    const consentStatus: ConsentStatus = plan ? must(plan.consents[code]) : 'signed';
    const screening: ScreeningState = plan ? must(plan.screening[code]) : 'verified';

    // Veterans: date the report first, then back the consent off it. Recent hires: the consent
    // was requested with the application and the report followed the signature.
    let issuedOn: string | null = null;
    let requestedAt: number;
    if (!plan) {
      issuedOn =
        kind === 'annual' ? annualIssuedOn(ctx, role) : addDays(driver.hireDate, -rng.int(3, 20));
      requestedAt = at(issuedOn, 9) - (kind === 'annual' ? rng.int(3, 12) : rng.int(2, 6)) * DAY;
    } else {
      requestedAt = openedAt + rng.int(1, 120) * MINUTE;
    }
    const consent = makeConsent(ctx, {
      driver,
      req: requirement,
      status: consentStatus,
      requestedAt,
      requestedBy: kind === 'annual' && !plan ? ctx.safety : ctx.recruiter,
    });
    if (screening === 'missing') return;
    if (plan) {
      const signed = consent.signedAt ? new Date(consent.signedAt).getTime() : openedAt;
      issuedOn = isoDate(clampPast(ctx, signed + rng.int(1, 3) * DAY));
    }
    const pulledOn = must(issuedOn);
    const uploadedAt = at(pulledOn, workHour(ctx), rng.int(0, 59));
    record(ctx, {
      req: requirement,
      owner,
      issuedOn: pulledOn,
      expiresOn: kind === 'annual' ? addYears(pulledOn, 1) : null,
      outcome: failed ? 'failed' : screening === 'pending' ? 'pending' : 'verified',
      uploadedAt,
      reviewedAt: uploadedAt + rng.int(1, 36) * HOUR,
      source: 'staff',
      note: failed ? CLEARINGHOUSE_FAILURE_NOTE : undefined,
    });
  };

  consented('mvr_review', 'annual', roles?.mvr ?? 'current', false);
  consented('psp_review', 'one_time', 'current', false);
  consented(
    'clearinghouse_query',
    'annual',
    roles?.clearinghouse ?? 'current',
    roles?.clearinghouseFailed ?? false,
  );
  consented('background_check', 'one_time', 'current', false);
  consented('employment_verification', 'one_time', 'current', false);

  // ----- pre-employment drug test (no consent object; the chain-of-custody form covers it) ----
  const drugState: ScreeningState = plan
    ? must(plan.screening.pre_employment_drug_test)
    : 'verified';
  if (drugState !== 'missing') {
    const issuedOn = plan
      ? isoDate(clampPast(ctx, openedAt + rng.int(2, 6) * DAY))
      : addDays(driver.hireDate, -rng.int(2, 12));
    const uploadedAt = at(issuedOn, workHour(ctx), rng.int(0, 59)) + rng.int(0, 2) * DAY;
    record(ctx, {
      req: req('pre_employment_drug_test'),
      owner,
      issuedOn,
      expiresOn: null,
      outcome: drugState === 'pending' ? 'pending' : 'verified',
      uploadedAt,
      reviewedAt: uploadedAt + rng.int(1, 24) * HOUR,
      source: 'staff',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Trucks & trailers
// ---------------------------------------------------------------------------------------------

function buildTrucks(ctx: Ctx, trucks: SeedTruck[]): void {
  const rng = ctx.rng;
  const req = (code: string) => must(ctx.byCode.get(code), `requirement ${code}`);
  const live = trucks.filter((t) => t.status !== 'sold');

  // Annual inspections fall on the in-service anniversary. The two units whose anniversary passed
  // most recently never got theirs done, so they read past due.
  const anniversaries = new Map(
    live.map((t) => [t.id, nextAnniversary(t.inServiceDate, ctx.today)]),
  );
  const pastDue = new Set(
    [...live]
      .sort(
        (a, b) =>
          daysBetween(ctx.today, must(anniversaries.get(b.id))) -
            daysBetween(ctx.today, must(anniversaries.get(a.id))) || a.id.localeCompare(b.id),
      )
      .slice(0, 2)
      .map((t) => t.id),
  );
  // Registrations renew on a month each unit was first plated; two are inside the 14-day window.
  const registrationSoon = new Set([live[5]?.id, live[17]?.id]);

  const fleetDoc = (owner: Owner, code: string, expiresOn: string, validityYears = 1) => {
    const issuedOn = addYears(expiresOn, -validityYears);
    const uploadedAt = at(issuedOn, workHour(ctx), rng.int(0, 59)) + rng.int(0, 5) * DAY;
    record(ctx, {
      req: req(code),
      owner,
      issuedOn,
      expiresOn,
      outcome: 'verified',
      uploadedAt,
      reviewedAt: uploadedAt + rng.int(1, 30) * HOUR,
      source: 'staff',
    });
  };

  for (const truck of live) {
    const owner: Owner = {
      type: 'truck',
      id: truck.id,
      label: `Unit ${truck.unitNumber}`,
      tag: truck.unitNumber,
    };
    const registration = registrationSoon.has(truck.id)
      ? addDays(ctx.today, rng.int(2, 13))
      : addMonths(ctx.today, rng.int(1, 12), rng.int(1, 28));
    fleetDoc(owner, 'registration', registration);
    const anniversary = must(anniversaries.get(truck.id));
    fleetDoc(
      owner,
      'annual_inspection',
      pastDue.has(truck.id) ? addYears(anniversary, -1) : anniversary,
    );
    fleetDoc(owner, 'ifta_license', FLEET_POLICY_DATES.ifta);
    // Required on every truck since 2026-10-24 (advisory).
    fleetDoc(owner, 'insurance_cab_card', addMonths(ctx.today, rng.int(1, 12), rng.int(1, 28)));
    fleetDoc(owner, 'ny_hut_sticker', addMonths(ctx.today, rng.int(1, 12), rng.int(1, 28)));
  }
}

function buildTrailers(ctx: Ctx, trailers: SeedTrailer[]): void {
  const rng = ctx.rng;
  const req = (code: string) => must(ctx.byCode.get(code), `requirement ${code}`);
  for (const trailer of trailers) {
    if (trailer.status === 'sold') continue;
    const owner: Owner = {
      type: 'trailer',
      id: trailer.id,
      label: trailer.unitNumber,
      tag: trailer.unitNumber,
    };
    const docs: Array<[string, string]> = [
      ['trailer_annual_inspection', trailer.nextInspectionDate],
      ['trailer_registration', addMonths(ctx.today, rng.int(1, 12), rng.int(1, 28))],
    ];
    for (const [code, expiresOn] of docs) {
      const issuedOn = addYears(expiresOn, -1);
      const uploadedAt = at(issuedOn, workHour(ctx), rng.int(0, 59)) + rng.int(0, 4) * DAY;
      record(ctx, {
        req: req(code),
        owner,
        issuedOn,
        expiresOn,
        outcome: 'verified',
        uploadedAt,
        reviewedAt: uploadedAt + rng.int(1, 30) * HOUR,
        source: 'staff',
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Verification cases
// ---------------------------------------------------------------------------------------------

/**
 * The stored half of a case. Steps are not built here: `deriveVerificationCase` computes them from
 * the items and consents this seed already produced, exactly as the API does on every read.
 */
function buildCaseRecord(ctx: Ctx, hire: RecentHire, index: number): VerificationCaseRecord {
  const { driver, plan, openedAt } = hire;
  const rng = ctx.rng;
  const decisionAt = plan.decision
    ? clampPast(ctx, openedAt + rng.int(10, 11) * DAY + 5 * HOUR)
    : null;
  const decisionBy = ctx.safety;
  const safetyReviewAt =
    plan.safetyReview === 'complete' && decisionAt !== null
      ? iso(decisionAt - rng.int(4, 30) * HOUR)
      : null;

  if (plan.decision && decisionAt !== null) {
    audit(ctx, {
      at: iso(decisionAt),
      actorId: decisionBy.id,
      actorName: decisionBy.name,
      action: 'decision_recorded',
      entity: ref('driver', driver.id, driver.name),
      subject: null,
      before: 'safety_review',
      after: plan.decision.decision,
      reason:
        plan.decision.note ??
        (plan.decision.conditions.length ? plan.decision.conditions.join('; ') : null),
      source: 'user',
    });
  }

  return {
    id: `vc_${pad(index + 1, 3)}`,
    driverId: driver.id,
    driverName: driver.name,
    openedAt: iso(openedAt),
    ownerId: ctx.recruiter.id,
    ownerName: ctx.recruiter.name,
    safetyReviewStatus: plan.safetyReview,
    safetyReviewAt,
    safetyReviewBy: plan.safetyReview === 'complete' ? ctx.safety.name : null,
    decision: plan.decision?.decision ?? null,
    decisionAt: decisionAt !== null ? iso(decisionAt) : null,
    decisionBy: decisionAt !== null ? decisionBy.name : null,
    conditions: plan.decision?.conditions ?? [],
    decisionNote: plan.decision?.note ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function buildComplianceSeed(rng: Rng, input: ComplianceSeedInput): ComplianceSeedOutput {
  const now = input.now.getTime();
  const safety = must(
    input.people.find((u) => u.department === 'safety'),
    'a safety person',
  );
  const recruiter = input.people.find((u) => u.department === 'hr') ?? safety;
  const management = input.people.find((u) => u.department === 'management') ?? safety;
  const ctx: Ctx = {
    rng,
    now,
    today: isoDate(now),
    safety,
    recruiter,
    management,
    byCode: new Map(SYSTEM_REQUIREMENTS.map((r) => [r.code, r])),
    items: [],
    documents: [],
    consents: [],
    audit: [],
  };

  const recentHires = planRecentHires(ctx, input.drivers);
  const veterans = input.drivers.filter((d) => !recentHires.has(d.id));
  const roles = assignVeteranRoles(ctx, veterans);
  // The one waiver: the driver whose CDL runs out soonest has a renewal receipt on file.
  const waiverDriver = [...input.drivers]
    .filter((d) => d.cdlStatus === 'expiring' && !recentHires.has(d.id))
    .sort((a, b) => a.cdlExpiresOn.localeCompare(b.cdlExpiresOn) || a.id.localeCompare(b.id))[0];
  const state = { nonCitizens: 0, waiverDriverId: waiverDriver?.id ?? '' };

  for (const driver of input.drivers) {
    buildDriver(ctx, driver, recentHires.get(driver.id), roles.get(driver.id), state);
  }
  buildTrucks(ctx, input.trucks);
  buildTrailers(ctx, input.trailers);
  // The DOT application came to the catalog after the rest of the file. It is generated in a pass
  // of its own, after everything else, so every earlier item and document keeps the id it had.
  for (const driver of input.drivers) {
    buildApplication(ctx, driver, recentHires.get(driver.id));
    // Every driver on the roster holds a CDL, which 391.33 accepts in lieu of a road test.
    recordNotApplicable(
      ctx,
      must(ctx.byCode.get('road_test'), 'requirement road_test'),
      { type: 'driver', id: driver.id, label: driver.name, tag: driver.driverNumber },
      'CDL accepted in lieu of a road test (49 CFR 391.33)',
    );
  }

  const caseRecords = [...recentHires.values()]
    .sort((a, b) => a.daysSinceHire - b.daysSinceHire)
    .map((hire, index) => buildCaseRecord(ctx, hire, index));

  const verificationCases = caseRecords.map((record) =>
    deriveVerificationCase({
      record,
      items: ctx.items.filter((i) => i.scope === 'driver' && i.entityId === record.driverId),
      consents: ctx.consents.filter((c) => c.driverId === record.driverId),
      requirements: SYSTEM_REQUIREMENTS,
      now: input.now,
      driverFirstName: input.drivers.find((d) => d.id === record.driverId)?.firstName,
    }),
  );

  ctx.audit.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)));

  return {
    requirements: [...SYSTEM_REQUIREMENTS],
    items: ctx.items,
    documents: ctx.documents,
    consents: ctx.consents,
    caseRecords,
    verificationCases,
    audit: ctx.audit,
  };
}

/** The audit action a consent transition maps to, when one exists. */
export function auditActionForConsent(
  status: ConsentStatus,
): 'consent_sent' | 'consent_signed' | 'consent_declined' | null {
  switch (status) {
    case 'sent':
      return 'consent_sent';
    case 'signed':
      return 'consent_signed';
    case 'declined':
      return 'consent_declined';
    default:
      return null;
  }
}
