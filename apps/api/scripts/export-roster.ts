/**
 * One-time export of the fleet roster into a seed file.
 *
 * The roster this carrier already runs on was generated in the browser from a pinned seed. Moving
 * it into PostgreSQL is a migration of existing records, not an invention of new ones: the ids,
 * unit numbers and driver numbers are carried across unchanged, so every load, work order, fuel
 * fill, settlement and accident that already references `trk_2785` still resolves after the move.
 *
 * Run from the repo root:  npx tsx apps/api/scripts/export-roster.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAFF_DEFS, demoCompany, demoUsers, generateDemoData } from '../../web/src/demo/data';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'database', 'seed', 'roster.seed.ts');

const data = generateDemoData();

const payload = {
  company: {
    id: demoCompany.id,
    name: demoCompany.name,
    timezone: demoCompany.timezone,
    weekStart: 'monday',
  },
  trucks: data.trucks,
  drivers: data.drivers,
};

// The staff seed: the twelve people who hold accounts, as employee records.
const staffOut = join(here, '..', 'src', 'database', 'seed', 'staff.seed.ts');
const staff = STAFF_DEFS.map((def) => {
  const user = demoUsers.find((u) => u.id === def.id);
  return {
    userId: def.id,
    firstName: def.first,
    lastName: def.last,
    email: user?.email ?? '',
    phone: def.phone,
    title: def.title,
    department: def.department,
    hireDate: def.hireDate,
    managerUserId: def.managerUserId,
    // Staff work out of the company address; it is the only work location on file for them.
    location: `${demoCompany.address.city}, ${demoCompany.address.state}`,
    active: user?.status === 'active',
  };
});

const staffBanner = [
  '// GENERATED FILE - do not edit by hand.',
  '// Produced by apps/api/scripts/export-roster.ts from the pinned dataset.',
  '// The twelve people who hold accounts, as the employee records those accounts belong to.',
  "import type { StaffSeed } from './roster-seed-types';",
  '',
  'export const STAFF_SEED: StaffSeed[] = ',
].join('\n');
writeFileSync(staffOut, `${staffBanner}${JSON.stringify(staff, null, 2)};\n`, 'utf8');

const banner = [
  '// GENERATED FILE - do not edit by hand.',
  '// Produced by apps/api/scripts/export-roster.ts from the pinned fleet dataset.',
  '// This is the roster this carrier already operates, moved into the database with its ids intact,',
  '// so every load, work order, fuel fill and settlement that references a unit still resolves.',
  "import type { RosterSeed } from './roster-seed-types';",
  '',
  'export const ROSTER_SEED: RosterSeed = ',
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${banner}${JSON.stringify(payload, null, 2)};\n`, 'utf8');

console.log(
  `Exported ${payload.trucks.length} trucks, ${payload.drivers.length} drivers and ${staff.length} staff for ${payload.company.id}`,
);
