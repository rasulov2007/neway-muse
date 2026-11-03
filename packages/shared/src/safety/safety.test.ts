import { describe, expect, it } from 'vitest';
import {
  accidentTransitions,
  buildSafetyExceptions,
  claimExposure,
  correctiveActionState,
  defectUrgency,
  dotRecordable,
  inspectionState,
  proposeDueDate,
  reviewAccident,
  summarizeViolations,
  violationState,
  type ExceptionAccident,
  type SummarizableViolation,
} from './index.js';

const NOW = '2026-09-10T14:30:00Z';
const TODAY = '2026-09-10';

describe('inspectionState', () => {
  const base = {
    at: '2026-09-09T08:00:00Z',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  };

  it('never optimistically passes an inspection that has not happened', () => {
    const result = inspectionState({ ...base, at: '2026-09-11T08:00:00Z' }, NOW);
    expect(result.state).toBe('scheduled');
    expect(result.actionable).toBe(false);
  });

  it('calls a missed appointment overdue rather than leaving it scheduled', () => {
    const result = inspectionState({ ...base, at: '2026-09-01T08:00:00Z' }, NOW);
    expect(result.state).toBe('overdue');
    expect(result.actionable).toBe(true);
  });

  it('treats a pass that left defects open as still needing action', () => {
    const result = inspectionState(
      { ...base, completedAt: NOW, result: 'pass', openDefects: 2, totalDefects: 3 },
      NOW,
    );
    expect(result.state).toBe('corrective_action_required');
    expect(result.actionable).toBe(true);
    expect(result.reasons.join(' ')).toContain('2 defects still open');
  });

  it('calls a failed inspection finished once every defect it raised is cleared', () => {
    const result = inspectionState(
      { ...base, completedAt: NOW, result: 'fail', openDefects: 0, totalDefects: 4 },
      NOW,
    );
    expect(result.state).toBe('failed');
    expect(result.actionable).toBe(false);
  });

  it('ranks the state that still needs work above the one that does not', () => {
    const needsWork = inspectionState(
      { ...base, completedAt: NOW, result: 'fail', openDefects: 1 },
      NOW,
    );
    const done = inspectionState(
      { ...base, completedAt: NOW, result: 'fail', openDefects: 0 },
      NOW,
    );
    expect(needsWork.state).toBe('corrective_action_required');
    expect(done.state).toBe('failed');
  });
});

describe('defectUrgency', () => {
  it('says an out-of-service defect stops the unit, rather than only colouring it red', () => {
    const result = defectUrgency(
      { severity: 'medium', status: 'open', dueOn: null, outOfService: true },
      TODAY,
    );
    expect(result.blocksDispatch).toBe(true);
    expect(result.summary).toContain('out of service');
  });

  it('treats a critical defect as blocking even without an out-of-service order', () => {
    const result = defectUrgency({ severity: 'critical', status: 'open' }, TODAY);
    expect(result.blocksDispatch).toBe(true);
  });

  it('stops blocking once the defect is resolved', () => {
    const result = defectUrgency(
      { severity: 'critical', status: 'resolved', outOfService: true },
      TODAY,
    );
    expect(result.blocksDispatch).toBe(false);
  });

  it('flags a repair past its due date', () => {
    const result = defectUrgency({ severity: 'low', status: 'open', dueOn: '2026-09-01' }, TODAY);
    expect(result.overdue).toBe(true);
  });
});

describe('violationState', () => {
  it('keeps a contested violation actionable, because it still counts', () => {
    const result = violationState({ contested: true, severity: 'high' }, TODAY);
    expect(result.state).toBe('disputed');
    expect(result.actionable).toBe(true);
    expect(result.reasons.join(' ')).toContain('still counts');
  });

  it('reports an overdue corrective action above everything else', () => {
    const result = violationState(
      {
        contested: true,
        severity: 'high',
        hasOpenCorrectiveAction: true,
        correctiveActionDueOn: '2026-09-01',
      },
      TODAY,
    );
    expect(result.state).toBe('overdue');
  });

  it('closes only on a resolved date', () => {
    expect(violationState({ resolvedAt: '2026-09-02', severity: 'low' }, TODAY).state).toBe(
      'resolved',
    );
  });
});

function violation(
  over: Partial<SummarizableViolation> & Pick<SummarizableViolation, 'id'>,
): SummarizableViolation {
  return { category: 'hos', severity: 'medium', onDate: '2026-09-05', ...over };
}

describe('summarizeViolations', () => {
  it('never invents a risk score, and names the score as unavailable', () => {
    const result = summarizeViolations([violation({ id: 'v1' })], TODAY);
    expect(result).not.toHaveProperty('score');
    expect(result.unavailable.map((u) => u.key)).toContain('driver_risk_score');
    expect(result.unavailable.map((u) => u.key)).toContain('csa_percentile');
  });

  it('carries the ids behind every indicator', () => {
    const result = summarizeViolations(
      [
        violation({ id: 'v1', category: 'hos', onDate: '2026-09-05' }),
        violation({ id: 'v2', category: 'hos', onDate: '2026-09-08' }),
        violation({ id: 'v3', category: 'unsafe_driving', severity: 'critical' }),
      ],
      TODAY,
    );
    const repeat = result.indicators.find((i) => i.key === 'repeat_hos');
    expect(repeat?.ids).toEqual(['v1', 'v2']);
    const critical = result.indicators.find((i) => i.key === 'critical_open');
    expect(critical?.ids).toEqual(['v3']);
    for (const indicator of result.indicators) {
      expect(indicator.ids.length).toBeGreaterThan(0);
    }
  });

  it('reports no points rather than zero when nothing carries points', () => {
    const result = summarizeViolations([violation({ id: 'v1' })], TODAY);
    expect(result.openPoints).toBeNull();
  });

  it('sums points only across unresolved violations', () => {
    const result = summarizeViolations(
      [
        violation({ id: 'v1', points: 5 }),
        violation({ id: 'v2', points: 3, resolvedAt: '2026-09-07' }),
      ],
      TODAY,
    );
    expect(result.openPoints).toBe(5);
  });

  it('does not report a percentage rise from a period with no violations', () => {
    const result = summarizeViolations(
      [
        violation({ id: 'v1', onDate: '2026-09-05' }),
        violation({ id: 'v2', onDate: '2026-09-08' }),
      ],
      TODAY,
    );
    expect(result.trend?.current).toBe(2);
    expect(result.trend?.previous).toBe(0);
    expect(result.trend?.changePct).toBeNull();
  });
});

describe('dotRecordable', () => {
  it('applies the federal definition and shows its working', () => {
    const towed = dotRecordable({ fatalities: 0, injuriesTreatedAway: 0, towedFromScene: true });
    expect(towed.recordable).toBe(true);
    expect(towed.reasons[0]).toContain('towed');

    const none = dotRecordable({ fatalities: 0, injuriesTreatedAway: 0, towedFromScene: false });
    expect(none.recordable).toBe(false);
    expect(none.reasons[0]).toContain('No fatality');
  });

  it('is recordable on a fatality alone', () => {
    expect(
      dotRecordable({ fatalities: 1, injuriesTreatedAway: 0, towedFromScene: false }).recordable,
    ).toBe(true);
  });
});

describe('reviewAccident', () => {
  const base = {
    status: 'investigating' as const,
    at: '2026-09-01T10:00:00Z',
    preventable: 'undetermined' as const,
    recordable: true,
    evidence: [] as never[],
    ownerId: null,
  };

  it('names exactly what stands between the file and being closed', () => {
    const result = reviewAccident(base, NOW);
    expect(result.blocked).toBe(true);
    expect(result.blockers).toContain('Preventability has not been decided');
    expect(result.blockers).toContain('No investigator is assigned');
    expect(result.missingEvidence).toEqual(['police_report', 'driver_statement', 'photos']);
  });

  it('asks for no evidence on a file that is not DOT recordable', () => {
    const result = reviewAccident({ ...base, recordable: false }, NOW);
    expect(result.missingEvidence).toEqual([]);
  });

  it('counts days open from the accident, not from the report', () => {
    expect(reviewAccident(base, NOW).daysOpen).toBe(9);
  });

  it('never guesses preventability', () => {
    const decided = reviewAccident(
      {
        ...base,
        preventable: 'no',
        ownerId: 'usr_001',
        evidence: ['police_report', 'driver_statement', 'photos'],
      },
      NOW,
    );
    expect(decided.blocked).toBe(false);
  });

  it('only allows the transitions the flow defines', () => {
    expect(accidentTransitions('reported')).toEqual(['under_review', 'closed']);
    expect(accidentTransitions('management_review')).toContain('closed');
    expect(accidentTransitions('reported')).not.toContain('management_review');
  });
});

describe('correctiveActionState', () => {
  it('derives assigned and overdue rather than storing them', () => {
    expect(
      correctiveActionState(
        { status: 'open', assigneeId: null, dueAt: '2026-09-20T00:00:00Z' },
        NOW,
      ).state,
    ).toBe('open');
    expect(
      correctiveActionState(
        { status: 'open', assigneeId: 'usr_1', dueAt: '2026-09-20T00:00:00Z' },
        NOW,
      ).state,
    ).toBe('assigned');
    expect(
      correctiveActionState(
        { status: 'open', assigneeId: 'usr_1', dueAt: '2026-09-01T00:00:00Z' },
        NOW,
      ).state,
    ).toBe('overdue');
  });

  it('reports how late it is', () => {
    const result = correctiveActionState(
      { status: 'in_progress', assigneeId: 'usr_1', dueAt: '2026-09-01T00:00:00Z' },
      NOW,
    );
    expect(result.daysLate).toBe(9);
    expect(result.outstanding).toBe(true);
  });

  it('proposes a tighter due date for a worse finding', () => {
    expect(proposeDueDate('critical', TODAY)).toBe('2026-09-11');
    expect(proposeDueDate('low', TODAY)).toBe('2026-10-10');
  });
});

describe('claimExposure', () => {
  it('reports an unreserved claim as unknown, never as zero exposure', () => {
    expect(claimExposure(null, 0).outstanding).toBeNull();
    expect(claimExposure(50_000, 12_000).outstanding).toBe(38_000);
  });
});

function accident(
  over: Partial<ExceptionAccident> & Pick<ExceptionAccident, 'id'>,
): ExceptionAccident {
  return {
    status: 'investigating',
    preventable: 'undetermined',
    recordable: false,
    ownerId: 'usr_001',
    missingEvidence: 0,
    ...over,
  };
}

describe('buildSafetyExceptions', () => {
  const empty = {
    inspections: [],
    defects: [],
    violations: [],
    accidents: [],
    correctiveActions: [],
  };

  it('produces nothing for a clean week, so the panel can disappear', () => {
    const result = buildSafetyExceptions(empty, NOW);
    expect(result.items).toHaveLength(0);
  });

  it('carries the ids behind every count', () => {
    const result = buildSafetyExceptions(
      {
        ...empty,
        defects: [
          { id: 'd1', severity: 'critical', status: 'open', dueOn: null, outOfService: false },
          { id: 'd2', severity: 'low', status: 'open', dueOn: null, outOfService: true },
          { id: 'd3', severity: 'low', status: 'resolved', dueOn: null, outOfService: true },
        ],
      },
      NOW,
    );
    const blocking = result.items.find((i) => i.key === 'defects_out_of_service');
    expect(blocking?.count).toBe(2);
    expect(blocking?.ids).toEqual(['d1', 'd2']);
    expect(blocking?.count).toBe(blocking?.ids.length);
  });

  it('sorts critical findings above warnings', () => {
    const result = buildSafetyExceptions(
      {
        ...empty,
        accidents: [
          accident({ id: 'a1', ownerId: null }),
          accident({ id: 'a2', preventable: 'undetermined' }),
        ],
      },
      NOW,
    );
    expect(result.items[0]?.severity).toBe('critical');
  });

  it('declares the checks it cannot run', () => {
    const result = buildSafetyExceptions(empty, NOW);
    expect(result.unavailable.map((u) => u.key)).toEqual([
      'csa_percentiles',
      'mvr_psp_monitoring',
      'drug_alcohol',
    ]);
  });

  it('does not ask a non-recordable accident for evidence', () => {
    const result = buildSafetyExceptions(
      { ...empty, accidents: [accident({ id: 'a1', recordable: false, missingEvidence: 3 })] },
      NOW,
    );
    expect(result.items.find((i) => i.key === 'accidents_missing_evidence')).toBeUndefined();
  });
});
