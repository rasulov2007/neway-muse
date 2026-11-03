import { z } from 'zod';

/**
 * Claims v2 phase 1 (owner brief, 2026-10-13): a driver charge - a deductible or chargeback raised
 * on a claim - from the moment Safety applies it to the last settlement deduction.
 *
 * The workflow lives here (who was told, Accounting's checklist, disputes, Management exceptions);
 * the money is Accounting's own driver transaction, created on approval and recovered by the
 * existing settlement engine. Nothing is deducted until Accounting approves.
 */

export const DRIVER_CHARGE_STATES = [
  'on_hold',
  'informed',
  'pending_accounting',
  'approved',
  'recovering',
  'recovered',
  'rejected',
  'disputed',
  'paused',
  'pending_management',
  'waived',
  'cancelled',
] as const;
export type DriverChargeState = (typeof DRIVER_CHARGE_STATES)[number];

export const DRIVER_CHARGE_STATE_LABEL: Record<DriverChargeState, string> = {
  on_hold: 'On hold · driver notification pending',
  informed: 'Driver informed',
  pending_accounting: 'Pending Accounting review',
  approved: 'Approved',
  recovering: 'Recovering',
  recovered: 'Recovered',
  rejected: 'Rejected',
  disputed: 'Disputed',
  paused: 'Paused',
  pending_management: 'Waiting on Management',
  waived: 'Waived',
  cancelled: 'Cancelled',
};

/** The tone a state reads in: symbol + word + colour. */
export const DRIVER_CHARGE_STATE_TONE: Record<DriverChargeState, 'urgent' | 'warning' | 'done' | 'moving' | 'neutral'> = {
  on_hold: 'urgent',
  informed: 'moving',
  pending_accounting: 'warning',
  approved: 'moving',
  recovering: 'moving',
  recovered: 'done',
  rejected: 'neutral',
  disputed: 'urgent',
  paused: 'warning',
  pending_management: 'warning',
  waived: 'neutral',
  cancelled: 'neutral',
};

/** States that still count: a second charge for the same source, driver and basis is refused. */
export const ACTIVE_CHARGE_STATES: DriverChargeState[] = ['on_hold', 'informed', 'pending_accounting', 'approved', 'recovering', 'disputed', 'paused', 'pending_management'];
export const isActiveCharge = (s: DriverChargeState) => ACTIVE_CHARGE_STATES.includes(s);

/** The Driver charges queue: one section per stage of the trip, as the mockup groups them. */
export const CHARGE_QUEUE_SECTIONS = [
  { key: 'on_hold', label: 'Notification pending (on hold)', note: 'These are frozen. Nothing goes to Accounting until Safety records how the driver was told.', states: ['on_hold'] },
  { key: 'management', label: 'Waiting on Management', note: 'Disputes and waiver/adjustment requests.', states: ['disputed', 'pending_management'] },
  { key: 'accounting', label: 'With Accounting', note: 'Driver informed; Accounting verifies authorization and recoverability.', states: ['informed', 'pending_accounting'] },
  { key: 'recovering', label: 'Being recovered', note: 'Scheduled deductions or payments in progress.', states: ['approved', 'recovering', 'paused'] },
  { key: 'finished', label: 'Finished', note: null, states: ['recovered', 'waived', 'rejected', 'cancelled'] },
] as const satisfies readonly { key: string; label: string; note: string | null; states: readonly DriverChargeState[] }[];

/** The six chips on the charge card. */
export const CHARGE_PROGRESS = [
  { key: 'on_hold', label: 'On hold' },
  { key: 'informed', label: 'Informed' },
  { key: 'pending_accounting', label: 'Accounting review' },
  { key: 'approved', label: 'Approved' },
  { key: 'recovering', label: 'Recovering' },
  { key: 'recovered', label: 'Recovered' },
] as const;

export const DRIVER_CHARGE_BASES = ['deductible_accident', 'deductible_cargo', 'damage_below_deductible', 'lease_chargeback', 'other'] as const;
export type DriverChargeBasis = (typeof DRIVER_CHARGE_BASES)[number];
export const DRIVER_CHARGE_BASIS_LABEL: Record<DriverChargeBasis, string> = {
  deductible_accident: 'Accident deductible',
  deductible_cargo: 'Cargo deductible',
  damage_below_deductible: 'Damage below the deductible',
  lease_chargeback: 'Lease chargeback',
  other: 'Other',
};

export const NOTIFY_METHODS = ['in_person', 'phone', 'driver_app', 'email', 'text'] as const;
export const NOTIFY_METHOD_LABEL: Record<(typeof NOTIFY_METHODS)[number], string> = {
  in_person: 'In person (terminal)',
  phone: 'Phone call',
  driver_app: 'Driver app',
  email: 'Email',
  text: 'Text message',
};
export const DRIVER_RESPONSES = ['signed', 'verbal', 'refused', 'disputes'] as const;
export const DRIVER_RESPONSE_LABEL: Record<(typeof DRIVER_RESPONSES)[number], string> = {
  signed: 'Signed acknowledgment',
  verbal: 'Verbal acknowledgment',
  refused: 'Refused to sign',
  disputes: 'Disputes the charge',
};

export const REJECT_REASONS = ['no_authorization', 'not_recoverable', 'wrong_amount', 'wrong_driver', 'policy', 'other'] as const;
export const REJECT_REASON_LABEL: Record<(typeof REJECT_REASONS)[number], string> = {
  no_authorization: 'No valid authorization',
  not_recoverable: 'Not recoverable from this driver',
  wrong_amount: 'Wrong amount',
  wrong_driver: 'Wrong driver',
  policy: 'Against policy or law',
  other: 'Other',
};

/** Who is responsible for the incident (Claims v2 §2.1). The deductible needs our driver. */
export const LIABILITY_PARTIES = ['our_driver', 'other_party', 'shared', 'none', 'undetermined'] as const;
export type LiabilityParty = (typeof LIABILITY_PARTIES)[number];
export const LIABILITY_PARTY_LABEL: Record<LiabilityParty, string> = {
  our_driver: 'Our driver',
  other_party: 'Other party',
  shared: 'Shared',
  none: 'No one',
  undetermined: 'Under review',
};

/**
 * The owner's decisions (2026-10-13 §10). Settings, not rules: kept in one place so a company
 * setting can replace them without touching the workflow.
 */
export const CLAIM_CHARGE_POLICY = {
  companyDriverCents: 500_000,
  ownerOperatorCents: 250_000,
  mgmtThresholdCents: 100_000,
  installmentCapCents: 25_000,
  installmentCapOwnerOperatorCents: 50_000,
  holdDaysSafetyManager: 3,
  holdDaysManagement: 7,
  pendingAccountingDays: 3,
  staleDays: 7,
} as const;

export type DriverKind = 'company' | 'owner_operator';
export const driverKindOf = (driverType: string | null | undefined): DriverKind => (driverType === 'company' || !driverType ? 'company' : 'owner_operator');
export const policyCentsFor = (kind: DriverKind) => (kind === 'company' ? CLAIM_CHARGE_POLICY.companyDriverCents : CLAIM_CHARGE_POLICY.ownerOperatorCents);
export const installmentCapFor = (kind: DriverKind) => (kind === 'company' ? CLAIM_CHARGE_POLICY.installmentCapCents : CLAIM_CHARGE_POLICY.installmentCapOwnerOperatorCents);

export interface DriverChargeHistoryEntry {
  at: string;
  by: string;
  action: string;
  from: DriverChargeState | null;
  to: DriverChargeState;
  note: string | null;
}

export interface DriverCharge {
  id: string;
  number: string;
  claimId: string | null;
  claimNumber: string | null;
  driverId: string;
  driverName: string;
  driverKind: DriverKind;
  basis: DriverChargeBasis;
  policyCents: number;
  amountCents: number;
  adjustReason: string | null;
  state: DriverChargeState;
  stateBeforeHold: DriverChargeState | null;
  notifiedOn: string | null;
  notifiedBy: string | null;
  notifyMethod: (typeof NOTIFY_METHODS)[number] | null;
  driverResponse: (typeof DRIVER_RESPONSES)[number] | null;
  noticeFileId: string | null;
  authorizationFileId: string | null;
  leaseClause: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  recoveryMethod: 'settlement_deduction' | 'escrow' | 'direct_payment' | null;
  installmentCents: number | null;
  installmentsTotal: number | null;
  driverTxId: string | null;
  /** From the settlement engine: what statements (and direct payments) took. Never typed in. */
  recoveredCents: number;
  remainingCents: number;
  disputeText: string | null;
  disputeRaisedBy: string | null;
  pendingChange: { kind: 'waive' | 'adjust'; amountCents: number | null; reason: string; requestedBy: string } | null;
  waiveReason: string | null;
  isTest: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Days in the current state. */
  ageDays: number;
  history: DriverChargeHistoryEntry[];
  recoveryLog: Array<{ label: string; cents: number; at: string; reversed: boolean }>;
  version: number;
}

const cents = z.number().int().positive().max(100_000_000);
const v = { version: z.number().int().nonnegative() };

export const ApplyDriverChargeSchema = z.object({
  amountCents: cents,
  basis: z.enum(DRIVER_CHARGE_BASES),
  reason: z.string().trim().max(500).nullable().optional(),
  /** The driver was told already: the notice fields, as Mark driver informed takes them. */
  notice: z
    .object({
      notifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      method: z.enum(NOTIFY_METHODS),
      response: z.enum(DRIVER_RESPONSES),
      fileId: z.string().min(1, 'Attach the evidence'),
    })
    .nullable()
    .optional(),
  isTest: z.boolean().optional(),
});
export type ApplyDriverChargeInput = z.infer<typeof ApplyDriverChargeSchema>;

export const NotifyDriverSchema = z.object({
  ...v,
  notifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(NOTIFY_METHODS),
  response: z.enum(DRIVER_RESPONSES),
  fileId: z.string().min(1, 'Attach the evidence: signed notice, call log or screenshot'),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type NotifyDriverInput = z.infer<typeof NotifyDriverSchema>;

export const ApproveDriverChargeSchema = z.object({
  ...v,
  method: z.enum(['settlement_deduction', 'escrow', 'direct_payment']),
  installmentCents: cents,
  authorizationFileId: z.string().min(1).nullable().optional(),
  leaseClause: z.string().trim().max(200).nullable().optional(),
  checklist: z.object({
    authorizationOrLease: z.literal(true, { message: 'Confirm the authorization (company driver) or the lease clause (owner-operator)' }),
    compliesWithLaw: z.literal(true, { message: 'Confirm it complies with the driver agreement, applicable law and payroll rules' }),
  }),
  overrideNote: z.string().trim().max(1000).nullable().optional(),
});
export type ApproveDriverChargeInput = z.infer<typeof ApproveDriverChargeSchema>;

export const RejectDriverChargeSchema = z.object({ ...v, reason: z.enum(REJECT_REASONS), note: z.string().trim().min(3, 'Say why').max(1000) });
export type RejectDriverChargeInput = z.infer<typeof RejectDriverChargeSchema>;

export const DriverChargePaymentSchema = z.object({
  ...v,
  amountCents: cents,
  source: z.enum(['direct', 'escrow']),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().trim().max(120).nullable().optional(),
});
export type DriverChargePaymentInput = z.infer<typeof DriverChargePaymentSchema>;

export const DriverChargeReasonSchema = z.object({ ...v, reason: z.string().trim().min(3, 'Say why').max(1000) });
export type DriverChargeReasonInput = z.infer<typeof DriverChargeReasonSchema>;

export const DisputeDriverChargeSchema = z.object({ ...v, raisedBy: z.string().trim().min(1).max(120), text: z.string().trim().min(3, 'What does the driver dispute?').max(2000) });
export type DisputeDriverChargeInput = z.infer<typeof DisputeDriverChargeSchema>;

export const ResolveDriverChargeSchema = z.object({
  ...v,
  outcome: z.enum(['uphold', 'reduce', 'waive']),
  amountCents: cents.nullable().optional(),
  note: z.string().trim().min(3, 'Explain the decision').max(1000),
});
export type ResolveDriverChargeInput = z.infer<typeof ResolveDriverChargeSchema>;

export const ChangeRequestSchema = z.object({
  ...v,
  kind: z.enum(['waive', 'adjust']),
  amountCents: cents.nullable().optional(),
  reason: z.string().trim().min(3, 'Say why').max(1000),
});
export type ChangeRequestInput = z.infer<typeof ChangeRequestSchema>;

export const VersionOnlyChargeSchema = z.object({ ...v, note: z.string().trim().max(1000).nullable().optional() });
export type VersionOnlyChargeInput = z.infer<typeof VersionOnlyChargeSchema>;

export const SetLiabilitySchema = z.object({
  version: z.number().int().nonnegative(),
  party: z.enum(LIABILITY_PARTIES),
  pct: z.number().int().min(0).max(100).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type SetLiabilityInput = z.infer<typeof SetLiabilitySchema>;

export const LogClaimUpdateSchema = z.object({
  version: z.number().int().nonnegative(),
  note: z.string().trim().min(3, 'What happened?').max(2000),
  nextAction: z.string().trim().max(300).nullable().optional(),
  nextActionDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  ownerId: z.string().nullable().optional(),
});
export type LogClaimUpdateInput = z.infer<typeof LogClaimUpdateSchema>;

/** Business days between two Eastern dates (weekends skipped), for hold escalations. */
export function businessDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso.slice(0, 10)}T12:00:00Z`);
  const to = new Date(`${toIso.slice(0, 10)}T12:00:00Z`);
  let n = 0;
  const d = new Date(from);
  while (d < to) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return n;
}

/** Number of installments a plan takes. */
export const installmentsFor = (amountCents: number, perCents: number) => Math.max(1, Math.ceil(amountCents / Math.max(1, perCents)));
