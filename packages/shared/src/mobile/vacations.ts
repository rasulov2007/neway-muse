import { z } from 'zod';

/**
 * Vacation requests from the driver app (mobile M3, docs/mobile/API.md §12).
 *
 * A request is a `driver_vacations` row with `request_status`: requested → approved / rejected
 * (or cancelled by the driver while still requested). Approval alone changes nothing about the
 * driver or the truck: the vacation starts through the existing Start vacation path (the
 * dispatcher, or VACATION on the Daily board), which adopts the approved row (`request_status`
 * started). Truck parked and keys handed over are separate confirmations; the return and the
 * Safety vacation-return review stay exactly as they are.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const DriverVacationRequestSchema = z
  .object({
    from: z.string().regex(DAY, 'Use YYYY-MM-DD'),
    to: z.string().regex(DAY, 'Use YYYY-MM-DD'),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.to >= v.from, { path: ['to'], message: 'The last day cannot be before the first.' });
export type DriverVacationRequestInput = z.input<typeof DriverVacationRequestSchema>;

/** The driver confirms where the truck was left (optional photo from POST /driver/files). */
export const DriverTruckParkedSchema = z
  .object({
    note: z.string().trim().max(1000).nullable().optional(),
    photoFileId: z.string().min(1).nullable().optional(),
    keysHandedOver: z.boolean().optional(),
  })
  .strict();
export type DriverTruckParkedInput = z.input<typeof DriverTruckParkedSchema>;

export const VACATION_REQUEST_STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'started'] as const;
export type VacationRequestStatus = (typeof VACATION_REQUEST_STATUSES)[number];

export const VACATION_REQUEST_STATUS_LABEL: Record<VacationRequestStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  started: 'On vacation',
};

/** The steps the app shows. `done` is when it happened; null = not yet. */
export const DRIVER_VACATION_STEPS = ['requested', 'decided', 'truck_parked', 'keys_handed', 'started', 'returned', 'return_review'] as const;
export type DriverVacationStep = (typeof DRIVER_VACATION_STEPS)[number];
export const DRIVER_VACATION_STEP_LABEL: Record<DriverVacationStep, string> = {
  requested: 'Requested',
  decided: 'Approved',
  truck_parked: 'Truck parked',
  keys_handed: 'Keys handed over',
  started: 'Vacation started',
  returned: 'Back from vacation',
  return_review: 'Safety return review',
};

export interface DriverVacationRequestView {
  id: string;
  from: string;
  to: string;
  note: string | null;
  status: VacationRequestStatus;
  statusLabel: string;
  decidedReason: string | null;
  steps: Array<{ step: DriverVacationStep; label: string; at: string | null; by: string | null; note?: string | null }>;
  truckParked: { at: string; by: string | null; note: string | null; photoFileId: string | null } | null;
  keysHandedAt: string | null;
  /** The Safety vacation-return review, when one is open for this vacation. */
  returnReview: { state: string; label: string } | null;
  canCancel: boolean;
  canConfirmParked: boolean;
  version: number;
  createdAt: string;
}

export interface DriverVacationRequestList {
  vacations: DriverVacationRequestView[];
}

// ------------------------------------------------------------------------------ office

export interface VacationRequestRow {
  id: string;
  driverId: string;
  driverName: string;
  driverNumber: string | null;
  unitNumber: string | null;
  dispatcherName: string | null;
  from: string;
  to: string;
  note: string | null;
  status: VacationRequestStatus;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  truckParkedAt: string | null;
  truckParkedBy: string | null;
  truckParkedNote: string | null;
  truckParkedPhotoFileId: string | null;
  keysHandedAt: string | null;
  version: number;
}

export interface VacationRequestList {
  requests: VacationRequestRow[];
  counts: { requested: number; approved: number };
}

const version = z.number().int().min(1);
export const DecideVacationRequestSchema = z
  .object({ version, decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).nullable().optional() })
  .refine((v) => v.decision === 'approve' || Boolean(v.reason && v.reason.length >= 3), { path: ['reason'], message: 'A rejection needs a reason the driver can read.' });
export type DecideVacationRequestInput = z.infer<typeof DecideVacationRequestSchema>;

export const ConfirmTruckParkedSchema = z.object({
  version,
  note: z.string().trim().max(1000).nullable().optional(),
  keysHandedOver: z.boolean().optional(),
});
export type ConfirmTruckParkedInput = z.infer<typeof ConfirmTruckParkedSchema>;
