import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { remainingMilesTo } from '@/demo/mileage';
import {
  assessBrokerRisk,
  assessLoadRisk,
  buildAttentionQueue,
  classifyDelivery,
  projectEta,
  updateDue,
  type DeliveryVerdict,
  type UpdateDue,
  computeLoadEconomics,
  driverAvailability,
  trackingFreshness,
  summarizePayment,
  summarizePerformance,
  truckAvailability,
  type AttentionQueue,
  type BrokerRisk,
  type EntityCompliance,
  type DriverAvailability,
  type LoadEconomics,
  type LoadRisk,
  type PaymentSummary,
  type PerformanceLoad,
  type PerformanceSummary,
  type TrackingFreshness,
  type TruckAvailability,
} from '@neway/shared';
import {
  listBrokers,
  listCustomers,
  listInvoices,
  listLoads,
  listMaintenance,
  type Broker,
  type Customer,
  type Driver,
  type Invoice,
  type Load,
  type MaintenanceItem,
  type Truck,
} from '@/demo';
import { nowIso as clockNowIso } from '@/lib/clock';
import { entityKey } from '@/features/safety/compliance-ui';
import { loadComplianceBundle, type ComplianceBundle } from '@/features/safety/useCompliance';

/** Big enough to cover the demo fleet in one request; the real API pages and filters server-side. */
const ALL = 10_000;

/**
 * A load with everything Operations needs to judge it: how it is running, whether the position
 * behind that judgement can be trusted, and what it earns on the miles the truck actually turns.
 */
/**
 * Cached for the length of a working session.
 *
 * These bundles are what a module's list pages render from, so the cache decides what "back"
 * feels like. The defaults (30 s stale, 5 min garbage collection) meant a detail page visited for
 * six minutes threw the list's data away, and returning to it showed a skeleton while the whole
 * nested bundle was fetched again. Keeping it an hour costs memory that is already allocated and
 * turns the return trip into a repaint; `refetchOnMount` still brings it up to date in the
 * background, and every mutation invalidates it explicitly.
 */
// Fresh for 15 s and polled every 30 s: the Loads list and the dashboard follow the Daily Board.
const BUNDLE_CACHE = { staleTime: 15_000, gcTime: 60 * 60_000, refetchInterval: 30_000 } as const;

export interface OperationalLoad {
  load: Load;
  risk: LoadRisk;
  economics: LoadEconomics;
  tracking: TrackingFreshness;
  /** The appointment risk is measured against — the final delivery stop. */
  controllingAppointmentAt: string | null;
  /**
   * The next stop, in the four words a dispatcher acts on (rule 1.4): on time, at risk, late, or
   * no update - and a stale position is never on time. Built from the ETA, which is built from the
   * miles Samsara says are left.
   */
  delivery: DeliveryVerdict;
  /** The projected arrival at the next stop; null when the miles left are unknown. */
  etaAt: string | null;
  /** Whether the load is owed a check-call or a position, by how near its next appointment is. */
  updateDue: UpdateDue;
}

export interface OperationalTruck {
  truck: Truck;
  availability: ReturnType<typeof truckAvailability>;
  tracking: TrackingFreshness;
  /** Hours since this unit's last delivery, when it is carrying no load. Null when unknown. */
  idleHours: number | null;
  maintenanceStatus: MaintenanceItem['status'] | null;
}

export interface OperationalDriver {
  driver: Driver;
  availability: ReturnType<typeof driverAvailability>;
  currentLoad: Load | null;
  /** Every load this driver has run, and what it earned on total miles. */
  loads: Load[];
  performance: PerformanceSummary;
  /** The driver's compliance standing, read from Safety rather than re-derived. */
  compliance: EntityCompliance | null;
}

/**
 * A customer as an operational relationship rather than an address book row: what their freight
 * earned, how they actually run, and how they pay.
 */
export interface OperationalCustomer {
  customer: Customer;
  loads: Load[];
  performance: PerformanceSummary;
  payment: PaymentSummary;
}

export interface OperationalBroker {
  broker: Broker;
  loads: Load[];
  performance: PerformanceSummary;
  payment: PaymentSummary;
  risk: BrokerRisk;
}

export interface OperationsBundle {
  /** The dataset's own clock. Every derived state is computed against this, not the wall clock. */
  nowIso: string;
  loads: OperationalLoad[];
  trucks: OperationalTruck[];
  drivers: OperationalDriver[];
  /** Archived drivers (owner, 2026-10-02): off the roster above, listed on the Drivers page's Archived tab. */
  archivedDrivers: ComplianceBundle['drivers'];
  customers: OperationalCustomer[];
  brokers: OperationalBroker[];
  attention: AttentionQueue;
  compliance: ComplianceBundle;
  byLoadNumber: Map<string, OperationalLoad>;
  byDriverId: Map<string, OperationalDriver>;
  byCustomerId: Map<string, OperationalCustomer>;
  byBrokerId: Map<string, OperationalBroker>;
}

export const OPERATIONS_QUERY_KEY = ['operations', 'bundle'] as const;

/** Statuses that still represent live work. */
const ACTIVE_LOAD_STATUSES = new Set([
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);

export function isActiveLoad(load: Load): boolean {
  return ACTIVE_LOAD_STATUSES.has(load.status);
}

/** The delivery a load is judged against: the last delivery stop, falling back to the last stop. */
function controllingStop(load: Load) {
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  return deliveries[deliveries.length - 1] ?? load.stops[load.stops.length - 1] ?? null;
}

const MAINTENANCE_RANK: Record<MaintenanceItem['status'], number> = {
  in_shop: 0,
  overdue: 1,
  due_soon: 2,
  scheduled: 3,
  ok: 4,
};

/**
 * A read this account is not allowed to make answers "none" (owner, 2026-10-12: new dispatcher
 * accounts saw Loads and Drivers fail because receivables were refused). An outage still throws.
 */
async function refusedAsEmpty<T extends { data: unknown[] }>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 401 || status === 403) return { data: [], total: 0, page: 1, pageSize: 0 } as unknown as T;
    throw error;
  }
}

/**
 * Builds the single operational picture every Operations page reads.
 *
 * It deliberately reuses the compliance bundle rather than re-deriving holds: Safety owns the
 * decision about who may run, and Operations reports it. That is what stops the dispatch board and
 * the safety desk from disagreeing about the same driver.
 */
export async function loadOperationsBundle(): Promise<OperationsBundle> {
  const [compliance, loadsPage, maintenance, customersPage, brokersPage, invoicesPage] =
    await Promise.all([
      loadComplianceBundle(),
      refusedAsEmpty(listLoads({ pageSize: ALL })),
      refusedAsEmpty(listMaintenance({ pageSize: ALL })),
      refusedAsEmpty(listCustomers({ pageSize: ALL })),
      refusedAsEmpty(listBrokers({ pageSize: ALL })),
      // A dispatcher may not read receivables (accounting.view): the invoices only add billing
      // state to a load, so a refusal means "none shown", never a blank Loads or Drivers page.
      refusedAsEmpty(listInvoices({ pageSize: ALL })),
    ]);

  const nowIso = clockNowIso();
  const loads = loadsPage.data;

  const trucksById = new Map(compliance.trucks.map((t) => [t.id, t]));

  // Worst open maintenance state per unit; the shop queue gates dispatch (§39 of the ops brief).
  const worstMaintenance = new Map<string, MaintenanceItem['status']>();
  for (const item of maintenance.data) {
    const current = worstMaintenance.get(item.truckId);
    if (!current || MAINTENANCE_RANK[item.status] < MAINTENANCE_RANK[current]) {
      worstMaintenance.set(item.truckId, item.status);
    }
  }

  const trackingForTruck = (truckId: string | null): TrackingFreshness =>
    trackingFreshness(
      truckId ? (trucksById.get(truckId)?.location?.updatedAt ?? null) : null,
      nowIso,
    );

  const operationalLoads: OperationalLoad[] = loads.map((load) => {
    const tracking = trackingForTruck(load.truckId);
    const stop = controllingStop(load);
    // The stop the truck is running to now - the first one not yet completed - is what the ETA
    // and the four words are about. The final delivery stays the one the risk engine judges.
    const next = load.stops.find((s) => s.status !== 'completed' && s.status !== 'cancelled') ?? null;
    const truck = load.truckId ? trucksById.get(load.truckId) : undefined;
    const remainingMiles = tracking.usable && next ? remainingMilesTo(truck?.location ?? null, next) : null;
    // A person's ETA from a check call stands in for the projection until a newer position lands.
    const manual = load.manualEta ?? null;
    const positionAt = truck?.location?.updatedAt ?? null;
    const manualWins = manual !== null && (!positionAt || manual.recordedAt >= positionAt) && (!next || !manual.stopId || manual.stopId === next.id);
    const etaAt = manualWins ? manual.at : projectEta({ nowIso, remainingMiles });
    const delivery = classifyDelivery({
      nowIso,
      etaAt,
      appointmentStartAt: next?.appointmentStartAt ?? null,
      appointmentEndAt: next?.appointmentEndAt ?? null,
      appointmentNoWindow: next?.appointmentNoWindow,
      arrivedAt: next?.arrivedAt ?? null,
      tracking: tracking.state,
    });
    const lastUpdateAt = [truck?.location?.updatedAt ?? null, load.timeline?.at(-1)?.at ?? null]
      .filter((t): t is string => Boolean(t))
      .sort()
      .at(-1) ?? null;
    const due = updateDue({ nowIso, appointmentAt: next?.appointmentStartAt ?? null, lastUpdateAt });
    const risk = assessLoadRisk({
      loadStatus: load.status,
      etaAt: load.etaAt,
      appointmentStartAt: stop?.appointmentStartAt ?? null,
      appointmentEndAt: stop?.appointmentEndAt ?? null,
      exception: load.exception
        ? { code: load.exception.code, reason: load.exception.reason }
        : null,
      tracking: tracking.state,
      nowIso,
    });
    const economics = computeLoadEconomics({
      revenue: load.rate,
      loadedMiles: load.loadedMiles,
      emptyMiles: load.emptyMiles,
      costs: load.financials
        ? {
            fuel: load.financials.fuel,
            driverPay: load.financials.driverPay,
            tolls: load.financials.tolls,
            maintenanceAllocation: load.financials.maintenanceAllocation,
            other: load.financials.other,
          }
        : null,
    });
    return {
      load,
      risk,
      economics,
      tracking,
      controllingAppointmentAt: stop?.appointmentEndAt ?? null,
      delivery,
      etaAt,
      updateDue: due,
    };
  });

  // Last delivery per unit, used to age a truck that is sitting with nothing assigned.
  const lastDeliveredAt = new Map<string, string>();
  for (const load of loads) {
    if (!load.truckId || !load.deliveredAt) continue;
    const current = lastDeliveredAt.get(load.truckId);
    if (!current || load.deliveredAt > current) lastDeliveredAt.set(load.truckId, load.deliveredAt);
  }

  const now = Date.parse(nowIso);
  const operationalTrucks: OperationalTruck[] = compliance.trucks
    .filter((truck) => truck.status !== 'sold' && truck.status !== 'archived')
    .map((truck) => {
      const gate = compliance.byKey.get(entityKey('truck', truck.id));
      const maintenanceStatus = worstMaintenance.get(truck.id) ?? null;
      const onLoad = truck.currentLoadId !== null;
      const availability = truckAvailability({
        status: truck.status,
        maintenanceStatus,
        onLoad,
        compliant: gate?.dispatchable ?? true,
        gateReasons: gate?.gateReasons ?? [],
      });
      let idleHours: number | null = null;
      if (!onLoad) {
        const since = lastDeliveredAt.get(truck.id);
        if (since) {
          const at = Date.parse(since);
          if (!Number.isNaN(at)) idleHours = Math.max(0, Math.round((now - at) / 3_600_000));
        }
      }
      return {
        truck,
        availability,
        tracking: trackingFreshness(truck.location?.updatedAt ?? null, nowIso),
        idleHours,
        maintenanceStatus,
      };
    });

  const loadByDriver = new Map<string, Load>();
  for (const load of loads) {
    if (load.driverId && isActiveLoad(load)) loadByDriver.set(load.driverId, load);
  }

  // One economics result per load, reused by every counterparty rollup below. Performance for a
  // driver, a customer and a broker is the same computation over different slices of these loads,
  // so they can never quote different profits for the same freight.
  const economicsByLoad = new Map(operationalLoads.map((row) => [row.load.id, row.economics]));
  const toPerformanceLoad = (load: Load): PerformanceLoad => ({
    id: load.id,
    status: load.status,
    economics:
      economicsByLoad.get(load.id) ??
      computeLoadEconomics({
        revenue: null,
        loadedMiles: null,
        emptyMiles: null,
        costs: null,
      }),
    stops: load.stops.map((stop) => ({
      kind: stop.kind,
      appointmentStartAt: stop.appointmentStartAt,
      appointmentEndAt: stop.appointmentEndAt,
      arrivedAt: stop.arrivedAt,
      departedAt: stop.departedAt,
      detentionMinutes: stop.detentionMinutes,
    })),
  });

  const groupLoads = (key: (load: Load) => string | null) => {
    const grouped = new Map<string, Load[]>();
    for (const load of loads) {
      const id = key(load);
      if (!id) continue;
      const bucket = grouped.get(id);
      if (bucket) bucket.push(load);
      else grouped.set(id, [load]);
    }
    return grouped;
  };

  const loadsByDriverId = groupLoads((load) => load.driverId);
  const loadsByCustomerId = groupLoads((load) => load.customerId);
  const loadsByBrokerId = groupLoads((load) => load.brokerId);

  const invoicesByParty = new Map<string, Invoice[]>();
  for (const invoice of invoicesPage.data) {
    const bucket = invoicesByParty.get(invoice.billToId);
    if (bucket) bucket.push(invoice);
    else invoicesByParty.set(invoice.billToId, [invoice]);
  }
  const paymentFor = (partyId: string) =>
    summarizePayment(
      (invoicesByParty.get(partyId) ?? []).map((invoice) => ({
        status: invoice.status,
        issuedOn: invoice.issuedOn,
        dueOn: invoice.dueOn,
        paidOn: invoice.paidOn,
        total: invoice.total,
        balance: invoice.balance,
      })),
    );

  const operationalDrivers: OperationalDriver[] = compliance.drivers
    .filter((driver) => driver.status !== 'terminated' && !driver.archivedAt)
    .map((driver) => {
      const gate = compliance.byKey.get(entityKey('driver', driver.id));
      const currentLoad = loadByDriver.get(driver.id) ?? null;
      const driverLoads = loadsByDriverId.get(driver.id) ?? [];
      /*
       * One verdict (2026-09-21). The roster row carries `cdlStatus` / `medicalCardStatus` from
       * the day the driver was added ("missing" until a document is on file) and nothing on the
       * roster side updates them; the qualification file does. So the badges the driver page
       * shows come from the file, and a driver whose file is complete is no longer held for
       * "onboarding" - the Compliance page said Compliant and the driver page said hold, and
       * they were reading two different things.
       */
      const fileStatus = (code: string) => {
        const item = gate?.items.find((i) => i.requirementCode === code);
        if (!item) return null;
        if (item.status === 'verified' || item.status === 'valid' || item.status === 'waived')
          return 'verified' as const;
        if (item.status === 'pending_verification') return 'verified' as const;
        if (item.status === 'expiring') return 'expiring' as const;
        if (item.status === 'expired') return 'expired' as const;
        return 'missing' as const;
      };
      const cleared =
        (driver.status as string) === 'onboarding' && gate !== undefined && gate.dispatchable;
      const shown = {
        ...driver,
        cdlStatus: fileStatus('cdl') ?? driver.cdlStatus,
        medicalCardStatus: fileStatus('medical_card') ?? driver.medicalCardStatus,
        status: cleared ? ('available' as const) : driver.status,
      };
      return {
        driver: shown,
        currentLoad,
        loads: driverLoads,
        performance: summarizePerformance(driverLoads.map(toPerformanceLoad)),
        compliance: gate ?? null,
        availability: driverAvailability({
          status: shown.status,
          currentLoadStatus: currentLoad?.status ?? null,
          compliant: gate?.dispatchable ?? true,
          gateReasons: gate?.gateReasons ?? [],
        }),
      };
    });

  const operationalCustomers: OperationalCustomer[] = customersPage.data.map((customer) => {
    const customerLoads = loadsByCustomerId.get(customer.id) ?? [];
    return {
      customer,
      loads: customerLoads,
      performance: summarizePerformance(customerLoads.map(toPerformanceLoad)),
      payment: paymentFor(customer.id),
    };
  });

  const operationalBrokers: OperationalBroker[] = brokersPage.data.map((broker) => {
    const brokerLoads = loadsByBrokerId.get(broker.id) ?? [];
    const performance = summarizePerformance(brokerLoads.map(toPerformanceLoad));
    const payment = paymentFor(broker.id);
    return {
      broker,
      loads: brokerLoads,
      performance,
      payment,
      risk: assessBrokerRisk({
        doNotUse: broker.doNotUse,
        doNotUseReason: broker.doNotUseReason,
        status: broker.status,
        paymentTermsDays: broker.paymentTermsDays,
        avgDaysToPay: payment.avgDaysToPay,
        overdueCount: payment.overdueCount,
        overdueAmount: payment.overdueAmount,
        disputedCount: payment.disputedCount,
        loadsSettled: performance.counts.delivered + performance.counts.cancelled,
        cancellationRatePct: performance.cancellationRatePct,
        marginPct: performance.marginPct,
      }),
    };
  });

  const attention = buildAttentionQueue({
    nowIso,
    loads: operationalLoads.map((row) => ({
      id: row.load.id,
      loadNumber: row.load.loadNumber,
      status: row.load.status,
      risk: row.risk.state,
      tracking: row.tracking.state,
      delivery: row.delivery.state,
      hasDriver: row.load.driverId !== null,
      hasTruck: row.load.truckId !== null,
      marginPct: row.economics.marginPct,
      deadheadPct: row.economics.deadheadPct,
      nextAppointmentAt: row.controllingAppointmentAt,
    })),
    trucks: operationalTrucks.map((row) => ({
      id: row.truck.id,
      unitNumber: row.truck.unitNumber,
      availability: row.availability.state,
      idleHours: row.idleHours,
    })),
    drivers: operationalDrivers.map((row) => ({
      id: row.driver.id,
      name: row.driver.name,
      availability: row.availability.state,
    })),
  });

  return {
    nowIso,
    loads: operationalLoads,
    trucks: operationalTrucks,
    drivers: operationalDrivers,
    archivedDrivers: compliance.drivers.filter((driver) => Boolean(driver.archivedAt)),
    customers: operationalCustomers,
    brokers: operationalBrokers,
    attention,
    compliance,
    byLoadNumber: new Map(operationalLoads.map((row) => [row.load.loadNumber, row])),
    byDriverId: new Map(operationalDrivers.map((row) => [row.driver.id, row])),
    byCustomerId: new Map(operationalCustomers.map((row) => [row.customer.id, row])),
    byBrokerId: new Map(operationalBrokers.map((row) => [row.broker.id, row])),
  };
}

export function useOperations(): UseQueryResult<OperationsBundle> {
  return useQuery({
    queryKey: OPERATIONS_QUERY_KEY,
    queryFn: loadOperationsBundle,
    ...BUNDLE_CACHE,
  });
}

/** Everything an operations mutation can change, invalidated by domain prefix. */
export function useInvalidateOperations(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['loads'] }),
      queryClient.invalidateQueries({ queryKey: ['load'] }),
    ]);
  };
}

export type { DriverAvailability, TruckAvailability };
