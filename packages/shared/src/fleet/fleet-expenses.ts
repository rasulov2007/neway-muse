import { z } from 'zod';

/**
 * Fleet expenses: what a truck cost the fleet, who paid it and who bears it.
 *
 * One expense is one cost. Two questions are kept apart because the money moves differently:
 *  - **Paid by**: who funded the payment (the company, the driver, the truck's owner).
 *  - **Charge to**: who bears the cost in the end (the company, or a driver it is recovered from).
 *
 * The four outcomes (owner brief, 2026-10-12):
 *  - company pays, company bears → one company expense: a vendor bill when unpaid, the payment
 *    record when paid;
 *  - company pays, driver bears  → the payment once, plus one driver charge recovered through
 *    settlements (never a second expense);
 *  - driver pays, company bears  → a reimbursement in Accounting, not another expense;
 *  - driver/owner pays and bears it → tracked fleet spend only: no payable, no deduction.
 *
 * Repairs are not entered here twice: a completed work order shows up as a projection of the
 * order (source `work_order`), never as a stored expense.
 *
 * Money is integer cents throughout.
 */

export const FLEET_EXPENSE_CATEGORIES = [
  // Cash given to a driver on the road for a truck cost (owner, 2026-10-13).
  'cash_advance',
  'parking',
  'truck_wash',
  'repair_maintenance',
  'tolls',
  'fuel',
  'permits',
  'scale',
  'lumper',
  'supplies',
  'other',
] as const;
export type FleetExpenseCategory = (typeof FLEET_EXPENSE_CATEGORIES)[number];

export const FLEET_EXPENSE_CATEGORY_LABEL: Record<FleetExpenseCategory, string> = {
  cash_advance: 'Cash advance',
  parking: 'Parking',
  truck_wash: 'Truck Wash',
  repair_maintenance: 'Repair/Maintenance',
  tolls: 'Tolls',
  fuel: 'Fuel',
  permits: 'Permits',
  scale: 'Scale',
  lumper: 'Lumper',
  supplies: 'Supplies',
  other: 'Other',
};

/** The Accounting category each one posts under; parking and wash have no account of their own yet. */
export const FLEET_EXPENSE_ACCOUNTING_CATEGORY: Record<FleetExpenseCategory, string> = {
  cash_advance: 'other',
  parking: 'other',
  truck_wash: 'other',
  repair_maintenance: 'maintenance',
  tolls: 'tolls',
  fuel: 'fuel',
  permits: 'permits',
  scale: 'other',
  lumper: 'lumper',
  supplies: 'other',
  other: 'other',
};

/** The reimbursement category a driver-paid expense goes to Accounting under. */
export const FLEET_EXPENSE_REIMBURSEMENT_CATEGORY: Record<FleetExpenseCategory, 'lumper' | 'scale' | 'parking' | 'repair_supplies' | 'other'> = {
  cash_advance: 'other',
  parking: 'parking',
  truck_wash: 'other',
  repair_maintenance: 'repair_supplies',
  tolls: 'other',
  fuel: 'other',
  permits: 'other',
  scale: 'scale',
  lumper: 'lumper',
  supplies: 'repair_supplies',
  other: 'other',
};

/** Where a place matters: parking requires one, a wash shows one, the rest may record one. */
export function locationRule(category: FleetExpenseCategory): 'required' | 'shown' | 'optional' {
  if (category === 'parking') return 'required';
  if (category === 'truck_wash') return 'shown';
  return 'optional';
}

export const FLEET_EXPENSE_PAYERS = ['company', 'driver', 'owner'] as const;
export type FleetExpensePayer = (typeof FLEET_EXPENSE_PAYERS)[number];
/** `owner` is the truck's vendor - the person whose own truck it is (owner, 2026-10-28: Vendor pays). */
export const FLEET_EXPENSE_PAYER_LABEL: Record<FleetExpensePayer, string> = { company: 'Company', driver: 'Driver', owner: 'Vendor' };

/**
 * Who bears it in the end. `investigation`: not decided yet between the company and a driver
 * (owner, 2026-10-13) - nothing is deducted and nothing is posted until somebody decides.
 */
export const FLEET_EXPENSE_CHARGE_TO = ['company', 'driver', 'owner', 'investigation'] as const;
export type FleetExpenseChargeTo = (typeof FLEET_EXPENSE_CHARGE_TO)[number];
export const FLEET_EXPENSE_CHARGE_TO_LABEL: Record<FleetExpenseChargeTo, string> = { company: 'Company', driver: 'Driver', owner: 'Vendor pays', investigation: 'Under investigation' };

/** The payment methods Accounting already uses, plus EFS. */
export const FLEET_PAYMENT_METHODS = ['card', 'ach', 'check', 'cash', 'wire', 'efs', 'other'] as const;
export type FleetPaymentMethod = (typeof FLEET_PAYMENT_METHODS)[number];
export const FLEET_PAYMENT_METHOD_LABEL: Record<FleetPaymentMethod, string> = {
  card: 'Company card',
  ach: 'ACH',
  check: 'Check',
  cash: 'Cash',
  wire: 'Wire',
  efs: 'EFS',
  other: 'Other',
};

export const EFS_STATUSES = ['issued', 'used', 'partially_used', 'unused', 'cancelled', 'verified'] as const;
export type EfsStatus = (typeof EFS_STATUSES)[number];
export const EFS_STATUS_LABEL: Record<EfsStatus, string> = {
  issued: 'Issued',
  used: 'Used',
  partially_used: 'Partially used',
  unused: 'Unused',
  cancelled: 'Cancelled',
  verified: 'Verified',
};

export const FLEET_EXPENSE_STATUSES = ['draft', 'recorded', 'void'] as const;
export type FleetExpenseStatus = (typeof FLEET_EXPENSE_STATUSES)[number];

export type FleetExpenseOutcome = 'company_cost' | 'driver_charge' | 'reimbursement' | 'external' | 'investigation';

export const FLEET_EXPENSE_OUTCOME_LABEL: Record<FleetExpenseOutcome, string> = {
  company_cost: 'Company expense',
  driver_charge: 'Company paid, driver charge',
  reimbursement: 'Driver paid, company reimburses',
  external: 'Paid and borne externally',
  investigation: 'Company paid, under investigation',
};

/** Which of the four outcomes an expense is. */
export function expenseOutcome(paidBy: FleetExpensePayer, chargeTo: FleetExpenseChargeTo): FleetExpenseOutcome {
  if (chargeTo === 'investigation') return 'investigation';
  if (paidBy === 'company') return chargeTo === 'driver' ? 'driver_charge' : 'company_cost';
  if (chargeTo === 'company') return 'reimbursement';
  return 'external';
}

/** Payment status as the list shows it: separate from driver recovery. */
export const FLEET_PAYMENT_STATUSES = ['paid', 'unpaid', 'partially_paid', 'reimbursement_pending', 'reimbursement_approved', 'reimbursed', 'reimbursement_rejected', 'paid_externally', 'not_billed', 'draft', 'void'] as const;
export type FleetPaymentStatus = (typeof FLEET_PAYMENT_STATUSES)[number];
export const FLEET_PAYMENT_STATUS_LABEL: Record<FleetPaymentStatus, string> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  partially_paid: 'Partially paid',
  reimbursement_pending: 'Reimbursement pending',
  reimbursement_approved: 'Reimbursement approved',
  reimbursed: 'Reimbursed',
  reimbursement_rejected: 'Reimbursement rejected',
  paid_externally: 'Paid externally',
  /** A repair with no vendor bill in Accounting yet. */
  not_billed: 'Not billed',
  draft: 'Draft',
  void: 'Void',
};

/** Recovery from a driver, in the finance model's own states. */
export const FLEET_RECOVERY_STATUSES = ['none', 'not_posted', 'pending_review', 'approved', 'in_settlement', 'partially_deducted', 'deducted', 'disputed', 'paused', 'cancelled'] as const;
export type FleetRecoveryStatus = (typeof FLEET_RECOVERY_STATUSES)[number];
export const FLEET_RECOVERY_STATUS_LABEL: Record<FleetRecoveryStatus, string> = {
  none: 'No recovery',
  not_posted: 'Awaiting Accounting',
  pending_review: 'Pending review',
  approved: 'Approved',
  in_settlement: 'Added to settlement',
  partially_deducted: 'Partially deducted',
  deducted: 'Deducted',
  disputed: 'Disputed',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

export const FLEET_EXPENSE_SOURCES = ['manual', 'work_order'] as const;
export type FleetExpenseSource = (typeof FLEET_EXPENSE_SOURCES)[number];
export const FLEET_EXPENSE_SOURCE_LABEL: Record<FleetExpenseSource, string> = { manual: 'Manual', work_order: 'From Maintenance' };

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Cents = z.number().int().min(0).max(100_000_000_00);
/** Notes are not squeezed into a tweet; the bound is the one other long notes in the app use. */
export const FLEET_EXPENSE_NOTES_MAX = 5000;

export const FleetExpenseLocationSchema = z.object({
  placeName: z.string().trim().max(160).nullable().default(null),
  address: z.string().trim().max(300).nullable().default(null),
  city: z.string().trim().max(120).nullable().default(null),
  state: z.string().trim().max(40).nullable().default(null),
  postalCode: z.string().trim().max(20).nullable().default(null),
});

export const FleetExpenseEfsSchema = z.object({
  /** The full code as typed; stored sealed and never returned in full, logged or printed. */
  code: z.string().trim().max(64).nullable().default(null),
  issuedOn: IsoDay.nullable().default(null),
  issuedCents: Cents.nullable().default(null),
  usedCents: Cents.nullable().default(null),
  status: z.enum(EFS_STATUSES).default('used'),
  receiptFileId: z.string().nullable().default(null),
});

export const FleetExpenseChargeSchema = z.object({
  driverId: z.string().min(1),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
  /** A request to recover through settlements; Accounting approves it (it never happens on save). */
  deductFromSettlement: z.boolean().default(true),
});

export const SaveFleetExpenseSchema = z.object({
  status: z.enum(['draft', 'recorded']).default('recorded'),
  /** Optional (owner, 2026-10-23): some costs belong to no one truck. '' means no truck. */
  truckId: z.string().default(''),
  category: z.enum(FLEET_EXPENSE_CATEGORIES),
  expenseDate: IsoDay,
  /** For EFS the actual used amount is the amount; for everything else it is the receipt. */
  amountCents: Cents,
  vendorId: z.string().nullable().default(null),
  vendorName: z.string().trim().max(160).nullable().default(null),
  invoiceNumber: z.string().trim().max(80).nullable().default(null),
  description: z.string().trim().max(300).nullable().default(null),
  notes: z.string().trim().max(FLEET_EXPENSE_NOTES_MAX).nullable().default(null),
  location: FleetExpenseLocationSchema.default({ placeName: null, address: null, city: null, state: null, postalCode: null }),
  paidBy: z.enum(FLEET_EXPENSE_PAYERS),
  /** The driver who paid, when a driver did. */
  payerDriverId: z.string().nullable().default(null),
  payerName: z.string().trim().max(160).nullable().default(null),
  paymentMethod: z.enum(FLEET_PAYMENT_METHODS).nullable().default(null),
  /** Whether the company has already paid (company-paid only); unpaid becomes a vendor bill. */
  paid: z.boolean().default(true),
  paymentReference: z.string().trim().max(120).nullable().default(null),
  chargeTo: z.enum(FLEET_EXPENSE_CHARGE_TO),
  charge: FleetExpenseChargeSchema.nullable().default(null),
  efs: FleetExpenseEfsSchema.nullable().default(null),
  /** Set when the person saw the possible repair duplicate and says this is a different cost. */
  notDuplicateOf: z.string().nullable().default(null),
  expectedVersion: z.number().int().min(0).optional(),
});
export type SaveFleetExpenseInput = z.input<typeof SaveFleetExpenseSchema>;
export type SaveFleetExpense = z.infer<typeof SaveFleetExpenseSchema>;

export interface FleetExpenseProblem {
  field: string;
  message: string;
}

/**
 * The rules a recorded expense has to meet, in words a person can act on. A draft only needs a
 * category; everything else can wait.
 */
export function validateFleetExpense(input: SaveFleetExpense): FleetExpenseProblem[] {
  const out: FleetExpenseProblem[] = [];
  const draft = input.status === 'draft';
  const efs = input.paymentMethod === 'efs';
  if (efs && input.paidBy !== 'company') out.push({ field: 'paymentMethod', message: 'EFS is company money: Paid by must be Company.' });
  if (efs && !draft) {
    if (!input.efs) out.push({ field: 'efs', message: 'Enter the EFS details.' });
    else {
      if (input.efs.issuedCents === null) out.push({ field: 'efs.issuedCents', message: 'Enter the issued amount.' });
      if (input.efs.usedCents === null) out.push({ field: 'efs.usedCents', message: 'Enter the amount actually used.' });
      if (input.efs.issuedCents !== null && input.efs.usedCents !== null && input.efs.usedCents > input.efs.issuedCents) out.push({ field: 'efs.usedCents', message: 'Used cannot be more than issued.' });
      if (input.efs.usedCents !== null && input.efs.usedCents !== input.amountCents) out.push({ field: 'amountCents', message: 'For EFS the amount is what was actually used.' });
    }
  }
  if (!draft) {
    const unusedEfs = efs && input.efs?.usedCents === 0;
    if (input.amountCents <= 0 && !unusedEfs) out.push({ field: 'amountCents', message: 'Enter an amount above $0.00.' });
    if (locationRule(input.category) === 'required') {
      if (!input.location.placeName) out.push({ field: 'location.placeName', message: 'Parking needs the parking name.' });
      if (!input.location.address && !(input.location.city && input.location.state)) out.push({ field: 'location.address', message: 'Parking needs the location or address.' });
    }
  }
  if (input.paidBy === 'driver' && !input.payerDriverId && !draft) out.push({ field: 'payerDriverId', message: 'Choose the driver who paid.' });
  if (input.paidBy === 'owner' && input.chargeTo !== 'owner') out.push({ field: 'chargeTo', message: 'A cost the vendor paid is the vendor’s own: Charge to must be Vendor pays. Vendor reimbursements go through Accounting › Payables.' });
  if (input.chargeTo === 'owner' && input.paidBy !== 'owner') out.push({ field: 'chargeTo', message: 'Vendor pays is only for a cost the vendor paid themselves.' });
  if (input.chargeTo === 'investigation' && input.paidBy !== 'company') out.push({ field: 'chargeTo', message: 'Under investigation is for money the company paid out: Paid by must be Company.' });
  if (input.paidBy === 'driver' && input.chargeTo === 'driver' && input.charge) out.push({ field: 'charge', message: 'A driver’s own cost is not charged to them again.' });
  if (input.paidBy === 'company' && input.chargeTo === 'driver') {
    if (!input.charge) out.push({ field: 'charge', message: 'Choose the driver, the amount and the reason for the charge.' });
    else if (input.charge.amountCents > input.amountCents && !draft) out.push({ field: 'charge.amountCents', message: 'The charge cannot be more than the expense.' });
  }
  if (input.chargeTo === 'investigation' && input.charge && input.charge.amountCents > input.amountCents && !draft) out.push({ field: 'charge.amountCents', message: 'The amount in question cannot be more than the expense.' });
  if (input.chargeTo !== 'driver' && input.chargeTo !== 'investigation' && input.charge && input.paidBy === 'company') out.push({ field: 'charge', message: 'Charge to is Company: remove the driver charge or set Charge to Driver.' });
  return out;
}

/** The figures an expense contributes; one definition used by every page and report. */
export interface FleetExpenseFigures {
  /** Everything tracked on the truck, external costs included. */
  spendCents: number;
  /** What the company bears in the end. */
  companyCents: number;
  /** Assigned for recovery from a driver. */
  driverChargeCents: number;
  /** Paid and borne by a driver or owner themselves. */
  externalCents: number;
  /** Company money whose bearer is not decided yet. */
  investigationCents: number;
}

export function expenseFigures(e: { status: FleetExpenseStatus; amountCents: number; paidBy: FleetExpensePayer; chargeTo: FleetExpenseChargeTo; chargeCents: number | null }): FleetExpenseFigures {
  if (e.status !== 'recorded') return { spendCents: 0, companyCents: 0, driverChargeCents: 0, externalCents: 0, investigationCents: 0 };
  const outcome = expenseOutcome(e.paidBy, e.chargeTo);
  if (outcome === 'investigation') return { spendCents: e.amountCents, companyCents: 0, driverChargeCents: 0, externalCents: 0, investigationCents: e.amountCents };
  const charge = outcome === 'driver_charge' ? Math.min(e.chargeCents ?? 0, e.amountCents) : 0;
  return {
    spendCents: e.amountCents,
    companyCents: outcome === 'external' ? 0 : e.amountCents - charge,
    driverChargeCents: charge,
    externalCents: outcome === 'external' ? e.amountCents : 0,
    investigationCents: 0,
  };
}

/** Masks an EFS code to its last four, for every screen, PDF and log. */
export function maskEfsCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const clean = code.replace(/\s+/g, '');
  if (clean.length <= 4) return '••••';
  return `•••• ${clean.slice(-4)}`;
}

// ------------------------------------------------------------------ views

export interface FleetExpenseFileView {
  id: string;
  fileId: string;
  fileName: string;
  contentType: string | null;
  kind: 'receipt' | 'invoice' | 'efs_receipt' | 'other';
  addedAt: string;
  addedBy: string;
  /** False for evidence Accounting already relies on, or the original Maintenance invoice. */
  removable: boolean;
  removeBlockedReason: string | null;
}

export interface FleetExpenseRecoveryEntry {
  settlementId: string;
  settlementNumber: string | null;
  cents: number;
  at: string;
  status: 'draft' | 'posted' | 'reversed';
  reversedAt?: string | null;
  reversedBy?: string | null;
  reason?: string | null;
}

export interface FleetExpenseRecovery {
  driverTxId: string;
  driverId: string;
  driverName: string | null;
  state: string;
  chargeCents: number;
  deductedCents: number;
  remainingCents: number;
  perSettlementCents: number | null;
  /** The draft statement that would take it now, with what it would take; not deducted yet. */
  inDraft: { settlementId: string; settlementNumber: string; cents: number } | null;
  entries: FleetExpenseRecoveryEntry[];
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface FleetExpenseAccountingLink {
  kind: 'bill' | 'payment' | 'driver_charge' | 'reimbursement' | 'settlement' | 'work_order';
  id: string;
  label: string;
  status: string;
  amountCents: number | null;
  at: string | null;
  by: string | null;
  href: string;
}

export interface FleetExpenseHistoryEntry {
  at: string;
  by: string;
  action: string;
  summary: string;
  reason: string | null;
}

export interface FleetExpenseRow {
  id: string;
  source: FleetExpenseSource;
  /** EXP-00001, or the repair order number for a Maintenance projection. */
  reference: string;
  status: FleetExpenseStatus;
  truckId: string;
  unitNumber: string;
  category: FleetExpenseCategory;
  categoryLabel: string;
  expenseDate: string;
  amountCents: number;
  vendorName: string | null;
  placeName: string | null;
  city: string | null;
  state: string | null;
  description: string | null;
  paidBy: FleetExpensePayer;
  paymentMethod: FleetPaymentMethod | null;
  chargeTo: FleetExpenseChargeTo;
  chargeDriverName: string | null;
  chargeCents: number | null;
  paymentStatus: FleetPaymentStatus;
  recoveryStatus: FleetRecoveryStatus;
  outcome: FleetExpenseOutcome;
  figures: FleetExpenseFigures;
  /** For a Maintenance projection: the work order to open. */
  workOrderId: string | null;
  efsMasked: string | null;
  fileCount: number;
  version: number;
}

export interface FleetExpenseDetail extends FleetExpenseRow {
  vendorId: string | null;
  invoiceNumber: string | null;
  notes: string | null;
  address: string | null;
  postalCode: string | null;
  payerDriverId: string | null;
  payerDriverName: string | null;
  payerName: string | null;
  paid: boolean;
  paymentReference: string | null;
  chargeDriverId: string | null;
  chargeReason: string | null;
  deductFromSettlement: boolean;
  efs: {
    masked: string | null;
    issuedOn: string | null;
    issuedCents: number | null;
    usedCents: number | null;
    /** Issued but not used: never spend. */
    unusedCents: number | null;
    status: EfsStatus;
    receiptFileId: string | null;
  } | null;
  recovery: FleetExpenseRecovery | null;
  accounting: {
    state: 'not_required' | 'awaiting_posting' | 'posted' | 'draft' | 'void';
    links: FleetExpenseAccountingLink[];
    postedAt: string | null;
    postedBy: string | null;
  };
  files: FleetExpenseFileView[];
  history: FleetExpenseHistoryEntry[];
  createdAt: string;
  createdBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  permissions: { canEdit: boolean; canPost: boolean; canRecover: boolean; canVoid: boolean };
}

export const FleetExpenseListQuerySchema = z.object({
  from: IsoDay.optional(),
  to: IsoDay.optional(),
  truckId: z.string().optional(),
  category: z.enum(FLEET_EXPENSE_CATEGORIES).optional(),
  paidBy: z.enum(FLEET_EXPENSE_PAYERS).optional(),
  chargeTo: z.enum(FLEET_EXPENSE_CHARGE_TO).optional(),
  paymentStatus: z.enum(FLEET_PAYMENT_STATUSES).optional(),
  recoveryStatus: z.enum(FLEET_RECOVERY_STATUSES).optional(),
  source: z.enum(FLEET_EXPENSE_SOURCES).optional(),
  /** KPI drill-downs: only rows that carry this figure. */
  figure: z.enum(['company', 'driver_outstanding', 'unpaid_bills', 'efs_remaining', 'external', 'investigation']).optional(),
  /** Leave out the repair/maintenance projection and the Repair/Maintenance category (Repair log › Expenses). */
  nonMaintenance: z.coerce.boolean().optional(),
  includeDrafts: z.coerce.boolean().optional(),
  includeVoid: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'truck', 'category']).default('amount_desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type FleetExpenseListQuery = z.infer<typeof FleetExpenseListQuerySchema>;
export type FleetExpenseListQueryInput = z.input<typeof FleetExpenseListQuerySchema>;

export interface FleetExpenseTotals {
  spendCents: number;
  companyCents: number;
  driverChargeCents: number;
  driverOutstandingCents: number;
  externalCents: number;
  investigationCents: number;
  unpaidBillsCents: number;
  efsRemainingCents: number;
  count: number;
  byCategory: Array<{ category: FleetExpenseCategory; label: string; cents: number; count: number }>;
}

export interface FleetExpenseList {
  rows: FleetExpenseRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: FleetExpenseTotals;
}

export interface FleetExpenseDashboard {
  from: string;
  to: string;
  totals: FleetExpenseTotals;
  byTruck: Array<{ truckId: string; unitNumber: string; cents: number; companyCents: number; count: number }>;
  recent: FleetExpenseRow[];
  /** Posted company cost can lag recorded spend: explained, not hidden. */
  timing: { awaitingPostingCount: number; awaitingPostingCents: number };
}

export const FleetExpenseRecoveryActionSchema = z.discriminatedUnion('action', [
  /** Approve for the next eligible settlement, optionally capped per settlement (partial). */
  z.object({ action: z.literal('add_to_settlement'), perSettlementCents: z.number().int().positive().nullable().default(null), reason: z.string().trim().max(500).default('') }),
  z.object({ action: z.literal('hold'), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().min(3).max(500) }),
  /** Reverse one posted deduction: the balance comes back and the driver is refunded next settlement. */
  z.object({ action: z.literal('reverse'), settlementId: z.string().min(1), reason: z.string().trim().min(3).max(500) }),
]);
export type FleetExpenseRecoveryAction = z.infer<typeof FleetExpenseRecoveryActionSchema>;

// ------------------------------------------------------------------ investigations

/**
 * Money nobody has decided who bears yet (owner, 2026-10-13): a repair or an expense set to
 * "Under investigation". It is not deducted from anyone; it waits on the driver (when one is
 * named), on the unit and on Costs until a fleet manager or Safety settles it.
 */
export const INVESTIGATION_OVERDUE_DAYS = 30;

export interface InvestigationItem {
  kind: 'work_order' | 'fleet_expense';
  id: string;
  reference: string;
  unitKind: 'truck' | 'trailer';
  unitId: string;
  unitNumber: string;
  /** The driver in question, when one is named. */
  driverId: string | null;
  driverName: string | null;
  amountCents: number;
  date: string;
  /** When it was put under investigation (the record's creation, or the last change of payer). */
  since: string;
  days: number;
  overdue: boolean;
  description: string | null;
  /** True for a repair that is still open: an estimate, not spend yet. */
  open: boolean;
  version: number;
}

export interface InvestigationList {
  items: InvestigationItem[];
  totalCents: number;
  overdueCount: number;
  canResolve: boolean;
}

export const InvestigationQuerySchema = z.object({
  driverId: z.string().optional(),
  unitId: z.string().optional(),
  from: IsoDay.optional(),
  to: IsoDay.optional(),
});
export type InvestigationQuery = z.infer<typeof InvestigationQuerySchema>;

export const ResolveInvestigationSchema = z
  .object({
    kind: z.enum(['work_order', 'fleet_expense']),
    id: z.string().min(1),
    to: z.enum(['company', 'driver']),
    driverId: z.string().min(1).nullable().default(null),
    /** For an expense: what the driver is charged (defaults to the whole amount). */
    amountCents: z.number().int().positive().nullable().default(null),
    /** For a repair: whether the driver has been told (a driver charge waits until they have). */
    driverInformed: z.boolean().nullable().default(null),
    reason: z.string().trim().min(3, 'Say what the investigation found').max(1000),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.to === 'driver' && v.kind === 'work_order' && v.driverInformed === null) ctx.addIssue({ code: 'custom', path: ['driverInformed'], message: 'Say whether the driver has been told about this charge' });
  });
export type ResolveInvestigationInput = z.input<typeof ResolveInvestigationSchema>;
