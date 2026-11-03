import { describe, expect, it } from 'vitest';
import { computeHours, detectException } from './attendance.js';
import { defaultOnboardingItems, onboardingProgress } from './onboarding.js';
import { goalIsBehind, goalProgress } from './performance.js';
import { computeBalance, detectPtoConflicts, inclusiveDays } from './pto.js';
import { ACTIVE_APPLICANT_STAGES, TERMINAL_APPLICANT_STAGES } from './recruiting.js';

describe('recruiting stages', () => {
  it('keeps hired, rejected and withdrawn out of the active pipeline', () => {
    for (const stage of TERMINAL_APPLICANT_STAGES) {
      expect(ACTIVE_APPLICANT_STAGES).not.toContain(stage);
    }
  });
});

describe('onboarding', () => {
  it('gives a driver the qualification items and an office hire none of them', () => {
    const driver = defaultOnboardingItems({ position: 'Driver', department: 'dispatch' });
    const clerk = defaultOnboardingItems({
      position: 'Billing Specialist',
      department: 'accounting',
    });
    expect(driver.map((i) => i.title)).toContain('CDL verified and on file');
    expect(clerk.map((i) => i.title)).not.toContain('CDL verified and on file');
    // Both still get the paperwork every hire needs.
    expect(clerk.map((i) => i.title)).toContain('Signed employment agreement');
  });

  it('reports no progress for a plan with no items rather than zero percent', () => {
    expect(onboardingProgress(0, 0)).toBeNull();
    expect(onboardingProgress(0, 4)).toBe(0);
    expect(onboardingProgress(3, 4)).toBe(75);
  });
});

describe('attendance hours', () => {
  it('does not guess an end time for a day that has not finished', () => {
    const open = computeHours({
      checkInAt: '2026-09-10T13:00:00.000Z',
      checkOutAt: null,
      breakMinutes: 30,
    });
    // Null, not zero: unknown hours and no hours are different facts about a shift.
    expect(open).toEqual({ worked: null, regular: null, overtime: null });
  });

  it('takes the break out and splits regular from overtime', () => {
    const day = computeHours({
      checkInAt: '2026-09-10T13:00:00.000Z',
      checkOutAt: '2026-09-10T23:00:00.000Z',
      breakMinutes: 60,
    });
    expect(day.worked).toBe(9);
    expect(day.regular).toBe(8);
    expect(day.overtime).toBe(1);
  });

  it('refuses to produce hours when the clock-out precedes the clock-in', () => {
    expect(
      computeHours({
        checkInAt: '2026-09-10T23:00:00.000Z',
        checkOutAt: '2026-09-10T13:00:00.000Z',
        breakMinutes: 0,
      }).worked,
    ).toBeNull();
  });

  it('reports the most consequential exception, not all of them', () => {
    expect(
      detectException({
        status: 'present',
        checkInAt: null,
        checkOutAt: null,
        breakMinutes: 0,
      }),
    ).toBe('missing_in');
  });

  it('says nothing is wrong with a day somebody was on leave', () => {
    expect(
      detectException({
        status: 'on_leave',
        checkInAt: null,
        checkOutAt: null,
        breakMinutes: 0,
      }),
    ).toBeNull();
  });
});

describe('pto balances', () => {
  it('derives the balance from the ledger and keeps pending separate', () => {
    const balance = computeBalance(
      [
        { kind: 'accrual', hours: 80 },
        { kind: 'usage', hours: 16 },
        { kind: 'adjustment', hours: -4 },
      ],
      8,
    );
    expect(balance.balance).toBe(60);
    // Hours awaiting a decision are neither spent nor available.
    expect(balance.pending).toBe(8);
    expect(balance.available).toBe(52);
  });

  it('counts one day off as one day, not zero', () => {
    expect(inclusiveDays('2026-09-10', '2026-09-10')).toBe(1);
    expect(inclusiveDays('2026-09-10', '2026-09-14')).toBe(5);
  });
});

describe('pto conflicts', () => {
  const base = {
    hours: 8,
    available: 40,
    allowsNegativeBalance: false,
    startsOn: '2026-10-01',
    endsOn: '2026-10-01',
    overlapping: [],
    departmentAbsences: [],
    recordedAttendanceDays: 0,
  };

  it('finds nothing wrong with an ordinary request', () => {
    expect(detectPtoConflicts(base)).toEqual([]);
  });

  it('blocks going past the balance when the policy forbids it', () => {
    const [conflict] = detectPtoConflicts({ ...base, hours: 60 });
    expect(conflict?.severity).toBe('blocking');
    expect(conflict?.message).toContain('20 hours more');
  });

  it('lets a policy that permits a negative balance through as a warning', () => {
    const [conflict] = detectPtoConflicts({
      ...base,
      hours: 60,
      allowsNegativeBalance: true,
    });
    expect(conflict?.severity).toBe('warning');
  });

  it('warns rather than blocks when a team is thin, because that is a manager judgement', () => {
    const conflicts = detectPtoConflicts({
      ...base,
      departmentAbsences: [
        { employeeName: 'A', startsOn: '2026-10-01', endsOn: '2026-10-02' },
        { employeeName: 'B', startsOn: '2026-10-01', endsOn: '2026-10-02' },
        { employeeName: 'C', startsOn: '2026-10-01', endsOn: '2026-10-02' },
      ],
    });
    expect(conflicts.every((c) => c.severity === 'warning')).toBe(true);
    expect(conflicts.map((c) => c.key)).toContain('department_thin');
  });

  it('names the overlapping requests instead of just saying there is a clash', () => {
    const conflicts = detectPtoConflicts({
      ...base,
      overlapping: [
        {
          requestNumber: 'PTO-1004',
          startsOn: '2026-10-01',
          endsOn: '2026-10-03',
          status: 'approved',
        },
      ],
    });
    expect(conflicts[0]?.message).toContain('PTO-1004');
  });
});

describe('goal progress', () => {
  it('reports nothing for a milestone rather than a fraction of one', () => {
    expect(
      goalProgress({
        measure: 'milestone',
        targetValue: null,
        currentValue: null,
        status: 'in_progress',
      }),
    ).toBe(0);
    expect(
      goalProgress({
        measure: 'milestone',
        targetValue: null,
        currentValue: null,
        status: 'completed',
      }),
    ).toBe(100);
  });

  it('has no answer for a numeric goal nobody has updated', () => {
    expect(
      goalProgress({
        measure: 'numeric',
        targetValue: 100,
        currentValue: null,
        status: 'in_progress',
      }),
    ).toBeNull();
  });

  it('divides the current value by the target and caps it', () => {
    expect(
      goalProgress({
        measure: 'numeric',
        targetValue: 200,
        currentValue: 50,
        status: 'in_progress',
      }),
    ).toBe(25);
    expect(
      goalProgress({
        measure: 'numeric',
        targetValue: 200,
        currentValue: 400,
        status: 'in_progress',
      }),
    ).toBe(100);
  });

  it('will not call a goal behind when it has no progress to judge', () => {
    expect(
      goalIsBehind({ startDate: '2026-01-01', dueDate: '2026-12-31' }, null, '2026-09-10'),
    ).toBe(false);
  });

  it('calls a goal behind when the clock has run further than the work', () => {
    expect(goalIsBehind({ startDate: '2026-01-01', dueDate: '2026-12-31' }, 10, '2026-09-10')).toBe(
      true,
    );
    expect(goalIsBehind({ startDate: '2026-01-01', dueDate: '2026-12-31' }, 90, '2026-09-10')).toBe(
      false,
    );
  });
});
