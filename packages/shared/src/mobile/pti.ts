import { z } from 'zod';
import {
  DriverPtiChecklistItemSchema,
  type DriverPtiSubmission,
  type PtiCorrection,
  type PtiDefectState,
  type PtiReceiptStatus,
  type PtiReviewResult,
  type PtiReviewState,
} from '../fleet/pti.js';

/**
 * The driver's weekly walk-around (PTI) in the app (docs/mobile/API.md).
 *
 * The truck and trailer come from the driver's assignment on the server. What the driver sends
 * is persisted on this week's `pti_inspections` row (receipt `received`, review `unreviewed`), so
 * Safety → PTI shows it as Received — Needs review. Defects the driver marks become open
 * `pti_defects`; nothing the driver sends marks anything repaired.
 */

export interface DriverPtiChecklistTemplateItem {
  /** Component key (the walk-around catalog). */
  key: string;
  label: string;
}

/** What the driver sees for the review (separate from the Fleet status of each defect). */
export const DRIVER_PTI_STATES = ['not_submitted', 'received', 'in_review', 'reviewed', 'correction_requested'] as const;
export type DriverPtiState = (typeof DRIVER_PTI_STATES)[number];

export const DRIVER_PTI_STATE_LABEL: Record<DriverPtiState, string> = {
  not_submitted: 'Not submitted',
  received: 'Received by TMS · Needs review',
  in_review: 'Safety is reviewing',
  reviewed: 'Reviewed',
  correction_requested: 'Correction requested',
};

export function driverPtiState(row: {
  driverSubmission?: unknown | null;
  receivedAt: string | null;
  reviewState: PtiReviewState;
  correction?: PtiCorrection | null;
}): DriverPtiState {
  if (row.correction) return 'correction_requested';
  if (row.reviewState === 'reviewed') return 'reviewed';
  if (!row.receivedAt) return 'not_submitted';
  if (row.reviewState === 'in_review') return 'in_review';
  return 'received';
}

export interface DriverPtiDefectView {
  id: string;
  defectNumber: string;
  component: string;
  componentName: string;
  description: string;
  /** Fleet's own status for the defect (open · assigned · scheduled · in_repair · …), read separately from the review. */
  state: PtiDefectState;
  stateLabel: string;
  workOrderNumber: string | null;
}

export interface DriverPtiCurrent {
  weekStart: string;
  dueAt: string;
  today: string;
  truck: { id: string; unitNumber: string } | null;
  trailer: { id: string; unitNumber: string } | null;
  /** Null when the driver has no truck: there is nothing to inspect. */
  inspection: {
    id: string;
    receiptStatus: PtiReceiptStatus;
    receivedAt: string | null;
    reviewState: PtiReviewState;
    reviewResult: PtiReviewResult | null;
    reviewerName: string | null;
    reviewedAt: string | null;
    version: number;
  } | null;
  state: DriverPtiState;
  stateLabel: string;
  correction: PtiCorrection | null;
  /** May the driver submit (or resubmit) now? */
  canSubmit: boolean;
  submission: DriverPtiSubmission | null;
  history: DriverPtiSubmission[];
  defects: DriverPtiDefectView[];
  checklist: DriverPtiChecklistTemplateItem[];
}

export const DriverPtiSubmitSchema = z.object({
  checklist: z.array(DriverPtiChecklistItemSchema).min(1, 'Fill in the checklist'),
  notes: z.string().trim().max(2000).nullable().default(null),
  odometer: z.number().int().nonnegative().max(10_000_000).nullable().default(null),
  /** Photos of the whole walk-around, beyond the per-item ones (stored_files ids from POST /driver/files). */
  photoFileIds: z.array(z.string().min(1)).max(30).default([]),
  /** The inspection version the driver was looking at; a stale one is refused (409). Optional. */
  version: z.number().int().optional(),
});
export type DriverPtiSubmitRequest = z.input<typeof DriverPtiSubmitSchema>;
export type DriverPtiSubmitInput = z.infer<typeof DriverPtiSubmitSchema>;
