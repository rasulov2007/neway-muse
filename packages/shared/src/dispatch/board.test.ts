import { describe, expect, it } from 'vitest';
import {
  BoardLoadSchema,
  boardLoadLabel,
  daysWorked,
  evaluateFormula,
  parseAmount,
  parseMiles,
  planAdjustedCents,
  statusRank,
  WEEK_COMMENT_COLUMN,
  WEEKLY_COLUMNS,
  WriteBoardCellsSchema,
} from './board';
import { isoWeek, payBlockOf, periodOf, weekStartMonday, weeksBetween } from './periods';
import {
  DEFAULT_POLICY,
  dispatcherCommission,
  policyProblems,
  previewCommission,
  type CommissionPolicy,
} from './policy';
import { cleanTruck, parseRosterCsv, splitName, stableKey } from './roster-import';

const c = (dollars: number) => Math.round(dollars * 100);

describe('formulas, the sheet way', () => {
  it('adds, keeps precedence, tolerates commas and dollars, refuses anything else', () => {
    expect(evaluateFormula('=2150+1350')).toBe(3500);
    expect(evaluateFormula('=100+1000')).toBe(1100);
    expect(evaluateFormula('=2*(3+4)')).toBe(14);
    expect(evaluateFormula('=1,250.50 + $10')).toBe(1260.5);
    expect(evaluateFormula('=-5+2')).toBe(-3);
    expect(evaluateFormula('=alert(1)')).toBeNull();
    expect(evaluateFormula('=process.exit()')).toBeNull();
    expect(evaluateFormula('HOME')).toBeNull();
    expect(evaluateFormula('=1/0')).toBeNull();
  });
  it('reads an amount as a status word, a number or a formula', () => {
    expect(parseAmount('home')).toEqual({ kind: 'status', code: 'HOME' });
    expect(parseAmount('$2,150')).toEqual({ kind: 'number', value: 2150, formula: null });
    expect(parseAmount('=2150+1350')).toEqual({ kind: 'number', value: 3500, formula: '=2150+1350' });
    expect(parseAmount('abc')).toBeNull();
  });
  it('reads miles with commas and a mi suffix, never negative', () => {
    expect(parseMiles('1,250 mi')).toEqual({ value: 1250, formula: null });
    expect(parseMiles('=600+650')).toEqual({ value: 1250, formula: '=600+650' });
    expect(parseMiles('-40')).toBeNull();
    expect(parseMiles('far')).toBeNull();
  });
});

describe('weeks, ISO weeks and pay periods', () => {
  it('starts on Monday and counts four-week blocks from 15 Jun 2026', () => {
    expect(weekStartMonday('2026-09-22')).toBe('2026-09-21');
    expect(weekStartMonday('2026-09-27')).toBe('2026-09-21');
    expect(payBlockOf('2026-06-15')).toMatchObject({ block: 1, week: 1, start: '2026-06-15', end: '2026-07-12' });
    expect(payBlockOf('2026-07-06')).toMatchObject({ block: 1, week: 4 });
    expect(payBlockOf('2026-07-13')).toMatchObject({ block: 2, week: 1, start: '2026-07-13' });
    expect(isoWeek('2026-09-21')).toEqual({ year: 2026, week: 39 });
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
    expect(weeksBetween('2026-07-13', '2026-08-09')).toEqual(['2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03']);
    expect(periodOf('month', '2026-09-22')).toMatchObject({ start: '2026-09-01', end: '2026-09-30' });
  });
});

describe('the weekly rules', () => {
  it('takes off-days off the plan, but not REST', () => {
    expect(daysWorked(['ENROUTE', 'ENROUTE', 'HOME', 'REST', null, 'SHOP', 'VACATION'])).toBe(4);
    // INACTIVE takes a day off like HOME (owner, 2026-10-28).
    expect(daysWorked(['ENROUTE', 'INACTIVE', 'inactive', null, null, null, null])).toBe(5);
    expect(planAdjustedCents(c(8_000), c(10_000), 4)).toBe(228571);
  });
  it('orders rows RE-UPDATE first and SHOP last, unknown after everything', () => {
    expect(statusRank('RE-UPDATE')).toBe(0);
    expect(statusRank('shop')).toBe(13);
    expect(statusRank(null)).toBe(14);
  });
});

describe('DISP-KPI-01, the worked examples of the policy document', () => {
  const run = (unit: 'solo' | 'team', gross: number, rpm: number | null, extra = {}) =>
    dispatcherCommission({ unit, grossCents: c(gross), miles: rpm === null ? null : gross / rpm, ...extra });
  it('Ex. 1 · solo $16,000 at $3.00 → Elite 2.25 % = $360', () => {
    const r = run('solo', 16_000, 3.0);
    expect(r).toMatchObject({ status: 'ok', pct: 2.25, amountCents: 36000, tier: 'Elite' });
  });
  it('Ex. 2 · solo $11,000 at $2.70 → reduced to 1 % = $110', () => {
    expect(run('solo', 11_000, 2.7)).toMatchObject({ status: 'reduced', pct: 1, amountCents: 11000 });
  });
  it('Ex. 3 · team $22,000 at $4.20 → 2.25 % + 0.25 % = $550', () => {
    expect(run('team', 22_000, 4.2)).toMatchObject({ status: 'ok', pct: 2.5, amountCents: 55000, bonusPct: 0.25 });
  });
  it('Ex. 4 · solo $14,000 below $2.80 → 1 % = $140', () => {
    expect(run('solo', 14_000, 2.6)).toMatchObject({ status: 'reduced', amountCents: 14000 });
  });
  it('Ex. 5 · solo $9,200 below the floor → flat 1 % = $92, whatever the RPM', () => {
    expect(run('solo', 9_200, 3.1)).toMatchObject({ status: 'below_floor', amountCents: 9200 });
    expect(run('solo', 9_200, 2.1)).toMatchObject({ status: 'below_floor', amountCents: 9200 });
    expect(run('solo', 9_200, null)).toMatchObject({ status: 'below_floor', amountCents: 9200 });
  });
  it('team floor is $16,000: $15,000 pays flat 1 %, $16,000 enters the tiers', () => {
    expect(run('team', 15_000, 3.5)).toMatchObject({ status: 'below_floor', amountCents: 15000 });
    expect(run('team', 16_000, 3.5)).toMatchObject({ status: 'ok', pct: 1.5, amountCents: 24000 });
  });
  it('above the floor with no miles asks for miles instead of paying $0 silently', () => {
    expect(run('solo', 12_500, null)).toMatchObject({ status: 'needs_miles', amountCents: 0 });
  });
  it('RPM below $2.50 above the floor pays nothing; the exact RPM decides, not a rounded one', () => {
    expect(run('solo', 14_000, 2.4)).toMatchObject({ status: 'no_payment', amountCents: 0 });
    // 2.796 would round to 2.80 at 10¢; the exact figure stays below the minimum.
    expect(run('solo', 14_000, 2.796)).toMatchObject({ status: 'reduced', pct: 1 });
    expect(run('solo', 14_000, 2.8)).toMatchObject({ status: 'ok', pct: 2 });
  });
  it('the RPM bonus needs the bonus threshold and no complaint', () => {
    expect(run('solo', 11_000, 4.2)).toMatchObject({ pct: 1.5, bonusPct: 0 });
    expect(run('solo', 12_000, 4.2)).toMatchObject({ pct: 2.25, bonusPct: 0.5 });
    expect(run('solo', 12_000, 4.2, { complaint: true })).toMatchObject({ pct: 1.75, bonusPct: 0, bonusWithheld: true });
    expect(run('team', 29_000, 5.6)).toMatchObject({ pct: 4, bonusPct: 1 });
  });
  it('a junior above the floor gets the flat junior rate', () => {
    expect(run('solo', 18_000, 4.5, { junior: true })).toMatchObject({ status: 'junior', pct: 1, amountCents: 18000 });
  });
  it('no positive gross is $0', () => {
    expect(run('solo', 0, null)).toMatchObject({ status: 'no_gross', amountCents: 0 });
  });
  it('rounds to the cent', () => {
    expect(run('solo', 10_333.33, 3.0).amountCents).toBe(15500);
  });
});

describe('policy validation', () => {
  it('accepts the shipped policy and rejects overlapping or descending tiers', () => {
    expect(policyProblems(DEFAULT_POLICY)).toEqual([]);
    const bad: CommissionPolicy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
    bad.solo.tiers[2]!.from = 11_000;
    bad.team.softFloor = 15_000;
    bad.rpmNoPay = 3.2;
    const problems = policyProblems(bad);
    expect(problems.some((p) => p.includes('Solo gross tier 3'))).toBe(true);
    expect(problems.some((p) => p.includes('Team soft floor'))).toBe(true);
    expect(problems.some((p) => p.includes('RPM minimum'))).toBe(true);
  });
  it('previews the representative rows', () => {
    const rows = previewCommission(DEFAULT_POLICY);
    expect(rows.find((r) => r.label.startsWith('Solo · $9,200'))?.result.amountCents).toBe(9200);
    expect(rows.find((r) => r.label.includes('no miles'))?.result.status).toBe('needs_miles');
  });
});

describe('roster import', () => {
  it('splits co-drivers on // and on the Baldwine / Michaelle slash, lifts pay tags, keeps zeros', () => {
    expect(splitName('JOHN SMITH // MARK DOE (lLO)')).toEqual({ name: 'John Smith', coDriver: 'Mark Doe', payTag: 'lLO' });
    expect(splitName('Baldwine / Michaelle')).toEqual({ name: 'Baldwine', coDriver: 'Michaelle', payTag: null });
    expect(splitName('ANNA LEE (C30)')).toEqual({ name: 'Anna Lee', coDriver: null, payTag: 'C30' });
    expect(cleanTruck('# 0053')).toBe('0053');
    expect(cleanTruck('202')).toBe('202');
    expect(stableKey('Team A', 'JOHN')).toBe(stableKey('team a ', ' john'));
  });
  it('reads a header layout and a sectioned layout the same way, and flags shared trucks', () => {
    const header = 'Team,Driver,Truck\nARLO / MAXWELL,JOHN SMITH,# 0053\n,"DOE, JANE (CD)",0086\nLILY,PETER PAN,0053\n';
    const a = parseRosterCsv(header);
    expect(a.rows).toHaveLength(3);
    expect(a.rows[1]).toMatchObject({ team: 'ARLO / MAXWELL', name: 'Doe, Jane', payTag: 'CD', truckUnit: '0086' });
    expect(a.conflicts).toEqual([
      { truckUnit: '0053', rows: [expect.objectContaining({ name: 'John Smith' }), expect.objectContaining({ name: 'Peter Pan' })] },
    ]);
    const sectioned = 'ARLO / MAXWELL\nJOHN SMITH,# 0053\nLILY\nPETER PAN,202\n';
    const b = parseRosterCsv(sectioned);
    expect(b.rows.map((r) => [r.team, r.name, r.truckUnit])).toEqual([
      ['ARLO / MAXWELL', 'John Smith', '0053'],
      ['LILY', 'Peter Pan', '202'],
    ]);
    expect(parseRosterCsv(header).rows[0]!.importKey).toBe(parseRosterCsv(header).rows[0]!.importKey);
  });
});

describe('weekly Comment column', () => {
  it('is a weekly column the cell write accepts, as free text', () => {
    expect(WEEKLY_COLUMNS).toContain(WEEK_COMMENT_COLUMN);
    const parsed = WriteBoardCellsSchema.parse({
      cells: [{ driverId: 'r1', day: '2026-09-28', column: WEEK_COMMENT_COLUMN, value: 'Home Friday, =call broker', expectedVersion: null }],
    });
    expect(parsed.cells[0]!.column).toBe('wk_comment');
  });
});

describe('the load label on the boards (owner, 2026-10-21)', () => {
  it('puts the broker reference before the load number when there is one', () => {
    expect(boardLoadLabel({ loadNumber: 'L-100009', brokerReference: '4471823' })).toBe('4471823/L-100009');
    expect(boardLoadLabel({ loadNumber: 'L-100009', brokerReference: '  4471823 ' })).toBe('4471823/L-100009');
  });
  it('is the load number alone without one', () => {
    expect(boardLoadLabel({ loadNumber: 'L-100009', brokerReference: null })).toBe('L-100009');
    expect(boardLoadLabel({ loadNumber: 'L-100009', brokerReference: '   ' })).toBe('L-100009');
    expect(boardLoadLabel({ loadNumber: 'L-100009' })).toBe('L-100009');
  });
  it('is accepted by the board load schema, old rows included', () => {
    const base = { id: 'ld', loadNumber: 'L-1', status: 'dispatched', origin: 'A', destination: 'B', pickupAt: '', pickupZone: null, deliveryAt: '', deliveryZone: null, rate: 0, loadedMiles: 0, trailer: null };
    expect(BoardLoadSchema.parse(base).brokerReference).toBeUndefined();
    expect(BoardLoadSchema.parse({ ...base, brokerReference: '4471823' }).brokerReference).toBe('4471823');
  });
});
