import { describe, expect, it } from 'vitest';
import { SYSTEM_REQUIREMENTS, requirementsFor } from './catalog.js';
import type { QualificationItem } from './item.js';
import {
  CONSENT_TTL_DAYS,
  VERIFICATION_LADDER,
  type ConsentRequest,
  type VerificationCaseRecord,
} from './records.js';
import { Rng } from './rng.js';
import {
  CLEARINGHOUSE_FAILURE_NOTE,
  RECENT_HIRE_DAYS,
  WAIVER_REASON,
  buildComplianceSeed,
  type ComplianceSeedInput,
  type SeedDriver,
} from './seed.js';
import { deriveVerificationCase } from './verification.js';

const NOW = new Date('2026-09-06T14:30:00-05:00');
const TODAY = '2026-09-06';
const DAY = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** A small fleet with every case the generator distinguishes: veterans, recent hires, a sale. */
function fleet(): ComplianceSeedInput {
  const drivers: SeedDriver[] = [];
  for (let i = 0; i < 20; i += 1) {
    const recent = i < 7;
    drivers.push({
      id: `drv_${String(i + 1).padStart(3, '0')}`,
      driverNumber: `D-${2000 + i}`,
      firstName: `First${i}`,
      name: `First${i} Last${i}`,
      hireDate: recent ? addDays(TODAY, -(3 + i * 7)) : addDays(TODAY, -(400 + i * 30)),
      cdlStatus: i === 9 ? 'expiring' : i === 12 ? 'missing' : 'verified',
      cdlExpiresOn: i === 9 ? addDays(TODAY, 20) : addDays(TODAY, 400 + i * 10),
      medicalCardStatus: i === 14 ? 'missing' : 'verified',
      medicalCardExpiresOn: addDays(TODAY, 200 + i * 5),
    });
  }
  return {
    drivers,
    trucks: Array.from({ length: 24 }, (_, i) => ({
      id: `trk_${3000 + i}`,
      unitNumber: String(3000 + i),
      status: i === 3 ? 'sold' : 'active',
      inServiceDate: addDays(TODAY, -(100 + i * 40)),
    })),
    trailers: Array.from({ length: 6 }, (_, i) => ({
      id: `trl_${5300 + i}`,
      unitNumber: `T-${5300 + i}`,
      status: i === 5 ? 'sold' : 'active',
      nextInspectionDate: addDays(TODAY, 30 + i * 20),
    })),
    people: [
      { id: 'usr_006', name: 'Tom Brennan', department: 'safety' },
      { id: 'usr_010', name: 'Monica Alvarez', department: 'hr' },
      { id: 'usr_012', name: 'Robert Lindqvist', department: 'management' },
    ],
    now: NOW,
  };
}

const consentCodes = new Set(
  requirementsFor('driver', SYSTEM_REQUIREMENTS)
    .filter((r) => r.requiresConsent)
    .map((r) => r.code),
);

describe('compliance seed', () => {
  it('is deterministic for the same seed', () => {
    const a = buildComplianceSeed(new Rng(7), fleet());
    const b = buildComplianceSeed(new Rng(7), fleet());
    expect(a).toEqual(b);
    expect(buildComplianceSeed(new Rng(8), fleet())).not.toEqual(a);
  });

  it('ships the system requirement catalog', () => {
    expect(buildComplianceSeed(new Rng(7), fleet()).requirements).toEqual([...SYSTEM_REQUIREMENTS]);
  });

  it('gives every non-sold truck an item for every truck requirement, and sold trucks none', () => {
    const input = fleet();
    const out = buildComplianceSeed(new Rng(7), input);
    const truckCodes = requirementsFor('truck', SYSTEM_REQUIREMENTS).map((r) => r.code);
    const byTruck = new Map<string, Set<string>>();
    for (const item of out.items.filter((i) => i.scope === 'truck')) {
      const set = byTruck.get(item.entityId) ?? new Set<string>();
      set.add(item.requirementCode);
      byTruck.set(item.entityId, set);
    }
    for (const truck of input.trucks) {
      const codes = byTruck.get(truck.id);
      if (truck.status === 'sold') expect(codes, truck.unitNumber).toBeUndefined();
      else expect([...(codes ?? [])].sort(), truck.unitNumber).toEqual([...truckCodes].sort());
    }
  });

  it('derives cdl and medical items from the driver record', () => {
    const input = fleet();
    const out = buildComplianceSeed(new Rng(7), input);
    for (const driver of input.drivers) {
      const items = out.items.filter((i) => i.scope === 'driver' && i.entityId === driver.id);
      const cdl = items.find((i) => i.requirementCode === 'cdl');
      const medical = items.find((i) => i.requirementCode === 'medical_card');
      expect(cdl !== undefined, driver.name).toBe(driver.cdlStatus !== 'missing');
      expect(medical !== undefined, driver.name).toBe(driver.medicalCardStatus !== 'missing');
      if (cdl) {
        expect(cdl.expiresOn).toBe(driver.cdlExpiresOn);
        expect(cdl.documentId).not.toBeNull();
        expect(cdl.verifiedAt).not.toBeNull();
      }
      expect(items.find((i) => i.requirementCode === 'work_authorization')).toBeDefined();
    }
    const waived = out.items.filter((i) => i.waivedUntil !== null);
    expect(waived).toHaveLength(1);
    expect(waived[0]?.waivedReason).toBe(WAIVER_REASON);
  });

  it('references real drivers and consent-gated requirements from every consent', () => {
    const input = fleet();
    const out = buildComplianceSeed(new Rng(7), input);
    const driverIds = new Set(input.drivers.map((d) => d.id));
    expect(out.consents.length).toBe(input.drivers.length * consentCodes.size);
    for (const consent of out.consents) {
      expect(driverIds.has(consent.driverId), consent.id).toBe(true);
      expect(consentCodes.has(consent.requirementCode), consent.id).toBe(true);
      expect(consent.history[0]?.status).toBe('draft');
      expect(consent.history[consent.history.length - 1]?.status).toBe(consent.status);
      const stamps = consent.history.map((h) => h.at);
      expect(stamps).toEqual([...stamps].sort());
      const ttl = new Date(consent.expiresAt).getTime() - new Date(consent.requestedAt).getTime();
      expect(ttl).toBe(CONSENT_TTL_DAYS * DAY);
    }
  });

  it('opens a case for every driver hired within the recent window and none for veterans', () => {
    const input = fleet();
    const out = buildComplianceSeed(new Rng(7), input);
    const recent = input.drivers.filter(
      (d) => (Date.parse(TODAY) - Date.parse(d.hireDate)) / DAY <= RECENT_HIRE_DAYS,
    );
    expect(out.caseRecords.map((c) => c.driverId).sort()).toEqual(recent.map((d) => d.id).sort());
    expect(out.verificationCases).toHaveLength(out.caseRecords.length);
    // One case at every interesting stage: the plans cycle, so seven hires cover all six.
    const stages = new Set(out.verificationCases.map((c) => c.stage));
    expect(stages.has('consent')).toBe(true);
    expect(stages.has('screening')).toBe(true);
    expect(stages.has('safety_review')).toBe(true);
    expect(stages.has('active')).toBe(true);
  });

  it('records exactly one failed clearinghouse query, with its note', () => {
    const out = buildComplianceSeed(new Rng(7), fleet());
    const failed = out.items.filter((i) => i.verificationFailed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.requirementCode).toBe('clearinghouse_query');
    expect(failed[0]?.verificationNote).toBe(CLEARINGHOUSE_FAILURE_NOTE);
  });

  it('writes every audit row with a newest-first order and a known action', () => {
    const out = buildComplianceSeed(new Rng(7), fleet());
    expect(out.audit.length).toBeGreaterThan(0);
    for (let i = 1; i < out.audit.length; i += 1) {
      expect(out.audit[i - 1]!.at >= out.audit[i]!.at).toBe(true);
    }
  });
});

describe('deriveVerificationCase', () => {
  const record: VerificationCaseRecord = {
    id: 'vc_test',
    driverId: 'drv_x',
    driverName: 'Test Driver',
    openedAt: '2026-08-20T14:00:00.000Z',
    ownerId: 'usr_010',
    ownerName: 'Monica Alvarez',
    safetyReviewStatus: 'not_started',
    safetyReviewAt: null,
    safetyReviewBy: null,
    decision: null,
    decisionAt: null,
    decisionBy: null,
    conditions: [],
    decisionNote: null,
  };

  const consent = (code: string, status: ConsentRequest['status']): ConsentRequest => ({
    id: `cns_${code}`,
    driverId: 'drv_x',
    driverName: 'Test Driver',
    purpose: 'mvr',
    requirementCode: code,
    subject: null,
    status,
    requestedAt: '2026-08-20T15:00:00.000Z',
    requestedBy: 'Monica Alvarez',
    sentAt: status === 'draft' ? null : '2026-08-20T15:10:00.000Z',
    viewedAt: null,
    signedAt: status === 'signed' ? '2026-08-21T09:00:00.000Z' : null,
    declinedAt: status === 'declined' ? '2026-08-21T09:00:00.000Z' : null,
    expiresAt: '2026-09-03T15:00:00.000Z',
    signerName: status === 'signed' ? 'Test Driver' : null,
    signerChannel: status === 'signed' ? 'driver_portal' : null,
    signedDocumentId: null,
    history: [],
  });

  const application = (overrides: Partial<QualificationItem> = {}): QualificationItem => ({
    id: 'qi_app',
    requirementCode: 'dot_application',
    scope: 'driver',
    entityId: 'drv_x',
    entityLabel: 'Test Driver',
    documentId: 'doc_app',
    issuedOn: '2026-08-20',
    expiresOn: null,
    verifiedAt: null,
    verifiedBy: null,
    verificationFailed: false,
    verificationNote: null,
    waivedUntil: null,
    waivedReason: null,
    notApplicable: false,
    notes: null,
    ...overrides,
  });

  it('produces one step per ladder rung and places the case at the first open stage', () => {
    const result = deriveVerificationCase({
      record,
      items: [application()],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    // One step per rung, less the rungs of retired requirements (background check, 2026-10-24).
    const retired = new Set(SYSTEM_REQUIREMENTS.filter((r) => !r.active).map((r) => r.code));
    expect(result.steps).toHaveLength(
      VERIFICATION_LADDER.filter((d) => !d.requirementCode || !retired.has(d.requirementCode)).length,
    );
    expect(result.steps.some((s) => s.requirementCode === 'background_check')).toBe(false);
    expect(result.steps[0]?.status).toBe('complete');
    // Only the application on file: the first open step is the CDL, so the case is at document
    // collection.
    expect(result.stage).toBe('document_collection');
    expect(result.steps[1]?.status).toBe('blocked');
    expect(result.steps[1]?.blocker).toMatch(/No Commercial/);
  });

  it('holds a case at Recruiting until the DOT application is on file, and clears it once it is', () => {
    const nothing = deriveVerificationCase({
      record,
      items: [],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(nothing.stage).toBe('recruiting');
    expect(nothing.steps[0]?.status).toBe('blocked');
    expect(nothing.steps[0]?.blocker).toMatch(/No DOT employment application on file/);

    // Filed but not yet reviewed still counts as received: the review is part of "all verified".
    const pending = deriveVerificationCase({
      record,
      items: [application()],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(pending.steps[0]?.status).toBe('complete');
    expect(pending.steps[0]?.completedAt).toBe(record.openedAt);

    const rejected = deriveVerificationCase({
      record,
      items: [application({ verificationFailed: true, verificationNote: 'Unsigned' })],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(rejected.stage).toBe('recruiting');
    expect(rejected.steps[0]?.blocker).toBe('Unsigned');
  });

  it('reads a purpose with several consents as a group: all signed completes, one refusal blocks', () => {
    const employer = (subject: string, status: ConsentRequest['status']): ConsentRequest => ({
      ...consent('mvr_review', status),
      id: `cns_${subject}`,
      subject,
    });
    const mixed = deriveVerificationCase({
      record,
      items: [application()],
      consents: [employer('Acme Freight', 'signed'), employer('Blue Line', 'sent')],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(mixed.steps.find((s) => s.key === 'consent_mvr')?.status).toBe('in_progress');

    const refused = deriveVerificationCase({
      record,
      items: [application()],
      consents: [employer('Acme Freight', 'signed'), employer('Blue Line', 'declined')],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
      driverFirstName: 'Test',
    });
    const step = refused.steps.find((s) => s.key === 'consent_mvr');
    expect(step?.status).toBe('blocked');
    expect(step?.blocker).toMatch(/^Test declined the MVR \(Blue Line\) consent/);

    const done = deriveVerificationCase({
      record,
      items: [application()],
      consents: [employer('Acme Freight', 'signed'), employer('Blue Line', 'signed')],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(done.steps.find((s) => s.key === 'consent_mvr')?.status).toBe('complete');
  });

  it('turns a declined consent into a blocker in the recruiter’s words', () => {
    const result = deriveVerificationCase({
      record,
      items: [],
      consents: [consent('mvr_review', 'declined')],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
      driverFirstName: 'Test',
    });
    const step = result.steps.find((s) => s.key === 'consent_mvr');
    expect(step?.status).toBe('blocked');
    expect(step?.blocker).toMatch(/^Test declined the MVR consent/);
  });

  it('ends the pipeline at the decision: rejected stays at Decision, approved reads Active', () => {
    const rejected = deriveVerificationCase({
      record: {
        ...record,
        decision: 'rejected',
        decisionAt: '2026-09-01T12:00:00.000Z',
        decisionBy: 'Tom Brennan',
      },
      items: [],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(rejected.stage).toBe('decision');
    const approved = deriveVerificationCase({
      record: {
        ...record,
        decision: 'approved',
        decisionAt: '2026-09-01T12:00:00.000Z',
        decisionBy: 'Tom Brennan',
      },
      items: [],
      consents: [],
      requirements: SYSTEM_REQUIREMENTS,
      now: NOW,
    });
    expect(approved.stage).toBe('active');
    expect(approved.daysInStage).toBe(5);
  });
});
