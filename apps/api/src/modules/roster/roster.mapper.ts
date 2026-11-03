import type {
  DriverRecord,
  RosterDriverStatus,
  RosterTruckStatus,
  TruckRecord,
} from '@neway/shared';
import type { DriverRow, TruckRow } from '../../database/schema/roster';

/**
 * Row → record. One place, so the wire shape cannot drift between the list and the detail endpoint.
 *
 * `numeric` columns come back from postgres-js as strings — deliberately, because that is the only
 * lossless representation of an arbitrary-precision decimal. They are parsed here, at the boundary,
 * rather than left for each caller to remember.
 */

function num(value: string | number | null, fallback = 0): number {
  if (value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toTruckRecord(row: TruckRow, driverName: string | null): TruckRecord {
  return {
    id: row.id,
    unitNumber: row.unitNumber,
    vin: row.vin,
    year: row.year,
    make: row.make,
    model: row.model,
    plate: row.plate,
    plateState: row.plateState,
    color: row.color,
    status: row.status as RosterTruckStatus,
    health: row.health as TruckRecord['health'],
    ownership: row.ownership as TruckRecord['ownership'],
    odometer: row.odometer,
    odometerAt: row.odometerAt.toISOString(),
    engineHours: num(row.engineHours),
    inServiceDate: row.inServiceDate,
    currentDriverId: row.currentDriverId,
    // Never stored: a copy of a name is a copy that goes stale the day somebody is renamed.
    currentDriverName: driverName,
    currentTrailerId: row.currentTrailerId,
    currentLoadId: row.currentLoadId,
    location: (row.location as TruckRecord['location']) ?? null,
    nextServiceOdometer: row.nextServiceOdometer,
    nextServiceDate: row.nextServiceDate,
    nextServiceType: row.nextServiceType as TruckRecord['nextServiceType'],
    telematicsProvider: row.telematicsProvider,
    telematicsStatus: row.telematicsStatus as TruckRecord['telematicsStatus'],
    mpg30d: num(row.mpg30d),
    mpg90d: num(row.mpg90d),
    idlePercent30d: num(row.idlePercent30d),
    idlePercent90d: num(row.idlePercent90d),
    homeTerminal: row.homeTerminal,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The driver serializer. The licence group (CDL state/class/endorsements/expiry/status, medical
 * card expiry/status, and the date of birth) is the personal-data block a licence permission masks.
 */
export function toDriverRecord(row: DriverRow, truckUnit: string | null): DriverRecord {
  return {
    id: row.id,
    driverNumber: row.driverNumber,
    firstName: row.firstName,
    lastName: row.lastName,
    name: `${row.firstName} ${row.lastName}`.trim(),
    phone: row.phone,
    secondaryPhone: row.secondaryPhone ?? null,
    secondaryPhoneLabel: (row.secondaryPhoneLabel ?? null) as DriverRecord['secondaryPhoneLabel'],
    email: row.email,
    driverType: row.driverType as DriverRecord['driverType'],
    cdlState: row.cdlState,
    cdlClass: row.cdlClass as DriverRecord['cdlClass'],
    cdlEndorsements: Array.isArray(row.cdlEndorsements) ? (row.cdlEndorsements as string[]) : [],
    employeeId: row.employeeId ?? null,
    cdlExpiresOn: row.cdlExpiresOn,
    cdlStatus: row.cdlStatus as DriverRecord['cdlStatus'],
    medicalCardExpiresOn: row.medicalCardExpiresOn,
    medicalCardStatus: row.medicalCardStatus as DriverRecord['medicalCardStatus'],
    // PII: masked on the way out (driver-pii.ts) for anybody without a personnel-record code
    dateOfBirth: row.dateOfBirth ?? null,
    hireDate: row.hireDate,
    status: row.status as RosterDriverStatus,
    dispatcherId: row.dispatcherId,
    dispatcherName: row.dispatcherName,
    currentTruckId: row.currentTruckId,
    currentTruckUnit: truckUnit,
    currentTrailerId: row.currentTrailerId,
    homeCity: row.homeCity,
    homeState: row.homeState,
    safetyScore: num(row.safetyScore, 100),
    safetyEvents30d: row.safetyEvents30d,
    payPlan: {
      kind: row.payPlanKind as DriverRecord['payPlan']['kind'],
      rate: num(row.payPlanRate),
    },
    preferredLanguage: row.preferredLanguage as DriverRecord['preferredLanguage'],
    archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
    archivedReason: row.archivedReason ?? null,
    // The version token an edit quotes back (expectedUpdatedAt).
    ...(row.updatedAt ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}),
  };
}
