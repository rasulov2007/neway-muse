import { z } from 'zod';
import { COMPLIANCE_SUBJECTS, DRIVER_RELATION_TOPICS, MANAGEMENT_CALL_TOPICS, type DriverRelationTopic } from '../driver-relations/index.js';

/**
 * Driver Care and referrals from the app (mobile M3, docs/mobile/API.md §10–§11).
 *
 * A message is an ordinary Driver Relations request (`driver_relation_requests`, source
 * `driver_app`) whose driver is the signed-in one - never a typed name. It is routed to the team
 * that answers it: pay and reimbursement questions to Accounting, compliance to Safety, the rest to
 * Driver Relations. A complaint (and a confidential call request) stays confidential: only staff
 * holding driver_relations.confidential see it. The driver sees the acknowledgement, the status and
 * the replies staff chose to share - never internal notes.
 */

export const DRIVER_CARE_TEAMS = ['driver_relations', 'accounting', 'safety'] as const;
export type DriverCareTeam = (typeof DRIVER_CARE_TEAMS)[number];

export const DRIVER_CARE_TEAM_LABEL: Record<DriverCareTeam, string> = {
  driver_relations: 'Driver Relations',
  accounting: 'Accounting',
  safety: 'Safety',
};

/** Which team answers a topic. */
export function careTeamFor(topic: DriverRelationTopic): DriverCareTeam {
  if (topic === 'pay_statement' || topic === 'reimbursement') return 'accounting';
  if (topic === 'compliance') return 'safety';
  return 'driver_relations';
}

export const DriverCareCreateSchema = z
  .object({
    topic: z.enum(DRIVER_RELATION_TOPICS),
    /** compliance: cdl · medical_card · other; management_call: the call topic; otherwise free. */
    subtopic: z.string().trim().max(60).nullable().optional(),
    message: z.string().trim().min(3, 'Write a few words').max(4000),
    /** From POST /driver/files. */
    attachments: z.array(z.string().min(1)).max(5).default([]),
    /** Pay statement / reimbursement questions may name the week or the load. */
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    loadNumber: z.string().trim().max(40).nullable().optional(),
    /** management_call: when the driver can talk (their own words, their own zone). */
    preferredTime: z.string().trim().max(150).nullable().optional(),
    /** referral only. */
    referralName: z.string().trim().max(120).nullable().optional(),
    referralPhone: z.string().trim().max(40).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.topic === 'compliance' && v.subtopic && !(COMPLIANCE_SUBJECTS as readonly string[]).includes(v.subtopic)) {
      ctx.addIssue({ code: 'custom', path: ['subtopic'], message: `Choose one of ${COMPLIANCE_SUBJECTS.join(', ')}` });
    }
    if (v.topic === 'management_call' && v.subtopic && !(MANAGEMENT_CALL_TOPICS as readonly string[]).includes(v.subtopic)) {
      ctx.addIssue({ code: 'custom', path: ['subtopic'], message: `Choose one of ${MANAGEMENT_CALL_TOPICS.join(', ')}` });
    }
    if (v.topic === 'referral' && (!v.referralName || !v.referralPhone)) {
      ctx.addIssue({ code: 'custom', path: ['referralName'], message: 'A referral needs the person’s name and phone (or use /driver/referrals).' });
    }
  });
export type DriverCareCreateInput = z.input<typeof DriverCareCreateSchema>;

export const DRIVER_CARE_STATES = ['received', 'in_progress', 'resolved'] as const;
export type DriverCareState = (typeof DRIVER_CARE_STATES)[number];
export const DRIVER_CARE_STATE_LABEL: Record<DriverCareState, string> = {
  received: 'Received',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

export interface DriverCareRequest {
  id: string;
  /** DR-1042: the acknowledgement the driver can quote. */
  number: string;
  topic: DriverRelationTopic;
  topicLabel: string;
  subtopic: string | null;
  message: string;
  team: DriverCareTeam;
  teamLabel: string;
  confidential: boolean;
  state: DriverCareState;
  stateLabel: string;
  acknowledgedAt: string;
  /** Replies staff shared with the driver, oldest first. Internal notes never appear. */
  responses: Array<{ at: string; byName: string; text: string }>;
  attachments: string[];
  lastUpdate: string;
}

export interface DriverCareList {
  requests: DriverCareRequest[];
}

// ------------------------------------------------------------------------------ referrals

export const DriverReferralCreateSchema = z
  .object({
    name: z.string().trim().min(2, 'Their name').max(120),
    phone: z.string().trim().min(7, 'Their phone').max(40),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type DriverReferralCreateInput = z.input<typeof DriverReferralCreateSchema>;

/** Non-sensitive progress only: a stage word, never notes, reasons or results. */
export const DRIVER_REFERRAL_STAGES = ['received', 'contacted', 'in_review', 'hiring', 'hired', 'closed'] as const;
export type DriverReferralStage = (typeof DRIVER_REFERRAL_STAGES)[number];
export const DRIVER_REFERRAL_STAGE_LABEL: Record<DriverReferralStage, string> = {
  received: 'Received',
  contacted: 'Contacted by Recruiting',
  in_review: 'In review',
  hiring: 'In hiring',
  hired: 'Hired',
  closed: 'Closed',
};

export interface DriverReferral {
  id: string;
  number: string;
  name: string;
  stage: DriverReferralStage;
  stageLabel: string;
  submittedAt: string;
}

export interface DriverReferralList {
  referrals: DriverReferral[];
  /** From the company setting `referral.bonus_amount`; null = not set, the app shows nothing. */
  bonusAmountCents: number | null;
}
