import { demoData } from './data';
import { appendFleetAudit, cloneValue, fleetRespond, nowIsoString } from './internals';
import { saveSoon } from './state-persist';
import type { DeductionPlan } from './accounting-types';
import type { RepairOrder, WorkOrderBilling } from './types';

/**
 * Who pays for a repair, and how the owner's share reaches their settlement.
 *
 * Repairs on owner-operator and lease-operator units are the owner's cost. Everything landing on
 * the company distorts fleet spend and cost per mile, so the work order carries who it is billed
 * to, and an owner-billed amount becomes a deduction on that driver through the machinery
 * settlements already read - not a second ledger.
 */
export interface SetWorkOrderBillingInput {
  orderId: string;
  party: WorkOrderBilling['party'];
  /** Required when the party is the owner. */
  ownerDriverId?: string | null;
  /** What the company keeps of the total; null when one party pays all of it. */
  companyAmount?: number | null;
  note?: string | null;
}

/** The deduction description that ties a plan back to its work order. */
export function billingDeductionDescription(order: RepairOrder): string {
  return `Shop charge — ${order.roNumber} ${order.summary}`.trim();
}

/**
 * What the billing should default to, and why.
 *
 * The unit's ownership decides it: a company truck is the company's cost; an owner-operator unit,
 * or one driven by an owner-operator or lease driver, is theirs. Always a suggestion - the person
 * sees the reason and can change it.
 */
export function suggestWorkOrderBilling(order: RepairOrder): {
  party: WorkOrderBilling['party'];
  ownerDriverId: string | null;
  ownerDriverName: string | null;
  suggestedFrom: string;
} {
  const company = {
    party: 'company' as const,
    ownerDriverId: null,
    ownerDriverName: null,
    suggestedFrom: 'the unit is company-owned',
  };
  if (order.unitType === 'trailer') {
    const trailer = demoData.trailers.find((t) => t.id === order.trailerId);
    if (!trailer || trailer.ownership !== 'leased') return company;
    return { ...company, suggestedFrom: 'the trailer is leased by the company' };
  }
  const truck = demoData.trucks.find((t) => t.id === order.truckId);
  if (!truck) return company;
  const driver = demoData.drivers.find((d) => d.id === truck.currentDriverId);
  const driverIsOwner =
    driver?.driverType === 'owner_operator' || driver?.driverType === 'lease_operator';
  if (truck.ownership === 'owner_operator' && driver) {
    return {
      party: 'owner',
      ownerDriverId: driver.id,
      ownerDriverName: driver.name,
      suggestedFrom: `unit ${truck.unitNumber} is owner-operated by ${driver.name}`,
    };
  }
  if (driverIsOwner && driver) {
    return {
      party: 'owner',
      ownerDriverId: driver.id,
      ownerDriverName: driver.name,
      suggestedFrom: `${driver.name} is a ${driver.driverType === 'owner_operator' ? 'owner-operator' : 'lease operator'} on this unit`,
    };
  }
  return company;
}

/** The owner's share of an order: everything the company does not keep. */
export function ownerShareOf(order: RepairOrder): number {
  if (!order.billing || order.billing.party !== 'owner') return 0;
  const kept = order.billing.companyAmount ?? 0;
  return Math.max(Math.round((order.total - kept) * 100) / 100, 0);
}

/** Work orders charged to a driver, newest first; what the driver's page shows. */
export function ownerBilledOrdersFor(driverId: string): RepairOrder[] {
  return demoData.repairOrders
    .filter((order) => order.billing?.party === 'owner' && order.billing.ownerDriverId === driverId)
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

function planFor(order: RepairOrder): DeductionPlan | undefined {
  return demoData.deductionPlans.find((plan) => plan.id === order.billing?.deductionPlanId);
}

export function setWorkOrderBilling(
  input: SetWorkOrderBillingInput,
  options?: Parameters<typeof fleetRespond>[0],
): Promise<RepairOrder> {
  return fleetRespond(
    options,
    () => {
      const order = demoData.repairOrders.find((ro) => ro.id === input.orderId);
      if (!order) throw new Error('That work order no longer exists');

      const companyAmount =
        typeof input.companyAmount === 'number' && Number.isFinite(input.companyAmount)
          ? Math.min(Math.max(Math.round(input.companyAmount * 100) / 100, 0), order.total)
          : null;
      const split = input.party === 'owner' && companyAmount !== null && companyAmount > 0;
      if (split && !(input.note ?? '').trim()) {
        throw new Error('A split needs a note saying why.');
      }

      let driver = null as (typeof demoData.drivers)[number] | null;
      if (input.party === 'owner') {
        driver = demoData.drivers.find((d) => d.id === input.ownerDriverId) ?? null;
        if (!driver) throw new Error('Choose the driver the repair is billed to.');
      }

      const before = order.billing?.party === 'owner' ? 'the owner' : 'the company';
      const suggestion = suggestWorkOrderBilling(order);
      order.billing = {
        party: input.party,
        ownerDriverId: driver?.id ?? null,
        ownerDriverName: driver?.name ?? null,
        companyAmount,
        note: (input.note ?? '').trim() || null,
        deductionPlanId: order.billing?.deductionPlanId ?? null,
        suggestedFrom: order.billing?.suggestedFrom ?? suggestion.suggestedFrom,
      };

      const owed = ownerShareOf(order);
      const existing = planFor(order);
      if (owed > 0 && driver) {
        if (existing) {
          // The same charge, corrected: the plan follows rather than a second one appearing.
          existing.driverId = driver.id;
          existing.description = billingDeductionDescription(order);
          existing.amountPerPeriod = owed;
          existing.balance = owed;
          existing.totalCap = owed;
          existing.status = 'active';
        } else {
          const plan: DeductionPlan = {
            id: `ded_wo_${order.id}`,
            driverId: driver.id,
            kind: 'other',
            description: billingDeductionDescription(order),
            amountPerPeriod: owed,
            balance: owed,
            totalCap: owed,
            startsOn: (order.completedAt ?? order.openedAt).slice(0, 10),
            endsOn: null,
            status: 'active',
          };
          demoData.deductionPlans.unshift(plan);
          order.billing.deductionPlanId = plan.id;
        }
      } else if (existing) {
        // Billed back to the company: the charge stops, and says so rather than vanishing.
        existing.status = 'cancelled';
        existing.balance = 0;
        order.billing.deductionPlanId = null;
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Billed to',
        before,
        after:
          input.party === 'owner'
            ? `${driver?.name ?? 'the owner'}${companyAmount ? ` (company keeps ${companyAmount})` : ''}`
            : 'the company',
        reason: order.billing.note ?? `${order.roNumber} billed to ${input.party}`,
      });
      saveSoon();
      return cloneValue(order);
    },
    () => {
      throw new Error('The billing could not be saved');
    },
  ) as Promise<RepairOrder>;
}

/** Keeps the owner's charge in step when an invoice changes what the work cost. */
export function refreshBillingCharge(order: RepairOrder): void {
  if (!order.billing || order.billing.party !== 'owner') return;
  const plan = planFor(order);
  if (!plan || plan.status === 'cancelled') return;
  const owed = ownerShareOf(order);
  plan.amountPerPeriod = owed;
  plan.balance = owed;
  plan.totalCap = owed;
  plan.description = billingDeductionDescription(order);
  plan.status = owed > 0 ? 'active' : 'cancelled';
}

/** The time a billing change is recorded at; exported so tests can read it back. */
export const billingChangedAt = nowIsoString;
