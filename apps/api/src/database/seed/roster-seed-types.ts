import type { DriverRecord, TruckRecord } from '@neway/shared';

/** The shape of the generated roster seed. Kept beside it so the generated file stays type-checked. */
export interface RosterSeed {
  company: { id: string; name: string; timezone: string; weekStart: string };
  trucks: TruckRecord[];
  drivers: DriverRecord[];
}

/** One staff member, as exported from the pinned dataset for the employee import. */
export interface StaffSeed {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  department: string;
  hireDate: string;
  managerUserId: string | null;
  location: string;
  active: boolean;
}
