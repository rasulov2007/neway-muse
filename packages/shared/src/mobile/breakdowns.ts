import { z } from 'zod';

/**
 * Breakdowns / road issues a driver reports from the app (mobile M3, docs/mobile/API.md §7).
 *
 * One case per breakdown (`fleet_breakdowns`, BD-0001 per company). The driver reports it; Fleet
 * works it (assign → shop arranged → in repair → ready → closed). A case never repairs anything by
 * itself: "In repair" needs the linked work order to be in the shop (the existing down-period
 * path), and closing a case never completes its work order.
 */

export const BREAKDOWN_CATEGORIES = [
  'tire',
  'engine',
  'brakes',
  'electrical',
  'air_leak',
  'overheating',
  'transmission',
  'trailer',
  'reefer',
  'lights',
  'other',
] as const;
export type BreakdownCategory = (typeof BREAKDOWN_CATEGORIES)[number];

export const BREAKDOWN_CATEGORY_LABEL: Record<BreakdownCategory, string> = {
  tire: 'Tire',
  engine: 'Engine',
  brakes: 'Brakes',
  electrical: 'Electrical',
  air_leak: 'Air leak',
  overheating: 'Overheating / coolant',
  transmission: 'Transmission / clutch',
  trailer: 'Trailer',
  reefer: 'Reefer unit',
  lights: 'Lights',
  other: 'Other',
};

export const BREAKDOWN_STATUSES = ['received', 'assigned', 'shop_arranged', 'in_repair', 'ready', 'closed'] as const;
export type BreakdownStatus = (typeof BREAKDOWN_STATUSES)[number];

export const BREAKDOWN_STATUS_LABEL: Record<BreakdownStatus, string> = {
  received: 'Received',
  assigned: 'Assigned',
  shop_arranged: 'Shop arranged',
  in_repair: 'In repair',
  ready: 'Ready',
  closed: 'Closed',
};

/** The steps the driver sees, in order. Ready and Closed are the last step either way. */
export const BREAKDOWN_STEPS: readonly BreakdownStatus[] = ['received', 'assigned', 'shop_arranged', 'in_repair', 'ready', 'closed'];

/** Where a status may move by the office's hand (assign and close have their own rules). */
export const BREAKDOWN_TRANSITIONS: Record<BreakdownStatus, readonly BreakdownStatus[]> = {
  received: ['assigned', 'shop_arranged', 'in_repair', 'closed'],
  assigned: ['shop_arranged', 'in_repair', 'closed'],
  shop_arranged: ['in_repair', 'ready', 'closed'],
  in_repair: ['ready', 'closed'],
  ready: ['closed', 'in_repair'],
  closed: [],
};

export function canMoveBreakdown(from: BreakdownStatus, to: BreakdownStatus): boolean {
  return BREAKDOWN_TRANSITIONS[from].includes(to);
}

export const LOCATION_SOURCES = ['gps', 'manual'] as const;

/** Where the driver is. GPS from the phone, or typed; never guessed by the server. */
export const DriverLocationSchema = z.object({
  text: z.string().trim().max(300).default(''),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  source: z.enum(LOCATION_SOURCES),
  captured_at: z.string().datetime({ offset: true }).optional(),
  /** Two-letter state, when the driver gives it (safety reports use it). */
  state: z.string().trim().toUpperCase().length(2).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
});
export type DriverLocation = z.infer<typeof DriverLocationSchema>;

export const DriverBreakdownCreateSchema = z
  .object({
    category: z.enum(BREAKDOWN_CATEGORIES),
    description: z.string().trim().min(3, 'Say what happened').max(4000),
    /** Another unit the driver is assigned to; absent = the server's assignment. */
    truckId: z.string().min(1).nullable().optional(),
    trailerId: z.string().min(1).nullable().optional(),
    /** Must be one of the driver's own loads. */
    loadId: z.string().min(1).nullable().optional(),
    location: DriverLocationSchema,
    /** From POST /driver/files (photos, a video). */
    fileIds: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();
export type DriverBreakdownCreateInput = z.input<typeof DriverBreakdownCreateSchema>;

export interface BreakdownHistoryEntry {
  at: string;
  /** created · assigned · shop_arranged · work_order_linked · in_repair · ready · closed · note · reopened */
  kind: string;
  status: BreakdownStatus;
  byName: string;
  note: string | null;
}

export interface BreakdownStep {
  status: BreakdownStatus;
  label: string;
  reachedAt: string | null;
  current: boolean;
}

/** What the driver sees: no cost, no vendor estimate, no internal notes. */
export interface DriverBreakdown {
  id: string;
  number: string;
  category: BreakdownCategory;
  categoryLabel: string;
  description: string;
  status: BreakdownStatus;
  statusLabel: string;
  steps: BreakdownStep[];
  truck: { id: string; unitNumber: string } | null;
  trailer: { id: string; unitNumber: string } | null;
  load: { id: string; loadNumber: string } | null;
  location: DriverLocation | null;
  /** The person working it in the office. */
  responsible: { name: string } | null;
  /** The shop, once one is arranged (name only). */
  shopName: string | null;
  latestUpdate: { at: string; text: string } | null;
  fileIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DriverBreakdownList {
  breakdowns: DriverBreakdown[];
}

// ------------------------------------------------------------------------------- office

export interface FleetBreakdown extends DriverBreakdown {
  driver: { id: string; name: string } | null;
  assignedUserId: string | null;
  vendor: { id: string; name: string } | null;
  estimateCents: number | null;
  workOrder: { id: string; number: string; status: string } | null;
  loadProblemId: string | null;
  history: BreakdownHistoryEntry[];
  source: string;
  closedAt: string | null;
  version: number;
}

export interface FleetBreakdownList {
  breakdowns: FleetBreakdown[];
  counts: { open: number; received: number; byStatus: Record<BreakdownStatus, number> };
}

const version = z.number().int().min(1);

export const BreakdownAssignSchema = z.object({ version, userId: z.string().min(1), note: z.string().trim().max(1000).nullable().optional() });
export const BreakdownShopSchema = z.object({
  version,
  vendorId: z.string().min(1),
  estimateCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
/** Link an existing work order, or open one (in the shop) through the existing work-order service. */
export const BreakdownWorkOrderSchema = z
  .object({
    version,
    workOrderId: z.string().min(1).optional(),
    create: z
      .object({
        /** in_shop opens the down period (the existing path); scheduled books the shop only. */
        status: z.enum(['scheduled', 'in_shop']).default('in_shop'),
        /** Trailer work belongs to the trailer. Absent: the trailer for trailer / reefer issues, else the truck. */
        assetType: z.enum(['truck', 'trailer']).optional(),
        title: z.string().trim().max(160).optional(),
        notes: z.string().trim().max(2000).optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.workOrderId) !== Boolean(v.create), { message: 'Link a work order or open one, not both.' });
export const BreakdownStatusSchema = z.object({
  version,
  status: z.enum(['in_repair', 'ready', 'closed']),
  note: z.string().trim().max(1000).nullable().optional(),
});
export const BreakdownNoteSchema = z.object({ version, note: z.string().trim().min(1).max(2000) });

export type BreakdownAssignInput = z.infer<typeof BreakdownAssignSchema>;
export type BreakdownShopInput = z.infer<typeof BreakdownShopSchema>;
export type BreakdownWorkOrderInput = z.infer<typeof BreakdownWorkOrderSchema>;
export type BreakdownStatusInput = z.infer<typeof BreakdownStatusSchema>;
export type BreakdownNoteInput = z.infer<typeof BreakdownNoteSchema>;

/** The steps with the first time each was reached; Ready and Closed share the last slot. */
export function breakdownSteps(status: BreakdownStatus, history: readonly BreakdownHistoryEntry[]): BreakdownStep[] {
  const reached = new Map<BreakdownStatus, string>();
  for (const h of history) if (!reached.has(h.status)) reached.set(h.status, h.at);
  return BREAKDOWN_STEPS.map((s) => ({ status: s, label: BREAKDOWN_STATUS_LABEL[s], reachedAt: reached.get(s) ?? null, current: s === status }));
}
