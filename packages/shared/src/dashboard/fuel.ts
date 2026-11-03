import { z } from 'zod';
import { DashboardMetaSchema } from './meta.js';

const money = z.number().nullable();

/** Fuel usage grouped by one entity (truck or driver); `share` is a % of total gallons. */
export const FuelGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  fillUps: z.number().int().nonnegative(),
  gallons: z.number().nonnegative(),
  cost: money,
  share: z.number().nullable(),
});
export type FuelGroup = z.infer<typeof FuelGroupSchema>;

export const FuelByStateSchema = z.object({
  state: z.string().min(1),
  fillUps: z.number().int().nonnegative(),
  gallons: z.number().nonnegative(),
  cost: money,
  avgPricePerGallon: money,
});
export type FuelByState = z.infer<typeof FuelByStateSchema>;

/** Response of `GET /dashboard/fuel` (docs/DASHBOARD.md §7). */
export const DashboardFuelSchema = z.object({
  meta: DashboardMetaSchema,
  totals: z.object({
    fillUps: z.number().int().nonnegative(),
    gallons: z.number().nonnegative(),
    discountedCost: money,
    grossCost: money,
    avgPricePerGallon: money,
    fuelCostPerMile: money,
  }),
  byTruck: z.array(FuelGroupSchema),
  byDriver: z.array(FuelGroupSchema),
  byState: z.array(FuelByStateSchema),
  masked: z.boolean(),
});
export type DashboardFuel = z.infer<typeof DashboardFuelSchema>;
