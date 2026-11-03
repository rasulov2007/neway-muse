/**
 * The work order contract, and the maintenance settings behind the Today page.
 *
 * Two deliberate narrowings from what the workspace held. `status` is two values rather than six,
 * because a work order is either being worked on or finished, and the six were quietly carrying a
 * second fact — how far along the shop was — which is now `shopStage` and has its own history.
 * And costs are a separate shape: `WorkOrder` has no money on it at all, so a response to somebody
 * without the cost permission cannot accidentally include a total. `WorkOrderWithCost` adds them.
 *
 * Fleet specification §3.5. The shop stages live in one list so a carrier can add to them.
 */

import { z } from 'zod';
import { WorkOrderTirePositionSchema } from './tire-positions.js';

/** A work order is against a truck or a trailer, and never both. */
export const ASSET_TYPES = ['truck', 'trailer'] as const;
export const AssetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  truck: 'Truck',
  trailer: 'Trailer',
};

/**
 * Three states. Booked into a shop (the appointment - the unit is still on the road), the shop
 * has the unit, or the work is finished. `scheduled` is what the Oil change / PM board writes
 * (docs/pm-module §3.7): the same record later moves to `in_shop` and `completed`, so the
 * appointment and the completion are one work order, never two.
 */
export const WORK_ORDER_STATUSES = ['scheduled', 'in_shop', 'completed'] as const;
export const WorkOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatusSchema>;

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  scheduled: 'Scheduled into a shop',
  in_shop: 'In shop',
  completed: 'Completed',
};

/**
 * How far along the shop is, while it has the unit.
 *
 * One list, in the order work actually moves, so a carrier can add a stage without a code change
 * reaching into six screens. `ready_for_pickup` is last because it is the one a coordinator is
 * waiting for, and it is the only stage that is good news.
 */
export const SHOP_STAGES = [
  'diagnosing',
  'waiting_approval',
  'waiting_parts',
  'in_repair',
  'quality_check',
  'ready_for_pickup',
] as const;
export const ShopStageSchema = z.enum(SHOP_STAGES);
export type ShopStage = z.infer<typeof ShopStageSchema>;

export const SHOP_STAGE_LABEL: Record<ShopStage, string> = {
  diagnosing: 'Diagnosing',
  waiting_approval: 'Waiting for approval',
  waiting_parts: 'Waiting for parts',
  in_repair: 'In repair',
  quality_check: 'Quality check / road test',
  ready_for_pickup: 'Ready for pickup',
};

/**
 * The kinds of work the shop does, as a mechanic would name them.
 *
 * Six, not the twenty the expense engine categorises by. A mechanic picking from a list at a
 * counter needs the shortest list that still routes the record correctly, and the three that
 * matter — oil change, annual inspection, PM — are the ones that update a unit's service clock.
 */
export const WORK_TYPES = [
  'oil_change',
  'annual_inspection',
  'pm_inspection',
  'repair',
  // What broke, named (owner, 2026-10-19): so Costs and the unit's history say engine, DPF …
  'engine',
  'electrical_harness',
  'frame',
  'body_repair',
  'steer_component',
  'dpf',
  'injector',
  'computer_module',
  /** Repairing a truck after an accident (owner, 2026-10-13). */
  'accident_repair',
  'tires',
  'other',
] as const;
export const WorkTypeSchema = z.enum(WORK_TYPES);
export type WorkType = z.infer<typeof WorkTypeSchema>;

export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  oil_change: 'Oil change',
  annual_inspection: 'Annual DOT inspection',
  pm_inspection: 'PM / mid-trip inspection',
  repair: 'Repair',
  engine: 'Engine',
  electrical_harness: 'Electrical harness',
  frame: 'Frame issue',
  body_repair: 'Body issue',
  steer_component: 'Steer component',
  dpf: 'DPF issue',
  injector: 'Injector issue',
  computer_module: 'Computer / Module',
  accident_repair: 'Accident repair',
  tires: 'Tires',
  other: 'Other',
};

/** The work types that reset a service clock when a record is completed. */
export const SERVICE_RESETTING_TYPES: Record<WorkType, 'oil' | 'annual' | 'pm' | null> = {
  oil_change: 'oil',
  annual_inspection: 'annual',
  pm_inspection: 'pm',
  repair: null,
  engine: null,
  electrical_harness: null,
  frame: null,
  body_repair: null,
  steer_component: null,
  dpf: null,
  injector: null,
  computer_module: null,
  accident_repair: null,
  tires: null,
  other: null,
};

/** One entry in a work order's history. */
export const WorkOrderActionSchema = z.object({
  id: z.string(),
  action: z.enum(['created', 'stage_changed', 'note_added', 'completed', 'reopened', 'voided']),
  stage: ShopStageSchema.nullable(),
  note: z.string().nullable(),
  userName: z.string(),
  createdAt: z.string(),
});
export type WorkOrderAction = z.infer<typeof WorkOrderActionSchema>;

/**
 * Who pays for the work (the owner's 2026-09-24 rule).
 *
 * `company` is the ordinary case: the bill is a company expense. `driver` means the repair is
 * charged back to the driver, and then one more thing has to be true before accounting may take
 * it off what the driver earned - the driver has to have been told. A charge the driver has not
 * been told about is not a silent deduction: it is held, said plainly on the repair log and
 * raised in accounting until somebody records that the driver was informed.
 */
export const WORK_ORDER_CHARGE_PARTIES = ['company', 'driver', 'investigation', 'vendor', 'warranty'] as const;
export type WorkOrderChargeParty = (typeof WORK_ORDER_CHARGE_PARTIES)[number];
export const WorkOrderChargePartySchema = z.enum(WORK_ORDER_CHARGE_PARTIES);
/**
 * `investigation`: who pays is not decided yet - nothing is taken off a driver until a fleet
 * manager or Safety settles it. `warranty`: claimed back from the maker or the shop
 * (owner, 2026-10-13). `vendor`: the truck's vendor pays it - a vendor truck's repairs are
 * never a company expense (owner, 2026-10-28).
 */
export const WORK_ORDER_CHARGE_PARTY_LABEL: Record<WorkOrderChargeParty, string> = {
  company: 'Company expense',
  driver: 'Driver charge',
  investigation: 'Under investigation',
  vendor: 'Vendor pays',
  warranty: 'Warranty claim',
};

/** The flag a held charge carries, on the order and in every list that reads it. */
export const DRIVER_NOT_INFORMED_FLAG = 'driver_not_informed';

/** What a driver charge says about itself, on every read of the order. */
export const WorkOrderChargeSchema = z.object({
  party: WorkOrderChargePartySchema,
  /** Who is charged. Null for a company expense. */
  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  /** Null for a company expense; true or false once somebody has answered for a driver charge. */
  driverInformed: z.boolean().nullable(),
  informedAt: z.string().nullable(),
  informedBy: z.string().nullable(),
});
export type WorkOrderCharge = z.infer<typeof WorkOrderChargeSchema>;

/**
 * Recording who pays after the fact - and, above all, recording that the driver has now been
 * told, which is what releases the charge to accounting.
 */
export const SetWorkOrderChargeSchema = z
  .object({
    party: WorkOrderChargePartySchema,
    driverId: z.string().min(1).nullable().optional(),
    driverInformed: z.boolean().nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.party !== 'driver') return;
    if (value.driverInformed === null || value.driverInformed === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['driverInformed'],
        message: 'Say whether the driver has been told about this charge',
      });
    }
  });
export type SetWorkOrderChargeInput = z.infer<typeof SetWorkOrderChargeSchema>;

/**
 * A work order, with no money on it.
 *
 * This is the shape every reader gets. It is not a redacted version of a richer object — the cost
 * fields are not in it, so there is nothing to blank, and a screen written against this type
 * cannot display a total by accident.
 */
export const WorkOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  assetType: AssetTypeSchema,
  unitId: z.string(),
  unitNumber: z.string(),
  status: WorkOrderStatusSchema,
  shopStage: ShopStageSchema.nullable(),
  workType: WorkTypeSchema,
  workDone: z.string().nullable(),
  shopInAt: z.string(),
  completedAt: z.string().nullable(),
  /** Minutes in the shop: frozen at completion, and counted to now while it is open. */
  downtimeMinutes: z.number().int(),
  odometer: z.number().int().nullable(),
  assignedTo: z.string().nullable(),
  /** The label a page shows, built from the unit and the work type rather than typed by anyone. */
  label: z.string(),
  /** The newest entry in the history, which is what a list needs to show "last action". */
  lastAction: WorkOrderActionSchema.nullable(),
  /** The walk-around defect this order was opened for, when it was. The link, not the sentence. */
  defectId: z.string().nullable(),
  /** The PM service this order resets when completed (docs/pm-module §3.5); null for repairs. */
  pmServiceCode: z.string().nullable(),
  /** The appointment (docs/pm-module §3.7): when the unit is booked in, and who is chasing it. */
  scheduledFor: z.string().nullable(),
  responsibleName: z.string().nullable(),
  /** The shop named on the order - a place, not a price, so everybody sees it. */
  vendorName: z.string().nullable(),
  /** The driver on the unit when the list was read; null when it has none. */
  driverName: z.string().nullable(),
  /** Who pays, and - for a driver charge - whether the driver has been told. */
  charge: WorkOrderChargeSchema,
  /** Set when the order was voided (entered by mistake); the record stays, marked. */
  voided: z.object({ at: z.string(), by: z.string().nullable(), reason: z.string().nullable() }).nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Said only in the answer to the save that wrote it (owner, 2026-10-22): the odometer typed was
   * not accepted as a reading - far above or below the last good one - and the person should check it.
   */
  odometerWarning: z.string().nullable().optional(),
});
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

/** The same record for a reader who is allowed to see money. */
export const WorkOrderWithCostSchema = WorkOrderSchema.extend({
  vendorId: z.string().nullable(),
  vendorName: z.string(),
  partsTotal: z.number(),
  laborTotal: z.number(),
  feesTotal: z.number(),
  total: z.number(),
  /** What the shop quoted when the order was booked; null until it says. */
  estimatedCost: z.number().nullable(),
  /** The invoice's own total, as given; null when the record has none. */
  invoiceTotal: z.number().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceFileIds: z.array(z.string()),
  /** Company paid or Pay later; null when it was not said. */
  paymentTerms: z.enum(['company_paid', 'pay_later']).nullable().optional(),
});
export type WorkOrderWithCost = z.infer<typeof WorkOrderWithCostSchema>;

/** One line of what was done. The amount is money and only rides along for a reader who may see it. */
export const WorkOrderLineSchema = z.object({
  id: z.string(),
  systemCode: z.string(),
  description: z.string().nullable(),
  amount: z.number().nullable().optional(),
});
export type WorkOrderLine = z.infer<typeof WorkOrderLineSchema>;

/** A file attached as the invoice, as the page shows it. */
export const WorkOrderFileSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  /** Served with the session; never a public link. */
  url: z.string(),
});
export type WorkOrderFile = z.infer<typeof WorkOrderFileSchema>;

/** A work order and its whole history, for the detail page. */
export const WorkOrderDetailSchema = WorkOrderSchema.extend({
  actions: z.array(WorkOrderActionSchema),
  notes: z.string().nullable(),
  title: z.string().nullable(),
  lines: z.array(WorkOrderLineSchema),
  invoiceFiles: z.array(WorkOrderFileSchema),
  /** The invoice's number is a reference, not a price: every reader gets it. */
  invoiceNumber: z.string().nullable(),
  /** Present only for a reader who may see money. */
  invoiceTotal: z.number().nullable().optional(),
});
export type WorkOrderDetail = z.infer<typeof WorkOrderDetailSchema>;

/** Attaching the shop's invoice to a record after the fact. */
export const AttachInvoiceSchema = z.object({
  fileId: z.string().min(1),
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  invoiceTotal: z.number().nonnegative().nullable().optional(),
});
export type AttachInvoiceInput = z.infer<typeof AttachInvoiceSchema>;

/** A note on the work order while the shop has it (owner, 2026-10-15); kept with who and when. */
export const AddWorkOrderNoteSchema = z.object({
  note: z.string().trim().min(1, 'Write the note first').max(2000),
});
export type AddWorkOrderNoteInput = z.infer<typeof AddWorkOrderNoteSchema>;

// -------------------------------------------------------------------------------------- writes

/** One line of the invoice: the system it was on, what the shop did, and what that part cost. */
export const WorkOrderLineInputSchema = z.object({
  systemCode: z.string().min(1, 'Pick the system'),
  description: z.string().trim().min(1, 'Say what was done').max(200),
  amount: z.number().nonnegative(),
});
export type WorkOrderLineInput = z.infer<typeof WorkOrderLineInputSchema>;

/** Why a completed repair cost nothing: the $0 total needs a reason (specification §2.3). */
export const WORK_ORDER_ZERO_REASONS = ['lease', 'warranty', 'goodwill', 'in_house'] as const;
export type WorkOrderZeroReason = (typeof WORK_ORDER_ZERO_REASONS)[number];
export const WORK_ORDER_ZERO_REASON_LABEL: Record<WorkOrderZeroReason, string> = {
  lease: 'Covered by the lease',
  warranty: 'Warranty',
  goodwill: 'Shop goodwill',
  in_house: 'Done in house',
};

/**
 * The Create work order form (the owner's 2026-09-20 mockup): one dialog for a work order and a
 * repair alike. Written up as completed it carries what the invoice says — the shop, the date the
 * unit went back on the road, the lines and the total; opened or scheduled it carries only what
 * is known so far, and every money field is optional.
 */
/** `INV-2026-1041` for work order `RO-2026-1041`: the invoice number a record gives itself. */
export function defaultInvoiceNumber(workOrderNumber: string): string {
  return workOrderNumber.replace(/^RO-/, 'INV-');
}

/**
 * How the shop's invoice is settled (owner, 2026-10-13): the company paid it at the shop, or it is
 * paid later - and until Accounting pays it, it counts in Unpaid vendor bills.
 */
export const WORK_ORDER_PAYMENT_TERMS = ['company_paid', 'pay_later'] as const;
export type WorkOrderPaymentTerms = (typeof WORK_ORDER_PAYMENT_TERMS)[number];
export const WORK_ORDER_PAYMENT_TERMS_LABEL: Record<WorkOrderPaymentTerms, string> = {
  company_paid: 'Company paid',
  pay_later: 'Pay later',
};

export const CreateWorkOrderSchema = z
  .object({
    assetType: AssetTypeSchema,
    unitId: z.string().min(1, 'Pick the unit the work is on'),
    status: WorkOrderStatusSchema,
    workType: WorkTypeSchema,
    /** What is wrong, in a few words. */
    title: z.string().trim().max(160).optional(),
    /** Left out, the server writes it from the lines. */
    workDone: z.string().trim().optional(),
    shopStage: ShopStageSchema.optional(),
    /** Defaults to now on the server when it is left out. */
    shopInAt: z.string().optional(),
    /** When the shop has the unit booked; only read for status `scheduled`. */
    scheduledFor: z.string().optional(),
    /** Back in service: when the unit went back on the road. Required to complete. */
    completedAt: z.string().optional(),
    odometer: z.number().int().nonnegative().optional(),
    /** The technician. */
    assignedTo: z.string().trim().optional(),
    vendorId: z.string().nullable().optional(),
    vendorName: z.string().trim().max(200).optional(),
    notes: z.string().trim().optional(),
    lines: z.array(WorkOrderLineInputSchema).default([]),
    invoiceTotal: z.number().nonnegative().nullable().optional(),
    zeroReason: z.enum(WORK_ORDER_ZERO_REASONS).nullable().optional(),
    /** Company paid or Pay later; left out, nothing is said about the bill. */
    paymentTerms: z.enum(WORK_ORDER_PAYMENT_TERMS).nullable().optional(),
    /** Tire repairs: the wheel positions, prefilled from the lines by the tire parser (2026-10-13). */
    tirePositions: z.array(WorkOrderTirePositionSchema).max(19).optional(),
    invoiceFileIds: z.array(z.string()).default([]),
    /** The shop's own number; left blank, the record numbers its invoice after itself. */
    invoiceNumber: z.string().trim().max(60).nullable().optional(),
    warranty: z.boolean().default(false),
    /** Opened for a walk-around defect: the server links both ways and moves the defect along. */
    defectId: z.string().optional(),
    /** Who pays. Left out, the work is a company expense. */
    chargeParty: WorkOrderChargePartySchema.default('company'),
    /** Which driver is charged; left out, the server takes the driver assigned to the unit. */
    chargeDriverId: z.string().min(1).nullable().optional(),
    /** Whether the driver has been told. Required for a driver charge, ignored otherwise. */
    driverInformed: z.boolean().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    /*
     * A driver charge has to say whether the driver was told. Not knowing is an answer as well -
     * it is recorded as "not informed" and held - but it has to be given, because the difference
     * decides whether accounting may take the money off the driver's earnings.
     */
    if (value.chargeParty === 'driver' && (value.driverInformed === null || value.driverInformed === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['driverInformed'],
        message: 'Say whether the driver has been told about this charge',
      });
    }
    if (value.status !== 'completed') return;
    /*
     * What a completed repair must say before it can be saved (specification §2.3): the shop, the
     * date back, the total and at least one line with a system. Nothing else blocks — everything
     * else is optional, prefilled, or flagged for review after saving.
     */
    if (!value.vendorId && !value.vendorName) {
      ctx.addIssue({ code: 'custom', path: ['vendorId'], message: 'Pick the shop' });
    }
    if (!value.completedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Say when the unit went back in service',
      });
    }
    if (value.invoiceTotal === null || value.invoiceTotal === undefined) {
      ctx.addIssue({ code: 'custom', path: ['invoiceTotal'], message: 'Enter the invoice total' });
    }
    if (value.lines.length === 0 && !value.workDone) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Add at least one line saying what was done',
      });
    }
    if (value.invoiceTotal === 0 && !value.zeroReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['zeroReason'],
        message: 'A $0 invoice needs a reason',
      });
    }
  });
export type CreateWorkOrderInput = z.infer<typeof CreateWorkOrderSchema>;

/** Two records for one shop (owner, 2026-10-14): the orders move to the one that stays. */
export const MergeVendorSchema = z.object({
  fromVendorId: z.string().min(1),
  toVendorId: z.string().min(1),
  toVendorName: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3, 'Say why').max(500),
});
export type MergeVendorInput = z.infer<typeof MergeVendorSchema>;
export type CreateWorkOrderRequest = z.input<typeof CreateWorkOrderSchema>;

export const UpdateWorkOrderSchema = z.object({
  workType: WorkTypeSchema.optional(),
  workDone: z.string().trim().optional(),
  odometer: z.number().int().nonnegative().nullable().optional(),
  assignedTo: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  shopInAt: z.string().optional(),
});
export type UpdateWorkOrderInput = z.infer<typeof UpdateWorkOrderSchema>;

/**
 * A booked (scheduled) work order taken into the shop (owner, 2026-10-30): the same order, now In
 * the shop, with what the person corrected or added on the way in. Money and the invoice come later.
 */
export const CheckInWorkOrderSchema = z.object({
  workType: WorkTypeSchema.optional(),
  title: z.string().trim().max(160).optional(),
  vendorId: z.string().min(1).nullable().optional(),
  vendorName: z.string().trim().max(200).optional(),
  assignedTo: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  invoiceNumber: z.string().trim().max(60).nullable().optional(),
  /** When it went into the shop; left out, now. */
  shopInAt: z.string().optional(),
});
export type CheckInWorkOrderInput = z.infer<typeof CheckInWorkOrderSchema>;

export const ChangeShopStageSchema = z.object({
  stage: ShopStageSchema,
  note: z.string().trim().max(2000).optional(),
});
export type ChangeShopStageInput = z.infer<typeof ChangeShopStageSchema>;

export const CompleteWorkOrderSchema = z.object({
  workDone: z.string().trim().min(1, 'Say what was done before completing it'),
  completedAt: z.string().optional(),
  odometer: z.number().int().nonnegative().optional(),
});
export type CompleteWorkOrderInput = z.infer<typeof CompleteWorkOrderSchema>;

// ------------------------------------------------------------------------------------ settings

/**
 * Company defaults for the service clocks.
 *
 * Settings rather than constants: a carrier changes an oil interval when it changes oil supplier,
 * and that should not need a deploy. Every one of these is overridable per unit.
 */
export const MaintenanceDefaultsSchema = z.object({
  oilChangeIntervalMiles: z.number().int().positive(),
  /** How many miles short of the interval counts as due soon. */
  oilChangeDueSoonMiles: z.number().int().nonnegative(),
  pmIntervalMiles: z.number().int().positive(),
  pmIntervalDays: z.number().int().positive(),
  pmDueSoonMiles: z.number().int().nonnegative(),
  pmDueSoonDays: z.number().int().nonnegative(),
  annualInspectionMonths: z.number().int().positive(),
  annualInspectionDueSoonDays: z.number().int().nonnegative(),
  /** Days in a shop before the downtime reads amber, then red. */
  downtimeAmberDays: z.number().int().positive(),
  downtimeRedDays: z.number().int().positive(),
});
export type MaintenanceDefaults = z.infer<typeof MaintenanceDefaultsSchema>;

export const MAINTENANCE_DEFAULTS: MaintenanceDefaults = {
  oilChangeIntervalMiles: 25_000,
  oilChangeDueSoonMiles: 1_000,
  pmIntervalMiles: 25_000,
  pmIntervalDays: 90,
  pmDueSoonMiles: 1_000,
  pmDueSoonDays: 14,
  annualInspectionMonths: 12,
  annualInspectionDueSoonDays: 30,
  downtimeAmberDays: 3,
  downtimeRedDays: 7,
};

/** Where a unit stands against a clock. `unknown` means no baseline was ever recorded. */
export const DUE_STATUSES = ['overdue', 'due_soon', 'ok', 'unknown'] as const;
export const DueStatusSchema = z.enum(DUE_STATUSES);
export type DueStatus = z.infer<typeof DueStatusSchema>;

export const DUE_STATUS_LABEL: Record<DueStatus, string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'On schedule',
  unknown: 'No record',
};

// -------------------------------------------------------------------------------------- Today

export const OilChangeRowSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string(),
  description: z.string(),
  odometer: z.number().int().nullable(),
  odometerAt: z.string().nullable(),
  lastOilChangeAt: z.string().nullable(),
  lastOilChangeOdometer: z.number().int().nullable(),
  intervalMiles: z.number().int(),
  /** Positive: miles still to run. Negative: miles past due. Null when there is no baseline. */
  milesRemaining: z.number().int().nullable(),
  status: DueStatusSchema,
});
export type OilChangeRow = z.infer<typeof OilChangeRowSchema>;

export const InspectionRowSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string(),
  assetType: AssetTypeSchema,
  inspectionType: z.enum(['annual_inspection', 'pm_inspection']),
  lastDoneAt: z.string().nullable(),
  lastDoneOdometer: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  dueOdometer: z.number().int().nullable(),
  /** Positive: days left. Negative: days overdue. Null when no baseline exists. */
  daysRemaining: z.number().int().nullable(),
  milesRemaining: z.number().int().nullable(),
  status: DueStatusSchema,
});
export type InspectionRow = z.infer<typeof InspectionRowSchema>;

export const InShopRowSchema = z.object({
  workOrderId: z.string(),
  number: z.string(),
  unitId: z.string(),
  unitNumber: z.string(),
  assetType: AssetTypeSchema,
  workType: WorkTypeSchema,
  label: z.string(),
  shopStage: ShopStageSchema.nullable(),
  shopInAt: z.string(),
  downtimeMinutes: z.number().int(),
  assignedTo: z.string().nullable(),
  lastAction: WorkOrderActionSchema.nullable(),
  /** The shop that has it, when the order names one. */
  vendorName: z.string().nullable(),
  /** The appointment the order was booked for; the date the shop was promised, when there is one. */
  scheduledFor: z.string().nullable(),
});
export type InShopRow = z.infer<typeof InShopRowSchema>;

/**
 * Everything the Today page shows, computed on the server and carrying no money at all.
 *
 * Each section holds only the rows that need attention. A section whose list is empty is the
 * answer "nothing due", and is shown as that rather than as a table with no rows in it.
 */
export const FleetTodaySchema = z.object({
  asOf: z.string(),
  defaults: MaintenanceDefaultsSchema,
  oilChanges: z.array(OilChangeRowSchema),
  inspections: z.array(InspectionRowSchema),
  workOrdersInShop: z.array(InShopRowSchema),
  counts: z.object({
    oilOverdue: z.number().int(),
    oilDueSoon: z.number().int(),
    oilUnknown: z.number().int(),
    inspectionsOverdue: z.number().int(),
    inspectionsDueSoon: z.number().int(),
    inShop: z.number().int(),
    /** Driver-reported breakdowns not closed yet, and those nobody has picked up (mobile M3). */
    breakdownsOpen: z.number().int().optional(),
    breakdownsNew: z.number().int().optional(),
  }),
});
export type FleetToday = z.infer<typeof FleetTodaySchema>;

// --------------------------------------------------------------------------------------- maths

const MS_DAY = 86_400_000;

/**
 * Where a unit stands on its oil change.
 *
 * Miles, never dates: an oil change is a mileage service and a truck that sat for a month is not
 * closer to needing one. A unit with no recorded oil change is `unknown` rather than overdue,
 * because "we have never written one down" and "it is late" call for different actions — the first
 * needs a baseline entered, and calling it overdue would send a mechanic to do work that may have
 * been done last week.
 */
export function oilChangeStatus(input: {
  odometer: number | null;
  lastOdometer: number | null;
  intervalMiles: number;
  dueSoonMiles: number;
}): { milesRemaining: number | null; status: DueStatus } {
  const { odometer, lastOdometer, intervalMiles, dueSoonMiles } = input;
  if (odometer === null || lastOdometer === null)
    return { milesRemaining: null, status: 'unknown' };
  const since = odometer - lastOdometer;
  const remaining = intervalMiles - since;
  if (remaining <= 0) return { milesRemaining: remaining, status: 'overdue' };
  if (remaining <= dueSoonMiles) return { milesRemaining: remaining, status: 'due_soon' };
  return { milesRemaining: remaining, status: 'ok' };
}

/** Whole days from `from` to `to`, by calendar date rather than by elapsed hours. */
export function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / MS_DAY);
}

/** The date an annual inspection falls due: the last one plus the interval in months. */
export function annualInspectionDue(lastDoneAt: string, months: number): string {
  const last = new Date(`${lastDoneAt.slice(0, 10)}T00:00:00Z`);
  const due = new Date(last);
  due.setUTCMonth(due.getUTCMonth() + months);
  return due.toISOString().slice(0, 10);
}

/**
 * Where a unit stands on its annual inspection.
 *
 * Dates only, for trucks and trailers alike, and overdue the day after it expires: under 49 CFR
 * 396.17 the unit may not be operated, which is not a threshold anybody should be able to tune.
 */
export function annualInspectionStatus(input: {
  lastDoneAt: string | null;
  today: string;
  months: number;
  dueSoonDays: number;
}): { dueDate: string | null; daysRemaining: number | null; status: DueStatus } {
  const { lastDoneAt, today, months, dueSoonDays } = input;
  if (!lastDoneAt) return { dueDate: null, daysRemaining: null, status: 'unknown' };
  const dueDate = annualInspectionDue(lastDoneAt, months);
  const daysRemaining = daysBetweenDates(today, dueDate);
  if (daysRemaining < 0) return { dueDate, daysRemaining, status: 'overdue' };
  if (daysRemaining <= dueSoonDays) return { dueDate, daysRemaining, status: 'due_soon' };
  return { dueDate, daysRemaining, status: 'ok' };
}

/**
 * Where a unit stands on its PM inspection: miles or days, whichever comes first.
 *
 * A trailer has no odometer, so it is judged on days alone. That is not a degraded case — it is
 * the only honest one, and inventing miles for it would put a trailer in a mileage ranking it
 * cannot belong to.
 */
export function pmInspectionStatus(input: {
  odometer: number | null;
  lastOdometer: number | null;
  lastDoneAt: string | null;
  today: string;
  intervalMiles: number;
  intervalDays: number;
  dueSoonMiles: number;
  dueSoonDays: number;
}): {
  dueDate: string | null;
  dueOdometer: number | null;
  daysRemaining: number | null;
  milesRemaining: number | null;
  status: DueStatus;
} {
  const {
    odometer,
    lastOdometer,
    lastDoneAt,
    today,
    intervalMiles,
    intervalDays,
    dueSoonMiles,
    dueSoonDays,
  } = input;

  const byMiles =
    odometer !== null && lastOdometer !== null
      ? { remaining: intervalMiles - (odometer - lastOdometer), due: lastOdometer + intervalMiles }
      : null;

  const byDays = lastDoneAt
    ? (() => {
        const due = new Date(`${lastDoneAt.slice(0, 10)}T00:00:00Z`);
        due.setUTCDate(due.getUTCDate() + intervalDays);
        const dueDate = due.toISOString().slice(0, 10);
        return { dueDate, remaining: daysBetweenDates(today, dueDate) };
      })()
    : null;

  if (!byMiles && !byDays) {
    return {
      dueDate: null,
      dueOdometer: null,
      daysRemaining: null,
      milesRemaining: null,
      status: 'unknown',
    };
  }

  const overdue = (byMiles?.remaining ?? 1) <= 0 || (byDays?.remaining ?? 1) < 0;
  const dueSoon =
    (byMiles !== null && byMiles.remaining <= dueSoonMiles) ||
    (byDays !== null && byDays.remaining <= dueSoonDays);

  return {
    dueDate: byDays?.dueDate ?? null,
    dueOdometer: byMiles?.due ?? null,
    daysRemaining: byDays?.remaining ?? null,
    milesRemaining: byMiles?.remaining ?? null,
    status: overdue ? 'overdue' : dueSoon ? 'due_soon' : 'ok',
  };
}

/** Minutes a unit has been in the shop: to completion when closed, to now while open. */
export function downtimeMinutes(shopInAt: string, completedAt: string | null, now: number): number {
  const end = completedAt ? Date.parse(completedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(shopInAt)) / 60_000));
}

/** `2d 5h`, the way a shop floor says it. Hours alone under a day; minutes under an hour. */
export function formatDowntime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The label a page shows for a record, since nobody types a title any more. */
export function workOrderLabel(unitNumber: string, workType: WorkType): string {
  return `Unit ${unitNumber} · ${WORK_TYPE_LABEL[workType]}`;
}

/**
 * Voiding a work order entered by mistake - most often a duplicate (owner, 2026-09-30). The record
 * stays, marked with who, when and why; lists, spend and the dashboard stop counting it.
 */
export const VoidWorkOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it is being voided').max(400),
});
export type VoidWorkOrderInput = z.infer<typeof VoidWorkOrderSchema>;
