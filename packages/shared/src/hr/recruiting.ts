import { z } from 'zod';
import { EMPLOYEE_DEPARTMENTS, EMPLOYMENT_TYPES, PAY_TYPES } from '../people/employee.js';

/**
 * Recruiting: the front of the employee lifecycle.
 *
 * A candidate is not a person record in their own right — they are someone who may become one. The
 * hire converts them by creating an employee and storing that employee's id on the applicant, so
 * the person exists exactly once and the trail from application to employment is a foreign key
 * rather than a matching exercise on names.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// -------------------------------------------------------------------------------- job openings

export const JOB_OPENING_STATUSES = [
  'draft',
  'open',
  'on_hold',
  'filled',
  'closed',
  'cancelled',
] as const;
export type JobOpeningStatus = (typeof JOB_OPENING_STATUSES)[number];

export const JOB_OPENING_TRANSITIONS: Record<JobOpeningStatus, readonly JobOpeningStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['on_hold', 'filled', 'closed', 'cancelled'],
  on_hold: ['open', 'closed', 'cancelled'],
  filled: ['closed', 'open'],
  closed: ['open'],
  cancelled: [],
};

export const JobOpeningSchema = z.object({
  id: z.string(),
  jobNumber: z.string(),
  title: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  location: z.string().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  hiringManagerEmployeeId: z.string().nullable(),
  hiringManagerName: z.string().nullable(),
  openDate: isoDate,
  targetHireDate: isoDate.nullable(),
  positionsCount: z.number().int(),
  status: z.enum(JOB_OPENING_STATUSES),
  notes: z.string().nullable(),
  /** Candidates currently in the pipeline for this opening, counted by the database. */
  activeCandidates: z.number().int(),
  hiredCount: z.number().int(),
  createdAt: z.string(),
});
export type JobOpeningRecord = z.infer<typeof JobOpeningSchema>;

export const CreateJobOpeningSchema = z.object({
  title: z.string().trim().min(1, 'A job title is required').max(80),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  location: z.string().trim().max(60).nullable().default(null),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  hiringManagerEmployeeId: z.string().nullable().default(null),
  openDate: isoDate,
  targetHireDate: isoDate.nullable().default(null),
  positionsCount: z.number().int().min(1).max(500).default(1),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateJobOpeningRequest = z.infer<typeof CreateJobOpeningSchema>;

// ----------------------------------------------------------------------------------- applicants

/**
 * The pipeline.
 *
 * `hired`, `rejected` and `withdrawn` are terminal. Everything before them moves forward or
 * backward freely, because a real pipeline sends people back a stage more often than anybody's
 * process diagram admits.
 */
export const APPLICANT_STAGES = [
  'applied',
  'screening',
  'interview',
  'assessment',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];

export const ACTIVE_APPLICANT_STAGES: readonly ApplicantStage[] = [
  'applied',
  'screening',
  'interview',
  'assessment',
  'offer',
];

export const TERMINAL_APPLICANT_STAGES: readonly ApplicantStage[] = [
  'hired',
  'rejected',
  'withdrawn',
];

export const APPLICANT_SOURCES = [
  'referral',
  'job_board',
  'website',
  'walk_in',
  'agency',
  'social',
  // Driver hiring's own channels (owner, 2026-09-29); plain text in the database, no migration.
  'facebook',
  'instagram',
  'phone_call',
  'other',
] as const;

export const ApplicantSchema = z.object({
  id: z.string(),
  applicantNumber: z.string(),
  jobOpeningId: z.string().nullable(),
  jobTitle: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  position: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  location: z.string().nullable(),
  source: z.string().nullable(),
  stage: z.enum(APPLICANT_STAGES),
  closedReason: z.string().nullable(),
  assignedRecruiterEmployeeId: z.string().nullable(),
  recruiterName: z.string().nullable(),
  driverType: z.string().nullable(),
  appliedOn: isoDate,
  hiredEmployeeId: z.string().nullable(),
  hiredOn: isoDate.nullable(),
  notes: z.string().nullable(),
  /** Most recent activity on this candidate, so a list can show what actually last happened. */
  lastActivityAt: z.string().nullable(),
  interviewCount: z.number().int(),
  nextInterviewAt: z.string().nullable(),
  /**
   * The driver hiring case behind this candidate, when they came in as a driver lead. A candidate
   * with one is on the driver track and is moved by the case, never by the office stages.
   */
  hiringCaseId: z.string().nullable(),
  /** That case's state (HIRING_STATES), read with the candidate; null on the office track. */
  hiringState: z.string().nullable(),
  createdAt: z.string(),
});
export type ApplicantRecord = z.infer<typeof ApplicantSchema>;

export const CreateApplicantSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(40),
  lastName: z.string().trim().min(1, 'Last name is required').max(40),
  email: z.email('That is not a valid email address'),
  phone: z.string().trim().min(7, 'A contact number is required').max(20),
  position: z.string().trim().min(1, 'A position is required').max(60),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  jobOpeningId: z.string().nullable().default(null),
  location: z.string().trim().max(60).nullable().default(null),
  source: z.enum(APPLICANT_SOURCES).nullable().default(null),
  assignedRecruiterEmployeeId: z.string().nullable().default(null),
  driverType: z.enum(['company', 'owner_operator', 'lease_operator']).nullable().default(null),
  appliedOn: isoDate,
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateApplicantRequest = z.infer<typeof CreateApplicantSchema>;

export const UpdateApplicantSchema = CreateApplicantSchema.partial().omit({ appliedOn: true });
export type UpdateApplicantRequest = z.infer<typeof UpdateApplicantSchema>;

export const MoveApplicantStageSchema = z.object({
  stage: z.enum(APPLICANT_STAGES),
  /** Required when a candidate leaves the pipeline; a rejection with no reason is indefensible. */
  reason: z.string().trim().max(400).nullable().default(null),
});
export type MoveApplicantStageRequest = z.infer<typeof MoveApplicantStageSchema>;

/** Hiring never happens through a stage move: it creates a person, so it has its own operation. */
export const HireApplicantSchema = z.object({
  hireDate: isoDate,
  position: z.string().trim().min(1).max(60).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  managerEmployeeId: z.string().nullable().default(null),
  location: z.string().trim().max(60).nullable().default(null),
  payType: z.enum(PAY_TYPES).nullable().default(null),
  payRate: z.number().positive().nullable().default(null),
  /** Build the onboarding plan as part of the hire. Default on, because that is the point. */
  startOnboarding: z.boolean().default(true),
  onboardingTemplateId: z.string().nullable().default(null),
});
export type HireApplicantRequest = z.infer<typeof HireApplicantSchema>;

export interface HireResult {
  applicant: ApplicantRecord;
  employeeId: string;
  employeeNumber: string;
  onboardingChecklistId: string | null;
}

// ----------------------------------------------------------------------------------- interviews

export const INTERVIEW_KINDS = [
  'phone_screen',
  'in_person',
  'video',
  'panel',
  'road_test',
] as const;
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
export const INTERVIEW_RECOMMENDATIONS = ['advance', 'hold', 'reject'] as const;

export const InterviewSchema = z.object({
  id: z.string(),
  applicantId: z.string(),
  kind: z.enum(INTERVIEW_KINDS),
  scheduledAt: z.string(),
  interviewerEmployeeId: z.string().nullable(),
  interviewerName: z.string().nullable(),
  location: z.string().nullable(),
  status: z.enum(INTERVIEW_STATUSES),
  score: z.number().int().nullable(),
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS).nullable(),
  notes: z.string().nullable(),
});
export type InterviewRecord = z.infer<typeof InterviewSchema>;

export const CreateInterviewSchema = z.object({
  kind: z.enum(INTERVIEW_KINDS),
  scheduledAt: z.string().min(1, 'A date and time is required'),
  interviewerEmployeeId: z.string().nullable().default(null),
  location: z.string().trim().max(120).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateInterviewRequest = z.infer<typeof CreateInterviewSchema>;

export const RecordInterviewOutcomeSchema = z.object({
  status: z.enum(INTERVIEW_STATUSES),
  score: z.number().int().min(1).max(5).nullable().default(null),
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS).nullable().default(null),
  notes: z.string().trim().max(4000).nullable().default(null),
});
export type RecordInterviewOutcomeRequest = z.infer<typeof RecordInterviewOutcomeSchema>;

// --------------------------------------------------------------------------------------- offers

export const OFFER_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'cancelled',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['accepted', 'declined', 'expired', 'cancelled'],
  accepted: [],
  declined: [],
  expired: ['sent'],
  cancelled: [],
};

export const OfferSchema = z.object({
  id: z.string(),
  offerNumber: z.string(),
  applicantId: z.string(),
  position: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  payType: z.enum(PAY_TYPES).nullable(),
  payRate: z.number().nullable(),
  startDate: isoDate,
  expiresOn: isoDate.nullable(),
  status: z.enum(OFFER_STATUSES),
  notes: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * Driver offers only; null on an office offer. The pay plan is the roster's own enum, so the
   * offer and the driver profile it becomes never disagree about how the person is paid.
   */
  hiringCaseId: z.string().nullable(),
  driverType: z.string().nullable(),
  payPlanKind: z.string().nullable(),
  payPlanRate: z.number().nullable(),
  signOnBonus: z.number().nullable(),
  referralBonus: z.number().nullable(),
  referringDriverId: z.string().nullable(),
  referringDriverName: z.string().nullable(),
  orientationDate: isoDate.nullable(),
  sentAt: z.string().nullable(),
});
export type OfferRecord = z.infer<typeof OfferSchema>;

export const CreateOfferSchema = z.object({
  position: z.string().trim().min(1).max(60),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  payType: z.enum(PAY_TYPES).nullable().default(null),
  payRate: z.number().positive().nullable().default(null),
  startDate: isoDate,
  expiresOn: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateOfferRequest = z.infer<typeof CreateOfferSchema>;

// -------------------------------------------------------------------------------------- queries

export const RecruitingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  stage: z.enum(APPLICANT_STAGES).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  jobOpeningId: z.string().max(40).optional(),
  recruiterEmployeeId: z.string().max(40).optional(),
  source: z.string().max(40).optional(),
  appliedFrom: isoDate.optional(),
  appliedTo: isoDate.optional(),
  sort: z.enum(['name', 'appliedOn', 'stage', 'position']).default('appliedOn'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  /**
   * Which hiring track: `driver` = candidates with a driver hiring case (converted from a lead),
   * `office` = everyone else. Omitted = both. Office-staff lists always ask for `office`, so a
   * driver candidate can never appear among office roles.
   */
  track: z.enum(['office', 'driver']).optional(),
  /** Terminal stages are hidden unless asked for; a pipeline is about who is still in it. */
  includeClosed: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export type RecruitingQuery = z.infer<typeof RecruitingQuerySchema>;

export interface RecruitingSummary {
  openPositions: number;
  activeCandidates: number;
  interviewsScheduled: number;
  offersOutstanding: number;
  hiredThisMonth: number;
  rejected: number;
  byStage: { stage: ApplicantStage; count: number }[];
  /**
   * Mean days from application to hire, over candidates actually hired. `null` when nobody has
   * been hired yet — an average of nothing is not zero days.
   */
  averageDaysToHire: number | null;
}
