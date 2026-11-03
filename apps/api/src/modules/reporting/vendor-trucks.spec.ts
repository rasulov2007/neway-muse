import { describe, expect, it } from 'vitest';
import { computeFinancials } from './engines/financial-calculator';
import type { ExpenseLine, ReportingFacts, RevenueLine } from './facts';
import { applyVendorTrucks, computeVendorMoney, type VendorArrangementFact } from './vendor-trucks';

/**
 * Vendor trucks in the company's numbers (owner, 2026-10-28): the company keeps its percentage of
 * the truck's gross as revenue and profit; the truck's driver pay, fuel and repairs leave company
 * expenses; the vendor's side is shown on its own and adds up to the gross.
 */
const range = { from: '2026-10-01', to: '2026-10-31' };
const rev = (id: string, truckId: string, day: string, linehaul: number, extra: Partial<RevenueLine> = {}): RevenueLine => ({
  loadId: id,
  loadNumber: `L-${id}`,
  truckId,
  driverId: 'drv_1',
  teamId: null,
  deliveredAt: `${day}T15:00:00.000Z`,
  deliveredOn: day,
  linehaul,
  loadedMiles: 500,
  emptyMiles: 50,
  ...extra,
});
const cost = (id: string, truckId: string | null, day: string, category: ExpenseLine['category'], amount: number, extra: Partial<ExpenseLine> = {}): ExpenseLine => ({
  id,
  date: day,
  category,
  amount,
  truckId,
  driverId: null,
  source: 'accounting',
  isEstimate: false,
  ...extra,
});
const facts = (): ReportingFacts => ({
  companyId: 'co_1',
  range,
  revenue: [
    rev('1', 'trk_v', '2026-10-10', 3000, { accessorials: 200 }),
    rev('2', 'trk_v', '2026-10-20', 2000),
    rev('3', 'trk_c', '2026-10-12', 4000),
    // Before the truck went to the vendor: the company's own load, counted whole.
    rev('4', 'trk_v', '2026-10-02', 1000),
  ],
  expenses: [
    cost('dp_v', 'trk_v', '2026-10-24', 'driver_pay', 1500),
    cost('fuel_v', 'trk_v', '2026-10-15', 'fuel', 900),
    cost('rep_v', 'trk_v', '2026-10-16', 'repairs', 400),
    cost('dp_c', 'trk_c', '2026-10-24', 'driver_pay', 1200),
    cost('fuel_c', 'trk_c', '2026-10-15', 'fuel', 700),
    cost('staff', null, '2026-10-31', 'staff_payroll', 5000),
    // Pay on a vendor-truck load with no truck on the line: found through the load.
    cost('dp_load', null, '2026-10-21', 'driver_pay', 100, { loadNumber: 'L-2' }),
    // The truck's fuel before the vendor days stays the company's.
    cost('fuel_before', 'trk_v', '2026-10-03', 'fuel', 50),
  ],
  fuel: [],
  mileage: [],
  trucks: [
    { truckId: 'trk_v', unitNumber: '0008', status: 'assigned', driverId: 'drv_1', driverName: 'A' },
    { truckId: 'trk_c', unitNumber: '0009', status: 'assigned', driverId: 'drv_2', driverName: 'B' },
  ],
  drivers: [],
  dispatchWeeks: [],
  expenseCoverage: [{ weekStart: '2026-10-05', hasExpenseData: true }],
  revenueLedgerTotal: 10200,
});
const arrangement: VendorArrangementFact = { truckId: 'trk_v', vendorId: 'ven_1', vendorName: 'Ali Vendor', companyBps: 2000, from: '2026-10-05', to: null };

describe('vendor trucks in the company numbers', () => {
  it('counts only the company share of a vendor truck as revenue, from the arrangement day on', () => {
    const out = applyVendorTrucks(facts(), [arrangement]);
    const byLoad = new Map(out.revenue.map((r) => [r.loadId, r.linehaul + (r.accessorials ?? 0)]));
    expect(byLoad.get('1')).toBe(640); // 20% of 3,200
    expect(byLoad.get('2')).toBe(400); // 20% of 2,000
    expect(byLoad.get('3')).toBe(4000); // company truck: whole
    expect(byLoad.get('4')).toBe(1000); // before the vendor: whole
    expect(out.revenueLedgerTotal).toBe(6040);
  });

  it('takes the vendor truck’s driver pay, fuel and repairs out of company expenses, never staff', () => {
    const out = applyVendorTrucks(facts(), [arrangement]);
    expect(out.expenses.map((e) => e.id).sort()).toEqual(['dp_c', 'fuel_before', 'fuel_c', 'staff']);
    expect(out.vendor?.costs.map((e) => e.id).sort()).toEqual(['dp_load', 'dp_v', 'fuel_v', 'rep_v']);
  });

  it('company profit = company trucks + the kept share; the vendor side adds up to the gross', () => {
    const out = applyVendorTrucks(facts(), [arrangement]);
    const fin = computeFinancials(out);
    // Revenue 640 + 400 + 4000 + 1000 = 6040; costs 1200 + 700 + 5000 + 50 = 6950.
    expect(fin.gross).toBe(6040);
    expect(fin.cost).toBe(6950);
    expect(fin.operatingProfit).toBe(-910);
    const money = computeVendorMoney(out);
    expect(money.trucks).toHaveLength(1);
    const t = money.trucks[0]!;
    expect(t).toMatchObject({ unitNumber: '0008', vendorName: 'Ali Vendor', companyPercent: 20, loads: 2, gross: 5200, companyShare: 1040, driverPay: 1600, truckCosts: 1300 });
    expect(t.vendorNet).toBe(5200 - 1040 - 1600 - 1300);
    expect(t.companyShare + t.driverPay + t.truckCosts + t.vendorNet).toBe(t.gross);
    expect(money.totals.companyShare).toBe(1040);
  });

  it('a truck moved back to the company counts whole again after its last vendor day', () => {
    const out = applyVendorTrucks(facts(), [{ ...arrangement, to: '2026-10-15' }]);
    const byLoad = new Map(out.revenue.map((r) => [r.loadId, r.linehaul + (r.accessorials ?? 0)]));
    expect(byLoad.get('1')).toBe(640);
    expect(byLoad.get('2')).toBe(2000);
    expect(out.expenses.some((e) => e.id === 'rep_v')).toBe(true);
    expect(out.expenses.some((e) => e.id === 'fuel_v')).toBe(false);
  });

  it('no arrangements leaves every number as it was', () => {
    const before = facts();
    const out = applyVendorTrucks(before, []);
    expect(out.revenue).toEqual(before.revenue);
    expect(out.expenses).toEqual(before.expenses);
    expect(computeVendorMoney(out).trucks).toEqual([]);
  });
});
