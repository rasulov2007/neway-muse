import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeAddress } from './address-norm';
import { planPmImport, type ImportContext } from './plan';
import { parseCsv, rowsFromGrid } from './sheet';

const FIXTURE = join(__dirname, '../../../../test/fixtures/pm-board-slice.csv');
const NAPERVILLE = normalizeAddress('1101 Frontenac Rd, Naperville, IL 60563').key as string;

function sheet() {
  return rowsFromGrid(parseCsv(readFileSync(FIXTURE, 'utf8'))).rows;
}

/** Every unit in the fixture exists in the roster; nothing is on record yet. */
function context(overrides: Partial<ImportContext> = {}): ImportContext {
  const units = new Map(
    sheet().map((r) => [r.unit as string, { id: `trk_${r.unit}`, unitNumber: r.unit as string, groupName: null, pmResponsibility: 'us', lessorName: null }]),
  );
  return {
    units,
    vendors: new Map(),
    services: new Set(),
    unitPlans: new Map(),
    readings: new Set(),
    today: '2026-09-17',
    importedAt: new Date('2026-09-17T07:45:00-05:00'),
    exportedAt: new Date('2026-09-16T18:00:00-05:00'),
    ownYardKeys: new Set([NAPERVILLE]),
    timeZone: 'America/Chicago',
    ownGroup: 'NWF',
    ...overrides,
  };
}

describe('the sheet reads as the package says', () => {
  it('has 17 rows, all ISO dates, with every cell readable', () => {
    const rows = sheet();
    expect(rows).toHaveLength(17);
    expect(rows.every((r) => r.parseErrors.length === 0)).toBe(true);
    expect(rows.every((r) => r.lastPmDateFormat === 'iso')).toBe(true);
    expect(rows[0]).toMatchObject({ unit: '0026', group: 'NWF', lastPmDate: '2026-07-07', lastPmMileage: 400_937, currentMileage: 436_158, pmEvery: 30_000, amount: 501.97 });
    expect(rows[14]).toMatchObject({ unit: '241061', group: 'M&K', amount: null, shop: null });
  });

  it('reads the customer’s own headers, a US date and a dollar sign the same way', () => {
    const grid = parseCsv(
      '#,UNIT,GROUP,LAST PM DATE,LAST PM MILEAGE,CURRENT MILEAGE,TOTAL RUNNING,PM EVERY,NEXT SERVICE,MILES LEFT,AMOUNT,SHOP\n' +
        '61,#0026,NWF,07/07/2026,"400,937","436,158","35,221","30,000","430,937","-5,221",$501.97,"1402 E Main St, Duncan, SC 29334"\n',
    );
    const { rows, missing } = rowsFromGrid(grid);
    expect(missing).toEqual([]);
    expect(rows[0]).toMatchObject({ unit: '0026', lastPmDate: '2026-07-07', lastPmDateFormat: 'us', lastPmMileage: 400_937, milesLeft: -5_221, amount: 501.97 });
  });
});

describe('A · the plan for the 17 rows', () => {
  it('A2 / A10 · 17 services, 17 unit plans, 34 readings, no units, and the interval distribution', () => {
    const plan = planPmImport(sheet(), context());
    expect(plan.parseErrors).toEqual([]);
    expect(plan.summary.imported).toBe(17);
    expect(plan.summary.skipped).toBe(0);
    expect(plan.services).toHaveLength(17);
    expect(plan.plans).toHaveLength(17);
    expect(plan.readings).toHaveLength(34);
    expect(plan.summary.unitsCreated).toBe(0);
    expect(plan.summary.intervalDistribution).toEqual([
      { intervalMiles: 30_000, count: 8 },
      { intervalMiles: 35_000, count: 5 },
      { intervalMiles: 25_000, count: 2 },
      { intervalMiles: 50_000, count: 1 },
      { intervalMiles: 20_000, count: 1 },
    ]);
  });

  it('A3 · the two rows whose own arithmetic is stale are flagged, and the stored values are recomputed', () => {
    const plan = planPmImport(sheet(), context());
    const stale = plan.rows.filter((r) => r.flags.includes('sheet_arithmetic_stale'));
    expect(stale.map((r) => r.unit).sort()).toEqual(['0017', '796570']);
    expect(plan.rows.find((r) => r.unit === '796570')?.recomputed).toEqual({ totalRunning: 54_783, nextService: 228_178, milesLeft: -4_783 });
    expect(plan.rows.find((r) => r.unit === '0017')?.recomputed).toEqual({ totalRunning: 29_643, nextService: 543_261, milesLeft: -4_643 });
    expect(plan.summary.staleArithmetic).toBe(2);
  });

  it('A4 · the three Naperville spellings become one own-yard vendor; the other addresses are drafts', () => {
    const plan = planPmImport(sheet(), context());
    const yard = plan.vendors.find((v) => v.key === NAPERVILLE);
    expect(yard?.spellings).toEqual([
      '1101 Frontenac Rd, Naperville, IL 60563, USA',
      '1101 Frontenac Rd, Naperville, IL 60563, United States',
      '1101 Frontenac RD Naperville, IL 60563',
    ]);
    expect(yard?.isOwnYard).toBe(true);
    expect(yard?.rows).toHaveLength(5);
    expect(plan.summary.merges).toEqual([{ key: NAPERVILLE, spellings: yard?.spellings }]);
    // 11 distinct shops in the sheet, all drafts on a clean database.
    expect(plan.vendors).toHaveLength(11);
    expect(plan.summary.vendorsDrafted).toBe(11);
    expect(plan.vendors.filter((v) => v.key !== NAPERVILLE).every((v) => !v.isOwnYard)).toBe(true);
    // Two ZIPs on one street would be two vendors: the rule is checked in address-norm.spec.
  });

  it('A5 · five rows have no cost and one has no shop; all still import', () => {
    const plan = planPmImport(sheet(), context());
    expect(plan.summary.costMissing).toBe(5);
    expect(plan.rows.filter((r) => r.flags.includes('cost_missing')).map((r) => r.unit).sort()).toEqual(['0017', '0048', '0066', '241061', '796570']);
    expect(plan.summary.shopMissing).toBe(1);
    expect(plan.rows.find((r) => r.flags.includes('shop_missing'))?.unit).toBe('241061');
    expect(plan.rows.every((r) => r.outcome === 'import')).toBe(true);
    const noCost = plan.services.find((s) => s.unitNumber === '0066');
    expect(noCost?.amount).toBeNull();
  });

  it('A6 · Ryder and M&K rows are the lessor’s, and the units are marked so', () => {
    const plan = planPmImport(sheet(), context());
    const ryder = plan.unitChanges.find((u) => u.unitNumber === '796570');
    const mk = plan.unitChanges.find((u) => u.unitNumber === '241061');
    expect(ryder).toMatchObject({ groupName: 'Ryder', pmResponsibility: 'lessor', lessorName: 'Ryder' });
    expect(mk).toMatchObject({ groupName: 'M&K', pmResponsibility: 'lessor', lessorName: 'M&K' });
    expect(plan.unitChanges.find((u) => u.unitNumber === '0026')).toMatchObject({ groupName: 'NWF', pmResponsibility: 'us', lessorName: null });
    expect(plan.summary.leaseRows).toBe(2);
  });

  it('A7 · without an export time every CURRENT reading is undated, which the row says', () => {
    const plan = planPmImport(sheet(), context({ exportedAt: null }));
    const current = plan.readings.filter((r) => r.kind === 'current');
    expect(current).toHaveLength(17);
    expect(current.every((r) => r.ageUnknown)).toBe(true);
    expect(plan.summary.readingsAgeUnknown).toBe(true);
    expect(plan.rows.every((r) => r.flags.includes('reading_age_unknown'))).toBe(true);
    const dated = planPmImport(sheet(), context());
    expect(dated.readings.filter((r) => r.kind === 'current').every((r) => !r.ageUnknown && r.readingAt === '2026-09-16T23:00:00.000Z')).toBe(true);
  });

  it('A8 · a unit NeWay does not have is listed and skipped, never created', () => {
    const ctx = context();
    ctx.units.delete('9010');
    const plan = planPmImport(sheet(), ctx);
    const row = plan.rows.find((r) => r.unit === '9010');
    expect(row).toMatchObject({ outcome: 'skip', skipReason: 'unit not in NeWay' });
    expect(plan.services.some((s) => s.unitNumber === '9010')).toBe(false);
    expect(plan.summary.skipped).toBe(1);
    expect(plan.summary.skippedBy).toEqual({ 'unit not in NeWay': 1 });
    expect(plan.summary.unitsCreated).toBe(0);
  });

  it('A9 · the same file again changes nothing: 17 unchanged', () => {
    const first = planPmImport(sheet(), context());
    const ctx = context();
    for (const s of first.services) ctx.services.add(`${s.unitId}|${s.serviceDate}|${s.serviceOdometer}`);
    for (const p of first.plans) ctx.unitPlans.set(p.unitId, p.intervalMiles);
    for (const r of first.readings) ctx.readings.add(`${r.unitId}|${r.readingAt.slice(0, 10) === '2026-09-16' ? '2026-09-16' : r.readingAt.slice(0, 10)}|${r.odometerMiles}|import`);
    for (const v of first.vendors) ctx.vendors.set(v.key, { id: `ven_${v.key}`, name: v.name, isOwnYard: v.isOwnYard });
    const again = planPmImport(sheet(), ctx);
    expect(again.summary.unchanged).toBe(17);
    expect(again.summary.imported).toBe(0);
    expect(again.services).toEqual([]);
    expect(again.plans).toEqual([]);
    expect(again.readings).toEqual([]);
    expect(again.summary.vendorsDrafted).toBe(0);
    expect(again.summary.vendorsMatched).toBe(11);
  });

  it('§3 · the other checks: interval, date, mileage, cost range, duplicate rows', () => {
    const rows = sheet();
    const a = rows[0]!;
    const bad = [
      { ...a, line: 100, unit: '0026', pmEvery: 1_000 },
      { ...a, line: 101, unit: '9010', lastPmDate: '2027-01-01' },
      { ...a, line: 102, unit: '0042', lastPmDate: '2022-01-01' },
      { ...a, line: 103, unit: '0066', currentMileage: 100_000 },
      { ...a, line: 104, unit: '0075', amount: 9_000 },
      { ...a, line: 105, unit: '0052' },
      { ...a, line: 106, unit: '0052', lastPmMileage: 236_727, currentMileage: 270_716 },
    ];
    const plan = planPmImport(bad, context());
    const by = (line: number) => plan.rows.find((r) => r.line === line);
    expect(by(100)).toMatchObject({ outcome: 'skip', skipReason: 'interval 1,000 is outside 5,000–100,000' });
    expect(by(101)?.skipReason).toMatch(/in the future/);
    expect(by(102)?.skipReason).toMatch(/more than 3 years ago/);
    expect(by(103)?.flags).toContain('mileage_conflict');
    expect(plan.readings.find((r) => r.line === 103 && r.kind === 'current')?.conflict).toBe(true);
    expect(by(104)?.flags).toContain('cost_out_of_range');
    expect(plan.services.find((s) => s.line === 104)?.amount).toBeNull();
    expect(by(105)).toMatchObject({ outcome: 'skip', skipReason: 'duplicate row for the unit; a later row wins' });
    expect(by(106)?.outcome).toBe('import');
  });

  it('§5 · the report’s numbers: 17 of 17 overdue, 67,771 mi in total, worst 5,221 on #0026', () => {
    const plan = planPmImport(sheet(), context());
    // Recomputed from the inputs, which is why the total is two miles more than the sheet's own.
    expect(plan.summary.overdue).toEqual({ count: 17, of: 17, totalMilesOver: 67_773, worst: { unit: '0026', milesOver: 5_221 } });
  });
});
