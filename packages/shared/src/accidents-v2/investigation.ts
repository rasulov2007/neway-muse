// Accident & Claims v2 — investigation, determinations, corrective actions and evidence contract (phase P4;
// docs/accidents/API.md §2 "Investigation & determinations" / "Evidence", adapted — see the P4 report in
// docs/accidents/IMPLEMENTATION-PLAN.md). Five separate human decisions: driver fault, preventability, FMCSA CPDP,
// legal liability (restricted) and insurance liability (per claim). NeWay records them; it never derives one from another.
import { z } from 'zod';
import { EVIDENCE_CATEGORIES } from './api.js';

const id = z.string().trim().min(1).max(120);
const version = z.number().int().min(1);
const isoInstant = z.string().datetime({ offset: true });
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const FAULT_VALUES = ['not_determined', 'not_at_fault', 'partial', 'at_fault'] as const;
export const PREVENT_VALUES = ['not_determined', 'non_preventable', 'preventable'] as const;
export const CPDP_VALUES = ['not_eligible', 'eligible_not_submitted', 'submitted', 'not_preventable', 'preventable', 'undecided'] as const;
export const LEGAL_VALUES = ['unknown', 'no_claim_expected', 'disputed', 'third_party_liable', 'shared', 'company_liable', 'in_litigation'] as const;
export const CORRECTIVE_KINDS = ['Coaching', 'Retraining', 'Ride-along evaluation', 'Disciplinary review', 'Equipment fix', 'Policy / bulletin'] as const;
export const CORRECTIVE_STATUSES = ['Open', 'In progress', 'Completed', 'Waived'] as const;
export const FACTOR_CATEGORIES = ['Driver', 'Vehicle', 'Environment', 'Other party', 'Operational'] as const;
export const STATEMENT_KINDS = ['Driver', 'Witness', 'Third party', 'Police'] as const;
export const REVIEW_STATES = ['pending', 'requested', 'reviewed', 'not_available'] as const;
/** Evidence categories restricted automatically (SPEC §1.4). */
export const RESTRICTED_EVIDENCE = ['Medical (restricted)', 'Legal (restricted)', 'Test record (restricted)'] as const;

/**
 * FMCSA Crash Preventability Determination Program — eligible crash types for crashes on/after Dec 1 2024, in FMCSA's
 * wording (SPEC §8.1). Kept as configuration so it can be updated when FMCSA changes it.
 */
export const CPDP_ELIGIBLE_TYPES: readonly string[] = [
  'CMV was struck in the rear by a motorist',
  'CMV was struck on the side at the rear',
  'CMV was struck on the side by a motorist operating in the same direction',
  'CMV was struck because another motorist was driving in the wrong direction',
  'CMV was struck by a motorist making a U-turn or illegal turn',
  'CMV was struck while legally stopped at a traffic control device or parked, including while unattended',
  'CMV was struck because another motorist did not stop or slow in traffic',
  'CMV was struck because another motorist failed to stop at a traffic control device',
  'CMV was struck because another individual was under the influence (per the jurisdiction’s legal standard)',
  'CMV was struck because another motorist had a medical issue that contributed to the crash',
  'CMV was struck because another motorist fell asleep',
  'CMV was struck because another motorist was distracted',
  'CMV was struck by cargo or equipment from another vehicle, or debris',
  'The crash resulted from an infrastructure failure',
  'CMV struck an animal',
  'The crash involved a suicide death or suicide attempt',
  'CMV was struck by a motorist entering the roadway from a private driveway or parking lot',
  'CMV was struck because another motorist lost control of their vehicle',
  'The crash involved a non-motorist',
  'A rare or unusual crash type that does not meet another eligible type (e.g. struck by an airplane or skydiver)',
  'Any other crash where video shows the sequence of events',
];

export const InvestigationActionSchema = z.object({ version, ownerId: id.optional(), note: optText(1000), reason: optText(1000) });
export type InvestigationActionInput = z.infer<typeof InvestigationActionSchema>;

export const PatchInvestigationSchema = z.object({ version, conclusion: optText(8000), ownerId: id.nullable().optional() });
export type PatchInvestigationInput = z.infer<typeof PatchInvestigationSchema>;

export const AddFactSchema = z.object({ version, text: text(2, 2000), source: optText(200), provenance: z.enum(['verified', 'driver', 'preliminary']) });
export type AddFactInput = z.infer<typeof AddFactSchema>;

export const AddQuestionSchema = z.object({ version, text: text(3, 1000), ownerId: id.nullable().optional() });
export type AddQuestionInput = z.infer<typeof AddQuestionSchema>;

export const ResolveQuestionSchema = z.object({ version, answer: text(1, 2000) });
export type ResolveQuestionInput = z.infer<typeof ResolveQuestionSchema>;

export const AddStatementSchema = z.object({ version, party: text(1, 200), kind: z.enum(STATEMENT_KINDS), summary: text(2, 4000), takenAt: isoInstant.optional() });
export type AddStatementInput = z.infer<typeof AddStatementSchema>;

export const AddFactorSchema = z.object({ version, category: z.enum(FACTOR_CATEGORIES), label: text(2, 200) });
export type AddFactorInput = z.infer<typeof AddFactorSchema>;

export const FactorLevelSchema = z.object({ version, level: z.enum(['possible', 'confirmed', 'ruled_out']) });
export type FactorLevelInput = z.infer<typeof FactorLevelSchema>;

export const ReviewItemSchema = z.object({ version, label: z.string().trim().min(2).max(200).optional(), state: z.enum(REVIEW_STATES).optional(), note: optText(1000), restricted: z.boolean().optional() });
export type ReviewItemInput = z.infer<typeof ReviewItemSchema>;

export const DeterminationSchema = z.object({ version, value: z.string().trim().min(2).max(40), basis: optText(2000), rdr: optText(80) });
export type DeterminationInput = z.infer<typeof DeterminationSchema>;

export const AddVehicleSchema = z.object({
  version,
  description: text(2, 200),
  ownerName: optText(200),
  driverName: optText(200),
  insurer: optText(160),
  policyNo: optText(80),
  plate: optText(40),
  damage: optText(1000),
  towed: z.enum(['yes', 'no', 'unknown', 'na']).nullable().optional(),
});
export type AddVehicleInput = z.infer<typeof AddVehicleSchema>;

export const AddWitnessSchema = z.object({ version, name: text(1, 200), contact: optText(300), note: optText(2000) });
export type AddWitnessInput = z.infer<typeof AddWitnessSchema>;

export const CreateCorrectiveActionSchema = z.object({ version, kind: z.enum(CORRECTIVE_KINDS), title: text(3, 500), assigneeId: id, dueAt: isoInstant, driverId: id.nullable().optional() });
export type CreateCorrectiveActionInput = z.infer<typeof CreateCorrectiveActionSchema>;

export const PatchCorrectiveActionSchema = z.object({
  /** The corrective action's own version (a safety_reviews row). */
  version,
  status: z.enum(CORRECTIVE_STATUSES).optional(),
  completionEvidence: optText(2000),
  assigneeId: id.optional(),
  dueAt: isoInstant.optional(),
  reason: optText(1000),
});
export type PatchCorrectiveActionInput = z.infer<typeof PatchCorrectiveActionSchema>;

export const UploadEvidenceSchema = z.object({
  version,
  files: z.array(z.object({ fileId: id })).min(1).max(30),
  category: z.enum(EVIDENCE_CATEGORIES),
  description: optText(2000),
  /** Mark a non-restricted category restricted (accidents.restricted). Restricted categories are restricted anyway. */
  restricted: z.boolean().optional(),
});
export type UploadEvidenceInput = z.infer<typeof UploadEvidenceSchema>;

export const EvidenceVersionSchema = z.object({ fileId: id, note: text(2, 1000) });
export type EvidenceVersionInput = z.infer<typeof EvidenceVersionSchema>;

export const RemoveEvidenceSchema = z.object({ reason: text(3, 1000) });
export type RemoveEvidenceInput = z.infer<typeof RemoveEvidenceSchema>;

// ------------------------------------------------------------------------------------------------ responses

export interface EvidenceItem {
  id: string;
  category: string;
  restricted: boolean;
  /** true = a lock card: the viewer may not see this document (no name, description, file or versions). */
  locked: boolean;
  name: string | null;
  description: string | null;
  kind: 'photo' | 'video' | 'pdf' | 'doc';
  uploadedBy: string | null;
  uploadedAt: string;
  sizeKb: number | null;
  version: number;
  versions: { v: number; at: string; by: string; note: string | null; fileId: string; fileName: string; sha256: string | null; sizeBytes: number }[] | null;
  removed: { at: string; by: string | null; reason: string | null } | null;
  /** The latest file (download through /files/:id) — absent on a lock card. */
  fileId: string | null;
}

export interface EvidenceListResponse {
  items: EvidenceItem[];
  counts: Record<string, number>;
  legalHold: { since: string; by: string; reason: string } | null;
}

export interface WitnessView {
  id: string;
  name: string;
  /** null for a viewer without accidents.restricted. */
  contact: string | null;
  note: string | null;
}

export interface VehicleView {
  id: string;
  description: string;
  ownerName: string | null;
  driverName: string | null;
  insurer: string | null;
  policyNo: string | null;
  plate: string | null;
  damage: string | null;
  towed: 'yes' | 'no' | 'unknown' | 'na' | null;
}

export interface CorrectiveActionView {
  id: string;
  number: string;
  kind: (typeof CORRECTIVE_KINDS)[number];
  /** "Restricted personnel action" for a disciplinary review the viewer may not see. */
  title: string;
  restricted: boolean;
  locked: boolean;
  status: (typeof CORRECTIVE_STATUSES)[number];
  assignee: { id: string; name: string } | null;
  dueAt: string;
  completedAt: string | null;
  evidence: string | null;
  driverId: string | null;
  version: number;
}

export interface InvestigationBlock {
  vehicles: VehicleView[];
  witnesses: WitnessView[];
  correctiveActions: CorrectiveActionView[];
  questions: { id: string; text: string; owner: { id: string; name: string } | null; answer: string | null; resolvedAt: string | null; resolvedBy: string | null }[];
  reviewItems: { key: string; label: string; state: (typeof REVIEW_STATES)[number]; note: string | null; restricted: boolean }[];
  submitMissing: string[];
}
