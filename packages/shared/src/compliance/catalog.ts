/**
 * The system requirement catalog: the rules every carrier starts with (`is_system = true` rows of
 * `qualification_requirements`). A company can deactivate any of these, change any policy, or add
 * its own; this is the starting point, not a ceiling.
 *
 * Lead days, grace periods and escalation ladders here are defaults a safety department would
 * recognise, not regulatory constants — the regulation says *when* a credential lapses, the
 * carrier decides how far ahead it wants to be warned and who gets woken up.
 */
import type { CompliancePolicy, EscalationStep, QualificationRequirement } from './requirement.js';

const ladder = (
  steps: ReadonlyArray<readonly [number, EscalationStep['notify'], EscalationStep['severity']]>,
): EscalationStep[] =>
  steps.map(([atDaysRemaining, notify, severity]) => ({ atDaysRemaining, notify, severity }));

/** The standard driver-credential run-up: 90 → 60 → 30 → 14 → 7 → 3 → 1 → expired. */
export const STANDARD_DRIVER_POLICY: CompliancePolicy = {
  leadDays: [90, 60, 30, 14, 7, 3, 1],
  gracePeriodDays: 0,
  escalation: ladder([
    [-1, ['safety_director', 'operations_manager', 'safety_manager', 'driver'], 'critical'],
    [1, ['safety_director', 'safety_manager', 'driver'], 'critical'],
    [3, ['safety_director', 'safety_manager', 'driver'], 'critical'],
    [7, ['safety_manager', 'driver'], 'warning'],
    [14, ['safety_manager'], 'warning'],
    [30, ['safety_coordinator'], 'info'],
    [60, ['safety_coordinator'], 'info'],
    [90, ['safety_coordinator'], 'info'],
  ]),
};

/** Vehicle documents renew on a calendar, so the run-up starts earlier and escalates to fleet. */
export const STANDARD_VEHICLE_POLICY: CompliancePolicy = {
  leadDays: [90, 60, 30, 14, 7, 1],
  gracePeriodDays: 0,
  escalation: ladder([
    [-1, ['safety_director', 'fleet_manager', 'operations_manager'], 'critical'],
    [1, ['safety_manager', 'fleet_manager'], 'critical'],
    [7, ['safety_manager', 'fleet_manager'], 'warning'],
    [14, ['fleet_manager'], 'warning'],
    [30, ['safety_coordinator'], 'info'],
    [60, ['safety_coordinator'], 'info'],
    [90, ['safety_coordinator'], 'info'],
  ]),
};

/** Periodic reviews (MVR, PSP) with a short grace: a review a few days late is a task, not a hold. */
export const REVIEW_POLICY: CompliancePolicy = {
  leadDays: [60, 30, 14, 7],
  gracePeriodDays: 14,
  escalation: ladder([
    [-1, ['safety_manager'], 'warning'],
    [7, ['safety_coordinator'], 'warning'],
    [30, ['safety_coordinator'], 'info'],
    [60, ['safety_coordinator'], 'info'],
  ]),
};

/** One-off checks that never expire: the ladder only matters when the item is missing. */
export const ONE_TIME_POLICY: CompliancePolicy = {
  leadDays: [],
  gracePeriodDays: 0,
  escalation: [],
};

export const SYSTEM_REQUIREMENTS: readonly QualificationRequirement[] = [
  // ---------------------------------------------------------------- driver
  {
    code: 'cdl',
    name: 'Commercial driver licence',
    description: 'A current CDL of the class the driver operates, with required endorsements.',
    scope: 'driver',
    authority: '49 CFR 383',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'safety_coordinator',
    policy: STANDARD_DRIVER_POLICY,
    active: true,
    isSystem: true,
    // The front of the card. The licence is one item with two slots (owner, 2026-10-24).
    partLabel: 'Front',
  },
  {
    // Shown as the Back slot of the CDL, not a row of its own (owner, 2026-10-24). Its code,
    // documents and verification stay as they were, so every back already on file keeps showing.
    code: 'cdl_back',
    name: 'CDL — back of the card',
    description: 'The reverse of the licence, which carries the restrictions and the class table.',
    scope: 'driver',
    authority: '49 CFR 383',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
    partOf: 'cdl',
    partLabel: 'Back',
  },
  {
    // Retired 2026-10-24 (owner): no longer asked for. Kept so filed photographs stay readable.
    code: 'driver_photo',
    name: 'Driver photograph',
    description: 'A current photograph of the driver, for the file and for dispatch to recognise.',
    scope: 'driver',
    authority: 'Company policy',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: false,
    isSystem: true,
  },
  {
    code: 'medical_card',
    name: 'DOT medical certificate',
    description: 'A current medical examiner certificate from a registered examiner.',
    scope: 'driver',
    authority: '49 CFR 391.41–391.49',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'safety_coordinator',
    policy: STANDARD_DRIVER_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'work_authorization',
    name: 'Work authorization',
    description: 'Proof of eligibility to work; tracked to its own expiry where one applies.',
    scope: 'driver',
    authority: 'Form I-9',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'recruiter',
    policy: STANDARD_DRIVER_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'mvr_review',
    name: 'MVR review',
    // Every 6 months from the report date (owner, 2026-10-24; was 12). Stricter than 391.25.
    description: 'Motor vehicle record obtained and reviewed by safety every 6 months.',
    scope: 'driver',
    authority: '49 CFR 391.25',
    hasExpiry: true,
    validityMonths: 6,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: true,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: REVIEW_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'psp_review',
    name: 'PSP review',
    // Re-run every 6 months from the report date (owner, 2026-10-24; was one-off).
    description: 'Pre-employment screening report obtained with consent, reviewed by safety and re-run every 6 months.',
    scope: 'driver',
    authority: 'FMCSA PSP',
    hasExpiry: true,
    validityMonths: 6,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: true,
    holdEffect: 'advisory',
    owner: 'recruiter',
    policy: REVIEW_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'clearinghouse_query',
    name: 'Clearinghouse query',
    description: 'Drug & Alcohol Clearinghouse pre-employment full query and annual limited query.',
    scope: 'driver',
    authority: '49 CFR 382.701',
    hasExpiry: true,
    validityMonths: 12,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: true,
    holdEffect: 'driver_hold',
    owner: 'safety_coordinator',
    policy: REVIEW_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'pre_employment_drug_test',
    name: 'Pre-employment drug test',
    description:
      'A negative pre-employment controlled-substances result before the first dispatch.',
    scope: 'driver',
    authority: '49 CFR 382.301',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // Retired 2026-10-24 (owner): no longer on the driver's list. Kept so filed reports stay
    // readable and the hiring Safety step can still file an "other" report under it.
    code: 'background_check',
    name: 'Background check',
    description: "Criminal and employment background check completed with the driver's consent.",
    scope: 'driver',
    authority: 'Company policy',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: true,
    holdEffect: 'advisory',
    owner: 'recruiter',
    policy: ONE_TIME_POLICY,
    active: false,
    isSystem: true,
  },
  {
    // A random controlled-substances test the driver was selected for (49 CFR 382.305), filed
    // with its collection date and result (owner, 2026-10-24). Not every driver is selected, so it
    // is a file on the driver's Documents tab, not a gap the Safety board reports.
    code: 'random_drug_test',
    name: 'Random drug test',
    description: 'The result of a random controlled-substances test, with the collection date.',
    scope: 'driver',
    authority: '49 CFR 382.305',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    // The driver's IRS Form W-9 (owner, 2026-10-25): a tax paper for 1099 pay, not a DOT
    // qualification. Document-only, like the random drug test: it sits on the driver's Documents
    // tab with Upload and View, never a missing item on the Safety board and never a hold. It
    // carries a taxpayer ID, so it is in SENSITIVE_REQUIREMENTS and PII_REQUIREMENTS (records.ts).
    code: 'w9',
    name: 'W-9',
    description: 'IRS Form W-9: the taxpayer identification number and certification, for 1099 pay.',
    scope: 'driver',
    authority: 'IRS Form W-9',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'recruiter',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'employment_verification',
    name: 'Previous employer verification',
    description: 'Three-year safety performance history from previous DOT-regulated employers.',
    scope: 'driver',
    authority: '49 CFR 391.23',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: true,
    holdEffect: 'advisory',
    owner: 'recruiter',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // The first document in a qualification file, and the one the funnel produces itself: the
    // recruiter records the application, the system renders the PDF and files it here.
    code: 'dot_application',
    name: 'DOT employment application',
    description:
      'The 49 CFR 391.21 application: address and licence history, ten years of employers, accidents and convictions in the last three years, signed and dated by the applicant.',
    scope: 'driver',
    authority: '49 CFR 391.21',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'recruiter',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // Given at orientation, after the offer; a CDL holder may be accepted in lieu (391.33).
    code: 'road_test',
    name: 'Road test certificate',
    description:
      'The 49 CFR 391.31 road test, or the CDL accepted in lieu of it under 391.33, recorded with the examiner and the vehicle used.',
    scope: 'driver',
    authority: '49 CFR 391.31',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'driver_hold',
    owner: 'recruiter',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
  // ---------------------------------------------------------------- truck
  {
    code: 'registration',
    name: 'Vehicle registration',
    description: 'Current state registration for the power unit.',
    scope: 'truck',
    authority: 'State DMV',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'annual_inspection',
    name: 'Annual DOT inspection',
    description: 'Periodic inspection completed within the last 12 months.',
    scope: 'truck',
    authority: '49 CFR 396.17',
    hasExpiry: true,
    validityMonths: 12,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // Retired 2026-09-22 as a graded requirement (owner: the same paper as the unit's insurance);
    // back 2026-10-24 as a document the truck carries, with its expiry, on the unit's Documents
    // tab. Required on every truck but advisory (owner, 2026-10-24): a truck without one shows as
    // missing, a reminder, and is not held. Cards filed before the retirement (and the Ditat
    // "Insurance" imports) carry this code and show again.
    code: 'insurance_cab_card',
    name: 'Insurance cab card',
    description: 'Proof of liability coverage carried in the cab.',
    scope: 'truck',
    authority: 'Company policy / FMCSA',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // Retired 2026-09-22 with the insurance cab card; kept for filed documents.
    code: 'irp_cab_card',
    name: 'IRP cab card',
    description: 'Apportioned registration for interstate operation.',
    scope: 'truck',
    authority: 'IRP',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: false,
    isSystem: true,
  },
  {
    code: 'ifta_license',
    name: 'IFTA licence',
    description: 'Fuel-tax licence and decals for the current year.',
    scope: 'truck',
    authority: 'IFTA',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    // The New York highway use tax (HUT) decal / certificate (owner, 2026-10-24). A file the truck
    // carries with its printed expiry. Required on every truck but advisory (owner, 2026-10-24):
    // missing is a reminder, never a hold.
    code: 'ny_hut_sticker',
    name: 'NY sticker',
    description: 'New York highway use tax (HUT) decal and certificate for trucks over 18,000 lb.',
    scope: 'truck',
    authority: 'NY Tax Law Article 21',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  // Paperwork a truck carries that is a file rather than a graded requirement.
  {
    code: 'title',
    name: 'Title',
    description: 'Certificate of title or the lienholder copy; proves ownership.',
    scope: 'truck',
    authority: 'State DMV',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'lease_agreement',
    name: 'Lease agreement',
    description: 'The lease the unit runs under, when it is leased rather than owned.',
    scope: 'truck',
    authority: 'Lessor',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'permit',
    name: 'Permit',
    description: 'A state or oversize/overweight permit the unit carries.',
    scope: 'truck',
    authority: 'Issuing state',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'warranty',
    name: 'Warranty',
    description: 'Manufacturer or extended warranty terms; drives the warranty-expiry check.',
    scope: 'truck',
    authority: 'Manufacturer / dealer',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'bill_of_sale',
    name: 'Bill of sale',
    description: 'Purchase paperwork for the unit.',
    scope: 'truck',
    authority: 'Seller',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  // ---------------------------------------------------------------- trailer
  {
    code: 'trailer_registration',
    name: 'Trailer registration',
    description: 'Current registration for the trailer.',
    scope: 'trailer',
    authority: 'State DMV',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'trailer_annual_inspection',
    name: 'Trailer annual inspection',
    description: 'Periodic inspection completed within the last 12 months.',
    scope: 'trailer',
    authority: '49 CFR 396.17',
    hasExpiry: true,
    validityMonths: 12,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'trailer_title',
    name: 'Title',
    description: 'Certificate of title for the trailer.',
    scope: 'trailer',
    authority: 'State DMV',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'none',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'trailer_insurance_card',
    name: 'Insurance card',
    description: 'Proof of insurance carried on the trailer.',
    scope: 'trailer',
    authority: 'Company policy / FMCSA',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'unit_hold',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  {
    code: 'trailer_lease_agreement',
    name: 'Lease agreement',
    description: 'The lease the trailer runs under, when it is leased rather than owned.',
    scope: 'trailer',
    authority: 'Lessor',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: false,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'fleet_manager',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
    documentOnly: true,
  },
  // ---------------------------------------------------------------- company (Safety v2, 2026-10-02)
  // The carrier's own file. Advisory: a gap here is the safety manager's to fix, and it does not
  // hold a driver or a truck. Status is derived like every other item, from the document on file.
  {
    code: 'insurance_filing',
    name: 'Insurance filing',
    description: 'Proof of public liability insurance on file with FMCSA (BMC-91/91X, MCS-90 endorsement).',
    scope: 'company',
    authority: '49 CFR 387',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'operating_authority',
    name: 'Operating authority',
    description: 'Active MC operating authority for the operations the carrier runs.',
    scope: 'company',
    authority: '49 CFR 365',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'dot_registration',
    name: 'DOT registration review',
    description: 'USDOT registration (MCS-150) updated every 24 months, with the filing on file.',
    scope: 'company',
    authority: '49 CFR 390.19',
    hasExpiry: true,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: STANDARD_VEHICLE_POLICY,
    active: true,
    isSystem: true,
  },
  {
    code: 'safety_policies',
    name: 'Policies & audit documents',
    description: 'Written drug & alcohol policy, safety policies and the records an audit asks for.',
    scope: 'company',
    authority: '49 CFR 382.601',
    hasExpiry: false,
    requiresDocument: true,
    requiresVerification: true,
    requiresConsent: false,
    holdEffect: 'advisory',
    owner: 'safety_coordinator',
    policy: ONE_TIME_POLICY,
    active: true,
    isSystem: true,
  },
];

/**
 * The fixed term of a document type in calendar months, when it has one (annual inspections, MVR
 * review, Clearinghouse query: 12). Null for a type that carries its own printed expiry or none.
 * The one place the Add-document forms read it from, for units and drivers alike.
 */
export function validityMonthsFor(
  code: string,
  catalog: readonly QualificationRequirement[] = SYSTEM_REQUIREMENTS,
): number | null {
  return catalog.find((requirement) => requirement.code === code)?.validityMonths ?? null;
}

/**
 * Whether a requirement must be reviewed and accepted before a hiring decision and a hire
 * (owner, 2026-10-02: "all applicable mandatory checks reviewed and accepted; optional items must
 * not block"). Mandatory means it carries a consequence: a hold, or an advisory a safety manager
 * must act on. A requirement whose hold effect is `none` (the back of the CDL, the driver photo)
 * stays in the file but never blocks.
 */
export function isMandatoryRequirement(requirement: QualificationRequirement): boolean {
  return requirement.active && requirement.holdEffect !== 'none';
}

/**
 * Codes a reviewer may mark "not applicable" for a driver, with a reason that is audited.
 * Everything else must be evidenced. Listed for the owner's confirmation in SAFETY-V2.md.
 */
export const NOT_APPLICABLE_ALLOWED: ReadonlySet<string> = new Set([
  'employment_verification',
  'work_authorization',
  'psp_review',
]);

/** True for a requirement that is shown as a slot of another (the back of the CDL). */
export function isRequirementPart(requirement: Pick<QualificationRequirement, 'partOf'>): boolean {
  return Boolean(requirement.partOf);
}

/**
 * The requirements the compliance engine grades for a scope. Document-only types are files a unit
 * carries, not gaps to report, so they are left out here and offered by the unit's Documents tab.
 */
export function requirementsFor(
  scope: QualificationRequirement['scope'],
  catalog: readonly QualificationRequirement[] = SYSTEM_REQUIREMENTS,
): QualificationRequirement[] {
  return catalog.filter(
    (requirement) => requirement.scope === scope && requirement.active && !requirement.documentOnly,
  );
}
