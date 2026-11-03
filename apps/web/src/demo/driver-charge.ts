import { demoData } from './data';
import { appendFleetAudit, cloneValue } from './internals';
import { saveSoon } from './state-persist';
import type { DeductionPlan } from './accounting-types';

/**
 * A repair charged to a driver, reaching that driver's pay.
 *
 * The work order itself lives on the server (fleet_v2); what accounting reads is a deduction
 * plan, the same machinery a settlement already subtracts. So a driver charge becomes one plan,
 * named after the order, and stays in step with it.
 *
 * The rule that matters: **a charge the driver has not been told about is never active.** It is
 * written down as a held plan so accounting can see the money exists and say so out loud, but it
 * takes nothing off the driver until somebody records that the driver was told. That is why
 * `informed` decides the status rather than the amount.
 */
export interface DriverChargeInput {
  /** The server work order's id; the plan is named after it, so a change corrects rather than duplicates. */
  orderId: string;
  orderNumber: string;
  driverId: string;
  /** What the repair cost. A charge of nothing cancels the plan instead of carrying a zero. */
  amount: number;
  /** Has the driver been told? Only then may the deduction run. */
  informed: boolean;
  /** What the charge describes, for the settlement line. */
  summary?: string | null;
  /** The day the charge starts counting; the back-in-service date, normally. */
  startsOn?: string | null;
}

export function driverChargePlanId(orderId: string): string {
  return `ded_wo_${orderId}`;
}

/** The settlement line a driver sees, which has to name the order it came from. */
export function driverChargeDescription(orderNumber: string, summary?: string | null): string {
  return `Shop charge — ${orderNumber}${summary ? ` ${summary}` : ''}`.trim();
}

/**
 * Write (or correct, or hold, or cancel) the deduction for one driver charge.
 *
 * Returns the plan as it now stands, or null when the charge was cancelled outright.
 */
export function syncDriverChargeDeduction(input: DriverChargeInput): DeductionPlan | null {
  const id = driverChargePlanId(input.orderId);
  const amount = Math.max(Math.round(input.amount * 100) / 100, 0);
  const existing = demoData.deductionPlans.find((p) => p.id === id) ?? null;
  const before = existing?.status ?? 'none';
  /*
   * Held and cancelled are different things and are kept different: `on_hold` still carries the
   * balance, so accounting can show what is waiting; `cancelled` is zero, because the charge is
   * off. Neither is ever subtracted from a settlement.
   */
  const status: DeductionPlan['status'] =
    amount <= 0 ? 'cancelled' : input.informed ? 'active' : 'on_hold';
  const description = driverChargeDescription(input.orderNumber, input.summary);

  if (!existing && status === 'cancelled') return null;

  const plan: DeductionPlan = existing ?? {
    id,
    driverId: input.driverId,
    kind: 'other',
    description,
    amountPerPeriod: amount,
    balance: amount,
    totalCap: amount,
    startsOn: (input.startsOn ?? new Date().toISOString()).slice(0, 10),
    endsOn: null,
    status,
  };
  plan.driverId = input.driverId;
  plan.description = description;
  plan.amountPerPeriod = amount;
  plan.balance = status === 'cancelled' ? 0 : amount;
  plan.totalCap = amount;
  plan.status = status;
  if (!existing) demoData.deductionPlans.unshift(plan);

  appendFleetAudit({
    action: 'status_changed',
    entity: { type: 'repair_order', id: input.orderId, label: input.orderNumber },
    subject: 'Driver charge',
    before,
    after: status,
    reason:
      status === 'on_hold'
        ? `${input.orderNumber} is charged to the driver, who has not been told yet — nothing is deducted`
        : status === 'active'
          ? `${input.orderNumber} is charged to the driver, who has been told`
          : `${input.orderNumber} is no longer charged to the driver`,
  });
  saveSoon();
  return cloneValue(plan);
}

/** Every driver charge plan, held or running, for one driver. */
export function driverChargePlans(driverId: string): DeductionPlan[] {
  return demoData.deductionPlans
    .filter((p) => p.id.startsWith('ded_wo_') && p.driverId === driverId)
    .map((p) => cloneValue(p));
}
