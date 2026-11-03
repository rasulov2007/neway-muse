import { MAINTENANCE_DEFAULTS, type FleetToday, type WorkOrderDetail } from '@neway/shared';

/**
 * What `GET /fleet/today` answers, shaped by hand.
 *
 * Handwritten rather than generated so each row stands for one case the board has to get right:
 * an oil change that is over, one that is close, one with no baseline at all, an overdue trailer
 * inspection (days only — a trailer has no odometer), a truck PM that is close on miles, and a
 * work order that has been in the shop long enough to read red. The object carries no cost field,
 * because the endpoint it stands in for has none.
 */
export function fleetTodayFixture(): FleetToday {
  return {
    asOf: '2026-09-17T14:30:00.000Z',
    defaults: MAINTENANCE_DEFAULTS,
    oilChanges: [
      {
        unitId: 'trk_3008',
        unitNumber: '3008',
        description: '2021 Freightliner Cascadia',
        odometer: 452_000,
        odometerAt: '2026-09-17T11:00:00.000Z',
        lastOilChangeAt: '2026-06-02T15:00:00.000Z',
        lastOilChangeOdometer: 420_000,
        intervalMiles: 25_000,
        milesRemaining: -7_000,
        status: 'overdue',
      },
      {
        unitId: 'trk_3021',
        unitNumber: '3021',
        description: '2022 Volvo VNL',
        odometer: 311_400,
        odometerAt: '2026-09-17T11:00:00.000Z',
        lastOilChangeAt: '2026-08-01T15:00:00.000Z',
        lastOilChangeOdometer: 287_000,
        intervalMiles: 25_000,
        milesRemaining: 600,
        status: 'due_soon',
      },
      {
        unitId: 'trk_3099',
        unitNumber: '3099',
        description: '2019 Kenworth T680',
        odometer: 615_000,
        odometerAt: '2026-09-17T11:00:00.000Z',
        lastOilChangeAt: null,
        lastOilChangeOdometer: null,
        intervalMiles: 25_000,
        milesRemaining: null,
        status: 'unknown',
      },
    ],
    inspections: [
      {
        unitId: 'trl_5502',
        unitNumber: '5502',
        assetType: 'trailer',
        inspectionType: 'annual_inspection',
        lastDoneAt: '2025-07-14T15:00:00.000Z',
        lastDoneOdometer: null,
        dueDate: '2026-07-14',
        dueOdometer: null,
        daysRemaining: -65,
        milesRemaining: null,
        status: 'overdue',
      },
      {
        unitId: 'trk_3021',
        unitNumber: '3021',
        assetType: 'truck',
        inspectionType: 'pm_inspection',
        lastDoneAt: '2026-07-10T15:00:00.000Z',
        lastDoneOdometer: 287_000,
        dueDate: '2026-10-08',
        dueOdometer: 312_000,
        daysRemaining: 21,
        milesRemaining: 600,
        status: 'due_soon',
      },
    ],
    workOrdersInShop: [
      {
        workOrderId: 'wo_1',
        number: 'RO-2026-0041',
        unitId: 'trk_3008',
        unitNumber: '3008',
        assetType: 'truck',
        workType: 'repair',
        label: 'Unit 3008 · Repair',
        shopStage: 'waiting_parts',
        shopInAt: '2026-09-08T13:00:00.000Z',
        downtimeMinutes: 13_050,
        assignedTo: 'Luis Ortega',
        lastAction: {
          id: 'woa_9',
          action: 'stage_changed',
          stage: 'waiting_parts',
          note: 'Injector ordered from Fort Worth',
          userName: 'Luis Ortega',
          createdAt: '2026-09-15T16:20:00.000Z',
        },
        vendorName: 'TA Truck Service – Effingham',
        scheduledFor: null,
      },
    ],
    counts: {
      oilOverdue: 1,
      oilDueSoon: 1,
      oilUnknown: 1,
      inspectionsOverdue: 1,
      inspectionsDueSoon: 1,
      inShop: 1,
    },
  };
}

/** The same work order, with its history, as `GET /fleet/work-orders/:id` answers it. */
export function workOrderDetailFixture(): WorkOrderDetail {
  return {
    id: 'wo_1',
    number: 'RO-2026-0041',
    assetType: 'truck',
    unitId: 'trk_3008',
    unitNumber: '3008',
    status: 'in_shop',
    shopStage: 'waiting_parts',
    workType: 'repair',
    workDone: null,
    shopInAt: '2026-09-08T13:00:00.000Z',
    completedAt: null,
    downtimeMinutes: 13_050,
    odometer: 452_000,
    assignedTo: 'Luis Ortega',
    label: 'Unit 3008 · Repair',
    notes: null,
    defectId: null,
    pmServiceCode: null,
    scheduledFor: null,
    responsibleName: null,
    vendorName: 'TA Truck Service – Effingham',
    driverName: 'Kelsey Boone',
    title: null,
    lines: [],
    invoiceFiles: [],
    invoiceNumber: null,
    lastAction: {
      id: 'woa_9',
      action: 'stage_changed',
      stage: 'waiting_parts',
      note: 'Injector ordered from Fort Worth',
      userName: 'Luis Ortega',
      createdAt: '2026-09-15T16:20:00.000Z',
    },
    actions: [
      {
        id: 'woa_1',
        action: 'created',
        stage: 'diagnosing',
        note: null,
        userName: 'System Administrator',
        createdAt: '2026-09-08T13:00:00.000Z',
      },
      {
        id: 'woa_9',
        action: 'stage_changed',
        stage: 'waiting_parts',
        note: 'Injector ordered from Fort Worth',
        userName: 'Luis Ortega',
        createdAt: '2026-09-15T16:20:00.000Z',
      },
    ],
    createdBy: 'System Administrator',
    createdAt: '2026-09-08T13:00:00.000Z',
    updatedAt: '2026-09-15T16:20:00.000Z',
  };
}
