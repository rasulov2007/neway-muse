/**
 * The accounting records, shaped to `docs/DATABASE.md` §3.13–§3.14.
 *
 * Column names and enums match the committed schema so the Postgres layer maps onto these
 * interfaces without a translation layer. Where the brief asked for something the schema does not
 * have, it is marked — the general ledger in particular is new, since the schema stops at
 * `expense_categories` and `ledger_periods`.
 */
import type {
  BillStatus,
  JournalEntry,
  LedgerPeriod,
  PayrollStatus,
  SettlementLineKind,
  SettlementStatus,
} from '@neway/shared';
import type { IsoDate, IsoDateTime } from './types';

// ---------------------------------------------------------------------------------------------
// Vendors (`vendors`)
// ---------------------------------------------------------------------------------------------

export type VendorKind =
  | 'shop'
  | 'dealer'
  | 'tire'
  | 'mobile_repair'
  | 'parts'
  | 'towing'
  | 'fuel'
  | 'tolls'
  | 'insurance'
  | 'lease'
  | 'other';

/** Somebody at the vendor worth knowing by name: the service writer, the night dispatcher. */
export interface VendorContact {
  id: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * A vendor: the one record accounting bills against and the fleet opens work orders with.
 *
 * The fields after `contactEmail` arrived with the fleet vendor records; older rows may not carry
 * them, which is why they are optional rather than defaulted to a made-up value.
 */
export interface Vendor {
  id: string;
  name: string;
  kind: VendorKind;
  city: string;
  state: string;
  paymentTermsDays: number;
  status: 'active' | 'inactive';
  /** The expense category this vendor's bills usually land in. */
  defaultCategory: string;
  contactName: string | null;
  contactEmail: string | null;
  phone?: string | null;
  street?: string | null;
  zip?: string | null;
  email?: string | null;
  website?: string | null;
  /** Our account or customer number with them. */
  accountNumber?: string | null;
  notes?: string | null;
  contacts?: VendorContact[];
  /** Retired as a duplicate (owner, 2026-10-14): the record its orders moved to. Kept, hidden. */
  mergedIntoId?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Invoice lines (`invoice_lines`) — the Invoice itself is already in types.ts
// ---------------------------------------------------------------------------------------------

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  loadId: string | null;
  /** `charge_types.code`. Decides which revenue account the line credits. */
  chargeType: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
}

// ---------------------------------------------------------------------------------------------
// Payments (`payments`, `payment_applications`)
// ---------------------------------------------------------------------------------------------

export type PaymentMethod = 'ach' | 'check' | 'card' | 'wire' | 'factoring' | 'cash';

export interface PaymentApplication {
  id: string;
  paymentId: string;
  invoiceId: string | null;
  billId: string | null;
  amount: number;
  appliedAt: IsoDateTime;
}

export interface Payment {
  id: string;
  /** `in` is money received; `out` is money paid to a vendor or a driver. */
  direction: 'in' | 'out';
  partyType: 'customer' | 'broker' | 'vendor' | 'driver' | 'employee';
  partyId: string;
  partyName: string;
  amount: number;
  method: PaymentMethod;
  receivedOn: IsoDate;
  reference: string;
  /** Received but not yet allocated to an invoice. Held as a liability until it is. */
  unappliedAmount: number;
  applications: PaymentApplication[];
  notes: string | null;
  createdAt: IsoDateTime;
  createdBy: string;
}

// ---------------------------------------------------------------------------------------------
// Bills (`bills`)
// ---------------------------------------------------------------------------------------------

export interface Bill {
  id: string;
  billNumber: string;
  /** The vendor's own invoice number, which is what they will quote on the phone. */
  vendorInvoiceNumber: string | null;
  vendorId: string;
  vendorName: string;
  issuedOn: IsoDate;
  dueOn: IsoDate;
  paymentTermsDays: number;
  amount: number;
  paid: number;
  balance: number;
  status: BillStatus;
  /** `expense_categories.code`. */
  categoryCode: string;
  /** Where it came from, so a bill raised by a repair order is never keyed twice. */
  source: 'repair_order' | 'fuel' | 'tolls' | 'lease' | 'manual';
  sourceId: string | null;
  truckId: string | null;
  unitNumber: string | null;
  trailerId: string | null;
  loadId: string | null;
  loadNumber: string | null;
  approvedAt: IsoDateTime | null;
  approvedBy: string | null;
  /** Why approval was needed, from the shared engine. Null when none was. */
  approvalReason: string | null;
  scheduledFor: IsoDate | null;
  notes: string | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------------------------
// Expenses (`expenses`)
// ---------------------------------------------------------------------------------------------

export interface Expense {
  id: string;
  expenseNumber: string;
  onDate: IsoDate;
  /** `expense_categories.code`. */
  categoryCode: string;
  description: string;
  amount: number;
  /** The dimensions that make profitability and cost-per-mile possible. */
  truckId: string | null;
  unitNumber: string | null;
  trailerId: string | null;
  driverId: string | null;
  driverName: string | null;
  loadId: string | null;
  loadNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** Where it came from, so the same fuel fill never becomes two expenses. */
  source: 'manual' | 'fuel' | 'maintenance' | 'tolls' | 'payroll' | 'settlement' | 'allocation';
  sourceId: string | null;
  /** The bill it sits behind, when it is not paid directly. */
  billId: string | null;
  paymentMethod: PaymentMethod | null;
  /** The ledger account it posted to, from the shared mapping. */
  accountCode: string;
  status: 'draft' | 'posted' | 'void';
  postedAt: IsoDateTime | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------------------------
// Settlements (`settlements`, `settlement_lines`, `deduction_plans`)
// ---------------------------------------------------------------------------------------------

export interface SettlementLineRecord {
  id: string;
  settlementId: string;
  kind: SettlementLineKind;
  loadId: string | null;
  loadNumber: string | null;
  description: string;
  amount: number;
  /** The arithmetic behind the amount, so the driver can check it. */
  basis: string;
}

export interface Settlement {
  id: string;
  settlementNumber: string;
  driverId: string;
  driverName: string;
  truckId: string | null;
  unitNumber: string | null;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: SettlementStatus;
  payPlanKind: string;
  payPlanRate: number;
  gross: number;
  deductions: number;
  escrow: number;
  adjustments: number;
  net: number;
  loadCount: number;
  totalMiles: number;
  lines: SettlementLineRecord[];
  /** Loads that could not be paid, named with why. Never silently dropped. */
  excluded: Array<{ loadId: string; loadNumber: string; reason: string }>;
  /** Deductions that could not be taken in full because the settlement did not cover them. */
  shortfall: number | null;
  finalizedAt: IsoDateTime | null;
  finalizedBy: string | null;
  paidAt: IsoDateTime | null;
  paymentId: string | null;
  notes: string | null;
}

export interface DeductionPlan {
  id: string;
  driverId: string;
  kind: 'escrow' | 'insurance' | 'lease' | 'advance_repayment' | 'other';
  description: string;
  amountPerPeriod: number;
  /** Remaining balance; the deduction never takes more than this. Null means open-ended. */
  balance: number | null;
  totalCap: number | null;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  /**
   * `on_hold` is a charge that exists but may not run yet - a repair charged to a driver who has
   * not been told. It keeps its balance so accounting can show what is waiting, and no settlement
   * ever subtracts it.
   */
  status: 'active' | 'completed' | 'cancelled' | 'on_hold';
}

// ---------------------------------------------------------------------------------------------
// Payroll (`payroll_periods`, `payslips`)
// ---------------------------------------------------------------------------------------------

export interface Payslip {
  id: string;
  payrollPeriodId: string;
  employeeId: string;
  employeeName: string;
  title: string;
  workerType: 'employee' | 'contractor';
  hourly: boolean;
  hours: number | null;
  basePay: number;
  bonuses: number;
  /** Null when nobody has recorded withholding. Never estimated. */
  taxWithheld: number | null;
  deductions: number;
  gross: number;
  netPay: number;
  /** True once the period is finalised; only an adjustment can change it after that. */
  locked: boolean;
  notes: string | null;
}

export interface PayrollPeriod {
  id: string;
  periodNumber: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  payDate: IsoDate;
  status: PayrollStatus;
  gross: number;
  taxWithheld: number;
  deductions: number;
  net: number;
  workerCount: number;
  finalizedAt: IsoDateTime | null;
  finalizedBy: string | null;
  paidAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------------------------
// Ledger — new; no equivalent table in the committed schema
// ---------------------------------------------------------------------------------------------

export type { JournalEntry, LedgerPeriod };
