import { z } from 'zod';
import { DriverLocationSchema } from './breakdowns.js';

/**
 * Accident / roadside inspection / violation reports from the driver (mobile M3, API.md §14).
 *
 * The report opens the real Safety record through the existing services: an accident through
 * Accidents v2 (when `accidents_v2` is on), a roadside inspection through Safety's roadside
 * inspections (when `safety_v2` is on and the driver gave the level and the agency). Anything else
 * - and every violation ticket - becomes a Driver Relations compliance request routed to Safety.
 * A report never decides fault, never closes anything and never assigns a result.
 */

export const DRIVER_SAFETY_REPORT_KINDS = ['accident', 'roadside_inspection', 'violation'] as const;
export type DriverSafetyReportKind = (typeof DRIVER_SAFETY_REPORT_KINDS)[number];
export const DRIVER_SAFETY_REPORT_KIND_LABEL: Record<DriverSafetyReportKind, string> = {
  accident: 'Accident',
  roadside_inspection: 'Roadside inspection',
  violation: 'Violation / ticket',
};

export const DriverSafetyReportCreateSchema = z
  .object({
    kind: z.enum(DRIVER_SAFETY_REPORT_KINDS),
    /** When it happened: an instant with its offset (the phone's clock, the stop's zone). */
    occurredAt: z.string().datetime({ offset: true }),
    location: DriverLocationSchema,
    description: z.string().trim().min(3, 'Say what happened').max(4000),
    fileIds: z.array(z.string().min(1)).max(20).default([]),
    truckId: z.string().min(1).nullable().optional(),
    trailerId: z.string().min(1).nullable().optional(),
    loadId: z.string().min(1).nullable().optional(),
    /** Roadside inspection only: the level on the report (1-6) and the agency, when known. */
    inspectionLevel: z.number().int().min(1).max(6).nullable().optional(),
    agency: z.string().trim().max(200).nullable().optional(),
    reportNumber: z.string().trim().max(80).nullable().optional(),
    /** Accident only: anyone hurt, towed, police on scene (yes / no / unknown). */
    injuries: z.enum(['yes', 'no', 'unknown']).optional(),
    towAway: z.enum(['yes', 'no', 'unknown']).optional(),
    police: z.enum(['yes', 'no', 'unknown']).optional(),
    /** Roadside / violation: the vehicle was put out of service. */
    outOfService: z.boolean().optional(),
  })
  .strict();
export type DriverSafetyReportCreateInput = z.input<typeof DriverSafetyReportCreateSchema>;

/** The Safety record the report became. */
export const DRIVER_SAFETY_TARGETS = ['accident', 'roadside_inspection', 'driver_relation_request'] as const;
export type DriverSafetyTarget = (typeof DRIVER_SAFETY_TARGETS)[number];

export interface DriverSafetyReport {
  id: string;
  kind: DriverSafetyReportKind;
  kindLabel: string;
  /** ACC-0007 · RSI-0003 · DR-1042 */
  reference: string;
  target: DriverSafetyTarget;
  /** The Safety record's own status word, as Safety sees it (never fault or results). */
  status: string;
  statusLabel: string;
  occurredAt: string;
  description: string;
  createdAt: string;
}

export interface DriverSafetyReportList {
  reports: DriverSafetyReport[];
}
