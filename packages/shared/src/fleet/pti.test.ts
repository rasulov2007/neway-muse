import { describe, expect, it } from 'vitest';
import {
  canTransition,
  componentKeyFromName,
  CreateDefectSchema,
  DEFAULT_PTI_COMPONENT_KEYS,
  LEGACY_CATEGORY_MAP,
  defectDueAt,
  describeDescriptionProblem,
  describeScreenshotProblem,
  isPtiIssue,
  isTelegramMessageUrl,
  ptiIssueLevel,
  ptiIssuesByUnit,
  summarizePtiIssues,
  ptiDueDateOf,
  ptiWeekStartOf,
  queuesFor,
  receiptStatusFor,
  ReviewSchema,
  screenshotRequired,
  TelegramSourceSchema,
  TransitionDefectSchema,
  unitServiceStatus,
  type PtiDefectSeverity,
  type PtiDefectState,
} from './pti';

/** A defect with only what the rules read. */
function defect(id: string, severity: PtiDefectSeverity, state: PtiDefectState = 'open') {
  return { id, defectNumber: `DEF-${id}`, severity, state };
}

describe('the unit service status is derived (§4.2)', () => {
  it('is cleared with no open defects, and with only closed ones', () => {
    expect(unitServiceStatus([]).status).toBe('cleared');
    expect(unitServiceStatus([defect('1', 'oos_risk', 'verified'), defect('2', 'replace_now', 'dismissed')])).toMatchObject({
      status: 'cleared',
      dispatchBlocked: false,
      defectIds: [],
    });
  });

  it('is out of service, and blocks dispatch, while an oos_risk defect is open — naming it', () => {
    const verdict = unitServiceStatus([defect('4417', 'oos_risk'), defect('2', 'monitor')]);
    expect(verdict.status).toBe('out_of_service');
    expect(verdict.dispatchBlocked).toBe(true);
    expect(verdict.defectIds).toEqual(['4417']);
    expect(verdict.reason).toBe('hold: DEF-4417');
    expect(verdict.releaseCondition).toBe('released when DEF-4417 is verified');
  });

  it('stays out of service while the hold is only proposed for verification (§4.4)', () => {
    expect(unitServiceStatus([defect('4417', 'oos_risk', 'fixed_pending_verify')]).status).toBe('out_of_service');
  });

  it('is restricted, not blocked, for replace_now', () => {
    const verdict = unitServiceStatus([defect('9', 'replace_now', 'assigned')]);
    expect(verdict.status).toBe('restricted');
    expect(verdict.dispatchBlocked).toBe(false);
    expect(verdict.reason).toMatch(/DEF-9 needs replacing now/);
  });

  it('is watch for replace_soon or monitor, naming the worst', () => {
    const verdict = unitServiceStatus([defect('1', 'monitor'), defect('2', 'replace_soon', 'scheduled')]);
    expect(verdict.status).toBe('watch');
    expect(verdict.reason).toMatch(/2 open defects, worst DEF-2 \(replace soon\)/);
    expect(verdict.releaseCondition).toBeNull();
  });
});

describe('a clean inspection resolves nothing (§4.3)', () => {
  it('will not accept defects on a no_issues review, nor a bare issues_found', () => {
    expect(ReviewSchema.safeParse({ version: 1, result: 'no_issues', defects: [{ component: 'brakes', description: 'Air leak at the gladhand', severity: 'monitor' }] }).success).toBe(false);
    expect(ReviewSchema.safeParse({ version: 1, result: 'issues_found', defects: [] }).success).toBe(false);
    expect(ReviewSchema.safeParse({ version: 1, result: 'no_issues' }).success).toBe(true);
  });
});

describe('closure is proposed by anyone and confirmed by a person (§4.4)', () => {
  it('reaches verified only from fixed_pending_verify', () => {
    for (const from of ['open', 'assigned', 'scheduled', 'in_repair'] as const) {
      expect(canTransition(from, 'verified'), from).toBe(false);
      expect(canTransition(from, 'fixed_pending_verify'), from).toBe(true);
    }
    expect(canTransition('fixed_pending_verify', 'verified')).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const to of ['open', 'in_repair', 'fixed_pending_verify', 'verified'] as const) {
      expect(canTransition('verified', to)).toBe(false);
      expect(canTransition('dismissed', to)).toBe(false);
    }
  });

  it('cannot dismiss without a reason', () => {
    expect(TransitionDefectSchema.safeParse({ version: 1, to: 'dismissed' }).success).toBe(false);
    expect(TransitionDefectSchema.safeParse({ version: 1, to: 'dismissed', reason: 'Was a reflection on the lens' }).success).toBe(true);
  });
});

describe('severity drives the due date (§4.1)', () => {
  const found = new Date('2026-09-18T10:00:00');
  it('monitor +30d, replace_soon +14d, replace_now +48h, oos_risk same day', () => {
    expect(defectDueAt('monitor', found).toISOString().slice(0, 10)).toBe('2026-10-18');
    expect(defectDueAt('replace_soon', found).toISOString().slice(0, 10)).toBe('2026-10-02');
    expect(defectDueAt('replace_now', found).getTime() - found.getTime()).toBe(48 * 3_600_000);
    const sameDay = defectDueAt('oos_risk', found);
    expect(sameDay.getDate()).toBe(found.getDate());
    expect(sameDay.getHours()).toBe(23);
  });

  it('requires a screenshot from replace_now upward', () => {
    expect(screenshotRequired('monitor')).toBe(false);
    expect(screenshotRequired('replace_soon')).toBe(false);
    expect(screenshotRequired('replace_now')).toBe(false);
    expect(screenshotRequired('oos_risk')).toBe(false);
  });

  it('a screenshot is an image of screenshot size, and the refusal says which it is not', () => {
    expect(describeScreenshotProblem({ contentType: 'image/png', sizeBytes: 320_000 })).toBeNull();
    expect(describeScreenshotProblem({ contentType: 'image/jpeg', sizeBytes: 10 * 1024 * 1024 })).toBeNull();
    expect(describeScreenshotProblem({ contentType: 'application/pdf', sizeBytes: 1000 })).toMatch(/image/);
    expect(describeScreenshotProblem({ contentType: 'video/mp4', sizeBytes: 1000 })).toMatch(/image/);
    expect(describeScreenshotProblem({ contentType: 'image/png', sizeBytes: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
  });
});

describe('the five junk strings are unsaveable (WP7)', () => {
  it.each(['65', '.+6.', '111111111111', '2222222222222222222', '65464', '', '   ', 'abcabca'])(
    'rejects %j',
    (text) => {
      expect(describeDescriptionProblem(text)).not.toBeNull();
      expect(CreateDefectSchema.safeParse({ unitId: 'trk_1', component: 'brakes', description: text, severity: 'monitor' }).success).toBe(false);
    },
  );

  it('accepts a real description', () => {
    expect(describeDescriptionProblem('Slack adjuster out of stroke on axle 3')).toBeNull();
    expect(describeDescriptionProblem('aaaaaaaa bbbbbbbb')).toBeNull();
  });
});

describe('the Telegram source is a link, checked by shape only (§3.3)', () => {
  it('accepts t.me and rejects everything else', () => {
    expect(isTelegramMessageUrl('https://t.me/c/1234567890/456')).toBe(true);
    expect(isTelegramMessageUrl('https://t.me/example_drivers/456')).toBe(true);
    expect(isTelegramMessageUrl('http://t.me/c/1/2')).toBe(false);
    expect(isTelegramMessageUrl('https://telegram.org/somewhere')).toBe(false);
    expect(isTelegramMessageUrl('https://drive.google.com/file/x')).toBe(false);
    expect(isTelegramMessageUrl('not a url')).toBe(false);
    expect(TelegramSourceSchema.safeParse({ chatTitle: 'NWF Drivers', messageUrl: 'https://youtu.be/x' }).success).toBe(false);
    expect(TelegramSourceSchema.safeParse({ chatTitle: 'NWF Drivers', messageUrl: 'https://t.me/c/1/2' }).success).toBe(true);
  });
});

describe('receipt is its own fact (§4.6)', () => {
  it('follows the calendar and the truck, and is never implied by a review', () => {
    // Sunday-start weeks (owner, 2026-10-18); the video is still due Wednesday.
    expect(ptiWeekStartOf('2026-09-18')).toBe('2026-09-13');
    expect(ptiWeekStartOf('2026-09-13')).toBe('2026-09-13');
    expect(ptiDueDateOf('2026-09-13')).toBe('2026-09-16');
    const week = '2026-09-13';
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-12', receivedOn: null, inShop: false })).toBe('not_due');
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-15', receivedOn: null, inShop: false })).toBe('awaiting');
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-18', receivedOn: null, inShop: false })).toBe('missing');
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-18', receivedOn: null, inShop: true })).toBe('exempt_in_shop');
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-18', receivedOn: '2026-09-15', inShop: true })).toBe('received');
    expect(receiptStatusFor({ weekStart: week, today: '2026-09-18', receivedOn: '2026-09-17', inShop: false })).toBe('late');
  });
});

describe('the four queues (§7.1)', () => {
  it('puts a row in every queue it belongs to, and none it does not', () => {
    expect(queuesFor({ inspection: { receiptStatus: 'missing', reviewState: 'unreviewed' }, openDefects: [] })).toEqual(['chase']);
    expect(queuesFor({ inspection: { receiptStatus: 'received', reviewState: 'unreviewed' }, openDefects: [] })).toEqual(['review']);
    // A late video has arrived: it is watched, not chased.
    expect(queuesFor({ inspection: { receiptStatus: 'late', reviewState: 'in_review' }, openDefects: [] })).toEqual(['review']);
    expect(
      queuesFor({ inspection: { receiptStatus: 'received', reviewState: 'reviewed' }, openDefects: [{ state: 'open' }, { state: 'fixed_pending_verify' }] }),
    ).toEqual(['defects', 'verify']);
    expect(queuesFor({ inspection: { receiptStatus: 'received', reviewState: 'reviewed' }, openDefects: [] })).toEqual([]);
  });
});

describe('one component vocabulary (WP1.1)', () => {
  it('derives the thirteen default keys from the catalog names, as the specification spells them', () => {
    const names = [
      'Steer tyres', 'Drive tyres', 'Trailer tyres', 'Brakes', 'Lights & reflectors', 'Leaks & fluids',
      'Suspension / airbags', 'Belts & hoses', 'Battery & electrical', 'Windshield & mirrors',
      'Body & mud flaps', '5th wheel / coupling', 'Trailer condition',
    ];
    expect(names.map(componentKeyFromName)).toEqual([...DEFAULT_PTI_COMPONENT_KEYS]);
    // A rename that only changes spacing or case keeps the key.
    expect(componentKeyFromName('  lights &  Reflectors ')).toBe('lights_reflectors');
  });

  it('maps every legacy category, and sends Mounting and Other to a person', () => {
    for (const category of ['Lights', 'Tires / Wheels', 'Brakes', 'Leaks', 'Body', 'Mounting', 'Other']) {
      expect(category in LEGACY_CATEGORY_MAP, category).toBe(true);
    }
    expect(LEGACY_CATEGORY_MAP.Mounting).toBeNull();
    expect(LEGACY_CATEGORY_MAP.Other).toBeNull();
    expect(LEGACY_CATEGORY_MAP['Tires / Wheels']).toEqual({ key: 'drive_tyres', flag: true });
    for (const target of Object.values(LEGACY_CATEGORY_MAP)) {
      if (target) expect(DEFAULT_PTI_COMPONENT_KEYS).toContain(target.key);
    }
  });
});

describe('the "PTI issue" sign on a unit (owner, 2026-10-21)', () => {
  const d = (id: string, severity: PtiDefectSeverity, state: PtiDefectState, unitId = 'u1') => ({
    id,
    unitId,
    defectNumber: `DEF-${id}`,
    component: 'brakes',
    componentName: 'Brakes',
    description: `Problem number ${id} on the unit`,
    severity,
    state,
  });

  it('counts every defect not yet fixed, owned or not, and nothing closed', () => {
    for (const state of ['open', 'assigned', 'scheduled', 'in_repair'] as const) {
      expect(isPtiIssue({ severity: 'monitor', state })).toBe(true);
    }
    expect(isPtiIssue({ severity: 'replace_now', state: 'fixed_pending_verify' })).toBe(false);
    expect(isPtiIssue({ severity: 'oos_risk', state: 'verified' })).toBe(false);
    expect(isPtiIssue({ severity: 'oos_risk', state: 'dismissed' })).toBe(false);
  });

  it('keeps an out-of-service defect while it awaits verification, because the hold stands', () => {
    expect(isPtiIssue({ severity: 'oos_risk', state: 'fixed_pending_verify' })).toBe(true);
  });

  it('summarises worst first, and is null with nothing open', () => {
    expect(summarizePtiIssues([d('1', 'oos_risk', 'verified')])).toBeNull();
    const issues = summarizePtiIssues([
      d('1', 'monitor', 'open'),
      d('2', 'replace_now', 'assigned'),
      d('3', 'oos_risk', 'dismissed'),
    ]);
    expect(issues).toMatchObject({ open: 2, worst: 'urgent' });
    expect(issues?.defects.map((x) => x.id)).toEqual(['2', '1']);
    expect(issues?.summary.split('\n')[0]).toBe(
      'Brakes: Problem number 2 on the unit (Replace now, assigned)',
    );
  });

  it('maps severity to the sign: oos, urgent, warning', () => {
    expect(ptiIssueLevel('oos_risk')).toBe('oos');
    expect(ptiIssueLevel('replace_now')).toBe('urgent');
    expect(ptiIssueLevel('replace_soon')).toBe('warning');
    expect(ptiIssueLevel('monitor')).toBe('warning');
  });

  it('groups by unit and leaves out a unit whose defects are all closed', () => {
    const map = ptiIssuesByUnit([
      d('1', 'replace_soon', 'in_repair', 'u1'),
      d('2', 'oos_risk', 'verified', 'u2'),
    ]);
    expect(Object.keys(map)).toEqual(['u1']);
    expect(map.u1?.worst).toBe('warning');
  });
});
