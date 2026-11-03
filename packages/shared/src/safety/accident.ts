/**
 * Accidents and the investigation that follows one.
 *
 * `accidents` in docs/DATABASE.md §3.10 stores the facts — when, who, what unit, where, injuries,
 * fatalities, towed, preventability, DOT recordability — and one `status`. Everything a safety
 * manager works from beyond that is derived here: how long it has been open, whether the
 * investigation is stalled, and whether the file has the evidence a DOT recordable accident is
 * required to keep.
 *
 * Honesty rules:
 *  - **Preventability is a decision, not a computation.** It stays `undetermined` until a person
 *    records it. Nothing here guesses.
 *  - DOT recordability is a definition, not an opinion: an accident is recordable when it involved
 *    a fatality, an injury requiring immediate medical treatment away from the scene, or a vehicle
 *    towed from the scene (49 CFR 390.5). `dotRecordable` applies that rule and shows its working,
 *    so a wrongly-flagged accident can be argued with.
 *  - Missing evidence is reported as missing. It is never inferred to be present.
 */

/** `accidents.status`. */
export const ACCIDENT_STATUSES = [
  'reported',
  'under_review',
  'investigating',
  'pending_documents',
  'safety_review',
  'management_review',
  'closed',
] as const;
export type AccidentStatus = (typeof ACCIDENT_STATUSES)[number];

/** `accidents.preventable`. */
export const PREVENTABILITY = ['yes', 'no', 'undetermined'] as const;
export type Preventability = (typeof PREVENTABILITY)[number];

export const ACCIDENT_SEVERITIES = ['minor', 'moderate', 'serious', 'critical'] as const;
export type AccidentSeverity = (typeof ACCIDENT_SEVERITIES)[number];

/** Which statuses mean the file is still open work. */
export const OPEN_ACCIDENT_STATUSES: readonly AccidentStatus[] = [
  'reported',
  'under_review',
  'investigating',
  'pending_documents',
  'safety_review',
  'management_review',
];

export function isAccidentOpen(status: AccidentStatus): boolean {
  return OPEN_ACCIDENT_STATUSES.includes(status);
}

/** The order a file moves through. A status may only advance to the next one, or close. */
export const ACCIDENT_FLOW: Record<AccidentStatus, readonly AccidentStatus[]> = {
  reported: ['under_review', 'closed'],
  under_review: ['investigating', 'pending_documents', 'closed'],
  investigating: ['pending_documents', 'safety_review', 'closed'],
  pending_documents: ['investigating', 'safety_review', 'closed'],
  safety_review: ['management_review', 'investigating', 'closed'],
  management_review: ['closed', 'safety_review'],
  closed: ['under_review'],
};

export function accidentTransitions(status: AccidentStatus): readonly AccidentStatus[] {
  return ACCIDENT_FLOW[status] ?? [];
}

// ---------------------------------------------------------------------------------------------
// DOT recordability (49 CFR 390.5)
// ---------------------------------------------------------------------------------------------

export interface RecordabilityInput {
  fatalities: number;
  /** People who needed immediate medical treatment away from the scene. */
  injuriesTreatedAway: number;
  /** True when any vehicle was towed from the scene because of disabling damage. */
  towedFromScene: boolean;
}

export interface Recordability {
  recordable: boolean;
  /** The clause that made it recordable, or why it is not. */
  reasons: string[];
}

/**
 * Whether an accident meets the federal definition of a recordable crash.
 *
 * Stated as a rule with its working shown, because this determination drives the carrier's crash
 * BASIC and a driver's record, and a number nobody can argue with is a number nobody can correct.
 */
export function dotRecordable(input: RecordabilityInput): Recordability {
  const reasons: string[] = [];
  if (input.fatalities > 0) {
    reasons.push(`${input.fatalities} fatality${input.fatalities === 1 ? '' : 'ies'}`);
  }
  if (input.injuriesTreatedAway > 0) {
    reasons.push(
      `${input.injuriesTreatedAway} injury requiring immediate treatment away from the scene`,
    );
  }
  if (input.towedFromScene) {
    reasons.push('A vehicle was towed from the scene due to disabling damage');
  }

  if (reasons.length > 0) return { recordable: true, reasons };
  return {
    recordable: false,
    reasons: [
      'No fatality, no injury treated away from the scene, and no vehicle towed for disabling damage',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Investigation state
// ---------------------------------------------------------------------------------------------

/** Evidence a file may hold. Named so the UI can say exactly what is missing. */
export const EVIDENCE_KINDS = [
  'police_report',
  'driver_statement',
  'photos',
  'dashcam',
  'witness_statement',
  'telematics',
  'repair_estimate',
  'insurance_correspondence',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** What a DOT recordable file must hold before it can be closed with a straight face. */
export const REQUIRED_EVIDENCE_WHEN_RECORDABLE: readonly EvidenceKind[] = [
  'police_report',
  'driver_statement',
  'photos',
];

export interface AccidentReviewInput {
  status: AccidentStatus;
  at: string;
  preventable: Preventability;
  recordable: boolean;
  /** Evidence kinds actually attached to the file. */
  evidence: EvidenceKind[];
  /** Whoever owns the investigation, when one has been assigned. */
  ownerId?: string | null;
  /** When the investigation is due to conclude, when a date was set. */
  investigationDueOn?: string | null;
  /** Corrective actions raised against this accident that are still outstanding. */
  openCorrectiveActions?: number;
}

export interface AccidentReview {
  open: boolean;
  /** Whole days since the accident. */
  daysOpen: number;
  /** True when the file cannot honestly be closed yet. */
  blocked: boolean;
  /** Exactly what stands between this file and being closed. */
  blockers: string[];
  /** Evidence a recordable file is missing. */
  missingEvidence: EvidenceKind[];
  /** True when the investigation has passed its own due date. */
  overdue: boolean;
}

const MS_PER_DAY = 86_400_000;

export function reviewAccident(input: AccidentReviewInput, nowIso: string): AccidentReview {
  const now = Date.parse(nowIso);
  const at = Date.parse(input.at);
  const daysOpen = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / MS_PER_DAY));
  const open = isAccidentOpen(input.status);

  const missingEvidence = input.recordable
    ? REQUIRED_EVIDENCE_WHEN_RECORDABLE.filter((kind) => !input.evidence.includes(kind))
    : [];

  const blockers: string[] = [];
  if (input.preventable === 'undetermined') {
    blockers.push('Preventability has not been decided');
  }
  if (!input.ownerId) {
    blockers.push('No investigator is assigned');
  }
  for (const kind of missingEvidence) {
    blockers.push(`A DOT recordable file needs a ${kind.replace(/_/g, ' ')}`);
  }
  if ((input.openCorrectiveActions ?? 0) > 0) {
    blockers.push(
      `${input.openCorrectiveActions} corrective action${input.openCorrectiveActions === 1 ? '' : 's'} still open`,
    );
  }

  const overdue =
    open &&
    !!input.investigationDueOn &&
    input.investigationDueOn.slice(0, 10) < nowIso.slice(0, 10);

  return {
    open,
    daysOpen,
    blocked: open && blockers.length > 0,
    blockers,
    missingEvidence,
    overdue,
  };
}

// ---------------------------------------------------------------------------------------------
// Claims (`claims` in docs/DATABASE.md §3.10)
// ---------------------------------------------------------------------------------------------

export const CLAIM_KINDS = ['cargo', 'liability', 'physical_damage', 'workers_comp'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = [
  'draft',
  'submitted',
  'acknowledged',
  'investigating',
  'approved',
  'denied',
  'settled',
  'closed',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface ClaimExposure {
  /** Money set aside against the claim. */
  reserve: number | null;
  paid: number | null;
  /** Reserve less what has been paid. Null when either side is unknown. */
  outstanding: number | null;
}

/**
 * What a claim still exposes the carrier to.
 *
 * A missing reserve is `null`, not zero: an unreserved claim is an unknown liability, and showing
 * it as $0 is the single most misleading thing this screen could do.
 */
export function claimExposure(reserve: number | null, paid: number | null): ClaimExposure {
  return {
    reserve,
    paid,
    outstanding:
      reserve === null || paid === null ? null : Math.round((reserve - paid) * 100) / 100,
  };
}
