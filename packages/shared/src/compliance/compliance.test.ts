import { describe, expect, it } from 'vitest';
import { SYSTEM_REQUIREMENTS, STANDARD_DRIVER_POLICY, requirementsFor } from './catalog.js';
import {
  buildActionQueue,
  daysBetween,
  escalationFor,
  evaluateEntity,
  evaluateItem,
  summarizeCompliance,
  warningStageFor,
} from './engine.js';
import type { QualificationItem } from './item.js';
import { QualificationRequirementSchema, type QualificationRequirement } from './requirement.js';

const TODAY = '2026-09-08';
const opts = { today: TODAY };
const driver = { id: 'drv_1', label: 'James Wilson' };

function req(code: string): QualificationRequirement {
  const found = SYSTEM_REQUIREMENTS.find((r) => r.code === code);
  if (!found) throw new Error(`no requirement ${code}`);
  return found;
}

function item(overrides: Partial<QualificationItem> = {}): QualificationItem {
  return {
    id: 'qi_1',
    requirementCode: 'medical_card',
    scope: 'driver',
    entityId: driver.id,
    entityLabel: driver.label,
    documentId: 'doc_1',
    issuedOn: '2025-09-01',
    expiresOn: '2027-09-01',
    verifiedAt: '2025-09-02T10:00:00.000Z',
    verifiedBy: 'Dana Ortiz',
    verificationFailed: false,
    verificationNote: null,
    waivedUntil: null,
    waivedReason: null,
    notApplicable: false,
    notes: null,
    ...overrides,
  };
}

describe('catalog', () => {
  it('ships only schema-valid system requirements with unique codes', () => {
    for (const requirement of SYSTEM_REQUIREMENTS) {
      expect(() => QualificationRequirementSchema.parse(requirement)).not.toThrow();
    }
    const codes = SYSTEM_REQUIREMENTS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('filters by scope and drops inactive rules', () => {
    expect(requirementsFor('driver').every((r) => r.scope === 'driver')).toBe(true);
    const disabled = SYSTEM_REQUIREMENTS.map((r) =>
      r.code === 'cdl' ? { ...r, active: false } : r,
    );
    expect(requirementsFor('driver', disabled).some((r) => r.code === 'cdl')).toBe(false);
  });
});

describe('date helpers', () => {
  it('counts whole days and tolerates bad input', () => {
    expect(daysBetween(TODAY, '2026-09-22')).toBe(14);
    expect(daysBetween(TODAY, '2026-09-01')).toBe(-7);
    expect(daysBetween(TODAY, 'nope')).toBeNull();
  });

  it('picks the tightest warning window crossed', () => {
    const lead = STANDARD_DRIVER_POLICY.leadDays;
    expect(warningStageFor(lead, 22)).toBe(30);
    expect(warningStageFor(lead, 7)).toBe(7);
    expect(warningStageFor(lead, 120)).toBeNull();
    expect(warningStageFor(lead, -2)).toBeNull();
  });

  it('escalates to the rung in force, including after expiry', () => {
    const ladder = STANDARD_DRIVER_POLICY.escalation;
    expect(escalationFor(ladder, 45)?.notify).toEqual(['safety_coordinator']);
    expect(escalationFor(ladder, 5)?.notify).toEqual(['safety_manager', 'driver']);
    expect(escalationFor(ladder, 2)?.severity).toBe('critical');
    expect(escalationFor(ladder, -3)?.notify).toContain('operations_manager');
    expect(escalationFor([], 5)).toBeNull();
  });
});

describe('evaluateItem', () => {
  it('reads verified and current when everything is in order', () => {
    const result = evaluateItem(req('medical_card'), item(), driver, opts);
    expect(result.status).toBe('verified');
    expect(result.severity).toBe('ok');
    expect(result.blocksDispatch).toBe(false);
    expect(result.requiredAction).toBeNull();
    expect(result.reasons).toContain('Verified by Dana Ortiz');
  });

  it('treats nothing on file as a missing finding that blocks dispatch', () => {
    const result = evaluateItem(req('medical_card'), null, driver, opts);
    expect(result.status).toBe('missing');
    expect(result.severity).toBe('critical');
    expect(result.blocksDispatch).toBe(true);
    expect(result.requiredAction).toMatch(/Collect and upload/);
    expect(result.deadline).toBe(TODAY);
  });

  it('is missing, not pending, when a required document is absent', () => {
    const result = evaluateItem(req('medical_card'), item({ documentId: null }), driver, opts);
    expect(result.status).toBe('missing');
  });

  it('is pending verification until safety signs it off', () => {
    const result = evaluateItem(
      req('medical_card'),
      item({ verifiedAt: null, verifiedBy: null }),
      driver,
      opts,
    );
    expect(result.status).toBe('pending_verification');
    expect(result.severity).toBe('warning');
    expect(result.blocksDispatch).toBe(false);
    expect(result.requiredAction).toMatch(/Verify/);
  });

  it('distinguishes a rejected document from an unreviewed one', () => {
    const result = evaluateItem(
      req('medical_card'),
      item({ verificationFailed: true, verificationNote: 'Examiner not on the registry' }),
      driver,
      opts,
    );
    expect(result.status).toBe('verification_failed');
    expect(result.severity).toBe('critical');
    expect(result.blocksDispatch).toBe(true);
    expect(result.reasons).toContain('Examiner not on the registry');
  });

  it('enters the warning run-up at the configured lead days with the right escalation', () => {
    const result = evaluateItem(
      req('medical_card'),
      item({ expiresOn: '2026-09-20' }), // 12 days out
      driver,
      opts,
    );
    expect(result.status).toBe('expiring');
    expect(result.daysRemaining).toBe(12);
    expect(result.warningStage).toBe(14);
    expect(result.severity).toBe('warning');
    expect(result.notify).toEqual(['safety_manager']);
    expect(result.blocksDispatch).toBe(false);
    expect(result.deadline).toBe('2026-09-20');
  });

  it('goes critical inside three days and names the driver on the escalation', () => {
    const result = evaluateItem(req('cdl'), item({ expiresOn: '2026-09-10' }), driver, opts);
    expect(result.severity).toBe('critical');
    expect(result.notify).toContain('driver');
    expect(result.notify).toContain('safety_director');
  });

  it('holds the driver the day a hard-hold credential expires', () => {
    const result = evaluateItem(req('cdl'), item({ expiresOn: '2026-09-07' }), driver, opts);
    expect(result.status).toBe('expired');
    expect(result.daysRemaining).toBe(-1);
    expect(result.inGracePeriod).toBe(false);
    expect(result.blocksDispatch).toBe(true);
    expect(result.severity).toBe('critical');
    expect(result.reasons).toContain('Commercial driver licence blocks dispatch until resolved');
  });

  it('keeps an expired review inside its grace period as a warning, not a hold', () => {
    const result = evaluateItem(
      req('mvr_review'),
      item({ requirementCode: 'mvr_review', issuedOn: '2026-03-01', expiresOn: '2026-09-01' }), // 7 days past, 14 grace
      driver,
      opts,
    );
    expect(result.status).toBe('expired');
    expect(result.inGracePeriod).toBe(true);
    expect(result.severity).toBe('warning');
    expect(result.blocksDispatch).toBe(false);
  });

  it('never blocks dispatch for an advisory requirement, even when expired', () => {
    const result = evaluateItem(
      req('ifta_license'),
      item({ requirementCode: 'ifta_license', scope: 'truck', expiresOn: '2026-01-01' }),
      { id: 'trk_1', label: 'Unit 3091' },
      opts,
    );
    expect(result.status).toBe('expired');
    expect(result.blocksDispatch).toBe(false);
  });

  it('honours a waiver until it runs out, then re-evaluates', () => {
    const waived = evaluateItem(
      req('cdl'),
      item({
        expiresOn: '2026-09-01',
        waivedUntil: '2026-09-30',
        waivedReason: 'Renewal receipt on file',
      }),
      driver,
      opts,
    );
    expect(waived.status).toBe('waived');
    expect(waived.severity).toBe('ok');
    expect(waived.reasons[0]).toMatch(/Renewal receipt on file/);

    const lapsed = evaluateItem(
      req('cdl'),
      item({ expiresOn: '2026-09-01', waivedUntil: '2026-09-05' }),
      driver,
      opts,
    );
    expect(lapsed.status).toBe('expired');
  });

  it('marks not-applicable items satisfied without a document', () => {
    const result = evaluateItem(
      req('work_authorization'),
      item({ documentId: null, expiresOn: null, notApplicable: true, notes: 'US citizen' }),
      driver,
      opts,
    );
    expect(result.status).toBe('not_applicable');
    expect(result.severity).toBe('ok');
  });

  it('reads a one-time check as verified with no run-up', () => {
    const result = evaluateItem(
      req('pre_employment_drug_test'),
      item({ requirementCode: 'pre_employment_drug_test', expiresOn: null }),
      driver,
      opts,
    );
    expect(result.status).toBe('verified');
    expect(result.daysRemaining).toBeNull();
    expect(result.warningStage).toBeNull();
  });
});

describe('evaluateEntity', () => {
  const driverRules = requirementsFor('driver');

  it('rolls every applicable rule up, including ones with nothing on file', () => {
    const result = evaluateEntity({ scope: 'driver', ...driver }, driverRules, [item()], opts);
    expect(result.items).toHaveLength(driverRules.length);
    expect(result.counts.missing).toBe(driverRules.length - 1);
    expect(result.state).toBe('non_compliant');
    expect(result.dispatchable).toBe(false);
    expect(result.gateReasons).toContain('Commercial driver licence missing');
  });

  it('is at risk, not non-compliant, when the only issue is an approaching expiry', () => {
    const complete = driverRules.map((r) =>
      item({
        id: `qi_${r.code}`,
        requirementCode: r.code,
        expiresOn: r.hasExpiry ? '2027-01-01' : null,
        ...(r.validityMonths ? { issuedOn: '2026-08-01' } : {}),
      }),
    );
    const soon = complete.map((i) =>
      i.requirementCode === 'medical_card' ? { ...i, expiresOn: '2026-09-25' } : i,
    );
    const result = evaluateEntity({ scope: 'driver', ...driver }, driverRules, soon, opts);
    expect(result.state).toBe('at_risk');
    expect(result.dispatchable).toBe(true);
    expect(result.nextDeadline).toBe('2026-09-25');
    // 17 days out sits in the 30-day window, which the standard ladder treats as informational.
    expect(result.severity).toBe('info');
  });

  it('is compliant when every rule is satisfied', () => {
    const complete = driverRules.map((r) =>
      item({
        id: `qi_${r.code}`,
        requirementCode: r.code,
        expiresOn: r.hasExpiry ? '2027-06-01' : null,
        // A fixed-term review (MVR, PSP: 6 months) is current only when it is recent.
        ...(r.validityMonths ? { issuedOn: '2026-08-01' } : {}),
      }),
    );
    const result = evaluateEntity({ scope: 'driver', ...driver }, driverRules, complete, opts);
    expect(result.state).toBe('compliant');
    expect(result.counts.satisfied).toBe(driverRules.length);
    expect(result.nextDeadline).toBeNull();
  });
});

describe('summary and action queue', () => {
  const driverRules = requirementsFor('driver');
  const complete = (id: string, label: string) =>
    driverRules.map((r) =>
      item({
        id: `${id}_${r.code}`,
        requirementCode: r.code,
        entityId: id,
        entityLabel: label,
        expiresOn: r.hasExpiry ? '2027-06-01' : null,
        // A fixed-term review (MVR, PSP: 6 months) is current only when it is recent.
        ...(r.validityMonths ? { issuedOn: '2026-08-01' } : {}),
      }),
    );

  const healthy = evaluateEntity(
    { scope: 'driver', id: 'd1', label: 'Ana Ruiz' },
    driverRules,
    complete('d1', 'Ana Ruiz'),
    opts,
  );
  const held = evaluateEntity(
    { scope: 'driver', id: 'd2', label: 'Ben Cole' },
    driverRules,
    complete('d2', 'Ben Cole').map((i) =>
      i.requirementCode === 'cdl' ? { ...i, expiresOn: '2026-09-01' } : i,
    ),
    opts,
  );
  const expiring = evaluateEntity(
    { scope: 'driver', id: 'd3', label: 'Cy Dunn' },
    driverRules,
    complete('d3', 'Cy Dunn').map((i) =>
      i.requirementCode === 'medical_card' ? { ...i, expiresOn: '2026-09-30' } : i,
    ),
    opts,
  );

  it('counts exactly the records a drill-down would list', () => {
    const summary = summarizeCompliance([healthy, held, expiring]);
    expect(summary).toMatchObject({
      entities: 3,
      compliant: 1,
      atRisk: 1,
      nonCompliant: 1,
      notDispatchable: 1,
      expiringSoon: 1,
      expired: 1,
      critical: 1,
    });
  });

  it('puts dispatch blockers first, then severity, then deadline', () => {
    const queue = buildActionQueue([healthy, expiring, held]);
    expect(queue).toHaveLength(2);
    expect(queue[0]?.item.entityLabel).toBe('Ben Cole');
    expect(queue[0]?.blocksDispatch).toBe(true);
    expect(queue[1]?.item.entityLabel).toBe('Cy Dunn');
    expect(queue[1]?.item.requiredAction).toMatch(/Renew the DOT medical certificate/);
  });
});
