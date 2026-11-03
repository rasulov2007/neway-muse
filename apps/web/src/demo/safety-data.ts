/**
 * Seed records for the Safety module.
 *
 * The same standing rule as every other demo module: the *records* are seeded so the screens have
 * something real to work on, and every *derived* number stays honest — nothing here writes a risk
 * score, a CSA percentile or a preventability decision that a person has not made.
 *
 * Two deliberate choices worth stating:
 *
 *  - Violations that came from a roadside inspection carry that inspection's id, and the defects
 *    that inspection raised carry it too. So "3 violations" on a driver and "the inspection that
 *    produced them" are the same records seen twice, not two invented sets.
 *  - Some accidents are left with preventability `undetermined` and no investigator, because that
 *    is the state a real safety desk is full of, and it is what the exception queue exists to find.
 */
import type {
  AccidentSeverity,
  DefectSeverity,
  EvidenceKind,
  InspectionKind,
  Preventability,
  ViolationCategory,
  ViolationSeverity,
} from '@neway/shared';
import { dotRecordable, proposeDueDate } from '@neway/shared';
import type { Rng } from './data';
import type {
  Accident,
  AccidentKind,
  Claim,
  CorrectiveAction,
  Defect,
  Inspection,
  Violation,
} from './safety-types';
import type { Driver, Load, Trailer, Truck, User } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SafetyData {
  inspections: Inspection[];
  defects: Defect[];
  violations: Violation[];
  accidents: Accident[];
  claims: Claim[];
  correctiveActions: CorrectiveAction[];
}

export interface SafetySeedInput {
  trucks: Truck[];
  trailers: Trailer[];
  drivers: Driver[];
  loads: Load[];
  users: User[];
  now: Date;
}

/** Real CVSA inspection findings, by the vehicle system they sit in. */
const DEFECT_CATALOG: ReadonlyArray<{
  component: string;
  description: string;
  regulation: string;
  severity: DefectSeverity;
  /** True when this finding routinely puts a unit out of service. */
  oos: boolean;
}> = [
  {
    component: 'Brakes',
    description: 'Brake adjustment beyond service limit on axle 3, left',
    regulation: '393.47(e)',
    severity: 'critical',
    oos: true,
  },
  {
    component: 'Brakes',
    description: 'Air leak at the trailer supply line',
    regulation: '393.45(d)',
    severity: 'high',
    oos: true,
  },
  {
    component: 'Tires',
    description: 'Tread depth below 4/32 on a steer tire',
    regulation: '393.75(b)',
    severity: 'critical',
    oos: true,
  },
  {
    component: 'Tires',
    description: 'Sidewall cut exposing the ply cord',
    regulation: '393.75(a)(3)',
    severity: 'high',
    oos: true,
  },
  {
    component: 'Lighting',
    description: 'Inoperative left rear turn signal',
    regulation: '393.9',
    severity: 'medium',
    oos: false,
  },
  {
    component: 'Lighting',
    description: 'Clearance lamp missing, driver side',
    regulation: '393.11',
    severity: 'low',
    oos: false,
  },
  {
    component: 'Cargo securement',
    description: 'Insufficient tiedowns for the load length',
    regulation: '393.110',
    severity: 'high',
    oos: true,
  },
  {
    component: 'Coupling',
    description: 'Fifth wheel mounting bolt loose',
    regulation: '393.70(d)',
    severity: 'critical',
    oos: true,
  },
  {
    component: 'Suspension',
    description: 'Cracked leaf in the rear spring assembly',
    regulation: '393.207(c)',
    severity: 'high',
    oos: false,
  },
  {
    component: 'Exhaust',
    description: 'Exhaust leak forward of the sleeper',
    regulation: '393.83',
    severity: 'medium',
    oos: false,
  },
  {
    component: 'Windshield',
    description: 'Crack in the driver sweep area',
    regulation: '393.60(c)',
    severity: 'medium',
    oos: false,
  },
  {
    component: 'Wipers',
    description: 'Wiper blade torn, driver side',
    regulation: '393.78',
    severity: 'low',
    oos: false,
  },
  {
    component: 'Mirrors',
    description: 'Passenger side convex mirror cracked',
    regulation: '393.80',
    severity: 'low',
    oos: false,
  },
  {
    component: 'Frame',
    description: 'Surface corrosion at the crossmember weld',
    regulation: '393.201(a)',
    severity: 'medium',
    oos: false,
  },
];

/** Real FMCSA violation codes, in the BASIC each one lands in. */
const VIOLATION_CATALOG: ReadonlyArray<{
  category: ViolationCategory;
  code: string;
  description: string;
  severity: ViolationSeverity;
  points: number;
}> = [
  {
    category: 'hos',
    code: '395.8(a)',
    description: "Driver's record of duty status not current",
    severity: 'high',
    points: 5,
  },
  {
    category: 'hos',
    code: '395.3(a)(2)',
    description: 'Driving beyond the 14-hour duty period',
    severity: 'critical',
    points: 7,
  },
  {
    category: 'hos',
    code: '395.3(b)',
    description: 'Driving beyond the 60/70-hour limit',
    severity: 'high',
    points: 7,
  },
  {
    category: 'unsafe_driving',
    code: '392.2-SLLS2',
    description: 'Speeding 6–10 mph over the posted limit',
    severity: 'medium',
    points: 4,
  },
  {
    category: 'unsafe_driving',
    code: '392.2FC',
    description: 'Following too closely',
    severity: 'high',
    points: 5,
  },
  {
    category: 'unsafe_driving',
    code: '392.16',
    description: 'Failing to use a seat belt while operating a commercial vehicle',
    severity: 'medium',
    points: 7,
  },
  {
    category: 'vehicle_maintenance',
    code: '393.75(a)',
    description: 'Flat tire or fabric exposed',
    severity: 'critical',
    points: 8,
  },
  {
    category: 'vehicle_maintenance',
    code: '396.3(a)(1)',
    description: 'Inspection, repair and maintenance parts and accessories',
    severity: 'high',
    points: 4,
  },
  {
    category: 'vehicle_maintenance',
    code: '393.9',
    description: 'Inoperable required lamp',
    severity: 'medium',
    points: 6,
  },
  {
    category: 'driver_fitness',
    code: '391.41(a)',
    description: 'Operating without a valid medical certificate',
    severity: 'critical',
    points: 1,
  },
  {
    category: 'driver_fitness',
    code: '383.23(a)(2)',
    description: 'Operating a commercial vehicle without a valid CDL',
    severity: 'critical',
    points: 8,
  },
  {
    category: 'controlled_substances',
    code: '392.5(a)(1)',
    description: 'Possession or use of alcohol while on duty',
    severity: 'critical',
    points: 10,
  },
];

const WEATHER = ['Clear', 'Rain', 'Snow', 'Fog', 'Overcast', 'High wind'];
const ROAD = ['Dry', 'Wet', 'Icy', 'Snow covered', 'Under construction'];
const TRAFFIC = ['Light', 'Moderate', 'Heavy', 'Stop and go'];

const ACCIDENT_KINDS: readonly AccidentKind[] = [
  'collision',
  'rear_end',
  'side_impact',
  'backing',
  'rollover',
  'jackknife',
  'fixed_object',
  'cargo_loss',
  'weather',
  'mechanical',
  'animal_strike',
];

const AGENCIES = [
  'Illinois State Police',
  'Indiana State Police',
  'Ohio State Highway Patrol',
  'Texas DPS',
  'Missouri State Highway Patrol',
  'Tennessee Highway Patrol',
];

const INSURERS = ['Great West Casualty', 'Sentry Insurance', 'Progressive Commercial'];

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

/**
 * Builds the Safety records.
 *
 * `now` is passed in rather than read from the clock, so the same seed produces the same fleet on
 * every run and the tests can trust the dates.
 */
export function buildSafety(rng: Rng, input: SafetySeedInput): SafetyData {
  const { trucks, trailers, drivers, loads, users, now } = input;
  const nowMs = now.getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const safetyUsers = users.filter((u) => u.department === 'safety');
  const owners = safetyUsers.length > 0 ? safetyUsers : users.slice(0, 2);

  const activeTrucks = trucks.filter((t) => t.status !== 'sold');
  const activeDrivers = drivers.filter((d) => d.status !== 'terminated');

  const inspections: Inspection[] = [];
  const defects: Defect[] = [];
  const violations: Violation[] = [];
  const accidents: Accident[] = [];
  const claims: Claim[] = [];
  const correctiveActions: CorrectiveAction[] = [];

  let defectSeq = 0;
  let violationSeq = 0;
  let actionSeq = 0;

  const raiseAction = (
    subjectType: CorrectiveAction['subjectType'],
    subjectId: string,
    subjectLabel: string,
    title: string,
    description: string,
    severity: string,
    createdMs: number,
    resolve: boolean,
  ): CorrectiveAction => {
    actionSeq += 1;
    const assignee = rng.chance(0.75) ? rng.pick(owners) : null;
    const dueOn = proposeDueDate(severity, isoDate(createdMs));
    const dueMs = Date.parse(`${dueOn}T17:00:00Z`);
    const completed = resolve;
    const action: CorrectiveAction = {
      id: `cap_${pad(actionSeq)}`,
      actionNumber: `CAP-${pad(actionSeq)}`,
      subjectType,
      subjectId,
      subjectLabel,
      title,
      description,
      assigneeId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? null,
      priority: severity === 'critical' ? 'urgent' : severity === 'high' ? 'high' : 'normal',
      status: completed ? 'completed' : assignee && rng.chance(0.4) ? 'in_progress' : 'open',
      dueAt: iso(dueMs),
      completedAt: completed ? iso(Math.min(nowMs, dueMs - rng.int(0, 3) * DAY)) : null,
      resolution: completed ? 'Repair completed and verified by the shop foreman.' : null,
      createdAt: iso(createdMs),
      createdBy: rng.pick(owners).name,
    };
    correctiveActions.push(action);
    return action;
  };

  // ----- Inspections and the defects they raise -------------------------------------------------
  // A mix a real desk sees: routine pre-trips that pass, annual DOT inspections, and roadside
  // stops — which are the ones that produce violations.
  const inspectionPlan: ReadonlyArray<{ kind: InspectionKind; count: number; failRate: number }> = [
    { kind: 'annual_dot', count: 14, failRate: 0.25 },
    { kind: 'roadside', count: 18, failRate: 0.45 },
    { kind: 'pre_trip', count: 22, failRate: 0.12 },
    { kind: 'post_trip', count: 10, failRate: 0.1 },
    { kind: 'other', count: 4, failRate: 0.2 },
  ];

  let inspectionSeq = 0;
  for (const plan of inspectionPlan) {
    for (let i = 0; i < plan.count; i += 1) {
      inspectionSeq += 1;
      const truck = rng.pick(activeTrucks);
      const driver =
        truck.currentDriverId !== null
          ? (drivers.find((d) => d.id === truck.currentDriverId) ?? rng.pick(activeDrivers))
          : rng.pick(activeDrivers);
      const trailer: Trailer | undefined = rng.chance(0.6) ? rng.pick(trailers) : undefined;

      // Most inspections are in the past; a handful are booked ahead, and a couple were booked and
      // missed — which is exactly what the exception queue should surface.
      const scheduledAhead = plan.kind === 'annual_dot' && i < 3;
      const missed = plan.kind === 'annual_dot' && i === 3;
      const atMs = scheduledAhead
        ? nowMs + rng.int(2, 21) * DAY
        : missed
          ? nowMs - rng.int(3, 12) * DAY
          : nowMs - rng.int(1, 150) * DAY;

      const performed = !scheduledAhead && !missed;
      const failed = performed && rng.chance(plan.failRate);
      const inspectionId = `insp_${pad(inspectionSeq)}`;
      const location = truck.location
        ? { city: truck.location.city, state: truck.location.state }
        : null;

      const raised: Defect[] = [];
      if (failed) {
        const findings = rng.int(1, 4);
        const chosen = rng.shuffle(DEFECT_CATALOG).slice(0, findings);
        for (const finding of chosen) {
          defectSeq += 1;
          // Older defects have mostly been fixed; recent ones are still open, which is what makes
          // the queue reflect a working week rather than a backlog of everything ever found.
          const ageDays = Math.max(0, Math.round((nowMs - atMs) / DAY));
          const resolved = ageDays > 21 ? rng.chance(0.85) : rng.chance(0.35);
          const reportedAt = atMs + rng.int(10, 90) * MINUTE;
          const defect: Defect = {
            id: `def_${pad(defectSeq)}`,
            defectNumber: `DEF-${pad(defectSeq)}`,
            assetType: 'truck',
            assetId: truck.id,
            unitNumber: truck.unitNumber,
            source: 'inspection',
            inspectionId,
            severity: finding.severity,
            component: finding.component,
            description: finding.description,
            regulation: finding.regulation,
            status: resolved ? 'resolved' : rng.chance(0.3) ? 'scheduled' : 'open',
            repairOrderId: null,
            reportedAt: iso(reportedAt),
            resolvedAt: resolved ? iso(Math.min(nowMs, reportedAt + rng.int(1, 10) * DAY)) : null,
            dueOn: proposeDueDate(finding.severity, isoDate(reportedAt)),
            outOfService: finding.oos,
            notes: null,
          };
          defects.push(defect);
          raised.push(defect);

          if (!resolved && (finding.severity === 'critical' || finding.severity === 'high')) {
            raiseAction(
              'defect',
              defect.id,
              defect.defectNumber,
              `Repair: ${finding.component.toLowerCase()}`,
              finding.description,
              finding.severity,
              reportedAt,
              false,
            );
          }
        }
      }

      const outOfService = raised.some((d) => d.outOfService && d.status !== 'resolved');

      inspections.push({
        id: inspectionId,
        inspectionNumber: `INS-2026-${pad(inspectionSeq)}`,
        assetType: 'truck',
        assetId: truck.id,
        unitNumber: truck.unitNumber,
        kind: plan.kind,
        at: iso(atMs),
        inspector:
          plan.kind === 'roadside'
            ? `Officer ${rng.pick(['Reyes', 'Nolan', 'Whitfield', 'Barnes', 'Okafor'])}`
            : rng.pick(['M. Delgado', 'T. Boone', 'R. Kaminski', 'D. Osei']),
        inspectorAgency: plan.kind === 'roadside' ? rng.pick(AGENCIES) : null,
        location,
        result: performed ? (failed ? 'fail' : 'pass') : null,
        startedAt: performed ? iso(atMs) : null,
        completedAt: performed ? iso(atMs + rng.int(25, 90) * MINUTE) : null,
        cancelledAt: null,
        driverId: driver.id,
        driverName: driver.name,
        trailerId: trailer?.id ?? null,
        trailerUnit: trailer?.unitNumber ?? null,
        odometer: truck.odometer - rng.int(0, 40_000),
        reportNumber:
          plan.kind === 'roadside'
            ? `${rng.pick(['IL', 'IN', 'OH', 'TX', 'MO', 'TN'])}${rng.int(1_000_000, 9_999_999)}`
            : null,
        level: plan.kind === 'roadside' ? (rng.pick([1, 2, 3]) as 1 | 2 | 3) : null,
        outOfService,
        notes: null,
      });

      // A roadside inspection that found something writes violations against the driver and unit.
      if (plan.kind === 'roadside' && failed) {
        const count = rng.int(1, 3);
        for (const entry of rng.shuffle(VIOLATION_CATALOG).slice(0, count)) {
          violationSeq += 1;
          const ageDays = Math.max(0, Math.round((nowMs - atMs) / DAY));
          const resolved = ageDays > 30 ? rng.chance(0.7) : rng.chance(0.25);
          const contested = !resolved && rng.chance(0.15);
          const citation = rng.chance(0.4);
          const violationId = `vio_${pad(violationSeq)}`;

          violations.push({
            id: violationId,
            violationNumber: `VIO-2026-${pad(violationSeq)}`,
            driverId: driver.id,
            driverName: driver.name,
            truckId: truck.id,
            unitNumber: truck.unitNumber,
            onDate: isoDate(atMs),
            category: entry.category,
            code: entry.code,
            description: entry.description,
            severity: entry.severity,
            points: entry.points,
            source: 'roadside',
            inspectionId,
            location,
            citationNumber: citation ? `C-${rng.int(100_000, 999_999)}` : null,
            issuingAgency: citation ? rng.pick(AGENCIES) : null,
            fineAmount: citation ? rng.int(75, 1_450) : null,
            courtDate: citation && rng.chance(0.5) ? isoDate(atMs + rng.int(20, 60) * DAY) : null,
            disposition: resolved && citation ? rng.pick(['Paid', 'Dismissed', 'Reduced']) : null,
            contested,
            resolvedAt: resolved ? iso(Math.min(nowMs, atMs + rng.int(5, 40) * DAY)) : null,
            notes: null,
          });

          if (!resolved && (entry.severity === 'critical' || entry.severity === 'high')) {
            raiseAction(
              'violation',
              violationId,
              `VIO-2026-${pad(violationSeq)}`,
              `Corrective action: ${entry.category.replace(/_/g, ' ')}`,
              entry.description,
              entry.severity,
              atMs,
              false,
            );
          }
        }
      }
    }
  }

  // A few violations come from inside the company rather than the roadside — a supervisor ride-along
  // or a telematics review. They carry no inspection and no citation.
  for (let i = 0; i < 8; i += 1) {
    violationSeq += 1;
    const driver = rng.pick(activeDrivers);
    const truck =
      activeTrucks.find((t) => t.id === driver.currentTruckId) ?? rng.pick(activeTrucks);
    const entry = rng.pick(
      VIOLATION_CATALOG.filter((v) => v.category === 'unsafe_driving' || v.category === 'hos'),
    );
    const onMs = nowMs - rng.int(1, 90) * DAY;
    const resolved = rng.chance(0.5);
    violations.push({
      id: `vio_${pad(violationSeq)}`,
      violationNumber: `VIO-2026-${pad(violationSeq)}`,
      driverId: driver.id,
      driverName: driver.name,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      onDate: isoDate(onMs),
      category: entry.category,
      code: entry.code,
      description: entry.description,
      severity: entry.severity,
      // A company-recorded finding carries no FMCSA weight: it never went on a roadside report.
      points: null,
      source: 'company',
      inspectionId: null,
      location: truck.location ? { city: truck.location.city, state: truck.location.state } : null,
      citationNumber: null,
      issuingAgency: null,
      fineAmount: null,
      courtDate: null,
      disposition: null,
      contested: false,
      resolvedAt: resolved ? iso(Math.min(nowMs, onMs + rng.int(2, 20) * DAY)) : null,
      notes: 'Recorded during an internal safety review.',
    });
  }

  // ----- Accidents ------------------------------------------------------------------------------
  const accidentPlan: ReadonlyArray<{
    severity: AccidentSeverity;
    count: number;
    preventable: Preventability | 'mixed';
  }> = [
    { severity: 'minor', count: 6, preventable: 'mixed' },
    { severity: 'moderate', count: 4, preventable: 'mixed' },
    { severity: 'serious', count: 2, preventable: 'mixed' },
    { severity: 'critical', count: 1, preventable: 'undetermined' },
  ];

  let accidentSeq = 0;
  let claimSeq = 0;

  for (const plan of accidentPlan) {
    for (let i = 0; i < plan.count; i += 1) {
      accidentSeq += 1;
      const driver = rng.pick(activeDrivers);
      const truck =
        activeTrucks.find((t) => t.id === driver.currentTruckId) ?? rng.pick(activeTrucks);
      const trailer = rng.chance(0.75) ? rng.pick(trailers) : null;
      const load = rng.chance(0.6) ? rng.pick(loads) : null;
      const atMs = nowMs - rng.int(2, 300) * DAY;
      const ageDays = Math.round((nowMs - atMs) / DAY);
      const serious = plan.severity === 'serious' || plan.severity === 'critical';

      const fatalities = plan.severity === 'critical' && rng.chance(0.3) ? 1 : 0;
      const injuryCount = serious ? rng.int(1, 2) : rng.chance(0.2) ? 1 : 0;
      const injuries = Array.from({ length: injuryCount }, (_, n) => ({
        id: `inj_${pad(accidentSeq)}_${n + 1}`,
        person: n === 0 ? driver.name : 'Third party occupant',
        role: (n === 0 ? 'driver' : 'third_party') as 'driver' | 'third_party',
        injuryType: rng.pick(['Soft tissue', 'Laceration', 'Fracture', 'Concussion']),
        treatedAwayFromScene: serious || rng.chance(0.5),
        hospital: serious
          ? rng.pick(['Mercy Regional', 'St. Anthony', 'Baylor Scott & White'])
          : null,
        workersCompClaim: n === 0 && serious ? `WC-${rng.int(10_000, 99_999)}` : null,
        notes: null,
      }));

      const towed = serious || rng.chance(0.25);
      const recordability = dotRecordable({
        fatalities,
        injuriesTreatedAway: injuries.filter((inj) => inj.treatedAwayFromScene).length,
        towedFromScene: towed,
      });

      // Older files have been worked through; recent ones are still open, and a couple sit with no
      // owner and no preventability decision — the state the exception queue exists to find.
      const closed = ageDays > 120 && rng.chance(0.8);
      const status = closed
        ? ('closed' as const)
        : ageDays > 60
          ? rng.pick(['safety_review', 'management_review', 'pending_documents'] as const)
          : ageDays > 14
            ? rng.pick(['investigating', 'pending_documents'] as const)
            : rng.pick(['reported', 'under_review'] as const);

      const unowned = !closed && rng.chance(0.25);
      const owner = unowned ? null : rng.pick(owners);
      const preventable: Preventability =
        plan.preventable === 'undetermined'
          ? 'undetermined'
          : closed
            ? rng.pick(['yes', 'no'] as const)
            : rng.chance(0.45)
              ? rng.pick(['yes', 'no'] as const)
              : 'undetermined';

      const evidence: EvidenceKind[] = ['driver_statement'];
      if (rng.chance(0.7)) evidence.push('photos');
      if (recordability.recordable && rng.chance(0.6)) evidence.push('police_report');
      if (rng.chance(0.4)) evidence.push('dashcam');
      if (serious && rng.chance(0.5)) evidence.push('witness_statement');
      if (rng.chance(0.5)) evidence.push('repair_estimate');

      const estimate = serious ? rng.int(18_000, 140_000) : rng.int(1_200, 16_000);
      const accidentId = `acc_${pad(accidentSeq)}`;
      const accidentNumber = `ACC-2026-${pad(accidentSeq)}`;

      let claimId: string | null = null;
      if (serious || rng.chance(0.4)) {
        claimSeq += 1;
        claimId = `clm_${pad(claimSeq)}`;
        const customer = load ? { id: load.customerId, name: load.customerName } : null;
        const paid = closed ? rng.int(0, estimate) : rng.chance(0.4) ? rng.int(0, estimate / 2) : 0;
        claims.push({
          id: claimId,
          claimNumber: `CLM-2026-${pad(claimSeq)}`,
          accidentId,
          accidentNumber,
          kind:
            injuries.length > 0 ? 'liability' : rng.chance(0.5) ? 'physical_damage' : 'liability',
          insurer: rng.pick(INSURERS),
          insurerClaimNumber: rng.chance(0.7) ? `GW${rng.int(100_000, 999_999)}` : null,
          status: closed
            ? rng.pick(['settled', 'closed', 'denied'] as const)
            : rng.pick(['submitted', 'acknowledged', 'investigating'] as const),
          // A claim that has not been reserved yet carries null, not zero: an unreserved claim is
          // an unknown liability and showing it as $0 would understate the carrier's exposure.
          reserveAmount: rng.chance(0.8) ? Math.round(estimate * rng.float(0.8, 1.4)) : null,
          paidAmount: paid,
          deductible: rng.pick([1_000, 2_500, 5_000, 10_000]),
          description: `Damage arising from ${accidentNumber}.`,
          driverId: driver.id,
          driverName: driver.name,
          truckId: truck.id,
          unitNumber: truck.unitNumber,
          trailerId: trailer?.id ?? null,
          loadId: load?.id ?? null,
          loadNumber: load?.loadNumber ?? null,
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? null,
          brokerId: load?.brokerId ?? null,
          brokerName: load?.brokerName ?? null,
          openedAt: iso(atMs + rng.int(1, 4) * DAY),
          closedAt: closed ? iso(Math.min(nowMs, atMs + rng.int(60, 180) * DAY)) : null,
          ownerId: owner?.id ?? null,
          ownerName: owner?.name ?? null,
          notes: null,
        });
      }

      const kind = rng.pick(ACCIDENT_KINDS);
      accidents.push({
        id: accidentId,
        accidentNumber,
        at: iso(atMs),
        driverId: driver.id,
        driverName: driver.name,
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        trailerId: trailer?.id ?? null,
        trailerUnit: trailer?.unitNumber ?? null,
        loadId: load?.id ?? null,
        loadNumber: load?.loadNumber ?? null,
        location: {
          city: truck.location?.city ?? 'Effingham',
          state: truck.location?.state ?? 'IL',
          highway: rng.chance(0.7) ? `I-${rng.pick([70, 65, 55, 40, 80, 44])}` : null,
        },
        kind,
        severity: plan.severity,
        description: describeAccident(kind),
        narrative: closed || ageDays > 14 ? describeNarrative(kind, driver.name) : null,
        primaryCause: closed ? rng.pick(CAUSES) : null,
        contributingFactors: closed ? rng.shuffle(FACTORS).slice(0, rng.int(1, 3)) : [],
        weather: rng.pick(WEATHER),
        roadConditions: rng.pick(ROAD),
        trafficConditions: rng.pick(TRAFFIC),
        preventable,
        preventabilityDecidedBy: preventable === 'undetermined' ? null : (owner?.name ?? null),
        preventabilityDecidedAt:
          preventable === 'undetermined' ? null : iso(Math.min(nowMs, atMs + rng.int(5, 30) * DAY)),
        dotRecordable: recordability.recordable,
        injuries,
        fatalities,
        towedFromScene: towed,
        policeReportNumber: evidence.includes('police_report')
          ? `PR-${rng.int(100_000, 999_999)}`
          : null,
        policeAgency: evidence.includes('police_report') ? rng.pick(AGENCIES) : null,
        damage: {
          truckRepairEstimate: estimate,
          truckRepairFinal: closed ? Math.round(estimate * rng.float(0.85, 1.2)) : null,
          trailerRepairEstimate: trailer && rng.chance(0.5) ? rng.int(800, 22_000) : null,
          trailerRepairFinal: null,
          cargoLossAmount: kind === 'cargo_loss' ? rng.int(4_000, 60_000) : null,
          thirdPartyEstimate: rng.chance(0.5) ? rng.int(1_500, 45_000) : null,
          propertyDamageEstimate: kind === 'fixed_object' ? rng.int(500, 18_000) : null,
          towingCost: towed ? rng.int(450, 4_800) : null,
          storageCost: towed && rng.chance(0.5) ? rng.int(200, 2_600) : null,
          otherCost: null,
        },
        status,
        ownerId: owner?.id ?? null,
        ownerName: owner?.name ?? null,
        investigationOpenedAt: owner ? iso(atMs + rng.int(1, 3) * DAY) : null,
        investigationDueOn: owner ? isoDate(atMs + rng.int(14, 45) * DAY) : null,
        rootCause: closed ? rng.pick(CAUSES) : null,
        conclusion: closed ? 'Reviewed with the driver; corrective action recorded.' : null,
        closedAt: closed ? iso(Math.min(nowMs, atMs + rng.int(40, 150) * DAY)) : null,
        evidence,
        claimId,
      });

      if (preventable === 'yes' && !closed) {
        raiseAction(
          'accident',
          accidentId,
          accidentNumber,
          'Driver coaching and re-training',
          `Preventable ${kind.replace(/_/g, ' ')} — coaching session and documented re-training.`,
          serious ? 'critical' : 'high',
          atMs + 2 * DAY,
          false,
        );
      }
    }
  }

  return { inspections, defects, violations, accidents, claims, correctiveActions };
}

const CAUSES = [
  'Following distance insufficient for conditions',
  'Speed too fast for conditions',
  'Failure to check blind spot before lane change',
  'Inadequate rear observation while backing',
  'Fatigue',
  'Improper load securement',
];

const FACTORS = [
  'Wet road surface',
  'Reduced visibility',
  'Heavy traffic',
  'Unfamiliar route',
  'Night driving',
  'Construction zone',
  'Third-party driver error',
];

function describeAccident(kind: AccidentKind): string {
  const map: Record<AccidentKind, string> = {
    collision: 'Collision with another vehicle at an intersection.',
    rear_end: 'Rear-ended a passenger vehicle in slowing traffic.',
    side_impact: 'Side impact during a lane change.',
    backing: 'Struck a fixed object while backing into a dock.',
    rollover: 'Trailer rollover on an off-ramp.',
    jackknife: 'Jackknife on a wet surface during braking.',
    fixed_object: 'Struck a guardrail on the shoulder.',
    cargo_loss: 'Load shifted and cargo was lost from the trailer.',
    weather: 'Loss of control in snow and high wind.',
    mechanical: 'Mechanical failure led to loss of control.',
    animal_strike: 'Struck a deer on a rural highway at night.',
    other: 'Incident reported by the driver.',
  };
  return map[kind];
}

function describeNarrative(kind: AccidentKind, driverName: string): string {
  return `${driverName} reported the incident by phone within the hour. ${describeAccident(kind)} Scene was photographed and a statement taken.`;
}
