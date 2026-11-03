// TEST FIXTURES ONLY — never load into production (ACCEPTANCE §0). Ported from docs/accidents/prototype/src/data/seed.ts:
// money ×100 to integer cents (`3960_00` = $3,960.00), stage/flag names per the v2 domain model, loads explicitly
// non-hazmat (the prototype's fixture loads are all non-hazmat), and local times converted with the DST-safe helper.
// FICTIONAL demo data. Every person, unit, load, vendor, insurer and number below is invented
// for the prototype and is not taken from Northwind Freight production records.
import type {
  SafetyRulesState, AccidentCase, Claim, Task, Evidence, TimelineEvent, WorkOrder, Bill, DowntimePeriod, Person, Driver, Truck, Trailer, Load,
  EquipmentState, CorrectiveAction, ClaimType, ClaimStatus, Fact, ChecklistItem, EventSource, EvidenceCategory,
} from '../types.js';
import { localToUtc } from '../time.js';

const CT = 'America/Chicago', ET = 'America/New_York', PT = 'America/Los_Angeles';
const at = (local: string, tz = ET): string => {
  const r = localToUtc(local, tz);
  if (!r.ok) throw new Error(`fixture time ${local} ${tz}: ${r.message}`);
  return r.iso;
};
/** Whole dollars → cents (used where the prototype computed amounts). */
const $ = (dollars: number): number => Math.round(dollars * 100);

/* ----------------------------------------------------------------- people */
export const PEOPLE: Person[] = [
  { id: 'p_rm', name: 'Rachel Moore', title: 'Safety Manager', dept: 'Safety', initials: 'RM', base: 'US', role: 'safety_manager' },
  { id: 'p_ta', name: 'Timur Aliev', title: 'Safety Specialist', dept: 'Safety', initials: 'TA', base: 'Tashkent', role: 'safety_specialist' },
  { id: 'p_nk', name: 'Nilufar Karimova', title: 'Claims Specialist', dept: 'Claims', initials: 'NK', base: 'Tashkent', role: 'claims' },
  { id: 'p_dv', name: 'Dmitri Volkov', title: 'Fleet Manager', dept: 'Fleet', initials: 'DV', base: 'US', role: 'fleet' },
  { id: 'p_sy', name: 'Sardor Yusupov', title: 'Dispatch Lead', dept: 'Dispatch', initials: 'SY', base: 'Tashkent', role: 'dispatch' },
  { id: 'p_ks', name: 'Kamila Saidova', title: 'AP Accountant', dept: 'Accounting', initials: 'KS', base: 'Tashkent', role: 'accounting' },
  { id: 'p_jb', name: 'James Booker', title: 'Operations Manager', dept: 'Management', initials: 'JB', base: 'US', role: 'ops_manager' },
  { id: 'p_ow', name: 'Company Owner', title: 'Owner / CEO', dept: 'Management', initials: 'CO', base: 'US', role: 'owner' },
  { id: 'p_ln', name: 'Lola Nazarova', title: 'Driver Relations', dept: 'Driver Relations', initials: 'LN', base: 'Tashkent', role: 'safety_specialist' },
];

/* ----------------------------------------------------------------- drivers */
const D = (id: string, name: string, type: Driver['type'], hired: string, terminal = 'Bensenville, IL', st = 'IL'): Driver =>
  ({ id, name, type, hired, phone: '(555) 01' + id.slice(1).padStart(2, '0') + '-' + (4100 + Number(id.slice(1)) * 7), terminal, cdlState: st });
export const DRIVERS: Driver[] = [
  D('d1', 'John Smith', 'Company driver', '2024-03-11'), D('d2', 'Andre Lewis', 'Company driver', '2023-08-02'),
  D('d3', 'Ruslan Tursunov', 'Lease operator', '2024-11-18', 'Harrisburg, PA', 'PA'), D('d4', 'Daniel Okafor', 'Company driver', '2025-02-03', 'Gary, IN', 'IN'),
  D('d5', 'Carlos Mendes', 'Company driver', '2022-06-27'), D('d6', 'Viktor Hale', 'Company driver', '2021-09-13'),
  D('d7', 'Marcus Bell', 'Company driver', '2023-01-16'), D('d8', 'Samuel Ortiz', 'Company driver', '2024-07-08', 'Laredo, TX', 'TX'),
  D('d9', 'Kevin Brooks', 'Company driver', '2025-01-20'), D('d10', 'Azamat Nurmatov', 'Lease operator', '2023-05-30', 'Harrisburg, PA', 'PA'),
  D('d11', 'Jean-Bastian Pierre', 'Company driver', '2022-10-03'), D('d12', 'Tyrone Jackson', 'Company driver', '2024-04-15', 'Forest Park, GA', 'GA'),
  D('d13', 'Eldor Rakhimov', 'Owner-operator', '2023-12-04'), D('d14', 'Mike Kowalski', 'Company driver', '2021-03-22', 'Columbus, OH', 'OH'),
  D('d15', 'Luis Herrera', 'Company driver', '2024-09-09', 'Edison, NJ', 'NJ'), D('d16', 'Bekzod Usmonov', 'Lease operator', '2025-04-14'),
  D('d17', "Patrick O'Neil", 'Company driver', '2023-06-19', 'Ontario, CA', 'CA'), D('d18', 'Omar Haddad', 'Company driver', '2024-01-29'),
  D('d19', 'Ivan Petrenko', 'Owner-operator', '2022-08-15'), D('d20', 'Chris Walker', 'Company driver', '2025-05-05', 'Joplin, MO', 'MO'),
];

/* ----------------------------------------------------------------- trucks & trailers */
const MODELS: [string, string][] = [['Freightliner', 'Cascadia'], ['Volvo', 'VNL 760'], ['Kenworth', 'T680'], ['International', 'LT625'], ['Peterbilt', '579']];
const T = (unit: string, i: number, status: Truck['status'], driverId?: string, trailerId?: string, loadId?: string, location = 'Bensenville, IL'): Truck =>
  ({ id: 't' + unit, unit, year: 2020 + (i % 5), make: MODELS[i % 5]![0], model: MODELS[i % 5]![1], vinTail: String(410000 + i * 3917).slice(0, 6), status, driverId, trailerId, loadId, dailyContributionCents: (600 + (i % 4) * 30) * 100, location });
export const TRUCKS: Truck[] = [
  T('101', 0, 'Available'), T('104', 1, 'Dispatched', 'd8', 'tlT-5302', undefined, 'Laredo, TX'), T('107', 2, 'Available'), T('109', 3, 'Dispatched', 'd6', 'tlT-5321', undefined, 'Rockford, IL'),
  T('112', 4, 'Dispatched', 'd9', 'tlT-5308', undefined, 'Elk Grove Village, IL'), T('115', 0, 'Available'), T('118', 1, 'In shop', 'd2', undefined, undefined, 'Joliet, IL (Prairie State Truck & Body)'),
  T('121', 2, 'Dispatched', 'd10', 'tlT-5313', undefined, 'Allentown, PA'), T('125', 3, 'Dispatched', 'd1', 'tlT-5318', 'lL-48213', 'I-65 S near Lafayette, IN'),
  T('128', 4, 'Dispatched', 'd11', 'tlT-5324', undefined, 'Joliet, IL'), T('131', 0, 'Dispatched', 'd7', 'tlT-5310', undefined, 'Columbus, OH'),
  T('133', 1, 'Dispatched', 'd4', 'tlT-5333', 'lL-48222', 'Fort Wayne, IN'), T('136', 2, 'Dispatched', 'd12', 'tlT-5336', undefined, 'Atlanta, GA'),
  T('139', 3, 'Available'), T('142', 4, 'Dispatched', 'd5', 'tlT-5305', 'lL-48077', 'Springfield, IL'), T('145', 0, 'Dispatched', 'd13', 'tlT-5339', undefined, 'Lafayette, IN'),
  T('148', 1, 'Available'), T('151', 2, 'Dispatched', 'd14', 'tlT-5345', undefined, 'Columbus, OH'), T('154', 3, 'Available'),
  T('156', 4, 'Dispatched', 'd3', 'tlT-5355', undefined, 'Harrisburg, PA'), T('159', 0, 'Dispatched', 'd15', 'tlT-5351', undefined, 'Edison, NJ'),
  T('162', 1, 'Dispatched', 'd16', 'tlT-5316', undefined, 'Nashville, TN'), T('165', 2, 'Dispatched', 'd17', 'tlT-5348', undefined, 'Ontario, CA'),
  T('168', 3, 'Available'), T('171', 4, 'Dispatched', 'd18', 'tlT-5327', undefined, 'Madison, WI'), T('174', 0, 'Dispatched', 'd19', 'tlT-5330', undefined, 'Lexington, KY'),
  T('177', 1, 'Dispatched', 'd20', 'tlT-5358', undefined, 'Joplin, MO'), T('180', 2, 'Available'), T('183', 3, 'Available'), T('186', 4, 'Available'),
];
const TL = (unit: string, i: number, status: Trailer['status'] = 'In use', location = 'On truck'): Trailer => ({ id: 'tl' + unit, unit, year: 2018 + (i % 7), make: ['Utility', 'Wabash', 'Great Dane', 'Hyundai Translead'][i % 4]!, status, location });
export const TRAILERS: Trailer[] = ['T-5302', 'T-5305', 'T-5308', 'T-5310', 'T-5313', 'T-5316', 'T-5318', 'T-5321', 'T-5324', 'T-5327', 'T-5330', 'T-5333', 'T-5336', 'T-5339', 'T-5342', 'T-5345', 'T-5348', 'T-5351', 'T-5355', 'T-5358']
  .map((u, i) => TL(u, i, u === 'T-5342' ? 'Available' : 'In use', u === 'T-5342' ? 'Harrisburg, PA yard' : 'On truck'));

/* ----------------------------------------------------------------- loads */
const L = (number: string, customer: string, broker: string | undefined, commodity: string, value: number, weightLbs: number, origin: string, destination: string, pickupAt: string, deliveryDue: string, status: Load['status'], truckId?: string, driverId?: string, trailerId?: string): Load =>
  ({ id: 'l' + number, number, customer, broker, commodity, valueCents: $(value), weightLbs, origin, destination, pickupAt, deliveryDue, status, truckId, driverId, trailerId, hazmat: false });
export const LOADS: Load[] = [
  L('L-48213', 'Great Plains Paper Co.', 'Lakeshore Freight Brokerage', 'Paper towels & tissue', 61200, 38400, 'Chicago, IL', 'Columbus, OH', at('2026-10-19T08:00', CT), at('2026-10-20T08:00', ET), 'In transit', 't125', 'd1', 'tlT-5318'),
  L('L-48222', 'Calumet Auto Components', undefined, 'Auto parts (palletized)', 88400, 31200, 'Fort Wayne, IN', 'Dayton, OH', at('2026-10-19T13:00', ET), at('2026-10-20T07:00', ET), 'In transit', 't133', 'd4', 'tlT-5333'),
  L('L-48077', 'Heartland Canned Foods', 'Crossroads Logistics', 'Canned vegetables', 42800, 42100, 'Springfield, IL', 'St. Louis, MO', at('2026-10-19T10:00', CT), at('2026-10-19T19:00', CT), 'In transit', 't142', 'd5', 'tlT-5305'),
  L('L-47982', 'Brightline Paper Products', 'Lakeshore Freight Brokerage', 'Paper towels (38 pallets)', 58600, 38000, 'Joliet, IL', 'Columbus, OH', at('2026-10-02T09:00', CT), at('2026-10-02T23:59', ET), 'Repowered', 't118', 'd2', 'tlT-5310'),
  L('L-47790', 'Riverbend Appliance Distribution', 'Lakeshore Freight Brokerage', 'Small kitchen appliances (22 pallets)', 96400, 27600, 'Harrisburg, PA', 'Atlanta, GA', at('2026-09-21T18:00', ET), at('2026-09-23T08:00', ET), 'Partially rejected', 't156', 'd3', 'tlT-5342'),
  L('L-48120', 'Calumet Auto Components', undefined, 'Auto parts (palletized)', 74100, 29800, 'Hammond, IN', 'Dayton, OH', at('2026-10-17T15:00', CT), at('2026-10-18T06:00', ET), 'Delivered', 't133', 'd4', 'tlT-5333'),
  L('L-48014', 'Heartland Canned Foods', 'Crossroads Logistics', 'Canned vegetables', 41900, 41800, 'Springfield, IL', 'Indianapolis, IN', at('2026-10-13T09:00', CT), at('2026-10-14T12:00', ET), 'Delivered', 't142', 'd5', 'tlT-5305'),
  L('L-46210', 'Prairie Foods', undefined, 'Dry groceries', 39800, 40200, 'Aurora, IL', 'Milwaukee, WI', at('2026-05-09T05:00', CT), at('2026-05-09T13:00', CT), 'Delivered', 't109', 'd6', 'tlT-5321'),
  L('L-47900', 'Pacific Gadget Supply', 'Coastline Freight', 'Consumer electronics', 58900, 18200, 'Ontario, CA', 'Phoenix, AZ', at('2026-09-29T14:00', PT), at('2026-10-01T08:00', 'America/Phoenix'), 'Delivered', 't165', 'd17', 'tlT-5348'),
  L('L-46980', 'Hoosier Home Goods', 'Crossroads Logistics', 'Housewares (cartons)', 24600, 21800, 'Laredo, TX', 'Indianapolis, IN', at('2026-08-19T07:00', CT), at('2026-08-22T08:00', ET), 'Delivered', 't104', 'd8', 'tlT-5302'),
  L('L-46440', 'Great Plains Paper Co.', undefined, 'Paper goods', 31800, 30100, 'Chicago, IL', 'Madison, WI', at('2026-07-13T06:00', CT), at('2026-07-13T14:00', CT), 'Delivered', 't171', 'd18', 'tlT-5327'),
];

/* ----------------------------------------------------------------- builders */
let seqId = 1;
const nid = (p: string) => `${p}${seqId++}`;
const EQ_OK: EquipmentState = { condition: 'drivable', status: 'operational', damage: '' };
const eq = (o: Partial<EquipmentState>): EquipmentState => ({ ...EQ_OK, ...o });

function baseCase(o: Partial<AccidentCase> & Pick<AccidentCase, 'id' | 'number' | 'occurredAt' | 'tz' | 'type' | 'description' | 'severity'>): AccidentCase {
  return {
    stage: 'closed', createdAt: o.occurredAt, createdBy: 'p_rm', updatedAt: o.occurredAt, version: 3, submittedAt: o.occurredAt, isTest: false,
    timeProvenance: 'verified', location: { city: '', state: '', publicRoad: 'yes' }, locationProvenance: 'verified', descriptionProvenance: 'driver',
    injuries: { status: 'no', treatedAway: 0, fatalities: 0, ourDriver: 'no', provenance: 'verified' }, towAway: 'no', towProvenance: 'verified',
    citation: { status: 'no' }, hazmat: 'no', police: { responded: 'no' }, conditions: {}, vehicles: [], witnesses: [],
    equipment: { truck: eq({}) }, cargo: { status: 'no_damage', plan: 'none_needed' }, immediate: [],
    investigation: { status: 'complete', ownerId: 'p_rm', facts: [], questions: [], statements: [], checklist: [], factors: [] },
    determinations: { fault: { value: 'not_determined' }, preventability: { value: 'not_determined' }, cpdp: { value: 'not_applicable' }, legal: { value: 'no_claim_expected' } },
    correctiveActions: [], testing: { alcohol: { substance: 'alcohol', decision: 'auto' }, drug: { substance: 'drug', decision: 'auto' } },
    ownerId: 'p_rm',
    ...o,
  } as AccidentCase;
}

const ev = (caseId: string | undefined, a: string, source: EventSource, by: string, text: string, extra: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id: nid('v'), caseId, at: a, loggedAt: extra.loggedAt || a, by, source, text, kind: 'milestone', ...extra });

const evd = (caseId: string, category: EvidenceCategory, name: string, description: string, uploadedAt: string, uploadedBy: string, kind: Evidence['kind'] = 'photo', extra: Partial<Evidence> = {}): Evidence =>
  ({ id: nid('e'), caseId, category, name, description, kind, uploadedAt, uploadedBy, sizeKb: kind === 'photo' ? 2400 + (seqId % 7) * 310 : kind === 'video' ? 48200 : 380 + (seqId % 5) * 90, versions: [{ v: 1, at: uploadedAt, by: uploadedBy, note: 'Original upload' }], ...extra });

const task = (caseId: string | undefined, title: string, dept: Task['dept'], assigneeId: string, due: string, status: Task['status'], createdAt: string, extra: Partial<Task> = {}): Task =>
  ({ id: nid('t'), caseId, title, dept, assigneeId, due, status, priority: 'normal', updates: [], createdAt, createdBy: 'p_rm', ...(status === 'done' ? { completedAt: extra.completedAt || due, completedBy: assigneeId } : {}), ...extra });

const fact = (text: string, source: string, provenance: Fact['provenance'], by: string, a: string): Fact => ({ id: nid('f'), text, source, provenance, by, at: a });
const ck = (key: string, label: string, state: ChecklistItem['state'], note?: string, restricted?: boolean): ChecklistItem => ({ key, label, state, note, restricted });

/* ----------------------------------------------------------------- showcase cases */
const cases: AccidentCase[] = []; const claims: Claim[] = []; const tasks: Task[] = []; const evidence: Evidence[] = [];
const events: TimelineEvent[] = []; const workOrders: WorkOrder[] = []; const bills: Bill[] = []; const downtime: DowntimePeriod[] = [];

function claim(o: Partial<Claim> & Pick<Claim, 'id' | 'number' | 'type' | 'status' | 'title' | 'insurer' | 'openedAt' | 'ownerId'>): Claim {
  return { isTest: false, payments: [], docs: [], log: [], lastUpdateAt: o.openedAt, ...o } as Claim;
}
function bill(o: Omit<Bill, 'id'>): Bill { const b = { id: 'b' + o.number.replace(/\D/g, ''), ...o }; bills.push(b); return b; }
function wo(o: Omit<WorkOrder, 'id'>): WorkOrder { const w = { id: 'w' + o.number.split('-').pop(), ...o }; workOrders.push(w); return w; }

/* ===== CASE 5 — fully resolved (ACC-2026-008) ===== */
{
  const id = 'c008', occ = at('2026-05-09T08:15', CT);
  const w = wo({ number: 'RO-2026-9041', unitKind: 'trailer', unitId: 'tlT-5321', caseId: id, type: 'Accident repair', title: 'Left side panel, 3 marker lights, side skirt bracket', shop: 'Bensenville Trailer Service', status: 'Completed', estimates: [{ id: 'es1', vendor: 'Bensenville Trailer Service', amountCents: 3960_00, at: at('2026-05-11T10:00', CT), selected: true }], estimatesRequired: 1, approvedAmountCents: 3960_00, approvedBy: 'p_dv', invoiceNumber: 'BTS-22816', invoiceTotalCents: 3960_00, openedAt: at('2026-05-09T11:30', CT), shopInAt: at('2026-05-10T07:00', CT), completedAt: at('2026-05-13T10:00', CT), createdBy: 'p_dv' });
  const b1 = bill({ number: 'AP-90098', vendor: 'Bensenville Trailer Service', amountCents: 3960_00, date: at('2026-05-13T12:00', CT), status: 'Paid', category: 'Trailer repair', caseId: id, woId: w.id, memo: 'Trailer T-5321 side panel & lights' });
  w.billId = b1.id;
  const kL = 'k0019';
  bill({ number: 'AP-90112', vendor: 'Harborline Insurance', amountCents: 2500_00, date: at('2026-06-30T12:00', CT), status: 'Paid', category: 'Deductible', caseId: id, claimId: kL, memo: 'Deductible reimbursement — CLM-2026-0019' });
  claims.push(claim({
    id: kL, number: 'CLM-2026-0019', caseId: id, type: 'auto_liability', status: 'Closed', title: 'Pickup truck damage (sideswipe)', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-AL-51904',
    adjuster: { name: 'Karen Whitfield', phone: '(555) 014-2230', email: 'k.whitfield@harborline.example' }, claimant: 'D. Ramirez (pickup owner)', openedAt: at('2026-05-12T09:30', CT), reportedToInsurerAt: at('2026-05-12T09:30', CT),
    claimedCents: 8400_00, reserveCents: 9000_00, deductibleCents: 2500_00, settlementCents: 7900_00, ownerId: 'p_nk', lastUpdateAt: at('2026-06-30T12:00', CT), closedAt: at('2026-06-30T12:00', CT),
    payments: [{ id: 'pp1', at: at('2026-06-18T12:00', CT), amountCents: 7900_00, direction: 'by_insurer_to_claimant', party: 'Harborline Insurance', note: 'Settlement to claimant' }, { id: 'pp2', at: at('2026-06-30T12:00', CT), amountCents: 2500_00, direction: 'by_us', party: 'Northwind Freight', note: 'Deductible reimbursement', billId: 'b90112' }],
    docs: [{ id: 'dd1', label: 'Police report', received: true }, { id: 'dd2', label: 'Claimant repair estimate', received: true }, { id: 'dd3', label: 'Release signed by claimant', received: true }],
    log: [{ id: 'lg1', at: at('2026-05-12T09:30', CT), by: 'p_nk', channel: 'Portal', text: 'First notice of loss filed with Harborline.' }, { id: 'lg2', at: at('2026-06-18T12:00', CT), by: 'p_nk', channel: 'Email', text: 'Adjuster confirms settlement of $7,900 paid to claimant; release received.' }, { id: 'lg3', at: at('2026-06-30T12:00', CT), by: 'p_ks', channel: 'Note', text: 'Deductible invoice $2,500 paid (AP-90112).' }],
  }));
  downtime.push({ id: 'd008a', caseId: id, unitKind: 'trailer', unitId: 'tlT-5321', start: occ, end: at('2026-05-13T10:00', CT), source: 'Work order', verifiedBy: 'p_dv' });
  downtime.push({ id: 'd008b', caseId: id, unitKind: 'truck', unitId: 't109', start: occ, end: at('2026-05-09T12:30', CT), source: 'Daily board status', verifiedBy: 'p_dv', note: 'Swapped to spare trailer T-5308 and resumed' });
  cases.push(baseCase({
    id, number: 'ACC-2026-008', occurredAt: occ, tz: CT, type: 'Sideswipe / lane change', severity: 'serious', stage: 'closed', createdAt: at('2026-05-09T08:31', CT), submittedAt: at('2026-05-09T08:36', CT),
    description: 'Moving from the center to the left lane, the trailer made contact with a pickup in the left lane. Both vehicles pulled to the shoulder. The pickup could not be driven and was towed.',
    location: { road: 'I-294 NB', detail: 'MM 30', city: 'Hillside', state: 'IL', lat: 41.871, lng: -87.903, publicRoad: 'yes' },
    driverId: 'd6', truckId: 't109', trailerId: 'tlT-5321', loadId: 'lL-46210',
    towAway: 'yes', citation: { status: 'yes', issuedAt: at('2026-05-09T09:05', CT), note: 'Improper lane usage' }, police: { responded: 'yes', dept: 'Illinois State Police — District 15', reportNumber: 'SP15-26-04471' },
    conditions: { weather: 'Clear', road: 'Dry', light: 'Daylight' },
    vehicles: [{ id: 'v1', description: '2019 pickup truck (gray)', owner: 'D. Ramirez', insurer: 'Owner’s carrier on file', damage: 'Right side and front wheel; not drivable', towed: 'yes' }],
    equipment: { truck: eq({ damage: 'was not damaged' }), trailer: eq({ condition: 'drivable', status: 'returned', damage: 'had left side panel and marker light damage', rtsAt: at('2026-05-13T10:00', CT) }) },
    cargo: { status: 'no_damage', plan: 'delivered_as_is', deliveryImpact: 'delivered 4 hours late' },
    investigation: {
      status: 'complete', ownerId: 'p_rm', submittedBy: 'p_rm', submittedAt: at('2026-05-19T15:00', CT), approvedBy: 'p_jb', completedAt: at('2026-05-20T11:00', CT),
      facts: [fact('Dashcam shows the lane change began 1.5 s after the turn signal with the pickup alongside the trailer.', 'Samsara video', 'verified', 'p_rm', at('2026-05-12T10:00', CT)), fact('Driver checked the left mirror once before moving over.', 'Driver statement', 'driver', 'p_rm', at('2026-05-10T09:00', CT))],
      questions: [], statements: [{ id: 's1', party: 'Viktor Hale', kind: 'Driver', takenAt: at('2026-05-09T10:30', CT), takenBy: 'p_rm', summary: 'Signaled, checked mirror, did not see the pickup in the blind spot.' }],
      checklist: [ck('police', 'Police report', 'reviewed'), ck('video', 'Dashcam video', 'reviewed'), ck('eld', 'ELD / hours of service', 'reviewed'), ck('tests', 'Post-accident test results', 'reviewed', undefined, true)],
      factors: [{ id: 'fa1', category: 'Driver', label: 'Lane change without sufficient clearance', level: 'confirmed' }, { id: 'fa2', category: 'Vehicle', label: 'Mirror adjustment (blind spot)', level: 'possible' }],
      conclusion: 'Preventable. The driver changed lanes without confirming the adjacent lane was clear. No equipment defects found.',
    },
    determinations: {
      fault: { value: 'at_fault', basis: 'Video and citation', by: 'p_rm', at: at('2026-05-20T11:00', CT) },
      preventability: { value: 'preventable', basis: 'Driver failed to confirm the lane was clear', by: 'p_rm', at: at('2026-05-20T11:00', CT) },
      cpdp: { value: 'not_eligible', basis: 'Our truck made the lane change — not an eligible crash type', by: 'p_rm' },
      legal: { value: 'company_liable', basis: 'Insurer accepted liability', by: 'p_nk' },
    },
    correctiveActions: [
      { id: 'ca1', kind: 'Retraining', title: 'Defensive driving — lane changes & mirror use (online + in-person)', driverId: 'd6', assigneeId: 'p_ta', due: at('2026-06-05T17:00', CT), status: 'Completed', completedAt: at('2026-06-02T15:00', CT), evidence: 'Certificate uploaded', decisionBy: 'p_rm' },
      { id: 'ca2', kind: 'Ride-along evaluation', title: 'Ride-along evaluation with trainer', driverId: 'd6', assigneeId: 'p_rm', due: at('2026-06-15T17:00', CT), status: 'Completed', completedAt: at('2026-06-10T14:00', CT), evidence: 'Evaluation form: pass', decisionBy: 'p_rm' },
      { id: 'ca3', kind: 'Policy / bulletin', title: 'Fleet-wide safety bulletin SB-2026-06: mirror set-up and lane changes', assigneeId: 'p_rm', due: at('2026-05-29T17:00', CT), status: 'Completed', completedAt: at('2026-05-28T12:00', CT) },
    ],
    testing: { alcohol: { substance: 'alcohol', decision: 'auto', administeredAt: at('2026-05-09T10:05', CT), resultRestricted: 'Negative (0.000)' }, drug: { substance: 'drug', decision: 'auto', administeredAt: at('2026-05-09T10:20', CT), resultRestricted: 'Negative — MRO verified May 14' } },
    initialEstimateCents: 6000_00, ownerId: 'p_rm',
    claimDecision: { text: 'Trailer damage ($3,960) is below the $5,000 physical damage deductible — company paid', by: 'p_rm', at: at('2026-05-11T12:00', CT) },
    closure: { at: at('2026-07-02T10:00', CT), by: 'p_rm', outcome: 'Investigation complete (preventable), trailer repaired, liability claim settled by insurer, deductible paid, retraining completed.', prevention: 'Driver retrained and passed a ride-along; fleet-wide bulletin SB-2026-06 on mirror set-up and lane changes.' },
  }));
  const E = (a: string, src: EventSource, by: string, text: string, x: Partial<TimelineEvent> = {}) => events.push(ev(id, a, src, by, text, x));
  E(occ, 'Telematics', 'System', 'Accident occurred — Samsara harsh-event at 8:15 AM CDT');
  E(at('2026-05-09T08:24', CT), 'Driver', 'Viktor Hale', 'Driver called Safety', { loggedAt: at('2026-05-09T08:29', CT) });
  E(at('2026-05-09T08:36', CT), 'Safety', 'Rachel Moore', 'Accident reported in NeWay');
  E(at('2026-05-09T08:50', CT), 'Driver', 'Viktor Hale', '6 photos uploaded from the driver app');
  E(at('2026-05-09T09:05', CT), 'Safety', 'Rachel Moore', 'Driver cited — improper lane usage', { loggedAt: at('2026-05-09T10:10', CT) });
  E(at('2026-05-09T10:05', CT), 'Safety', 'Rachel Moore', 'Post-accident alcohol test administered (1 h 50 m after)', { restricted: true });
  E(at('2026-05-09T12:30', CT), 'Dispatch', 'Sardor Yusupov', 'Truck 109 swapped to spare trailer T-5308 and resumed');
  E(at('2026-05-11T12:00', CT), 'Safety', 'Rachel Moore', 'No physical damage claim: $3,960 is below the $5,000 deductible');
  E(at('2026-05-12T09:30', CT), 'Claims', 'Nilufar Karimova', 'CLM-2026-0019 opened — liability (pickup damage)');
  E(at('2026-05-13T10:00', CT), 'Fleet', 'Dmitri Volkov', 'Trailer T-5321 repaired and returned to service (RO-2026-9041)');
  E(at('2026-05-20T11:00', CT), 'Management', 'James Booker', 'Investigation approved — preventable, at fault');
  E(at('2026-05-28T12:00', CT), 'Safety', 'Rachel Moore', 'Safety bulletin SB-2026-06 published to all drivers');
  E(at('2026-06-02T15:00', CT), 'Safety', 'Timur Aliev', 'Retraining completed — certificate uploaded');
  E(at('2026-06-18T12:00', CT), 'Claims', 'Nilufar Karimova', 'Liability claim settled: insurer paid claimant $7,900');
  E(at('2026-06-30T12:00', CT), 'Accounting', 'Kamila Saidova', 'Deductible $2,500 paid to Harborline (AP-90112)');
  E(at('2026-07-02T10:00', CT), 'Safety', 'Rachel Moore', 'Case closed');
  evidence.push(evd(id, 'Scene photo', 'Shoulder — both vehicles.jpg', 'Taken by driver after pulling over', at('2026-05-09T08:50', CT), 'Viktor Hale'));
  evidence.push(evd(id, 'Damage photo', 'Trailer left side panel.jpg', 'Panel crease and marker lights', at('2026-05-09T08:51', CT), 'Viktor Hale'));
  evidence.push(evd(id, 'Dashcam / video', 'Samsara forward + side camera.mp4', 'Lane change sequence, 20 s', at('2026-05-09T09:20', CT), 'Rachel Moore', 'video'));
  evidence.push(evd(id, 'Police report', 'ISP report SP15-26-04471.pdf', 'Final report', at('2026-05-15T14:00', CT), 'Rachel Moore', 'pdf'));
  evidence.push(evd(id, 'Driver statement', 'Driver statement — V. Hale.pdf', 'Signed statement', at('2026-05-09T11:00', CT), 'Rachel Moore', 'pdf'));
  evidence.push(evd(id, 'Invoice', 'Bensenville Trailer Service BTS-22816.pdf', 'Repair invoice $3,960', at('2026-05-13T12:00', CT), 'Dmitri Volkov', 'pdf'));
  evidence.push(evd(id, 'Settlement', 'Claimant release — Harborline.pdf', 'Signed release', at('2026-06-18T12:30', CT), 'Nilufar Karimova', 'pdf'));
  evidence.push(evd(id, 'Test record (restricted)', 'Post-accident test results.pdf', 'Alcohol & drug results', at('2026-05-14T09:00', CT), 'Rachel Moore', 'pdf', { restricted: true }));
  tasks.push(task(id, 'Collect driver statement', 'Safety', 'p_rm', at('2026-05-10T17:00', CT), 'done', occ, { completedAt: at('2026-05-09T11:00', CT) }));
  tasks.push(task(id, 'Post-accident alcohol & drug tests', 'Safety', 'p_rm', at('2026-05-09T16:15', CT), 'done', occ, { completedAt: at('2026-05-09T10:20', CT), priority: 'high' }));
  tasks.push(task(id, 'Report liability claim to insurer', 'Claims', 'p_nk', at('2026-05-12T17:00', CT), 'done', occ, { completedAt: at('2026-05-12T09:30', CT) }));
  tasks.push(task(id, 'Repair trailer T-5321', 'Fleet', 'p_dv', at('2026-05-14T17:00', CT), 'done', occ, { completedAt: at('2026-05-13T10:00', CT) }));
  tasks.push(task(id, 'Management review of serious incident', 'Management', 'p_jb', at('2026-05-20T17:00', CT), 'done', occ, { completedAt: at('2026-05-20T11:00', CT) }));
}

/* ===== CASE 3 — cargo + three claims, accident closed while claims continue (ACC-2026-015) ===== */
{
  const id = 'c015', occ = at('2026-09-21T23:10', ET);
  const wT = wo({ number: 'RO-2026-9108', unitKind: 'truck', unitId: 't156', caseId: id, type: 'Accident repair', title: 'Right front fairing & bumper bracket', shop: 'Keystone Diesel & Collision', status: 'Completed', estimates: [{ id: 'es2', vendor: 'Keystone Diesel & Collision', amountCents: 2140_00, at: at('2026-09-22T10:00'), selected: true }], estimatesRequired: 1, approvedAmountCents: 2140_00, approvedBy: 'p_dv', invoiceNumber: 'KDC-7781', invoiceTotalCents: 2140_00, openedAt: at('2026-09-22T09:00'), shopInAt: at('2026-09-23T07:00'), completedAt: at('2026-09-23T11:00'), createdBy: 'p_dv' });
  const wL = wo({ number: 'RO-2026-9112', unitKind: 'trailer', unitId: 'tlT-5342', caseId: id, type: 'Accident repair', title: 'Right side wall, rear axle alignment, 2 cross members', shop: 'Keystone Diesel & Collision', status: 'Completed', estimates: [{ id: 'es3', vendor: 'Keystone Diesel & Collision', amountCents: 18750_00, at: at('2026-09-29T10:00'), selected: true }], estimatesRequired: 1, approvedAmountCents: 18750_00, approvedBy: 'p_dv', invoiceNumber: 'KDC-7854', invoiceTotalCents: 18750_00, openedAt: at('2026-09-22T09:10'), shopInAt: at('2026-09-22T01:45'), completedAt: at('2026-10-06T14:00'), createdBy: 'p_dv' });
  wT.billId = bill({ number: 'AP-90193', vendor: 'Keystone Diesel & Collision', amountCents: 2140_00, date: at('2026-09-24T12:00'), status: 'Paid', category: 'Tractor repair', caseId: id, woId: wT.id, memo: 'Tractor 156 fairing & bracket' }).id;
  wL.billId = bill({ number: 'AP-90204', vendor: 'Keystone Diesel & Collision', amountCents: 18750_00, date: at('2026-10-07T12:00'), status: 'Paid', category: 'Trailer repair', caseId: id, woId: wL.id, memo: 'Trailer T-5342 side wall & axle' }).id;
  bill({ number: 'AP-90188', vendor: 'Blue Mountain Heavy Recovery', amountCents: 3400_00, date: at('2026-09-23T12:00'), status: 'Paid', category: 'Towing', caseId: id, memo: 'Tow trailer T-5342 from I-81 Exit 52 ramp' });
  bill({ number: 'AP-90190', vendor: 'Keystone Diesel & Collision', amountCents: 1850_00, date: at('2026-09-24T12:00'), status: 'Paid', category: 'Transload / recovery', caseId: id, memo: 'Transload 22 pallets, yard & forklift' });
  claims.push(claim({
    id: 'k0035', number: 'CLM-2026-0035', caseId: id, type: 'physical_damage', status: 'Settled', title: 'Trailer T-5342 and tractor 156 damage', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-PD-54880',
    adjuster: { name: 'Karen Whitfield', phone: '(555) 014-2230', email: 'k.whitfield@harborline.example' }, openedAt: at('2026-09-25T09:00'), reportedToInsurerAt: at('2026-09-25T09:00'),
    claimedCents: 20890_00, deductibleCents: 5000_00, settlementCents: 15890_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-09T15:00'), closedAt: at('2026-10-09T15:00'), unitLabel: 'Trailer T-5342 · Tractor 156',
    payments: [{ id: 'pp3', at: at('2026-10-09T15:00'), amountCents: 15890_00, direction: 'to_us', party: 'Harborline Insurance', note: 'Repair cost $20,890 less $5,000 deductible' }],
    docs: [{ id: 'dd4', label: 'Repair invoices', received: true }, { id: 'dd5', label: 'Damage photos', received: true }, { id: 'dd6', label: 'Police report', received: true }],
    log: [{ id: 'lg4', at: at('2026-09-25T09:00'), by: 'p_nk', channel: 'Portal', text: 'Physical damage claim reported.' }, { id: 'lg5', at: at('2026-10-09T15:00'), by: 'p_ks', channel: 'Note', text: 'Payment $15,890 received (ACH).' }],
  }));
  claims.push(claim({
    id: 'k0036', number: 'CLM-2026-0036', caseId: id, type: 'cargo', status: 'Negotiating', title: '9 of 22 pallets damaged — kitchen appliances', insurer: 'Ironclad Cargo Underwriters', insurerClaimNo: 'ICU-26-31907',
    adjuster: { name: 'Marco Bianchi', phone: '(555) 019-7741', email: 'm.bianchi@ironclad.example' }, claimant: 'Lakeshore Freight Brokerage (for Riverbend Appliance Distribution)', loadId: 'lL-47790',
    openedAt: at('2026-09-25T11:00'), reportedToInsurerAt: at('2026-09-25T11:00'), claimedCents: 41200_00, reserveCents: 35200_00, deductibleCents: 2500_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-16T12:00'),
    payments: [],
    docs: [{ id: 'dd7', label: 'Bill of lading with exceptions', received: true }, { id: 'dd8', label: 'Commercial invoice for damaged pallets', received: true }, { id: 'dd9', label: 'Salvage bid / proceeds', received: true }, { id: 'dd10', label: 'Signed proof of loss', received: false }],
    log: [{ id: 'lg6', at: at('2026-09-25T11:00'), by: 'p_nk', channel: 'Email', text: 'Cargo claim received from broker: $41,200 for 9 pallets.' }, { id: 'lg7', at: at('2026-10-14T10:00'), by: 'p_nk', channel: 'Email', text: 'Salvage sold for $6,000; reserve reduced to $35,200.' }, { id: 'lg8', at: at('2026-10-16T12:00'), by: 'p_nk', channel: 'Phone', text: 'Insurer offered $33,700 (net of salvage and unearned freight). Broker reviewing.' }],
    nextFollowUp: { at: at('2026-10-21T11:00'), assigneeId: 'p_nk', what: 'Get broker response to $33,700 offer' },
  }));
  claims.push(claim({
    id: 'k0037', number: 'CLM-2026-0037', caseId: id, type: 'auto_liability', status: 'Awaiting documents', title: 'Guardrail damage — I-81 Exit 52 ramp', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-AL-54902',
    adjuster: { name: 'Karen Whitfield', phone: '(555) 014-2230', email: 'k.whitfield@harborline.example' }, claimant: 'State highway authority (PA) — guardrail repair',
    openedAt: at('2026-09-28T10:00'), reportedToInsurerAt: at('2026-09-28T10:00'), claimedCents: undefined, reserveCents: 9800_00, deductibleCents: 2500_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-05T09:00'),
    docs: [{ id: 'dd11', label: 'Damage notice from state', received: true }, { id: 'dd12', label: 'Repair invoice from state', received: false }],
    log: [{ id: 'lg9', at: at('2026-09-28T10:00'), by: 'p_nk', channel: 'Letter', text: 'Damage notice received; claim reported to Harborline.' }, { id: 'lg10', at: at('2026-10-05T09:00'), by: 'p_nk', channel: 'Email', text: 'State says the repair invoice can take up to 60 days.' }],
  }));
  downtime.push({ id: 'd015a', caseId: id, unitKind: 'truck', unitId: 't156', start: occ, end: at('2026-09-23T11:00'), source: 'Daily board status', verifiedBy: 'p_dv' });
  downtime.push({ id: 'd015b', caseId: id, unitKind: 'trailer', unitId: 'tlT-5342', start: occ, end: at('2026-10-06T14:00'), source: 'Work order', verifiedBy: 'p_dv' });
  cases.push(baseCase({
    id, number: 'ACC-2026-015', occurredAt: occ, tz: ET, type: 'Struck fixed object on roadway', severity: 'serious', stage: 'closed', createdAt: at('2026-09-21T23:32'), submittedAt: at('2026-09-21T23:41'), createdBy: 'p_ta',
    description: 'On the Exit 52 ramp a car cut in from the right without signaling. The driver steered left and braked; the trailer struck the guardrail and the load shifted. The car left the scene.',
    location: { road: 'I-81 SB', detail: 'Exit 52 ramp', city: 'Carlisle', state: 'PA', lat: 40.19, lng: -77.21, publicRoad: 'yes' },
    driverId: 'd3', truckId: 't156', trailerId: 'tlT-5342', loadId: 'lL-47790', towAway: 'yes', police: { responded: 'yes', dept: 'Pennsylvania State Police — Carlisle', reportNumber: 'PA-26-44021' },
    conditions: { weather: 'Light rain', road: 'Wet', light: 'Dark — lighted' },
    vehicles: [{ id: 'v2', description: 'Dark sedan (unidentified — left scene)', owner: 'Unknown', damage: 'None observed', towed: 'no' }],
    equipment: { truck: eq({ condition: 'drivable', status: 'returned', damage: 'had minor right-front fairing damage', rtsAt: at('2026-09-23T11:00') }), trailer: eq({ condition: 'not_drivable', status: 'returned', damage: 'had a torn right side wall and axle damage', towCompany: 'Blue Mountain Heavy Recovery', towedTo: 'Keystone Diesel & Collision, Carlisle', rtsAt: at('2026-10-06T14:00') }) },
    cargo: { status: 'damaged', plan: 'transload', notes: '9 of 22 pallets', deliveryImpact: '13 pallets delivered Sep 24, 9 pallets rejected and sold for salvage' },
    investigation: {
      status: 'complete', ownerId: 'p_ta', submittedBy: 'p_ta', submittedAt: at('2026-10-07T09:00'), approvedBy: 'p_jb', completedAt: at('2026-10-08T10:00'),
      facts: [fact('Forward video shows a sedan entering the ramp lane from the right with no signal, 1.1 s before our brake application.', 'Samsara video', 'verified', 'p_ta', at('2026-09-23T08:00')), fact('Truck speed 34 mph; ramp advisory speed 35 mph.', 'Samsara / ECM', 'verified', 'p_ta', at('2026-09-23T08:00')), fact('Load was secured with 2 load bars; shift occurred on impact.', 'Driver statement + photos', 'driver', 'p_ta', at('2026-09-26T08:00'))],
      questions: [{ id: 'q1', text: 'Can the sedan be identified for a recovery claim?', createdAt: at('2026-09-23T08:00'), ownerId: 'p_ta', answer: 'No — plate not visible on video; police could not identify.', resolvedAt: at('2026-10-02T09:00'), resolvedBy: 'p_ta' }],
      statements: [{ id: 's2', party: 'Ruslan Tursunov', kind: 'Driver', takenAt: at('2026-09-26T10:00'), takenBy: 'p_ta', summary: 'Car cut in from the right on the ramp; swerved left to avoid it.' }],
      checklist: [ck('police', 'Police report', 'reviewed'), ck('video', 'Dashcam video', 'reviewed'), ck('eld', 'ELD / hours of service', 'reviewed'), ck('securement', 'Load securement photos', 'reviewed')],
      factors: [{ id: 'fa3', category: 'Other party', label: 'Unsafe cut-in without signal', level: 'confirmed' }, { id: 'fa4', category: 'Environment', label: 'Wet ramp at night', level: 'possible' }],
      conclusion: 'Non-preventable. Video shows an unsignaled cut-in; speed was at the ramp advisory. Load securement met policy.',
    },
    determinations: {
      fault: { value: 'not_at_fault', basis: 'Video evidence', by: 'p_ta', at: at('2026-10-08T10:00') },
      preventability: { value: 'non_preventable', basis: 'Evasive action from an unsignaled cut-in; speed appropriate', by: 'p_ta', at: at('2026-10-08T10:00') },
      cpdp: { value: 'submitted', basis: 'Eligible type 21 — video shows the sequence of events', by: 'p_ta', at: at('2026-10-01T10:00'), rdr: 'RDR 2026-118420' },
      legal: { value: 'third_party_liable', basis: 'Other vehicle unidentified — no recovery possible', by: 'p_nk' },
    },
    initialEstimateCents: 30000_00, ownerId: 'p_ta',
    closure: { at: at('2026-10-12T10:00'), by: 'p_rm', outcome: 'Investigation complete (non-preventable). Tractor and trailer repaired and back in service. Physical damage claim settled; cargo and guardrail claims continue on the Claims board.', prevention: 'No driver action required. Ramp added to the night-route hazard list for the Harrisburg lanes.' },
  }));
  const E = (a: string, src: EventSource, by: string, text: string, x: Partial<TimelineEvent> = {}) => events.push(ev(id, a, src, by, text, x));
  E(occ, 'Telematics', 'System', 'Accident occurred — Samsara harsh-braking event, 34 mph');
  E(at('2026-09-21T23:18'), 'Driver', 'Ruslan Tursunov', 'Driver called the after-hours dispatch line', { loggedAt: at('2026-09-21T23:25') });
  E(at('2026-09-21T23:41'), 'Safety', 'Timur Aliev', 'Accident reported in NeWay (from Tashkent, 8:41 AM local)');
  E(at('2026-09-22T00:05'), 'Safety', 'Timur Aliev', 'State Police on scene — no citation for our driver; other car left the scene', { loggedAt: at('2026-09-22T00:40') });
  E(at('2026-09-22T00:45'), 'Fleet', 'Dmitri Volkov', 'Trailer towed by Blue Mountain Heavy Recovery to Keystone Diesel & Collision');
  E(at('2026-09-22T10:00'), 'Dispatch', 'Sardor Yusupov', 'Transload: 13 good pallets moved to trailer T-5355; 9 damaged pallets held');
  E(at('2026-09-23T11:00'), 'Fleet', 'Dmitri Volkov', 'Tractor 156 repaired and returned to service (RO-2026-9108)');
  E(at('2026-09-24T09:30'), 'Dispatch', 'Sardor Yusupov', '13 pallets delivered in Atlanta; 9 pallets rejected');
  E(at('2026-09-25T09:00'), 'Claims', 'Nilufar Karimova', 'CLM-2026-0035 physical damage and CLM-2026-0036 cargo opened');
  E(at('2026-09-28T10:00'), 'Claims', 'Nilufar Karimova', 'CLM-2026-0037 opened — guardrail damage notice from the state');
  E(at('2026-10-01T10:00'), 'Safety', 'Timur Aliev', 'Crash preventability request submitted to FMCSA DataQs (RDR 2026-118420)');
  E(at('2026-10-06T14:00'), 'Fleet', 'Dmitri Volkov', 'Trailer T-5342 repaired and returned to service (RO-2026-9112)');
  E(at('2026-10-08T10:00'), 'Management', 'James Booker', 'Investigation approved — non-preventable');
  E(at('2026-10-09T15:00'), 'Accounting', 'Kamila Saidova', 'Harborline paid $15,890 on the physical damage claim');
  E(at('2026-10-12T10:00'), 'Safety', 'Rachel Moore', 'Accident closed — cargo and guardrail claims remain open');
  E(at('2026-10-16T12:00'), 'Claims', 'Nilufar Karimova', 'Cargo insurer offered $33,700 — broker reviewing');
  evidence.push(evd(id, 'Scene photo', 'Ramp — trailer at guardrail.jpg', 'Night photo from the cab', at('2026-09-21T23:30'), 'Ruslan Tursunov'));
  evidence.push(evd(id, 'Damage photo', 'Trailer right wall tear.jpg', '', at('2026-09-21T23:31'), 'Ruslan Tursunov'));
  evidence.push(evd(id, 'Damage photo', 'Shifted pallets — rear doors.jpg', 'Load shift', at('2026-09-22T09:40'), 'Sardor Yusupov'));
  evidence.push(evd(id, 'Dashcam / video', 'Samsara forward camera — cut-in.mp4', 'Shows unsignaled cut-in', at('2026-09-21T23:55'), 'Timur Aliev', 'video'));
  evidence.push(evd(id, 'Police report', 'PSP report PA-26-44021.pdf', '', at('2026-09-30T10:00'), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Driver statement', 'Driver statement — R. Tursunov.pdf', '', at('2026-09-26T10:30'), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Third-party correspondence', 'Broker cargo claim letter.pdf', '$41,200 claim', at('2026-09-25T11:00'), 'Nilufar Karimova', 'pdf'));
  evidence.push(evd(id, 'Repair estimate', 'Keystone estimate — trailer.pdf', '$18,750', at('2026-09-29T10:00'), 'Dmitri Volkov', 'pdf', { versions: [{ v: 1, at: at('2026-09-27T10:00'), by: 'Dmitri Volkov', note: 'Initial estimate $21,300' }, { v: 2, at: at('2026-09-29T10:00'), by: 'Dmitri Volkov', note: 'Revised after teardown: $18,750' }] }));
  evidence.push(evd(id, 'Invoice', 'Blue Mountain tow invoice.pdf', '$3,400', at('2026-09-23T12:00'), 'Kamila Saidova', 'pdf'));
  evidence.push(evd(id, 'Insurance document', 'Harborline PD payment advice.pdf', '$15,890', at('2026-10-09T15:00'), 'Kamila Saidova', 'pdf'));
  tasks.push(task(id, 'Arrange tow and transload', 'Fleet', 'p_dv', at('2026-09-22T08:00'), 'done', occ, { completedAt: at('2026-09-22T10:00') }));
  tasks.push(task(id, 'Notify broker and customer', 'Dispatch', 'p_sy', at('2026-09-22T06:00'), 'done', occ, { completedAt: at('2026-09-22T01:10') }));
  tasks.push(task(id, 'Submit DataQs preventability request', 'Safety', 'p_ta', at('2026-10-03T17:00'), 'done', occ, { completedAt: at('2026-10-01T10:00') }));
  tasks.push(task(undefined, 'Follow up on cargo settlement offer', 'Claims', 'p_nk', at('2026-10-21T11:00'), 'open', at('2026-10-16T12:00'), { claimId: 'k0036' }));
}

/* ===== CASE 2 — serious rear-end, truck down (ACC-2026-016) ===== */
{
  const id = 'c016', occ = at('2026-10-02T15:45', CT);
  wo({ number: 'RO-2026-9131', unitKind: 'truck', unitId: 't118', caseId: id, type: 'Accident repair', title: 'Front end: bumper, hood, radiator, charge-air cooler, frame rail inspection', shop: 'Prairie State Truck & Body, Joliet', status: 'Waiting for approval',
    estimates: [{ id: 'es4', vendor: 'Prairie State Truck & Body', amountCents: 38450_00, at: at('2026-10-06T13:00', CT) }, { id: 'es5', vendor: 'Joliet Diesel Collision', amountCents: 41900_00, at: at('2026-10-09T11:00', CT) }], estimatesRequired: 3,
    openedAt: at('2026-10-02T18:10', CT), shopInAt: at('2026-10-02T18:10', CT), createdBy: 'p_dv' });
  bill({ number: 'AP-90241', vendor: 'Lakeshore Towing & Recovery', amountCents: 2850_00, date: at('2026-10-05T12:00', CT), status: 'Paid', category: 'Towing', caseId: id, memo: 'Heavy tow, tractor 118 from I-80 MM 127 to Joliet' });
  claims.push(claim({
    id: 'k0040', number: 'CLM-2026-0040', caseId: id, type: 'physical_damage', status: 'Under review', title: 'Tractor 118 front-end damage', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-PD-55218',
    adjuster: { name: 'Karen Whitfield', phone: '(555) 014-2230', email: 'k.whitfield@harborline.example' }, unitLabel: 'Tractor 118',
    openedAt: at('2026-10-03T09:00', CT), reportedToInsurerAt: at('2026-10-03T09:00', CT), claimedCents: 38450_00, deductibleCents: 5000_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-15T14:00', CT),
    docs: [{ id: 'dd13', label: 'Damage photos', received: true }, { id: 'dd14', label: 'Police report', received: true }, { id: 'dd15', label: 'Repair estimates (3 required by our policy)', received: false }, { id: 'dd16', label: 'Final repair invoice', received: false }],
    log: [{ id: 'lg11', at: at('2026-10-03T09:00', CT), by: 'p_nk', channel: 'Portal', text: 'Physical damage claim reported.' }, { id: 'lg12', at: at('2026-10-15T14:00', CT), by: 'p_nk', channel: 'Phone', text: 'Adjuster inspected the tractor at Prairie State; waiting for final estimate.' }],
    nextFollowUp: { at: at('2026-10-22T10:00', CT), assigneeId: 'p_nk', what: 'Send third estimate to the adjuster' },
  }));
  claims.push(claim({
    id: 'k0041', number: 'CLM-2026-0041', caseId: id, type: 'auto_liability', status: 'Open', title: 'Box truck rear damage — Midway Supply Co.', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-AL-55219',
    adjuster: { name: 'Karen Whitfield', phone: '(555) 014-2230', email: 'k.whitfield@harborline.example' }, claimant: 'Midway Supply Co.',
    openedAt: at('2026-10-05T11:00', CT), reportedToInsurerAt: at('2026-10-05T11:00', CT), claimedCents: 14600_00, reserveCents: 16000_00, deductibleCents: 2500_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-13T10:00', CT),
    docs: [{ id: 'dd17', label: 'Claimant repair estimate', received: true }, { id: 'dd18', label: 'Claimant photos', received: true }, { id: 'dd19', label: 'Final invoice / release', received: false }],
    log: [{ id: 'lg13', at: at('2026-10-05T11:00', CT), by: 'p_nk', channel: 'Email', text: 'Notice of claim from Midway Supply Co.; reported to Harborline.' }, { id: 'lg14', at: at('2026-10-13T10:00', CT), by: 'p_nk', channel: 'Email', text: 'Claimant estimate $14,600 forwarded to adjuster.' }],
  }));
  downtime.push({ id: 'd016a', caseId: id, unitKind: 'truck', unitId: 't118', start: occ, source: 'Daily board status', verifiedBy: 'p_dv', note: 'Daily board: ACCIDENT → SHOP since Oct 2, 6:10 PM CDT' });
  cases.push(baseCase({
    id, number: 'ACC-2026-016', occurredAt: occ, tz: CT, type: 'Rear-end — we struck the vehicle ahead', severity: 'serious', stage: 'investigation', createdAt: at('2026-10-02T15:58', CT), submittedAt: at('2026-10-02T16:02', CT), updatedAt: at('2026-10-19T10:00', CT),
    description: 'Traffic slowed suddenly approaching the work zone. I braked hard but hit the back of a box truck. Nobody hurt. My truck is leaking coolant and can’t move.',
    location: { road: 'I-80 EB', detail: 'near MM 127 (Houbolt Rd)', city: 'Channahon', state: 'IL', lat: 41.507, lng: -88.152, publicRoad: 'yes' },
    driverId: 'd2', truckId: 't118', trailerId: 'tlT-5310', loadId: 'lL-47982', assignmentSource: 'Daily board at 3:45 PM CDT',
    towAway: 'yes', citation: { status: 'yes', issuedAt: at('2026-10-02T16:30', CT), note: 'Following too closely' }, police: { responded: 'yes', dept: 'Illinois State Police — District 5', reportNumber: 'SP5-26-118734' },
    conditions: { weather: 'Clear', road: 'Dry', light: 'Daylight' },
    vehicles: [{ id: 'v3', description: '2021 Isuzu NPR box truck (white)', owner: 'Midway Supply Co.', driver: 'R. Delgado', insurer: 'Cornerstone Mutual', policyNo: 'on file', damage: 'Rear door and bumper; drivable', towed: 'no' }],
    equipment: { truck: eq({ condition: 'not_drivable', status: 'at_shop', damage: 'has heavy front-end damage (bumper, hood, radiator) and could not be driven', towCompany: 'Lakeshore Towing & Recovery', towedTo: 'Prairie State Truck & Body, Joliet' }), trailer: eq({ condition: 'drivable', status: 'operational', damage: 'was inspected and not damaged' }) },
    cargo: { status: 'no_damage', plan: 'repower', deliveryImpact: 'repowered with Truck 131 and delivered 1 day late', brokerNotified: 'yes' },
    immediate: [{ key: 'ems', label: 'Confirmed no one needed EMS', done: true }, { key: 'tow', label: 'Tow arranged', done: true }, { key: 'broker', label: 'Broker notified', done: true }],
    investigation: {
      status: 'in_progress', ownerId: 'p_ta',
      facts: [
        fact('Speed 58 mph four seconds before impact; hard braking began at 3:44:47 PM; impact at 3:44:51 PM.', 'Samsara event + ECM summary', 'verified', 'p_ta', at('2026-10-12T09:00', CT)),
        fact('Traffic ahead slowed from about 55 to 15 mph within roughly 6 seconds.', 'Samsara forward video', 'verified', 'p_ta', at('2026-10-12T09:00', CT)),
        fact('Work-zone signs posted 1.2 miles before the crash site; posted limit 55 mph.', 'Samsara forward video', 'verified', 'p_ta', at('2026-10-12T09:10', CT)),
        fact('Driver was 7 h 40 min into the 11-hour driving window; hours of service compliant.', 'ELD log', 'verified', 'p_ta', at('2026-10-07T10:00', CT)),
        fact('Driver states the box truck had no working brake lights.', 'Driver statement', 'driver', 'p_rm', at('2026-10-05T14:00', CT)),
      ],
      questions: [
        { id: 'q2', text: 'Were the box truck’s brake lights working? (driver says no; video is inconclusive in sunlight)', ownerId: 'p_ta', createdAt: at('2026-10-07T10:00', CT) },
        { id: 'q3', text: 'Following distance before the slowdown — video estimate 1.9 s; confirm with the ECM download.', ownerId: 'p_dv', createdAt: at('2026-10-07T10:00', CT) },
        { id: 'q4', text: 'Was our driver cited?', ownerId: 'p_rm', createdAt: at('2026-10-02T16:10', CT), answer: 'Yes — following too closely (State Police report).', resolvedAt: at('2026-10-02T16:45', CT), resolvedBy: 'p_rm' },
      ],
      statements: [{ id: 's3', party: 'Andre Lewis', kind: 'Driver', takenAt: at('2026-10-05T14:00', CT), takenBy: 'p_rm', summary: 'Traffic stopped quickly near the work zone; braked hard; says the box truck had no brake lights.' }, { id: 's4', party: 'R. Delgado (box truck driver)', kind: 'Third party', takenAt: at('2026-10-02T16:30', CT), takenBy: 'Police', summary: 'Per police report: slowed for the work zone traffic, was struck from behind.' }],
      checklist: [ck('police', 'Police report', 'reviewed'), ck('video', 'Dashcam video', 'reviewed'), ck('eld', 'ELD / hours of service', 'reviewed'), ck('ecm', 'ECM / engine data download', 'requested', 'Requested from Prairie State — overdue'), ck('maint', 'Brake maintenance records', 'reviewed', 'Last PM Sep 12 — brakes within spec'), ck('tests', 'Post-accident test results', 'reviewed', undefined, true), ck('photos', 'Scene and damage photos', 'reviewed')],
      factors: [{ id: 'fa5', category: 'Environment', label: 'Sudden work-zone slowdown', level: 'confirmed' }, { id: 'fa6', category: 'Driver', label: 'Following distance', level: 'possible' }, { id: 'fa7', category: 'Other party', label: 'Possible brake light failure (unverified)', level: 'possible' }],
    },
    determinations: { fault: { value: 'not_determined' }, preventability: { value: 'not_determined' }, cpdp: { value: 'not_eligible', basis: 'Our truck struck the vehicle ahead — not one of the 21 eligible types', by: 'p_ta' }, legal: { value: 'unknown', basis: 'Insurer handling third-party claim' } },
    testing: { alcohol: { substance: 'alcohol', decision: 'auto', administeredAt: at('2026-10-02T17:40', CT), resultRestricted: 'Negative (0.000)' }, drug: { substance: 'drug', decision: 'auto', administeredAt: at('2026-10-02T18:05', CT), resultRestricted: 'Negative — MRO verified Oct 6' } },
    initialEstimateCents: 35000_00, ownerId: 'p_rm',
  }));
  const E = (a: string, src: EventSource, by: string, text: string, x: Partial<TimelineEvent> = {}) => events.push(ev(id, a, src, by, text, x));
  E(at('2026-10-02T15:44', CT), 'Telematics', 'System', 'Samsara collision event: 58 → 9 mph at I-80 EB MM 127');
  E(occ, 'Driver', 'Andre Lewis', 'Accident occurred', { kind: 'milestone' });
  E(at('2026-10-02T15:49', CT), 'Driver', 'Andre Lewis', 'Driver called Safety', { loggedAt: at('2026-10-02T15:52', CT) });
  E(at('2026-10-02T16:02', CT), 'Safety', 'Rachel Moore', 'Accident reported in NeWay');
  E(at('2026-10-02T16:02', CT), 'Telematics', 'Rachel Moore', 'Samsara video saved to the case');
  E(at('2026-10-02T16:05', CT), 'Safety', 'Rachel Moore', 'State Police on scene', { loggedAt: at('2026-10-02T16:20', CT) });
  E(at('2026-10-02T16:20', CT), 'Dispatch', 'Sardor Yusupov', 'Broker notified of delay; repower requested');
  E(at('2026-10-02T16:30', CT), 'Safety', 'Rachel Moore', 'Driver cited — following too closely', { loggedAt: at('2026-10-02T16:45', CT) });
  E(at('2026-10-02T16:40', CT), 'Fleet', 'Dmitri Volkov', 'Heavy tow dispatched — Lakeshore Towing & Recovery');
  E(at('2026-10-02T17:40', CT), 'Safety', 'Rachel Moore', 'Post-accident alcohol test administered (1 h 55 m after)', { restricted: true });
  E(at('2026-10-02T18:05', CT), 'Safety', 'Rachel Moore', 'Post-accident drug test collected', { restricted: true });
  E(at('2026-10-02T18:10', CT), 'Fleet', 'Dmitri Volkov', 'Tractor arrived at Prairie State Truck & Body; RO-2026-9131 opened');
  E(at('2026-10-03T06:30', CT), 'Dispatch', 'Sardor Yusupov', 'Load L-47982 repowered by Truck 131 (Marcus Bell); trailer T-5310 inspected — no damage');
  E(at('2026-10-03T09:00', CT), 'Claims', 'Nilufar Karimova', 'CLM-2026-0040 opened — physical damage, Harborline');
  E(at('2026-10-03T14:20', ET), 'Dispatch', 'Sardor Yusupov', 'Load delivered in Columbus — 1 day late');
  E(at('2026-10-05T11:00', CT), 'Claims', 'Nilufar Karimova', 'CLM-2026-0041 opened — Midway Supply Co. box truck damage');
  E(at('2026-10-05T14:00', CT), 'Safety', 'Rachel Moore', 'Driver statement received');
  E(at('2026-10-06T13:00', CT), 'Fleet', 'Dmitri Volkov', 'Estimate 1 of 3: Prairie State $38,450');
  E(at('2026-10-07T10:00', CT), 'Safety', 'Timur Aliev', 'Investigation started');
  E(at('2026-10-09T11:00', CT), 'Fleet', 'Dmitri Volkov', 'Estimate 2 of 3: Joliet Diesel Collision $41,900');
  E(at('2026-10-12T09:00', CT), 'Safety', 'Timur Aliev', 'Dashcam video and ECM summary reviewed');
  E(at('2026-10-15T14:00', CT), 'Claims', 'Nilufar Karimova', 'Adjuster inspected the tractor');
  E(at('2026-10-19T09:15', CT), 'Fleet', 'Dmitri Volkov', 'Third estimate requested from Will County Truck Collision');
  evidence.push(evd(id, 'Scene photo', 'I-80 shoulder — both vehicles.jpg', 'Taken by driver', at('2026-10-02T16:20', CT), 'Andre Lewis'));
  evidence.push(evd(id, 'Damage photo', 'Tractor 118 front end.jpg', 'Bumper, hood, radiator', at('2026-10-02T16:21', CT), 'Andre Lewis'));
  evidence.push(evd(id, 'Damage photo', 'Box truck rear door.jpg', 'Third-party damage', at('2026-10-02T16:22', CT), 'Andre Lewis'));
  evidence.push(evd(id, 'Damage photo', 'Coolant leak under tractor.jpg', '', at('2026-10-02T16:23', CT), 'Andre Lewis'));
  evidence.push(evd(id, 'Dashcam / video', 'Samsara forward camera — 30 s.mp4', 'Event clip, saved before overwrite', at('2026-10-02T16:02', CT), 'Rachel Moore', 'video'));
  evidence.push(evd(id, 'Police report', 'ISP report SP5-26-118734.pdf', 'Includes citation', at('2026-10-09T10:00', CT), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Driver statement', 'Driver statement — A. Lewis.pdf', 'Signed', at('2026-10-05T14:00', CT), 'Rachel Moore', 'pdf'));
  evidence.push(evd(id, 'Repair estimate', 'Prairie State estimate.pdf', '$38,450', at('2026-10-06T13:00', CT), 'Dmitri Volkov', 'pdf'));
  evidence.push(evd(id, 'Repair estimate', 'Joliet Diesel Collision estimate.pdf', '$41,900', at('2026-10-09T11:00', CT), 'Dmitri Volkov', 'pdf'));
  evidence.push(evd(id, 'Invoice', 'Lakeshore Towing invoice.pdf', '$2,850', at('2026-10-05T12:00', CT), 'Kamila Saidova', 'pdf'));
  evidence.push(evd(id, 'Test record (restricted)', 'Post-accident test results.pdf', 'Alcohol & drug', at('2026-10-06T12:00', CT), 'Rachel Moore', 'pdf', { restricted: true }));
  const c0 = at('2026-10-02T16:02', CT);
  tasks.push(task(id, 'Get third repair estimate (policy: 3 estimates over $25,000)', 'Fleet', 'p_dv', at('2026-10-20T17:00', CT), 'in_progress', at('2026-10-09T12:00', CT), { priority: 'high', instructions: 'Estimates over $25,000 need three quotes before approval. Two received ($38,450, $41,900).', updates: [{ id: 'u1', at: at('2026-10-19T09:15', CT), by: 'p_dv', text: 'Requested from Will County Truck Collision; they inspect Tuesday morning.' }] }));
  tasks.push(task(id, 'Request ECM / engine data download from Prairie State', 'Fleet', 'p_dv', at('2026-10-16T17:00', CT), 'open', at('2026-10-07T10:00', CT), { priority: 'high', instructions: 'Needed to confirm following distance before braking.' }));
  tasks.push(task(id, 'Management review of serious incident', 'Management', 'p_jb', at('2026-10-21T17:00', CT), 'open', c0, { auto: 'Serious severity', priority: 'high' }));
  tasks.push(task(id, 'Complete fault and preventability determination', 'Safety', 'p_ta', at('2026-10-23T17:00', CT), 'open', at('2026-10-07T10:00', CT)));
  tasks.push(task(id, 'Decide driver follow-up after the determination', 'Safety', 'p_rm', at('2026-10-26T17:00', CT), 'open', at('2026-10-07T10:00', CT)));
  tasks.push(task(id, 'Arrange tow and recovery', 'Fleet', 'p_dv', at('2026-10-02T18:00', CT), 'done', c0, { completedAt: at('2026-10-02T16:40', CT), auto: 'Truck not drivable' }));
  tasks.push(task(id, 'Notify broker and arrange repower', 'Dispatch', 'p_sy', at('2026-10-02T18:00', CT), 'done', c0, { completedAt: at('2026-10-02T16:20', CT), auto: 'Active load' }));
  tasks.push(task(id, 'Post-accident alcohol & drug tests', 'Safety', 'p_rm', at('2026-10-02T23:45', CT), 'done', c0, { completedAt: at('2026-10-02T18:05', CT), priority: 'high', auto: 'Tow-away + citation' }));
  tasks.push(task(id, 'Report claims to insurer', 'Claims', 'p_nk', at('2026-10-03T17:00', CT), 'done', c0, { completedAt: at('2026-10-03T09:00', CT) }));
  tasks.push(task(id, 'Collect driver statement', 'Safety', 'p_rm', at('2026-10-03T17:00', CT), 'done', c0, { completedAt: at('2026-10-05T14:00', CT) }));
}

/* ===== CASE 1 — minor parking strike (ACC-2026-017) ===== */
{
  const id = 'c017', occ = at('2026-10-14T06:20', CT);
  const w = wo({ number: 'RO-2026-9140', unitKind: 'truck', unitId: 't142', caseId: id, type: 'Accident repair', title: 'Right fairing replaced, bumper bracket straightened', shop: 'I-55 Truck Service, Lincoln IL', status: 'Completed', estimates: [{ id: 'es6', vendor: 'I-55 Truck Service', amountCents: 1840_00, at: at('2026-10-14T15:00', CT), selected: true }], estimatesRequired: 1, approvedAmountCents: 1840_00, approvedBy: 'p_dv', invoiceNumber: 'ITS-30418', invoiceTotalCents: 1840_00, openedAt: at('2026-10-14T15:00', CT), shopInAt: at('2026-10-15T07:00', CT), completedAt: at('2026-10-15T15:30', CT), createdBy: 'p_dv' });
  w.billId = bill({ number: 'AP-90266', vendor: 'I-55 Truck Service', amountCents: 1840_00, date: at('2026-10-16T10:00', CT), status: 'Open', category: 'Tractor repair', caseId: id, woId: w.id, memo: 'Tractor 142 fairing & bracket' }).id;
  downtime.push({ id: 'd017a', caseId: id, unitKind: 'truck', unitId: 't142', start: at('2026-10-15T07:00', CT), end: at('2026-10-15T15:30', CT), source: 'Work order', verifiedBy: 'p_dv', note: 'Kept running until the shop slot; down only for the repair' });
  cases.push(baseCase({
    id, number: 'ACC-2026-017', occurredAt: occ, tz: CT, type: 'Parking / struck fixed object', severity: 'minor', stage: 'resolution', createdAt: at('2026-10-14T06:41', CT), submittedAt: at('2026-10-14T06:43', CT), createdBy: 'p_ta', updatedAt: at('2026-10-16T12:00', CT),
    description: 'Backing into a parking space at the truck stop, the right side of the tractor hit a concrete-filled post. Fairing cracked, bracket bent. Truck is drivable.',
    location: { road: 'Truck stop lot', detail: 'I-55 Exit 126', city: 'Lincoln', state: 'IL', lat: 40.13, lng: -89.35, publicRoad: 'no' },
    driverId: 'd5', truckId: 't142', trailerId: 'tlT-5305', loadId: 'lL-48014', assignmentSource: 'Daily board at 6:20 AM CDT',
    conditions: { weather: 'Clear', road: 'Dry', light: 'Dawn' },
    equipment: { truck: eq({ condition: 'drivable', status: 'returned', damage: 'had a cracked right fairing and a bent bumper bracket', rtsAt: at('2026-10-15T15:30', CT) }), trailer: eq({ damage: 'was not damaged' }) },
    cargo: { status: 'no_damage', plan: 'delivered_as_is', deliveryImpact: 'delivered on time' },
    investigation: {
      status: 'complete', ownerId: 'p_ta', submittedBy: 'p_ta', submittedAt: at('2026-10-15T16:00', CT), approvedBy: 'p_rm', completedAt: at('2026-10-16T10:00', CT),
      facts: [fact('Driver did not get out to check the right side before backing.', 'Driver statement', 'driver', 'p_ta', at('2026-10-14T08:00', CT)), fact('Lot was lit; post is painted yellow.', 'Photos', 'verified', 'p_ta', at('2026-10-14T08:00', CT))],
      questions: [], statements: [{ id: 's5', party: 'Carlos Mendes', kind: 'Driver', takenAt: at('2026-10-14T07:30', CT), takenBy: 'p_ta', summary: 'Was tired at end of shift and backed in without a walk-around.' }],
      checklist: [ck('photos', 'Damage photos', 'reviewed'), ck('eld', 'ELD / hours of service', 'reviewed', 'Within limits')],
      factors: [{ id: 'fa8', category: 'Driver', label: 'Backing without a walk-around (G.O.A.L.)', level: 'confirmed' }],
      conclusion: 'Preventable low-speed backing incident. Coaching assigned.',
    },
    determinations: { fault: { value: 'at_fault', basis: 'Driver statement and photos', by: 'p_ta', at: at('2026-10-16T10:00', CT) }, preventability: { value: 'preventable', basis: 'Fixed, visible object; no walk-around', by: 'p_ta', at: at('2026-10-16T10:00', CT) }, cpdp: { value: 'not_applicable', basis: 'Not DOT-reportable (private lot, no injury, no tow)' }, legal: { value: 'no_claim_expected' } },
    correctiveActions: [{ id: 'ca4', kind: 'Coaching', title: 'Backing & parking coaching — G.O.A.L. walk-around', driverId: 'd5', assigneeId: 'p_ta', due: at('2026-10-23T17:00', CT), status: 'In progress', decisionBy: 'p_rm' }],
    initialEstimateCents: 1500_00, ownerId: 'p_ta',
    claimDecision: { text: 'Repair ($1,840) is below the $5,000 physical damage deductible — company paid', by: 'p_rm', at: at('2026-10-15T16:00', CT) },
  }));
  const E = (a: string, src: EventSource, by: string, text: string, x: Partial<TimelineEvent> = {}) => events.push(ev(id, a, src, by, text, x));
  E(occ, 'Driver', 'Carlos Mendes', 'Accident occurred');
  E(at('2026-10-14T06:34', CT), 'Driver', 'Carlos Mendes', 'Reported from the driver app with 4 photos');
  E(at('2026-10-14T06:43', CT), 'Safety', 'Timur Aliev', 'Accident reported in NeWay (Tashkent 4:43 PM)');
  E(at('2026-10-14T07:10', CT), 'Safety', 'Timur Aliev', 'Photo review: drivable — cleared to continue the trip');
  E(at('2026-10-15T07:00', CT), 'Fleet', 'Dmitri Volkov', 'Truck 142 in at I-55 Truck Service (RO-2026-9140)');
  E(at('2026-10-15T15:30', CT), 'Fleet', 'Dmitri Volkov', 'Repaired and returned to service — 8 h 30 m down');
  E(at('2026-10-15T16:00', CT), 'Safety', 'Rachel Moore', 'No claim: $1,840 is below the $5,000 deductible');
  E(at('2026-10-16T10:00', CT), 'Safety', 'Rachel Moore', 'Investigation approved — preventable; coaching assigned');
  evidence.push(evd(id, 'Damage photo', 'Right fairing crack.jpg', '', at('2026-10-14T06:34', CT), 'Carlos Mendes'));
  evidence.push(evd(id, 'Damage photo', 'Bumper bracket.jpg', '', at('2026-10-14T06:34', CT), 'Carlos Mendes'));
  evidence.push(evd(id, 'Scene photo', 'Post and parking space.jpg', '', at('2026-10-14T06:35', CT), 'Carlos Mendes'));
  evidence.push(evd(id, 'Driver statement', 'Driver statement — C. Mendes.pdf', '', at('2026-10-14T07:40', CT), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Invoice', 'I-55 Truck Service ITS-30418.pdf', '$1,840', at('2026-10-16T10:00', CT), 'Kamila Saidova', 'pdf'));
  tasks.push(task(id, 'Complete backing coaching session with Carlos Mendes', 'Safety', 'p_ta', at('2026-10-23T17:00', CT), 'open', at('2026-10-16T10:00', CT), { instructions: 'Use the G.O.A.L. module; record completion and the driver’s acknowledgment.' }));
  tasks.push(task(id, 'Schedule fairing repair', 'Fleet', 'p_dv', at('2026-10-16T17:00', CT), 'done', at('2026-10-14T07:10', CT), { completedAt: at('2026-10-14T15:00', CT) }));
}

/* ===== CASE 4 — third-party injury, restricted (ACC-2026-018) ===== */
{
  const id = 'c018', occ = at('2026-10-17T17:32', CT);
  wo({ number: 'RO-2026-9152', unitKind: 'truck', unitId: 't133', caseId: id, type: 'Accident repair', title: 'Front bumper and hood', shop: 'Hoosier Fleet Repair, Merrillville', status: 'Approved', estimates: [{ id: 'es7', vendor: 'Hoosier Fleet Repair', amountCents: 3900_00, at: at('2026-10-18T10:00', CT), selected: true }], estimatesRequired: 1, approvedAmountCents: 3900_00, approvedBy: 'p_dv', openedAt: at('2026-10-18T10:00', CT), eta: at('2026-10-26T17:00', CT), createdBy: 'p_dv' });
  claims.push(claim({
    id: 'k0044', number: 'CLM-2026-0044', caseId: id, type: 'auto_liability', status: 'Under review', title: 'Sedan occupants — bodily injury and vehicle damage', insurer: 'Harborline Insurance', insurerClaimNo: 'HL-AL-55301',
    adjuster: { name: 'Paul Nguyen', phone: '(555) 014-8872', email: 'p.nguyen@harborline.example' }, claimant: 'Sedan driver and passenger (names restricted)',
    openedAt: at('2026-10-17T18:45', CT), reportedToInsurerAt: at('2026-10-17T18:45', CT), reserveCents: 85000_00, deductibleCents: 2500_00, ownerId: 'p_nk', restricted: true, lastUpdateAt: at('2026-10-19T10:00', CT),
    docs: [{ id: 'dd20', label: 'Police report', received: false }, { id: 'dd21', label: 'Attorney letter of representation', received: true }, { id: 'dd22', label: 'Medical authorizations', received: false }],
    log: [{ id: 'lg15', at: at('2026-10-17T18:45', CT), by: 'p_nk', channel: 'Phone', text: 'First notice of loss to Harborline after-hours line.' }, { id: 'lg16', at: at('2026-10-19T09:40', CT), by: 'p_nk', channel: 'Letter', text: 'Attorney letter of representation received for the passenger.' }, { id: 'lg17', at: at('2026-10-19T10:00', CT), by: 'p_nk', channel: 'Email', text: 'Adjuster Paul Nguyen assigned; reserve set by insurer.' }],
    nextFollowUp: { at: at('2026-10-21T10:00', CT), assigneeId: 'p_nk', what: 'Driver recorded statement with adjuster' },
  }));
  downtime.push({ id: 'd018a', caseId: id, unitKind: 'truck', unitId: 't133', start: occ, end: at('2026-10-18T11:00', CT), source: 'Daily board status', verifiedBy: 'p_dv', note: 'Inspected at Hoosier Fleet Repair; released drivable' });
  cases.push(baseCase({
    id, number: 'ACC-2026-018', occurredAt: occ, tz: CT, timeProvenance: 'verified', type: 'Intersection / turning', severity: 'serious', stage: 'investigation', createdAt: at('2026-10-17T17:47', CT), submittedAt: at('2026-10-17T17:50', CT), updatedAt: at('2026-10-19T10:00', CT),
    severityManual: undefined,
    description: 'Going westbound on US-30 on a green light, a sedan turned left from the eastbound lanes across my path. I braked but hit its passenger side. Two people in the car were taken by ambulance.',
    location: { road: 'US-30 WB', detail: 'at Broadway', city: 'Merrillville', state: 'IN', lat: 41.47, lng: -87.33, publicRoad: 'yes' },
    driverId: 'd4', truckId: 't133', trailerId: 'tlT-5333', loadId: 'lL-48120', assignmentSource: 'Daily board at 5:32 PM CDT',
    injuries: { status: 'yes', treatedAway: 2, fatalities: 0, ourDriver: 'no', provenance: 'preliminary', detailsRestricted: 'Sedan driver and passenger transported by EMS to a regional hospital; both conscious at the scene. Passenger reported neck pain. Admission status not confirmed.' },
    towAway: 'yes', citation: { status: 'no', note: 'Police confirmed Oct 18 that our driver was not cited' }, police: { responded: 'yes', dept: 'Merrillville Police Department' },
    conditions: { weather: 'Clear', road: 'Dry', light: 'Daylight' },
    vehicles: [{ id: 'v4', description: '2015 sedan (silver)', owner: 'Private individual (restricted)', insurer: 'Requested', damage: 'Passenger side; towed', towed: 'yes' }],
    witnesses: [{ id: 'w1', name: 'M. Alvarez (pedestrian)', contact: 'Restricted — on file with Safety', note: 'Says the sedan turned on a solid green' }],
    equipment: { truck: eq({ condition: 'drivable', status: 'returned', damage: 'has front bumper and hood damage but stayed drivable', rtsAt: at('2026-10-18T11:00', CT) }), trailer: eq({ damage: 'was not damaged' }) },
    cargo: { status: 'no_damage', plan: 'delivered_as_is', deliveryImpact: 'delivered 3 hours late', brokerNotified: 'na' },
    legalHold: { since: at('2026-10-17T18:25', CT), by: 'p_rm', reason: 'Injury crash — preserve video, ECM, ELD and inspection records' },
    investigation: {
      status: 'in_progress', ownerId: 'p_rm',
      facts: [
        fact('Truck speed 41 mph in a 45 mph zone at the time of braking.', 'Samsara event / ECM', 'verified', 'p_rm', at('2026-10-17T19:00', CT)),
        fact('Westbound signal was green for our truck.', 'Samsara forward video', 'verified', 'p_rm', at('2026-10-17T19:05', CT)),
        fact('Sedan turned left from the eastbound lanes across our lane.', 'Samsara forward video', 'verified', 'p_rm', at('2026-10-17T19:05', CT)),
        fact('Officer at the scene said the sedan driver failed to yield.', 'Driver account of officer’s remark', 'preliminary', 'p_rm', at('2026-10-17T19:30', CT)),
        fact('Our driver was not cited.', 'Phone confirmation with Merrillville PD', 'verified', 'p_ta', at('2026-10-18T09:10', CT)),
      ],
      questions: [
        { id: 'q5', text: 'Did eastbound traffic have a protected green arrow?', ownerId: 'p_ta', createdAt: at('2026-10-18T10:00', CT) },
        { id: 'q6', text: 'Is there a second camera angle from businesses at the intersection?', ownerId: 'p_ta', createdAt: at('2026-10-18T10:00', CT) },
        { id: 'q7', text: 'Final police report narrative and diagram', ownerId: 'p_ta', createdAt: at('2026-10-18T10:00', CT) },
      ],
      statements: [{ id: 's6', party: 'Daniel Okafor', kind: 'Driver', takenAt: at('2026-10-17T19:15', CT), takenBy: 'p_rm', summary: 'Green light westbound; sedan turned left in front of him; braked hard.' }, { id: 's7', party: 'M. Alvarez (pedestrian)', kind: 'Witness', takenAt: at('2026-10-18T11:30', CT), takenBy: 'p_ta', summary: 'Saw the sedan turn on a solid green, not an arrow.' }],
      checklist: [ck('video', 'Dashcam video (forward + driver-facing)', 'reviewed'), ck('ecm', 'ECM / speed data', 'reviewed'), ck('eld', 'ELD / hours of service', 'reviewed', 'Within limits'), ck('police', 'Police report', 'requested', 'Requested Oct 18; 5–7 business days'), ck('witness', 'Witness statement', 'reviewed'), ck('signal', 'Signal timing from the city', 'pending'), ck('inspection', 'Post-crash truck inspection', 'reviewed', 'Brakes and lights OK')],
      factors: [{ id: 'fa9', category: 'Other party', label: 'Left turn across path (failure to yield)', level: 'possible' }, { id: 'fa10', category: 'Driver', label: 'Speed / reaction', level: 'ruled_out' }],
    },
    determinations: { fault: { value: 'not_determined' }, preventability: { value: 'not_determined' }, cpdp: { value: 'eligible_not_submitted', basis: 'Likely eligible (type 21 — video shows the sequence). Submit once the police report is received.', by: 'p_rm' }, legal: { value: 'unknown', basis: 'Attorney letter of representation received Oct 19 — insurer handling', by: 'p_nk' } },
    testing: { alcohol: { substance: 'alcohol', decision: 'auto', notAdministeredReason: 'Not required — no citation issued (confirmed with police Oct 18)' }, drug: { substance: 'drug', decision: 'auto', notAdministeredReason: 'Not required — no citation issued within 32 hours' } },
    initialEstimateCents: 4000_00, ownerId: 'p_rm',
  }));
  const E = (a: string, src: EventSource, by: string, text: string, x: Partial<TimelineEvent> = {}) => events.push(ev(id, a, src, by, text, x));
  E(occ, 'Telematics', 'System', 'Samsara collision event at US-30 & Broadway');
  E(at('2026-10-17T17:41', CT), 'Driver', 'Daniel Okafor', 'Driver called Safety (911 already called by bystanders)', { loggedAt: at('2026-10-17T17:47', CT) });
  E(at('2026-10-17T17:50', CT), 'Safety', 'Rachel Moore', 'Accident reported in NeWay');
  E(at('2026-10-17T17:50', CT), 'Safety', 'Rachel Moore', 'Two sedan occupants transported by EMS', { restricted: true, loggedAt: at('2026-10-17T18:00', CT) });
  E(at('2026-10-17T17:55', CT), 'Safety', 'Rachel Moore', 'Merrillville police on scene', { loggedAt: at('2026-10-17T18:05', CT) });
  E(at('2026-10-17T18:20', CT), 'Safety', 'Rachel Moore', 'Sedan towed from the scene (police rotation tow)', { loggedAt: at('2026-10-17T18:30', CT) });
  E(at('2026-10-17T18:25', CT), 'Safety', 'Rachel Moore', 'Legal hold placed — video, ECM, ELD, inspection records preserved');
  E(at('2026-10-17T18:45', CT), 'Claims', 'Nilufar Karimova', 'CLM-2026-0044 opened — first notice of loss to Harborline');
  E(at('2026-10-17T19:15', CT), 'Safety', 'Rachel Moore', 'Driver statement recorded');
  E(at('2026-10-17T20:30', CT), 'Dispatch', 'Sardor Yusupov', 'Customer notified; load continued — delivered 3 hours late');
  E(at('2026-10-18T09:10', CT), 'Safety', 'Timur Aliev', 'Police confirmed our driver was not cited — DOT testing not required');
  E(at('2026-10-18T11:00', CT), 'Fleet', 'Dmitri Volkov', 'Truck 133 inspected; drivable — released to service. Repair booked Oct 26 (RO-2026-9152)');
  E(at('2026-10-18T11:30', CT), 'Safety', 'Timur Aliev', 'Witness statement taken (pedestrian)');
  E(at('2026-10-18T13:00', CT), 'Safety', 'Timur Aliev', 'Police report requested');
  E(at('2026-10-19T09:40', CT), 'Claims', 'Nilufar Karimova', 'Attorney letter of representation received for the passenger', { restricted: true });
  E(at('2026-10-19T10:00', CT), 'Claims', 'Nilufar Karimova', 'Adjuster Paul Nguyen assigned');
  evidence.push(evd(id, 'Scene photo', 'Intersection — final rest.jpg', '', at('2026-10-17T18:10', CT), 'Daniel Okafor'));
  evidence.push(evd(id, 'Damage photo', 'Truck 133 bumper and hood.jpg', '', at('2026-10-17T18:11', CT), 'Daniel Okafor'));
  evidence.push(evd(id, 'Damage photo', 'Sedan passenger side.jpg', '', at('2026-10-17T18:12', CT), 'Daniel Okafor'));
  evidence.push(evd(id, 'Dashcam / video', 'Samsara forward camera — 30 s.mp4', 'Legal hold', at('2026-10-17T18:25', CT), 'Rachel Moore', 'video'));
  evidence.push(evd(id, 'Dashcam / video', 'Samsara driver-facing camera — 30 s.mp4', 'Legal hold', at('2026-10-17T18:25', CT), 'Rachel Moore', 'video', { restricted: true }));
  evidence.push(evd(id, 'Driver statement', 'Driver statement — D. Okafor.pdf', '', at('2026-10-17T19:20', CT), 'Rachel Moore', 'pdf'));
  evidence.push(evd(id, 'Witness statement', 'Witness — M. Alvarez.pdf', 'Contact details redacted', at('2026-10-18T11:40', CT), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Medical (restricted)', 'EMS transport notes (from police).pdf', 'Restricted', at('2026-10-18T13:30', CT), 'Rachel Moore', 'pdf', { restricted: true }));
  evidence.push(evd(id, 'Legal (restricted)', 'Attorney letter of representation.pdf', 'Restricted', at('2026-10-19T09:40', CT), 'Nilufar Karimova', 'pdf', { restricted: true }));
  evidence.push(evd(id, 'Repair estimate', 'Hoosier Fleet Repair estimate.pdf', '$3,900', at('2026-10-18T10:00', CT), 'Dmitri Volkov', 'pdf'));
  const c0 = at('2026-10-17T17:50', CT);
  tasks.push(task(id, 'Canvass businesses at US-30 & Broadway for camera footage', 'Safety', 'p_ta', at('2026-10-18T17:00', CT), 'open', at('2026-10-18T10:00', CT), { priority: 'high', instructions: 'Most systems overwrite in 3–7 days. Ask the gas station on the NE corner first.' }));
  tasks.push(task(id, 'Forward attorney letter of representation to Harborline', 'Claims', 'p_nk', at('2026-10-20T12:00', CT), 'open', at('2026-10-19T09:40', CT), { priority: 'high' }));
  tasks.push(task(id, 'Management review of injury incident', 'Management', 'p_jb', at('2026-10-20T17:00', CT), 'open', c0, { priority: 'high', auto: 'Injury treated away from the scene' }));
  tasks.push(task(id, 'Schedule driver’s recorded statement with the adjuster', 'Claims', 'p_nk', at('2026-10-21T17:00', CT), 'open', at('2026-10-19T10:00', CT)));
  tasks.push(task(id, 'Obtain police report (Merrillville PD)', 'Safety', 'p_ta', at('2026-10-23T17:00', CT), 'open', at('2026-10-18T13:00', CT)));
  tasks.push(task(id, 'Repair front bumper and hood (RO-2026-9152)', 'Fleet', 'p_dv', at('2026-10-26T17:00', CT), 'open', at('2026-10-18T11:00', CT)));
  tasks.push(task(id, 'Preserve Samsara video, ECM and ELD data (legal hold)', 'Safety', 'p_rm', at('2026-10-17T20:00', CT), 'done', c0, { completedAt: at('2026-10-17T18:25', CT), priority: 'high', auto: 'Injury crash' }));
  tasks.push(task(id, 'Confirm citation status within 32 hours (testing decision)', 'Safety', 'p_ta', at('2026-10-19T01:32', CT), 'done', c0, { completedAt: at('2026-10-18T09:10', CT), priority: 'high', auto: 'Injury treated away' }));
  tasks.push(task(id, 'Notify insurer (first notice of loss)', 'Claims', 'p_nk', at('2026-10-17T23:00', CT), 'done', c0, { completedAt: at('2026-10-17T18:45', CT) }));
  tasks.push(task(id, 'Collect driver statement', 'Safety', 'p_rm', at('2026-10-18T17:00', CT), 'done', c0, { completedAt: at('2026-10-17T19:15', CT) }));
}

/* ----------------------------------------------------------------- history (closed cases for trends) */
interface HistSpec {
  n: string; local: string; tz: string; state: string; city: string; road?: string; detail?: string; type: string; sev: AccidentCase['severity'];
  truck: string; driver: string; trailer?: string; prevent: 'p' | 'n'; publicRoad?: boolean; tow?: boolean; cited?: string; injuredAway?: number;
  tractor?: number; trailerCost?: number; towCost?: number; rental?: number; downDays?: number; trailerDownDays?: number;
  claims?: { type: ClaimType; insurer: string; claimed: number; ded?: number; toUs?: number; insurerPaid?: number; byUs?: number; status?: ClaimStatus; reserve?: number; num: string; opened: string }[];
  ca?: CorrectiveAction['kind']; caTitle?: string; summary: string; estimate?: number; cpdp?: AccidentCase['determinations']['cpdp'];
  invDays?: number; closeDays?: number; factor?: string;
}

let ro = 9001, ap = 90010;
function hist(h: HistSpec) {
  const id = 'c' + h.n.replace(/\D/g, '').slice(-5);
  const occ = at(h.local, h.tz);
  const add = (d: number) => new Date(Date.parse(occ) + d * 86400000).toISOString();
  const invDone = add(h.invDays ?? 9), closed = add(h.closeDays ?? 34);
  const truckId = 't' + h.truck, trailerId = h.trailer ? 'tl' + h.trailer : undefined;
  const mkWO = (kind: 'truck' | 'trailer', amount: number, days: number) => {
    const w = wo({ number: `RO-${h.local.slice(0, 4)}-${ro++}`, unitKind: kind, unitId: kind === 'truck' ? truckId : trailerId!, caseId: id, type: 'Accident repair', title: kind === 'truck' ? 'Accident repair — tractor' : 'Accident repair — trailer', shop: ['Prairie State Truck & Body, Joliet', 'Keystone Diesel & Collision', 'Southern Fleet Collision', 'Midwest Truck & Trailer', 'Gateway Fleet Repair'][ro % 5]!, status: 'Completed', estimates: [{ id: nid('es'), vendor: 'Shop', amountCents: $(amount), at: add(1), selected: true }], estimatesRequired: amount > 25000 ? 3 : 1, approvedAmountCents: $(amount), approvedBy: 'p_dv', invoiceNumber: `INV-${ro}`, invoiceTotalCents: $(amount), openedAt: add(0.2), shopInAt: add(0.4), completedAt: add(Math.max(0.3, days)), createdBy: 'p_dv' });
    w.billId = bill({ number: `AP-${ap++}`, vendor: w.shop, amountCents: $(amount), date: add(Math.max(0.5, days) + 1), status: 'Paid', category: kind === 'truck' ? 'Tractor repair' : 'Trailer repair', caseId: id, woId: w.id, memo: `${kind === 'truck' ? 'Tractor ' + h.truck : 'Trailer ' + h.trailer} repair` }).id;
  };
  if (h.tractor) mkWO('truck', h.tractor, h.downDays ?? 1);
  if (h.trailerCost) mkWO('trailer', h.trailerCost, h.trailerDownDays ?? h.downDays ?? 1);
  if (h.towCost) bill({ number: `AP-${ap++}`, vendor: 'Regional heavy tow', amountCents: $(h.towCost), date: add(2), status: 'Paid', category: 'Towing', caseId: id, memo: `Tow ${h.tractor ? 'tractor ' + h.truck : 'trailer ' + h.trailer}` });
  if (h.rental) bill({ number: `AP-${ap++}`, vendor: 'Fleet rental — replacement tractor', amountCents: $(h.rental), date: add(h.downDays ?? 10), status: 'Paid', category: 'Rental equipment', caseId: id, memo: 'Replacement tractor while in repair' });
  if (h.downDays) downtime.push({ id: nid('d'), caseId: id, unitKind: 'truck', unitId: truckId, start: occ, end: add(h.downDays), source: 'Daily board status', verifiedBy: 'p_dv' });
  if (h.trailerDownDays && trailerId) downtime.push({ id: nid('d'), caseId: id, unitKind: 'trailer', unitId: trailerId, start: occ, end: add(h.trailerDownDays), source: 'Work order', verifiedBy: 'p_dv' });
  for (const k of h.claims || []) {
    const pays: Claim['payments'] = [];
    if (k.toUs) pays.push({ id: nid('pp'), at: add((h.closeDays ?? 34) - 2), amountCents: $(k.toUs), direction: 'to_us', party: k.insurer });
    if (k.insurerPaid) pays.push({ id: nid('pp'), at: add((h.closeDays ?? 34) - 4), amountCents: $(k.insurerPaid), direction: 'by_insurer_to_claimant', party: k.insurer, note: 'Settlement to claimant' });
    if (k.byUs) pays.push({ id: nid('pp'), at: add((h.closeDays ?? 34) - 1), amountCents: $(k.byUs), direction: 'by_us', party: 'Northwind Freight', note: 'Deductible reimbursement' });
    const st = k.status || 'Closed';
    claims.push(claim({ id: 'k' + k.num.slice(-4) + (k.num.includes('2025') ? 'x' : ''), number: k.num, caseId: id, type: k.type, status: st, title: `${h.type} — ${h.city}, ${h.state}`, insurer: k.insurer, insurerClaimNo: 'HL-' + k.num.slice(-4), openedAt: at(k.opened, h.tz), reportedToInsurerAt: at(k.opened, h.tz), claimedCents: $(k.claimed), reserveCents: k.reserve === undefined ? undefined : $(k.reserve), deductibleCents: k.ded === undefined ? undefined : $(k.ded), settlementCents: k.insurerPaid !== undefined ? $(k.insurerPaid) : k.toUs !== undefined ? $(k.toUs) : undefined, ownerId: 'p_nk', lastUpdateAt: st === 'Negotiating' ? at('2026-10-02T10:00', h.tz) : add((h.closeDays ?? 34) - 1), closedAt: OPEN(st) ? undefined : add((h.closeDays ?? 34) - 1), payments: pays, docs: [{ id: nid('dd'), label: 'Police report', received: true }, { id: nid('dd'), label: 'Repair invoice', received: true }] }));
  }
  const pre = h.prevent === 'p';
  cases.push(baseCase({
    id, number: h.n, occurredAt: occ, tz: h.tz, type: h.type, severity: h.sev, stage: 'closed', createdAt: add(0.01), submittedAt: add(0.02), description: h.summary,
    location: { road: h.road, detail: h.detail, city: h.city, state: h.state, publicRoad: h.publicRoad === false ? 'no' : 'yes' },
    driverId: h.driver, truckId, trailerId, towAway: h.tow ? 'yes' : 'no',
    injuries: h.injuredAway ? { status: 'yes', treatedAway: h.injuredAway, fatalities: 0, ourDriver: 'no', provenance: 'verified' } : { status: 'no', treatedAway: 0, fatalities: 0, ourDriver: 'no', provenance: 'verified' },
    citation: h.cited ? { status: 'yes', issuedAt: add(0.03), note: h.cited } : { status: 'no' },
    police: { responded: h.tow || h.injuredAway ? 'yes' : 'no', dept: h.tow || h.injuredAway ? 'State / local police' : undefined, reportNumber: h.tow || h.injuredAway ? 'on file' : undefined },
    equipment: { truck: eq({ condition: h.tow && h.tractor ? 'not_drivable' : 'drivable', status: 'returned', damage: h.tractor ? 'was damaged' : 'was not damaged', rtsAt: h.downDays ? add(h.downDays) : undefined }), ...(h.trailer ? { trailer: eq({ status: h.trailerCost ? 'returned' : 'operational', damage: h.trailerCost ? 'was damaged' : 'was not damaged', rtsAt: h.trailerDownDays ? add(h.trailerDownDays) : undefined }) } : {}) },
    investigation: { status: 'complete', ownerId: 'p_ta', facts: [], questions: [], statements: [], checklist: [], factors: h.factor ? [{ id: nid('fa'), category: pre ? 'Driver' : 'Other party', label: h.factor, level: 'confirmed' }] : [], completedAt: invDone, approvedBy: 'p_rm', conclusion: pre ? 'Preventable.' : 'Non-preventable.' },
    determinations: { fault: { value: pre ? 'at_fault' : 'not_at_fault', by: 'p_rm', at: invDone }, preventability: { value: pre ? 'preventable' : 'non_preventable', by: 'p_rm', at: invDone }, cpdp: h.cpdp || { value: h.tow || h.injuredAway ? 'not_eligible' : 'not_applicable' }, legal: { value: pre ? 'company_liable' : 'third_party_liable' } },
    correctiveActions: h.ca ? [{ id: nid('ca'), kind: h.ca, title: h.caTitle || h.ca, driverId: h.driver, assigneeId: 'p_ta', due: add((h.invDays ?? 9) + 14), status: 'Completed', completedAt: add((h.invDays ?? 9) + 10), decisionBy: 'p_rm' }] : [],
    testing: { alcohol: { substance: 'alcohol', decision: 'auto', ...(h.cited && h.tow ? { administeredAt: add(0.08), resultRestricted: 'Negative' } : {}) }, drug: { substance: 'drug', decision: 'auto', ...(h.cited && h.tow ? { administeredAt: add(0.09), resultRestricted: 'Negative' } : {}) } },
    initialEstimateCents: $(h.estimate ?? Math.round(((h.tractor || 0) + (h.trailerCost || 0)) * 0.85)), ownerId: 'p_ta',
    claimDecision: (h.claims || []).length ? undefined : { text: 'Below deductible or no recoverable party — company paid', by: 'p_rm', at: add(2) },
    closure: { at: closed, by: 'p_rm', outcome: `Closed — ${pre ? 'preventable' : 'non-preventable'}; repairs invoiced${(h.claims || []).length ? ', claims handled' : ''}.`, prevention: h.ca ? `${h.ca} completed.` : 'No driver action required.' },
  }));
  events.push(ev(id, occ, 'Driver', 'System', 'Accident occurred'));
  events.push(ev(id, add(0.02), 'Safety', 'Timur Aliev', 'Accident reported in NeWay'));
  if (h.downDays) events.push(ev(id, add(h.downDays), 'Fleet', 'Dmitri Volkov', `Truck ${h.truck} returned to service`));
  events.push(ev(id, invDone, 'Safety', 'Rachel Moore', `Investigation approved — ${pre ? 'preventable' : 'non-preventable'}`));
  events.push(ev(id, closed, 'Safety', 'Rachel Moore', 'Case closed'));
  evidence.push(evd(id, 'Damage photo', 'Damage overview.jpg', '', add(0.05), 'Driver app'));
  if (h.tow || h.injuredAway) evidence.push(evd(id, 'Police report', 'Police report.pdf', '', add(6), 'Timur Aliev', 'pdf'));
  evidence.push(evd(id, 'Driver statement', 'Driver statement.pdf', '', add(1), 'Timur Aliev', 'pdf'));
}
const OPEN = (s: ClaimStatus) => !['Settled', 'Denied', 'Closed'].includes(s);
const HL = 'Harborline Insurance';
const HIST: HistSpec[] = [
  { n: 'ACC-2025-028', local: '2025-09-14T09:40', tz: CT, state: 'TX', city: 'Laredo', road: 'Customer DC', detail: 'Mines Rd', type: 'Backing', sev: 'minor', truck: '104', driver: 'd8', trailer: 'T-5302', prevent: 'p', publicRoad: false, trailerCost: 2300, trailerDownDays: 1, ca: 'Coaching', caTitle: 'Backing coaching', summary: 'Backing into door 14, trailer struck the dock bumper post.', factor: 'Backing without a spotter' },
  { n: 'ACC-2025-029', local: '2025-10-03T02:10', tz: ET, state: 'OH', city: 'Lewisburg', road: 'I-70 WB rest area', detail: 'MM 26', type: 'Struck while parked or stopped', sev: 'minor', truck: '112', driver: 'd9', prevent: 'n', tractor: 1450, downDays: 0.5, claims: [{ type: 'recovery', insurer: 'Other party’s insurer', claimed: 1450, toUs: 1450, num: 'CLM-2025-0071', opened: '2025-10-06T10:00' }], summary: 'Parked at the rest area; a pickup backed into the tractor door.', factor: 'Other vehicle backing' },
  { n: 'ACC-2025-030', local: '2025-11-11T18:05', tz: ET, state: 'PA', city: 'Snow Shoe', road: 'I-80 WB', detail: 'MM 147', type: 'Animal strike', sev: 'serious', truck: '121', driver: 'd10', prevent: 'n', tow: true, tractor: 6800, towCost: 1250, downDays: 5, claims: [{ type: 'physical_damage', insurer: HL, claimed: 6800, ded: 5000, toUs: 1800, num: 'CLM-2025-0079', opened: '2025-11-13T09:00' }], summary: 'Deer strike at dusk; radiator damaged, tractor towed.', factor: 'Deer in roadway' },
  { n: 'ACC-2025-031', local: '2025-12-09T05:50', tz: ET, state: 'IN', city: 'Lafayette', road: 'I-65 NB', detail: 'MM 175', type: 'Jackknife / loss of control', sev: 'serious', truck: '145', driver: 'd13', trailer: 'T-5339', prevent: 'p', tow: true, tractor: 21400, trailerCost: 4300, towCost: 3200, downDays: 21, trailerDownDays: 12, claims: [{ type: 'physical_damage', insurer: HL, claimed: 25700, ded: 5000, toUs: 20700, num: 'CLM-2025-0084', opened: '2025-12-10T09:00' }], ca: 'Retraining', caTitle: 'Winter driving & speed for conditions', summary: 'Lost traction on an icy overpass and jackknifed into the median.', factor: 'Speed for conditions (ice)' },
  { n: 'ACC-2025-032', local: '2025-12-22T13:15', tz: ET, state: 'GA', city: 'Forest Park', road: 'Customer yard', type: 'Backing', sev: 'minor', truck: '136', driver: 'd12', trailer: 'T-5336', prevent: 'p', publicRoad: false, trailerCost: 3100, ca: 'Coaching', caTitle: 'Backing coaching', summary: 'Trailer top rail struck a loading-dock awning while backing.', factor: 'Backing — overhead clearance' },
  { n: 'ACC-2026-001', local: '2026-01-12T07:25', tz: CT, state: 'IL', city: 'Minooka', road: 'I-80 EB', detail: 'MM 122', type: 'Rear-end — struck by another vehicle', sev: 'serious', truck: '128', driver: 'd11', trailer: 'T-5324', prevent: 'n', tow: true, trailerCost: 7450, trailerDownDays: 3, downDays: 0.3, claims: [{ type: 'recovery', insurer: 'Other party’s insurer', claimed: 7450, toUs: 7450, num: 'CLM-2026-0003', opened: '2026-01-14T09:00' }], cpdp: { value: 'not_preventable', basis: 'Rear-end struck — eligible type 1', rdr: 'RDR 2026-010233' }, closeDays: 60, summary: 'Stopped in traffic, rear-ended by a car; car towed.', factor: 'Following vehicle too close' },
  { n: 'ACC-2026-002', local: '2026-01-27T16:40', tz: ET, state: 'OH', city: 'Springfield', road: 'I-70 EB', detail: 'MM 54', type: 'Sideswipe / lane change', sev: 'moderate', truck: '151', driver: 'd14', prevent: 'p', tractor: 5200, downDays: 2, claims: [{ type: 'auto_liability', insurer: HL, claimed: 4400, ded: 2500, insurerPaid: 4100, byUs: 2500, num: 'CLM-2026-0006', opened: '2026-01-28T09:00' }], ca: 'Coaching', caTitle: 'Lane changes in snow', summary: 'Lane change in light snow; mirror and fender contact with a car.', factor: 'Lane change clearance' },
  { n: 'ACC-2026-003', local: '2026-02-08T10:05', tz: ET, state: 'NJ', city: 'Edison', road: 'Customer DC', type: 'Backing', sev: 'minor', truck: '159', driver: 'd15', trailer: 'T-5351', prevent: 'p', publicRoad: false, trailerCost: 1900, ca: 'Coaching', caTitle: 'Backing coaching', summary: 'Backing at the customer DC, trailer struck a light pole base.', factor: 'Backing without a walk-around' },
  { n: 'ACC-2026-004', local: '2026-02-24T14:30', tz: CT, state: 'TN', city: 'Lebanon', road: 'I-40 WB', detail: 'MM 238', type: 'Road debris / tire debris', sev: 'minor', truck: '162', driver: 'd16', prevent: 'n', tractor: 2650, downDays: 1, summary: 'Tire tread in the lane struck the fairing and an air line.', factor: 'Road debris' },
  { n: 'ACC-2026-005', local: '2026-03-15T08:10', tz: CT, state: 'TX', city: 'Waxahachie', road: 'I-35E SB', detail: 'MM 403', type: 'Rear-end — we struck the vehicle ahead', sev: 'serious', truck: '118', driver: 'd2', prevent: 'p', tow: true, cited: 'Following too closely', tractor: 24800, towCost: 2900, rental: 3700, downDays: 19, claims: [{ type: 'physical_damage', insurer: HL, claimed: 24800, ded: 5000, toUs: 19800, num: 'CLM-2026-0011', opened: '2026-03-16T09:00' }, { type: 'auto_liability', insurer: HL, claimed: 13100, ded: 2500, insurerPaid: 12300, byUs: 2500, num: 'CLM-2026-0012', opened: '2026-03-17T09:00' }], ca: 'Retraining', caTitle: 'Following distance & space management', summary: 'Struck the rear of an SUV in slowing traffic; both vehicles towed.', factor: 'Following distance' },
  { n: 'ACC-2026-006', local: '2026-04-02T03:40', tz: PT, state: 'CA', city: 'Ontario', road: 'Truck stop lot', type: 'Struck while parked or stopped', sev: 'minor', truck: '165', driver: 'd17', prevent: 'n', publicRoad: false, tractor: 1200, summary: 'Parked overnight; struck by an unknown truck (no note left).', factor: 'Unidentified vehicle' },
  { n: 'ACC-2026-007', local: '2026-04-21T11:20', tz: CT, state: 'IL', city: 'Elk Grove Village', road: 'Customer yard', type: 'Backing', sev: 'minor', truck: '112', driver: 'd9', trailer: 'T-5308', prevent: 'p', publicRoad: false, trailerCost: 2450, trailerDownDays: 1, ca: 'Coaching', caTitle: 'Backing coaching', summary: 'Backing in a tight yard, trailer struck a parked trailer.', factor: 'Backing without a walk-around' },
  { n: 'ACC-2026-009', local: '2026-05-30T21:50', tz: CT, state: 'WI', city: 'Johnson Creek', road: 'I-94 WB', detail: 'MM 267', type: 'Animal strike', sev: 'serious', truck: '171', driver: 'd18', prevent: 'n', tow: true, tractor: 5900, towCost: 1100, downDays: 4, claims: [{ type: 'physical_damage', insurer: HL, claimed: 5900, ded: 5000, toUs: 900, num: 'CLM-2026-0022', opened: '2026-06-01T09:00' }], summary: 'Deer strike at night; tractor towed.', factor: 'Deer in roadway' },
  { n: 'ACC-2026-010', local: '2026-06-18T13:05', tz: ET, state: 'GA', city: 'Atlanta', road: 'Fulton Industrial Blvd', type: 'Intersection / turning', sev: 'moderate', truck: '136', driver: 'd12', trailer: 'T-5336', prevent: 'p', trailerCost: 650, claims: [{ type: 'auto_liability', insurer: HL, claimed: 6500, ded: 2500, insurerPaid: 6200, byUs: 2500, num: 'CLM-2026-0025', opened: '2026-06-19T09:00' }], ca: 'Coaching', caTitle: 'Right-turn trailer swing', summary: 'Trailer swing on a right turn struck a car waiting at the light.', factor: 'Right-turn setup' },
  { n: 'ACC-2026-011', local: '2026-07-07T17:15', tz: CT, state: 'IN', city: 'Hammond', road: 'I-80/94 EB', detail: 'MM 5', type: 'Rear-end — struck by another vehicle', sev: 'serious', truck: '128', driver: 'd11', trailer: 'T-5324', prevent: 'n', tow: true, tractor: 3100, trailerCost: 9800, towCost: 1400, downDays: 2, trailerDownDays: 8, claims: [{ type: 'recovery', insurer: 'Other party’s insurer', claimed: 14300, toUs: 9000, status: 'Negotiating', num: 'CLM-2026-0026', opened: '2026-07-09T09:00' }], cpdp: { value: 'not_preventable', basis: 'Rear-end struck — eligible type 1', rdr: 'RDR 2026-071552' }, summary: 'Slowing for congestion, struck from behind by a pickup towing a trailer.', factor: 'Following vehicle too close' },
  { n: 'ACC-2026-012', local: '2026-07-29T06:45', tz: ET, state: 'PA', city: 'York', road: 'Customer DC', type: 'Backing', sev: 'minor', truck: '112', driver: 'd9', trailer: 'T-5308', prevent: 'p', publicRoad: false, trailerCost: 3300, trailerDownDays: 1, ca: 'Ride-along evaluation', caTitle: 'Ride-along evaluation — backing', summary: 'Backing to a door, trailer struck the door frame.', factor: 'Backing without a walk-around' },
  { n: 'ACC-2026-013', local: '2026-08-16T04:20', tz: ET, state: 'KY', city: 'Berea', road: 'I-75 SB', detail: 'MM 77', type: 'Run off road / rollover', sev: 'serious', truck: '174', driver: 'd19', trailer: 'T-5330', prevent: 'p', tow: true, tractor: 16900, trailerCost: 2400, towCost: 3500, downDays: 15, trailerDownDays: 6, claims: [{ type: 'physical_damage', insurer: HL, claimed: 19300, ded: 5000, toUs: 14300, num: 'CLM-2026-0030', opened: '2026-08-17T09:00' }], ca: 'Retraining', caTitle: 'Fatigue management & trip planning', summary: 'Drifted onto the right shoulder in the early morning and into the ditch.', factor: 'Lane departure (early morning)' },
  { n: 'ACC-2026-014', local: '2026-09-05T19:30', tz: CT, state: 'MO', city: 'Joplin', road: 'Truck stop fuel island', type: 'Parking / struck fixed object', sev: 'minor', truck: '177', driver: 'd20', prevent: 'p', publicRoad: false, tractor: 1650, ca: 'Coaching', caTitle: 'Fuel island clearance', summary: 'Pulling out of the fuel island, the steps struck a bollard.', factor: 'Clearance misjudged' },
];
HIST.forEach(hist);

/* ----------------------------------------------------------------- standalone claims (no accident) */
claims.push(claim({
  id: 'k0027', number: 'CLM-2026-0027', type: 'cargo', status: 'Closed', title: 'Water damage — paper goods (trailer roof leak)', standaloneKind: 'Damaged freight', insurer: 'Self-handled (below deductible)', claimant: 'Great Plains Paper Co.', loadId: 'lL-46440', unitLabel: 'Trailer T-5327',
  openedAt: at('2026-07-14T10:00', CT), claimedCents: 2180_00, settlementCents: 2180_00, ownerId: 'p_nk', lastUpdateAt: at('2026-08-03T10:00', CT), closedAt: at('2026-08-03T10:00', CT),
  payments: [{ id: 'pp9', at: at('2026-08-03T10:00', CT), amountCents: 2180_00, direction: 'by_us', party: 'Northwind Freight', note: 'Paid to shipper' }],
  docs: [{ id: 'dd30', label: 'Delivery receipt with exceptions', received: true }, { id: 'dd31', label: 'Photos', received: true }],
  log: [{ id: 'lg30', at: at('2026-07-14T10:00', CT), by: 'p_nk', channel: 'Email', text: 'Shipper claim for 6 wet cartons; trailer roof patched (RO).' }],
}));
claims.push(claim({
  id: 'k0031', number: 'CLM-2026-0031', type: 'cargo', status: 'Under review', title: '14 cartons short — seal intact', standaloneKind: 'Cargo shortage', insurer: 'Ironclad Cargo Underwriters', insurerClaimNo: 'ICU-26-28810', claimant: 'Crossroads Logistics (for Hoosier Home Goods)', loadId: 'lL-46980', unitLabel: 'Truck 104 · Trailer T-5302',
  openedAt: at('2026-08-24T10:00', ET), reportedToInsurerAt: at('2026-08-25T10:00', ET), claimedCents: 3640_00, reserveCents: 3640_00, deductibleCents: 2500_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-14T10:00', ET),
  docs: [{ id: 'dd32', label: 'Bill of lading', received: true }, { id: 'dd33', label: 'Shipper load count & seal record', received: true }, { id: 'dd34', label: 'Receiver count sheet', received: false }],
  log: [{ id: 'lg31', at: at('2026-08-24T10:00', ET), by: 'p_nk', channel: 'Email', text: 'Shortage claim received; seal intact on arrival (shipper load & count).' }, { id: 'lg32', at: at('2026-10-14T10:00', ET), by: 'p_nk', channel: 'Email', text: 'Asked the receiver for the count sheet again.' }],
  nextFollowUp: { at: at('2026-10-24T10:00', ET), assigneeId: 'p_nk', what: 'Receiver count sheet' },
}));
claims.push(claim({
  id: 'k0038', number: 'CLM-2026-0038', type: 'cargo', status: 'Under review', title: 'Trailer burglary — consumer electronics', standaloneKind: 'Cargo theft', insurer: 'Ironclad Cargo Underwriters', insurerClaimNo: 'ICU-26-32114', claimant: 'Coastline Freight (for Pacific Gadget Supply)', loadId: 'lL-47900', unitLabel: 'Truck 165 · Trailer T-5348',
  openedAt: at('2026-09-30T08:00', PT), reportedToInsurerAt: at('2026-09-30T09:00', PT), claimedCents: 58900_00, reserveCents: 58900_00, deductibleCents: 2500_00, ownerId: 'p_nk', lastUpdateAt: at('2026-10-08T12:00', PT),
  docs: [{ id: 'dd35', label: 'Police theft report', received: true }, { id: 'dd36', label: 'Seal photos', received: true }, { id: 'dd37', label: 'Commercial invoice', received: true }, { id: 'dd38', label: 'Driver statement on parking location', received: false }],
  log: [{ id: 'lg33', at: at('2026-09-30T08:00', PT), by: 'p_nk', channel: 'Phone', text: 'Driver found seal cut at the truck stop; police report filed.' }, { id: 'lg34', at: at('2026-10-08T12:00', PT), by: 'p_nk', channel: 'Email', text: 'Insurer asked whether the lot was on the approved secure-parking list.' }],
}));
tasks.push(task(undefined, 'Driver statement on parking location (theft claim)', 'Safety', 'p_ta', at('2026-10-15T17:00', PT), 'open', at('2026-10-08T12:00', PT), { claimId: 'k0038', priority: 'high' }));

/* An accident repair entered by Fleet with no accident case — mirrors what the audit found in production. */
{
  const w = wo({ number: 'RO-2026-9158', unitKind: 'truck', unitId: 't148', type: 'Accident repair', title: 'Right mirror arm and door skin — shop note: “struck by forklift at customer dock”', shop: 'Midwest Truck & Trailer', status: 'Completed', estimates: [{ id: 'es9', vendor: 'Midwest Truck & Trailer', amountCents: 1260_00, at: at('2026-10-18T09:00', CT), selected: true }], estimatesRequired: 1, approvedAmountCents: 1260_00, approvedBy: 'p_dv', invoiceNumber: 'MTT-5512', invoiceTotalCents: 1260_00, openedAt: at('2026-10-18T09:00', CT), shopInAt: at('2026-10-18T09:00', CT), completedAt: at('2026-10-18T15:00', CT), createdBy: 'p_dv' });
  w.billId = bill({ number: 'AP-90288', vendor: 'Midwest Truck & Trailer', amountCents: 1260_00, date: at('2026-10-18T16:00', CT), status: 'Open', category: 'Tractor repair', woId: w.id, memo: 'Truck 148 mirror arm & door skin' }).id;
}

/* ----------------------------------------------------------------- mileage for rates */
const MILEAGE = [
  ['2025-09', 1452000, 0.31], ['2025-10', 1498000, 0.33], ['2025-11', 1461000, 0.36], ['2025-12', 1389000, 0.38], ['2026-01', 1402000, 0.41], ['2026-02', 1366000, 0.47],
  ['2026-03', 1517000, 0.55], ['2026-04', 1543000, 0.72], ['2026-05', 1588000, 0.79], ['2026-06', 1604000, 0.84], ['2026-07', 1611000, 0.88], ['2026-08', 1597000, 0.91], ['2026-09', 1562000, 0.93], ['2026-10', 968000, 0.94],
].map(([month, miles, coverage]) => ({ month: month as string, miles: miles as number, coverage: coverage as number }));

export function seedState(): SafetyRulesState {
  return JSON.parse(JSON.stringify({
    people: PEOPLE, drivers: DRIVERS, trucks: TRUCKS, trailers: TRAILERS, loads: LOADS,
    assignments: [],
    cases: cases.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)), claims, tasks, evidence, events, workOrders, bills, downtime, mileage: MILEAGE,
  }));
}
