/**
 * TEST-ONLY fixture loader for Accident & Claims v2 (ACCEPTANCE §0). Never imported by application code, never run
 * against production: it writes the fictional prototype seed into a dedicated company of the LOCAL test database.
 *
 * Loads what is stored so far: cases (v2 columns), units, restricted details, post-accident tests, corrective actions,
 * tasks, timeline events, downtime and case documents (P1); claims with payments, checklist and log (P2); trucks with
 * their daily contribution, trailers, shops, work orders with estimates and AP bills (P3). The investigation sub-records
 * (P4) arrive with their phase. Every row is UPSERTed to its seeded state, so a re-run resets what a test changed
 * (timeline events are append-only: they are only ever inserted).
 */
import { sql } from 'drizzle-orm';
import { safetyRules as R } from '@neway/shared';
import type { DatabaseService } from '../../src/database/database.service';
import { acctBills } from '../../src/database/schema/accounting';
import {
  accidentFactors,
  accidentFacts,
  accidentOtherVehicles,
  accidentQuestions,
  accidentRestricted,
  accidentReviewItems,
  accidentStatements,
  accidentUnits,
  accidentWitnesses,
  downtimePeriods,
  safetyClaimDocuments,
  safetyClaimLog,
  safetyDocumentVersions,
  safetyTaskUpdates,
  safetyTasks,
  safetyTimelineEvents,
  workOrderEstimates,
} from '../../src/database/schema/accidents-v2';
import { trailers, vendors, workOrders } from '../../src/database/schema/fleet';
import { companies, trucks } from '../../src/database/schema/roster';
import { drugAlcoholTests, safetyAccidents, safetyCaseDocuments, safetyClaimPayments, safetyClaims, safetyReviews } from '../../src/database/schema/safety';
import { LEGACY_KIND, legacyStageFor } from '../../src/modules/safety/accidents-v2/mapping';
import { seedState } from '../../../../packages/shared/src/safety-rules/test-fixtures/seed';

type Db = DatabaseService['db'];

export const FIXTURE_COMPANY = 'co_acc2_fixtures';
export const FIXTURE_CLOCK = new Date('2026-10-19T17:00:00Z');

/** Fixture ids are prefixed so they can never collide with real rows. */
export const fx = (id: string) => `fx2_${id}`;

/** The seed restricted to what is stored so far (P1, P2 claims, P3 work orders and bills) — the reference the API is compared with. */
export function p1Seed(): R.SafetyRulesState {
  // Since P4 everything the seed holds is stored, so the reference is the whole seed.
  return seedState();
}

/**
 * Cutover C1 (many claims per accident) on the LOCAL test database only — the fixture has three claims on ACC-2026-015.
 * Refuses anything but a localhost DATABASE_URL (cutover steps never run elsewhere without the owner).
 */
export async function applyLocalCutoverC1(db: Db): Promise<void> {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x@nowhere/x').hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Cutover C1 runs only on a local test database');
  // The statement of cutover step C1 (the step file itself now also writes the runner's change log).
  await db.execute(sql.raw('DROP INDEX IF EXISTS "safety_claims_accident_key"'));
}

/** Upserts every column of a row (resets a fixture to its seeded state). */
function excludedAll(table: Record<string, unknown>, keys: string[]) {
  const set: Record<string, unknown> = {};
  for (const k of keys) set[k] = sql.raw(`excluded."${(table[k] as { name: string }).name}"`);
  return set;
}

export async function loadAccidentFixtures(db: Db, opts: { company?: string; prefix?: string } = {}): Promise<R.SafetyRulesState> {
  const C = opts.company ?? FIXTURE_COMPANY;
  const X = (id: string) => `${opts.prefix ?? 'fx2_'}${id}`;
  const s = seedState();
  const name = (id?: string) => (id ? (R.byId(s.people, id)?.name ?? id) : null);
  await applyLocalCutoverC1(db);
  await db.insert(companies).values({ id: C, name: 'Accidents v2 fixtures (TEST, fictional)', timezone: 'America/New_York', weekStart: 'monday' }).onConflictDoNothing();

  for (const c of s.cases) {
    const truck = R.byId(s.trucks, c.truckId);
    const trailer = R.byId(s.trailers, c.trailerId);
    const driver = R.byId(s.drivers, c.driverId);
    const load = R.byId(s.loads, c.loadId);
    const row: typeof safetyAccidents.$inferInsert = {
      id: X(c.id),
      companyId: C,
      number: c.number,
      ownerId: c.ownerId,
      ownerName: name(c.ownerId),
      isTest: false,
      createdBy: name(c.createdBy) ?? '',
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
      version: c.version,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      occurredAt: new Date(c.occurredAt),
      location: [c.location.road, c.location.city, c.location.state].filter(Boolean).join(', '),
      city: c.location.city,
      state: c.location.state,
      driverId: c.driverId ? X(c.driverId) : null,
      driverName: driver?.name ?? null,
      truckId: c.truckId ? X(c.truckId) : null,
      truckNumber: truck?.unit ?? null,
      trailerId: c.trailerId ? X(c.trailerId) : null,
      trailerNumber: trailer?.unit ?? null,
      loadId: c.loadId ? X(c.loadId) : null,
      loadNumber: load?.number ?? null,
      description: c.description,
      stage: c.stage,
      fault: c.determinations.fault.value,
      preventability: c.determinations.preventability.value,
      preventabilityNote: c.determinations.preventability.basis ?? null,
      policeReportNumber: c.police.reportNumber ?? null,
      citationAt: c.citation.issuedAt ? new Date(c.citation.issuedAt) : null,
      citationNote: c.citation.note ?? null,
      closedAt: c.closure ? new Date(c.closure.at) : null,
      closedBy: c.closure ? name(c.closure.by) : null,
      closeKind: c.closure ? 'normal' : null,
      closeReason: null,
      occurredTz: c.tz,
      timeProvenance: c.timeProvenance,
      submittedAt: c.submittedAt ? new Date(c.submittedAt) : null,
      locationRoad: c.location.road ?? null,
      locationDetail: c.location.detail ?? null,
      latitude: c.location.lat !== undefined ? String(c.location.lat) : null,
      longitude: c.location.lng !== undefined ? String(c.location.lng) : null,
      publicRoad: c.location.publicRoad,
      locationProvenance: c.locationProvenance,
      accidentType: c.type,
      descriptionProvenance: c.descriptionProvenance,
      severity: c.severity,
      severityManualReason: c.severityManual?.reason ?? null,
      severityManualBy: c.severityManual ? name(c.severityManual.by) : null,
      assignmentSource: c.assignmentSource ?? null,
      injuriesStatus: c.injuries.status,
      injuriesProvenance: c.injuries.provenance,
      ourDriverInjured: c.injuries.ourDriver,
      treatedAwayCount: c.injuries.treatedAway,
      fatalitiesCount: c.injuries.fatalities,
      towAway: c.towAway,
      towProvenance: c.towProvenance,
      citationStatus: c.citation.status,
      hazmatReleased: c.hazmat,
      excludedOccurrence: c.excludedOccurrence ?? null,
      policeResponded: c.police.responded,
      policeDepartment: c.police.dept ?? null,
      weather: c.conditions.weather ?? null,
      roadSurface: c.conditions.road ?? null,
      lightCondition: c.conditions.light ?? null,
      cargoStatus: c.cargo.status,
      cargoPlan: c.cargo.plan ?? null,
      cargoNotes: c.cargo.notes ?? null,
      cargoDeliveryImpact: c.cargo.deliveryImpact ?? null,
      brokerNotified: c.cargo.brokerNotified ?? null,
      initialEstimateCents: c.initialEstimateCents ?? null,
      immediateActions: c.immediate,
      investigationStatus: c.investigation.status,
      investigationOwnerId: c.investigation.ownerId ?? null,
      investigationConclusion: c.investigation.conclusion ?? null,
      investigationSubmittedBy: name(c.investigation.submittedBy),
      investigationSubmittedAt: c.investigation.submittedAt ? new Date(c.investigation.submittedAt) : null,
      investigationApprovedBy: name(c.investigation.approvedBy),
      investigationCompletedAt: c.investigation.completedAt ? new Date(c.investigation.completedAt) : null,
      faultBasis: c.determinations.fault.basis ?? null,
      faultBy: name(c.determinations.fault.by),
      cpdpStatus: c.determinations.cpdp.value,
      cpdpRdr: c.determinations.cpdp.rdr ?? null,
      cpdpBasis: c.determinations.cpdp.basis ?? null,
      summaryOverrideText: c.summaryOverride?.text ?? null,
      summaryOverrideBy: c.summaryOverride ? name(c.summaryOverride.by) : null,
      summaryOverrideAt: c.summaryOverride ? new Date(c.summaryOverride.at) : null,
      summaryFactsHash: c.summaryOverride?.factsHash ?? null,
      claimDecisionText: c.claimDecision?.text ?? null,
      claimDecisionBy: c.claimDecision ? name(c.claimDecision.by) : null,
      claimDecisionAt: c.claimDecision ? new Date(c.claimDecision.at) : null,
      legalHoldSince: c.legalHold ? new Date(c.legalHold.since) : null,
      legalHoldBy: c.legalHold ? name(c.legalHold.by) : null,
      legalHoldReason: c.legalHold?.reason ?? null,
      closeOutcome: c.closure?.outcome ?? null,
      closePrevention: c.closure?.prevention ?? null,
      closeOverrideReason: c.closure?.override?.reason ?? null,
      closeOverrideBy: c.closure?.override ? name(c.closure.override.by) : null,
      closeSkippedBlockers: null,
    };
    const keys = Object.keys(row).filter((k) => k !== 'id');
    await db
      .insert(safetyAccidents)
      .values(row)
      .onConflictDoUpdate({ target: safetyAccidents.id, set: excludedAll(safetyAccidents as unknown as Record<string, unknown>, keys) });

    const units: (typeof accidentUnits.$inferInsert)[] = [];
    const unit = (kind: 'truck' | 'trailer', unitId: string, unitNumber: string, e: R.EquipmentState) =>
      units.push({
        id: X(`${c.id}_${kind}`),
        companyId: C,
        accidentId: X(c.id),
        unitKind: kind,
        unitId: X(unitId),
        unitNumber,
        conditionAtScene: e.condition,
        status: e.status,
        damage: e.damage || null,
        towCompany: e.towCompany ?? null,
        towedTo: e.towedTo ?? null,
        storageRateCents: e.storageRatePerDayCents ?? null,
        storageSince: e.storageSince ? new Date(e.storageSince) : null,
        returnedToServiceAt: e.rtsAt ? new Date(e.rtsAt) : null,
        version: 1,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
      });
    if (c.truckId && truck) unit('truck', c.truckId, truck.unit, c.equipment.truck);
    if (c.trailerId && trailer && c.equipment.trailer) unit('trailer', c.trailerId, trailer.unit, c.equipment.trailer);
    for (const u of units) {
      await db
        .insert(accidentUnits)
        .values(u)
        .onConflictDoUpdate({ target: accidentUnits.id, set: excludedAll(accidentUnits as unknown as Record<string, unknown>, Object.keys(u).filter((k) => k !== 'id')) });
    }

    if (c.injuries.detailsRestricted || c.determinations.legal.value !== 'unknown') {
      const r: typeof accidentRestricted.$inferInsert = {
        accidentId: X(c.id),
        companyId: C,
        medicalDetails: c.injuries.detailsRestricted ?? null,
        legalLiability: c.determinations.legal.value,
        legalBasis: c.determinations.legal.basis ?? null,
        legalBy: name(c.determinations.legal.by),
        version: 1,
      };
      await db
        .insert(accidentRestricted)
        .values(r)
        .onConflictDoUpdate({ target: accidentRestricted.accidentId, set: excludedAll(accidentRestricted as unknown as Record<string, unknown>, Object.keys(r).filter((k) => k !== 'accidentId')) });
    }

    for (const sub of ['alcohol', 'drug'] as const) {
      const t = c.testing[sub];
      if (t.decision === 'auto' && !t.administeredAt && !t.notAdministeredReason && !t.delayReason && !t.resultRestricted) continue;
      const tr: typeof drugAlcoholTests.$inferInsert = {
        id: X(`${c.id}_${sub}`),
        companyId: C,
        number: `FX-${c.number}-${sub === 'alcohol' ? 'A' : 'D'}`,
        isTest: false,
        createdBy: 'fixture',
        testType: 'post_accident',
        substance: sub,
        driverId: c.driverId ? X(c.driverId) : null,
        driverName: driver?.name ?? null,
        accidentId: X(c.id),
        accidentNumber: c.number,
        required: true,
        occurredAt: new Date(c.occurredAt),
        collectedAt: t.administeredAt ? new Date(t.administeredAt) : null,
        result: t.resultRestricted ? 'negative' : 'pending',
        notCompletedReason: t.notAdministeredReason ?? null,
        lateReason: t.delayReason ?? null,
        postAccidentDecision: t.decision,
        version: 1,
        voidedAt: null,
      };
      await db
        .insert(drugAlcoholTests)
        .values(tr)
        .onConflictDoUpdate({ target: drugAlcoholTests.id, set: excludedAll(drugAlcoholTests as unknown as Record<string, unknown>, Object.keys(tr).filter((k) => k !== 'id')) });
    }

    for (const a of c.correctiveActions) {
      const rv: typeof safetyReviews.$inferInsert = {
        id: X(`${c.id}_${a.id}`),
        companyId: C,
        number: `FX-${c.number}-${a.id}`,
        isTest: false,
        createdBy: 'fixture',
        kind: a.kind === 'Coaching' ? 'coaching' : 'corrective_action',
        reason: a.title,
        driverId: a.driverId ? X(a.driverId) : null,
        driverName: a.driverId ? (R.byId(s.drivers, a.driverId)?.name ?? null) : null,
        status: a.status === 'Completed' ? 'completed' : a.status === 'In progress' ? 'in_progress' : 'not_started',
        completedAt: a.completedAt ? new Date(a.completedAt) : null,
        evidenceNote: a.evidence ?? null,
        accidentId: X(c.id),
        actionKind: a.kind,
        dueAt: new Date(a.due),
        assigneeId: a.assigneeId,
        assigneeName: name(a.assigneeId),
        restricted: Boolean(a.restricted),
        version: 1,
        voidedAt: null,
      };
      await db
        .insert(safetyReviews)
        .values(rv)
        .onConflictDoUpdate({ target: safetyReviews.id, set: excludedAll(safetyReviews as unknown as Record<string, unknown>, Object.keys(rv).filter((k) => k !== 'id')) });
    }
  }

  // ---- P2: claims, one per coverage line (needs cutover C1 applied to this LOCAL database: two claims on one case).
  // ---- P3: trucks (with their daily contribution for lost revenue), trailers, shops, work orders, estimates, AP bills.
  for (const [i, t] of s.trucks.entries()) {
    const tr: typeof trucks.$inferInsert = {
      id: X(t.id),
      companyId: C,
      unitNumber: t.unit,
      vin: `FX${t.unit}${C.slice(-6).toUpperCase()}VIN${i}`.slice(0, 17),
      year: t.year,
      make: t.make,
      model: t.model,
      status: 'active',
      health: 'good',
      ownership: 'company',
      odometer: 100000,
      odometerAt: new Date('2026-10-01T00:00:00Z'),
      engineHours: '1000',
      nextServiceOdometer: 110000,
      nextServiceDate: '2026-12-01',
      nextServiceType: 'PM A',
      telematicsProvider: 'none',
      telematicsStatus: 'none',
      dailyContributionCents: t.dailyContributionCents ?? null,
    };
    await db
      .insert(trucks)
      .values(tr)
      .onConflictDoUpdate({ target: trucks.id, set: { unitNumber: tr.unitNumber, dailyContributionCents: tr.dailyContributionCents } });
  }
  for (const t of s.trailers) {
    await db.insert(trailers).values({ id: X(t.id), companyId: C, unitNumber: t.unit }).onConflictDoNothing();
  }
  const shops = [...new Set([...s.workOrders.map((w) => w.shop), ...s.bills.map((b) => b.vendor)])];
  const vendorId = (name: string) => X(`vnd_${shops.indexOf(name)}`);
  for (const name of shops) {
    await db.insert(vendors).values({ id: vendorId(name), companyId: C, name, kind: 'shop', paymentTermsDays: 30, status: 'active', source: 'user' }).onConflictDoNothing();
  }
  for (const w of s.workOrders) {
    const unit = w.unitKind === 'truck' ? R.byId(s.trucks, w.unitId)?.unit : R.byId(s.trailers, w.unitId)?.unit;
    const stage = w.status === 'Completed' ? null : w.status === 'In repair' ? 'in_repair' : w.status === 'Waiting for approval' ? 'waiting_approval' : w.status === 'Approved' ? 'waiting_parts' : 'diagnosing';
    const opened = new Date(w.openedAt);
    const wr: typeof workOrders.$inferInsert = {
      id: X(w.id),
      companyId: C,
      number: w.number,
      assetType: w.unitKind,
      unitId: X(w.unitId),
      unitNumber: unit ?? '',
      status: w.status === 'Completed' ? 'completed' : 'in_shop',
      shopStage: stage,
      workType: w.type === 'Accident repair' ? 'accident_repair' : 'repair',
      title: w.title,
      workDone: w.status === 'Completed' ? w.title : null,
      shopInAt: new Date(w.shopInAt ?? w.openedAt),
      completedAt: w.completedAt ? new Date(w.completedAt) : null,
      vendorId: vendorId(w.shop),
      vendorName: w.shop,
      invoiceNumber: w.invoiceNumber ?? null,
      invoiceTotal: w.invoiceTotalCents !== undefined ? (w.invoiceTotalCents / 100).toFixed(2) : null,
      total: w.invoiceTotalCents !== undefined ? (w.invoiceTotalCents / 100).toFixed(2) : '0',
      enteredVia: 'migration',
      voidedAt: null,
      createdBy: name(w.createdBy) ?? 'fixture',
      createdAt: opened,
      updatedAt: opened,
      accidentId: w.caseId ? X(w.caseId) : null,
      estimatesRequired: w.estimatesRequired,
      approvedCents: w.approvedAmountCents ?? null,
      approvedBy: w.approvedBy ? name(w.approvedBy) : null,
      approvedAt: w.approvedAmountCents ? opened : null,
      eta: w.eta ? new Date(w.eta) : null,
    };
    await db
      .insert(workOrders)
      .values(wr)
      .onConflictDoUpdate({ target: workOrders.id, set: excludedAll(workOrders as unknown as Record<string, unknown>, Object.keys(wr).filter((x) => x !== 'id')) });
    for (const e of w.estimates) {
      const er: typeof workOrderEstimates.$inferInsert = { id: X(`${w.id}_${e.id}`), companyId: C, workOrderId: X(w.id), vendor: e.vendor, amountCents: e.amountCents, receivedAt: new Date(e.at), selected: Boolean(e.selected), createdBy: 'fixture' };
      await db
        .insert(workOrderEstimates)
        .values(er)
        .onConflictDoUpdate({ target: workOrderEstimates.id, set: excludedAll(workOrderEstimates as unknown as Record<string, unknown>, Object.keys(er).filter((x) => x !== 'id')) });
    }
  }
  for (const b of s.bills) {
    const issued = R.isoToLocalInput(b.date, R.EASTERN).slice(0, 10);
    const status = b.status === 'Paid' ? 'paid' : b.status === 'Approved' ? 'approved' : 'open';
    const br: typeof acctBills.$inferInsert = {
      id: X(b.id),
      companyId: C,
      billNumber: b.number,
      vendorId: vendorId(b.vendor),
      status,
      dueOn: issued,
      amountCents: b.amountCents,
      balanceCents: b.status === 'Paid' ? 0 : b.amountCents,
      source: b.woId ? 'repair_order' : 'manual',
      sourceKey: b.woId ? `repair_order:${X(b.woId)}` : `manual:${X(b.id)}`,
      truckId: null,
      loadId: null,
      record: { id: X(b.id), billNumber: b.number, vendorId: vendorId(b.vendor), vendorName: b.vendor, issuedOn: issued, status, amount: b.amountCents / 100, notes: b.memo, source: b.woId ? 'repair_order' : 'manual' },
      accidentId: b.caseId ? X(b.caseId) : null,
      claimId: b.claimId ? X(b.claimId) : null,
      accidentCostCategory: b.category,
    };
    await db
      .insert(acctBills)
      .values(br)
      .onConflictDoUpdate({ target: acctBills.id, set: excludedAll(acctBills as unknown as Record<string, unknown>, Object.keys(br).filter((x) => x !== 'id')) });
  }

  for (const [ki, k] of s.claims.entries()) {
    const c = k.caseId ? R.byId(s.cases, k.caseId) : undefined;
    const load = k.loadId ? R.byId(s.loads, k.loadId) : undefined;
    const kr: typeof safetyClaims.$inferInsert = {
      id: X(k.id),
      companyId: C,
      number: k.number,
      ownerId: k.ownerId,
      ownerName: name(k.ownerId),
      isTest: false,
      createdBy: 'fixture',
      // Created in seed order (the order the reference rules read claims in); opened_at carries the real opening time.
      createdAt: new Date(Date.UTC(2025, 0, 1) + ki * 1000),
      updatedAt: new Date(k.lastUpdateAt),
      version: 1,
      voidedAt: null,
      kind: LEGACY_KIND[k.type],
      accidentId: c ? X(c.id) : null,
      accidentNumber: c?.number ?? null,
      loadId: load ? X(load.id) : null,
      loadNumber: load?.number ?? null,
      driverId: c?.driverId ? X(c.driverId) : null,
      driverName: c?.driverId ? (R.byId(s.drivers, c.driverId)?.name ?? null) : null,
      truckId: c?.truckId ? X(c.truckId) : null,
      truckNumber: c?.truckId ? (R.byId(s.trucks, c.truckId)?.unit ?? null) : null,
      description: k.title,
      insurer: k.insurer,
      insurerReference: k.insurerClaimNo ?? null,
      adjusterName: k.adjuster?.name ?? null,
      adjusterPhone: k.adjuster?.phone ?? null,
      adjusterEmail: k.adjuster?.email ?? null,
      openedOn: R.isoToLocalInput(k.openedAt, R.EASTERN).slice(0, 10),
      stage: legacyStageFor(k.status, 'opened'),
      claimedCents: k.claimedCents ?? null,
      deductibleCents: k.deductibleCents ?? null,
      closedAt: k.closedAt ? new Date(k.closedAt) : null,
      lastActivityAt: new Date(k.lastUpdateAt),
      claimType: k.type,
      status: k.status,
      title: k.title,
      standaloneKind: k.standaloneKind ?? null,
      whatWasLost: null,
      claimant: k.claimant ?? null,
      responsibleParty: k.responsibleParty ?? null,
      unitLabel: k.unitLabel ?? null,
      openedAt: new Date(k.openedAt),
      reportedToInsurerAt: k.reportedToInsurerAt ? new Date(k.reportedToInsurerAt) : null,
      reserveCents: k.reserveCents ?? null,
      settlementCents: k.settlementCents ?? null,
      disputed: Boolean(k.disputed),
      restricted: Boolean(k.restricted),
      nextFollowUpAt: k.nextFollowUp ? new Date(k.nextFollowUp.at) : null,
      nextFollowUpAssigneeId: k.nextFollowUp?.assigneeId ?? null,
      nextFollowUpAssigneeName: k.nextFollowUp ? name(k.nextFollowUp.assigneeId) : null,
      nextFollowUpWhat: k.nextFollowUp?.what ?? null,
    };
    await db
      .insert(safetyClaims)
      .values(kr)
      .onConflictDoUpdate({ target: safetyClaims.id, set: excludedAll(safetyClaims as unknown as Record<string, unknown>, Object.keys(kr).filter((x) => x !== 'id')) });
    for (const p of k.payments) {
      const pr: typeof safetyClaimPayments.$inferInsert = {
        id: X(`${k.id}_${p.id}`),
        companyId: C,
        claimId: X(k.id),
        receivedOn: R.isoToLocalInput(p.at, R.EASTERN).slice(0, 10),
        amountCents: p.amountCents,
        note: p.note ?? null,
        createdBy: 'fixture',
        createdAt: new Date(p.at),
        voidedAt: null,
        direction: p.direction,
        party: p.party,
        paidAt: new Date(p.at),
      };
      await db
        .insert(safetyClaimPayments)
        .values(pr)
        .onConflictDoUpdate({ target: safetyClaimPayments.id, set: excludedAll(safetyClaimPayments as unknown as Record<string, unknown>, Object.keys(pr).filter((x) => x !== 'id')) });
    }
    for (const [i, d] of k.docs.entries()) {
      const dr: typeof safetyClaimDocuments.$inferInsert = { id: X(`${k.id}_${d.id}`), companyId: C, claimId: X(k.id), label: d.label, received: d.received, sort: i, version: 1 };
      await db
        .insert(safetyClaimDocuments)
        .values(dr)
        .onConflictDoUpdate({ target: safetyClaimDocuments.id, set: excludedAll(safetyClaimDocuments as unknown as Record<string, unknown>, Object.keys(dr).filter((x) => x !== 'id')) });
    }
    for (const l of k.log) {
      await db
        .insert(safetyClaimLog)
        .values({ id: X(`${k.id}_${l.id}`), companyId: C, claimId: X(k.id), at: new Date(l.at), byId: l.by, byName: name(l.by) ?? l.by, channel: l.channel, text: l.text })
        .onConflictDoNothing();
    }
  }

  for (const t of s.tasks) {
    const tr: typeof safetyTasks.$inferInsert = {
      id: X(t.id),
      companyId: C,
      accidentId: t.caseId ? X(t.caseId) : null,
      claimId: t.claimId ? X(t.claimId) : null,
      title: t.title,
      dept: t.dept,
      assigneeId: t.assigneeId ?? null,
      assigneeName: name(t.assigneeId),
      dueAt: new Date(t.due),
      status: t.status,
      priority: t.priority,
      instructions: t.instructions ?? null,
      blockedReason: t.blockedReason ?? null,
      autoRule: t.auto ?? null,
      createdBy: name(t.createdBy) ?? '',
      createdAt: new Date(t.createdAt),
      completedBy: t.completedBy ? name(t.completedBy) : null,
      completedAt: t.completedAt ? new Date(t.completedAt) : null,
      version: 1,
      updatedAt: new Date(t.createdAt),
    };
    await db
      .insert(safetyTasks)
      .values(tr)
      .onConflictDoUpdate({ target: safetyTasks.id, set: excludedAll(safetyTasks as unknown as Record<string, unknown>, Object.keys(tr).filter((k) => k !== 'id')) });
    for (const u of t.updates) {
      await db
        .insert(safetyTaskUpdates)
        .values({ id: X(`${t.id}_${u.id}`), companyId: C, taskId: X(t.id), at: new Date(u.at), byId: u.by, byName: name(u.by) ?? u.by, text: u.text })
        .onConflictDoNothing();
    }
  }

  for (const d of s.downtime) {
    const dr: typeof downtimePeriods.$inferInsert = {
      id: X(d.id),
      companyId: C,
      accidentId: X(d.caseId),
      unitKind: d.unitKind,
      unitId: X(d.unitId),
      startedAt: new Date(d.start),
      endedAt: d.end ? new Date(d.end) : null,
      source: d.source === 'Daily board status' ? 'daily_board' : d.source === 'Work order' ? 'work_order' : 'entered',
      verifiedBy: d.verifiedBy ? name(d.verifiedBy) : null,
      note: d.note ?? null,
      version: 1,
    };
    await db
      .insert(downtimePeriods)
      .values(dr)
      .onConflictDoUpdate({ target: downtimePeriods.id, set: excludedAll(downtimePeriods as unknown as Record<string, unknown>, Object.keys(dr).filter((k) => k !== 'id')) });
  }

  // ---- P4: parties and investigation records (each fixture row upserted / inserted once by its fixture id).
  for (const c of s.cases) {
    const A = X(c.id);
    for (const v of c.vehicles) {
      await db
        .insert(accidentOtherVehicles)
        .values({ id: X(`${c.id}_${v.id}`), companyId: C, accidentId: A, description: v.description, ownerName: v.owner || null, driverName: v.driver ?? null, insurer: v.insurer ?? null, policyNo: v.policyNo ?? null, plate: v.plate ?? null, damage: v.damage || null, towed: v.towed, createdBy: 'fixture', createdAt: new Date(c.createdAt) })
        .onConflictDoNothing();
    }
    for (const w of c.witnesses) {
      await db
        .insert(accidentWitnesses)
        .values({ id: X(`${c.id}_${w.id}`), companyId: C, accidentId: A, name: w.name, contact: w.contact || null, note: w.note ?? null, createdBy: 'fixture', createdAt: new Date(c.createdAt) })
        .onConflictDoNothing();
    }
    for (const [i, f] of c.investigation.facts.entries()) {
      await db
        .insert(accidentFacts)
        .values({ id: X(`${c.id}_${f.id}`), companyId: C, accidentId: A, text: f.text, source: f.source, provenance: f.provenance, createdBy: name(f.by) ?? f.by, createdAt: new Date(Date.parse(f.at) + i) })
        .onConflictDoNothing();
    }
    for (const [i, q] of c.investigation.questions.entries()) {
      const qr: typeof accidentQuestions.$inferInsert = {
        id: X(`${c.id}_${q.id}`),
        companyId: C,
        accidentId: A,
        text: q.text,
        ownerId: q.ownerId ?? null,
        ownerName: name(q.ownerId),
        answer: q.answer ?? null,
        resolvedAt: q.resolvedAt ? new Date(q.resolvedAt) : null,
        resolvedBy: q.resolvedBy ? name(q.resolvedBy) : null,
        version: 1,
        createdBy: 'fixture',
        createdAt: new Date(Date.parse(q.createdAt) + i),
      };
      await db
        .insert(accidentQuestions)
        .values(qr)
        .onConflictDoUpdate({ target: accidentQuestions.id, set: excludedAll(accidentQuestions as unknown as Record<string, unknown>, Object.keys(qr).filter((x) => x !== 'id')) });
    }
    for (const st of c.investigation.statements) {
      await db
        .insert(accidentStatements)
        .values({ id: X(`${c.id}_${st.id}`), companyId: C, accidentId: A, party: st.party, kind: st.kind, takenAt: new Date(st.takenAt), takenBy: name(st.takenBy) ?? st.takenBy, summary: st.summary, documentId: st.evidenceId ? X(st.evidenceId) : null })
        .onConflictDoNothing();
    }
    for (const [i, f] of c.investigation.factors.entries()) {
      const fr: typeof accidentFactors.$inferInsert = { id: X(`${c.id}_${f.id}`), companyId: C, accidentId: A, category: f.category, label: f.label, level: f.level, version: 1, createdBy: 'fixture', createdAt: new Date(Date.parse(c.createdAt) + i) };
      await db
        .insert(accidentFactors)
        .values(fr)
        .onConflictDoUpdate({ target: accidentFactors.id, set: excludedAll(accidentFactors as unknown as Record<string, unknown>, Object.keys(fr).filter((x) => x !== 'id')) });
    }
    for (const [i, it] of c.investigation.checklist.entries()) {
      const ir: typeof accidentReviewItems.$inferInsert = { id: X(`${c.id}_rv_${it.key}`), companyId: C, accidentId: A, key: it.key, label: it.label, state: it.state, note: it.note ?? null, restricted: Boolean(it.restricted), sort: i, version: 1 };
      await db
        .insert(accidentReviewItems)
        .values(ir)
        .onConflictDoUpdate({ target: accidentReviewItems.id, set: excludedAll(accidentReviewItems as unknown as Record<string, unknown>, Object.keys(ir).filter((x) => x !== 'id')) });
    }
  }

  for (const e of s.evidence) {
    if (!e.caseId) continue;
    const doc: typeof safetyCaseDocuments.$inferInsert = {
      id: X(e.id),
      companyId: C,
      caseType: 'accident',
      caseId: X(e.caseId),
      fileId: X(`file_${e.id}`),
      fileName: e.name,
      contentType: e.kind === 'photo' ? 'image/jpeg' : e.kind === 'video' ? 'video/mp4' : 'application/pdf',
      sizeBytes: e.sizeKb * 1024,
      title: e.name,
      kind: 'other',
      category: e.category,
      description: e.description,
      restricted: Boolean(e.restricted),
      uploadedBy: e.uploadedBy,
      uploadedAt: new Date(e.uploadedAt),
      voidedAt: e.removed ? new Date(e.removed.at) : null,
      voidedBy: e.removed?.by ?? null,
      voidReason: e.removed?.reason ?? null,
      currentVersion: e.versions.length || 1,
    };
    await db
      .insert(safetyCaseDocuments)
      .values(doc)
      .onConflictDoUpdate({ target: safetyCaseDocuments.id, set: excludedAll(safetyCaseDocuments as unknown as Record<string, unknown>, Object.keys(doc).filter((k) => k !== 'id')) });
    // P4: immutable version rows (inserted once; the trigger refuses any change).
    if (e.versions.length > 1) {
      for (const v of e.versions) {
        await db
          .insert(safetyDocumentVersions)
          .values({ id: X(`${e.id}_v${v.v}`), companyId: C, documentId: X(e.id), version: v.v, fileId: X(`file_${e.id}_v${v.v}`), fileName: e.name, contentType: doc.contentType, sizeBytes: e.sizeKb * 1024, sha256: 'fixture', note: v.note, uploadedBy: v.by, uploadedAt: new Date(v.at) })
          .onConflictDoNothing();
      }
    }
  }

  for (const e of s.events) {
    if (!e.caseId) continue;
    await db
      .insert(safetyTimelineEvents)
      .values({
        id: X(e.id),
        companyId: C,
        accidentId: X(e.caseId),
        occurredAt: new Date(e.at),
        loggedAt: new Date(e.loggedAt),
        actorName: e.by,
        source: e.source,
        kind: e.kind ?? 'note',
        text: e.text,
        restricted: Boolean(e.restricted),
      })
      .onConflictDoNothing();
  }
  return s;
}
