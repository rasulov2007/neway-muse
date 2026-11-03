import { z } from 'zod';

/**
 * A recruiter's own record around a candidate (owner, 2026-09-30): who works them, and each time
 * somebody reached out. A follow-up is recorded after it happened; recording one never sends a
 * message and the product never says it did.
 */

export const FOLLOW_UP_METHODS = ['call', 'text', 'email', 'in_person', 'other'] as const;
export const FOLLOW_UP_OUTCOMES = ['reached', 'no_answer', 'left_message', 'wrong_number', 'not_interested', 'other'] as const;
export type FollowUpMethod = (typeof FOLLOW_UP_METHODS)[number];
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];

export const FOLLOW_UP_METHOD_LABELS: Readonly<Record<FollowUpMethod, string>> = {
  call: 'Phone call',
  text: 'Text message',
  email: 'Email',
  in_person: 'In person',
  other: 'Other',
};
export const FOLLOW_UP_OUTCOME_LABELS: Readonly<Record<FollowUpOutcome, string>> = {
  reached: 'Reached them',
  no_answer: 'No answer',
  left_message: 'Left a message',
  wrong_number: 'Wrong number',
  not_interested: 'Not interested',
  other: 'Other',
};

export const FollowUpSchema = z
  .object({
    method: z.enum(FOLLOW_UP_METHODS),
    outcome: z.enum(FOLLOW_UP_OUTCOMES),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .refine((v) => v.outcome !== 'other' || (v.note ?? '').length > 0, {
    message: 'Say what happened when the outcome is Other',
    path: ['note'],
  });
export type FollowUpInput = z.input<typeof FollowUpSchema>;
export type FollowUpRequest = z.infer<typeof FollowUpSchema>;

export const AssignRecruiterSchema = z.object({ employeeId: z.string().min(1).nullable() });
export type AssignRecruiterRequest = z.infer<typeof AssignRecruiterSchema>;

export interface LatestFollowUp {
  /** The case or lead id. */
  entityId: string;
  at: string;
  byName: string;
  method: FollowUpMethod;
  outcome: FollowUpOutcome;
  note: string | null;
}

export interface HiringActivityEntry {
  id: string;
  at: string;
  kind: 'stage' | 'follow_up' | 'record';
  title: string;
  detail: string | null;
  byName: string;
}

/**
 * A plain note on a lead (owner, 2026-10-07): free text, no method or outcome. Notes and recorded
 * follow-ups share one store (the audit trail) and one history, newest first.
 */
export const LeadNoteSchema = z.object({
  note: z.string().trim().min(1, 'Write the note first').max(2000),
});
export type LeadNoteInput = z.input<typeof LeadNoteSchema>;
export type LeadNoteRequest = z.infer<typeof LeadNoteSchema>;

export interface LeadNote {
  id: string;
  leadId: string;
  at: string;
  byName: string;
  kind: 'note' | 'follow_up';
  /** The note text; for a follow-up, its optional note. */
  text: string | null;
  /** A follow-up's "Phone call — No answer"; null for a plain note. */
  summary: string | null;
}

/** One recruiter in the automatic lead rotation, in turn order. */
export interface LeadRotationMember {
  employeeId: string;
  name: string;
  /** When they became a recruiter (ISO), the key the order is by. */
  since: string;
}

/**
 * The automatic assignment of online applications (owner, 2026-10-07): strict turns over the
 * active recruiters, ordered by when each became a recruiter.
 */
export interface LeadRotation {
  recruiters: LeadRotationMember[];
  next: LeadRotationMember | null;
  last: { employeeId: string; name: string; at: string } | null;
}

/** A lead as "My leads" lists it: the lead plus its newest note or follow-up. */
export interface MyLeadRow {
  id: string;
  leadNumber: string;
  name: string;
  phone: string;
  email: string | null;
  source: string;
  status: 'new' | 'contacted' | 'prequalified' | 'converted' | 'dead';
  applicantId: string | null;
  createdAt: string;
  contactedAt: string | null;
  lastNote: LeadNote | null;
}

export interface MyLeads {
  /** The recruiter whose leads these are; null when the account is not linked to an employee. */
  recruiter: { employeeId: string; name: string; isRecruiter: boolean } | null;
  leads: MyLeadRow[];
}

export const MyLeadsQuerySchema = z.object({
  recruiterEmployeeId: z.string().min(1).max(80).optional(),
});
export type MyLeadsQuery = z.infer<typeof MyLeadsQuerySchema>;
