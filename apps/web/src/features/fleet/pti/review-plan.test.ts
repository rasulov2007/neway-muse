import { describe, expect, it } from 'vitest';
import type { PtiDefect, PtiInspection } from '@neway/shared';
import type { ComponentCondition, PtiComponentDef } from '@/demo';
import {
  emptyDraft,
  newIssue,
  planReview,
  routeOwner,
  withSeverity,
  type ReviewContext,
} from './review-plan';

function component(id: string, key: string, name: string): PtiComponentDef {
  return { id, key, name, defaultLifeHint: null, active: true, sortOrder: 0, trailerOnly: false, quickPicks: [] };
}

const COMPONENTS = [
  component('ptc_brakes', 'brakes', 'Brakes'),
  component('ptc_lights', 'lights_reflectors', 'Lights & reflectors'),
  component('ptc_body', 'body_mudflaps', 'Body & mud flaps'),
];

function inspection(overrides: Partial<PtiInspection> = {}): PtiInspection {
  return {
    id: 'pin_1',
    unitId: 'trk_2718',
    unitNumber: '2718',
    weekStart: '2026-09-14',
    dueAt: '2026-09-16',
    driverId: 'drv_1',
    driverName: 'Luis Herrera',
    driverType: 'company',
    dispatcherId: 'usr_elena',
    dispatcherName: 'Elena Vasquez',
    receiptStatus: 'received',
    receivedAt: '2026-09-15T14:00:00.000Z',
    source: { chatTitle: 'NWF Drivers', messageUrl: 'https://t.me/c/1/2', messageId: null, senderName: 'Luis', sentAt: null, capturedBy: 'manual' },
    reviewState: 'unreviewed',
    reviewerId: null,
    reviewerName: null,
    reviewedAt: null,
    reviewResult: null,
    inReviewBy: null,
    inReviewByName: null,
    inReviewSince: null,
    openDefectDispositions: [],
    legacyRecordId: null,
    createdAt: '2026-09-14T05:00:00.000Z',
    updatedAt: '2026-09-14T05:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function defect(id: string, number: string): PtiDefect {
  return {
    id,
    defectNumber: number,
    unitId: 'trk_2718',
    unitNumber: '2718',
    foundOnInspectionId: null,
    component: 'lights_reflectors',
    componentName: 'Lights & reflectors',
    description: 'Marker lamp dark, driver side rear',
    quickPick: null,
    severity: 'monitor',
    state: 'open',
    evidence: { clipTime: null, screenshots: [] },
    ownerId: null,
    ownerName: null,
    dueAt: null,
    workOrderId: null,
    workOrderNumber: null,
    resolution: { fixedAt: null, fixedVia: null, verifiedAt: null, verifiedBy: null, dismissedReason: null },
    needsReview: false,
    legacyRecordId: null,
    history: [],
    createdBy: 'Tom',
    createdAt: '2026-09-08T15:00:00.000Z',
    updatedAt: '2026-09-08T15:00:00.000Z',
    version: 1,
  };
}

function context(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    inspection: inspection(),
    openDefects: [],
    components: COMPONENTS,
    conditions: [] as ComponentCondition[],
    assignees: [
      { id: 'usr_tom', name: 'Tom Brennan', roles: ['maintenance'] },
      { id: 'usr_elena', name: 'Elena Vasquez', roles: ['dispatcher'] },
    ],
    reviewerName: 'Sarah Chen',
    now: new Date('2026-09-15T16:00:00.000Z'),
    ...overrides,
  };
}

describe('the clean path (§6.2, §4.3)', () => {
  it('saves in one choice when nothing is open, touching no rating', () => {
    const plan = planReview({ ...emptyDraft(), result: 'no_issues' }, context());
    expect(plan.canSave).toBe(true);
    expect(plan.defects).toEqual([]);
    expect(plan.ratings).toEqual([]);
    expect(plan.effects).toContain('Leaves every component rating untouched, with its original date');
  });

  it('blocks until every open defect is dispositioned, and no disposition closes one', () => {
    const ctx = context({ openDefects: [defect('pd_1', 'DEF-0007'), defect('pd_2', 'DEF-0008')] });
    const blocked = planReview({ ...emptyDraft(), result: 'no_issues' }, ctx);
    expect(blocked.canSave).toBe(false);
    expect(blocked.problems).toEqual(['Say what this video showed for DEF-0007', 'Say what this video showed for DEF-0008']);

    const answered = planReview(
      { ...emptyDraft(), result: 'no_issues', dispositions: { pd_1: 'still_present', pd_2: 'looks_fixed' } },
      ctx,
    );
    expect(answered.canSave).toBe(true);
    expect(answered.dispositions).toEqual([
      { defectId: 'pd_1', seen: 'still_present' },
      { defectId: 'pd_2', seen: 'looks_fixed' },
    ]);
    expect(answered.effects.join('\n')).toMatch(/DEF-0007: still present — stays open/);
    expect(answered.effects.join('\n')).toMatch(/DEF-0008: looks fixed — proposed for verification; the hold stays/);
  });

  it('"Mark all Good" rates every component once, and the footer says how many', () => {
    const plan = planReview({ ...emptyDraft(), result: 'no_issues', othersGood: true }, context());
    expect(plan.ratings).toHaveLength(3);
    expect(plan.ratings.every((r) => r.rating === 'good')).toBe(true);
    expect(plan.effects).toContain('Rates 3 components: 3 others → Good');
  });
});

describe('the issue path (§6.2, §6.3)', () => {
  it('routes the owner by severity, and stops once the reviewer chose', () => {
    const ctx = context();
    expect(routeOwner('oos_risk', ctx)?.name).toBe('Tom Brennan');
    expect(routeOwner('replace_now', ctx)?.name).toBe('Tom Brennan');
    expect(routeOwner('monitor', ctx)?.name).toBe('Elena Vasquez');
    const issue = newIssue('brakes', ctx, 'monitor');
    expect(issue.ownerName).toBe('Elena Vasquez');
    expect(withSeverity(issue, 'oos_risk', ctx).ownerName).toBe('Tom Brennan');
    const chosen = { ...issue, ownerId: 'usr_elena', ownerName: 'Elena Vasquez', ownerEdited: true };
    expect(withSeverity(chosen, 'oos_risk', ctx).ownerName).toBe('Elena Vasquez');
  });

  it('refuses an issue without a real description, in words; a missing screenshot no longer blocks (owner, 2026-10-05)', () => {
    const ctx = context();
    const issue = { ...newIssue('brakes', ctx, 'oos_risk'), description: '65' };
    const plan = planReview({ ...emptyDraft(), result: 'issues_found', issues: [issue] }, ctx);
    expect(plan.canSave).toBe(false);
    expect(plan.problems[0]).toMatch(/Issue 1 \(Brakes\): /);
    expect(plan.problems.some((p) => /screenshot/.test(p))).toBe(false);
  });

  it('two issues share the unit, week and source; each is a defect, each rates its component once', () => {
    const ctx = context();
    const brakes = {
      ...newIssue('brakes', ctx, 'oos_risk'),
      description: 'Slack adjuster out of stroke on axle 3',
      screenshots: [{ fileId: 'file_1', fileName: 'a.png', uploadedAt: '2026-09-15T16:00:00.000Z', uploadedBy: 'Sarah' }],
      nextAction: 'work_order' as const,
      vendorName: 'TA Truck Service',
    };
    const lights = { ...newIssue('lights_reflectors', ctx, 'monitor'), description: 'Marker lamp dark, driver side rear' };
    const plan = planReview({ ...emptyDraft(), result: 'issues_found', issues: [brakes, lights], othersGood: true }, ctx);
    expect(plan.canSave).toBe(true);
    expect(plan.defects.map((d) => [d.component, d.severity])).toEqual([
      ['brakes', 'oos_risk'],
      ['lights_reflectors', 'monitor'],
    ]);
    // Same day: the end of the day it was found, on the reviewer's clock.
    expect(new Date(plan.defects[0]?.dueAt ?? '').getHours()).toBe(23);
    expect(plan.defects[0]?.ownerId).toBe('usr_tom');
    expect(plan.ratings.map((r) => [r.componentId, r.rating])).toEqual([
      ['ptc_brakes', 'replace_now'],
      ['ptc_lights', 'monitor'],
      ['ptc_body', 'good'],
    ]);
    const text = plan.effects.join('\n');
    expect(text).toMatch(/Creates a defect on Brakes \(out-of-service risk\) · due .* · owner Tom Brennan · opens a work order at TA Truck Service/);
    expect(text).toMatch(/Puts unit 2718 out of service — dispatch is blocked/);
    expect(text).toMatch(/Rates 3 components: Brakes → Replace now, Lights & reflectors → Monitor, 1 other → Good/);
    expect(text).toMatch(/Notifies dispatch \(Elena Vasquez\)/);
    expect(plan.notifiesDispatch).toBe(true);
  });

  it('an edited due date is kept when the severity changes', () => {
    const ctx = context();
    const issue = { ...newIssue('brakes', ctx, 'monitor'), dueAt: '2026-09-20T12:00:00.000Z', dueEdited: true };
    expect(withSeverity(issue, 'oos_risk', ctx).dueAt).toBe('2026-09-20T12:00:00.000Z');
    expect(withSeverity({ ...issue, dueEdited: false }, 'oos_risk', ctx).dueAt).toBeNull();
  });
});

describe('a clean result cannot coexist with a replacement rating (WP7)', () => {
  it('refuses No issues beside a component rated Replace soon or worse', () => {
    const plan = planReview({ ...emptyDraft(), result: 'no_issues', ratings: { ptc_brakes: 'replace_now', ptc_lights: 'good' } }, context());
    expect(plan.canSave).toBe(false);
    expect(plan.problems).toContain('Brakes is rated for replacement; this is an issue, not a clean review');
    const fine = planReview({ ...emptyDraft(), result: 'no_issues', ratings: { ptc_brakes: 'monitor', ptc_lights: 'good' } }, context());
    expect(fine.canSave).toBe(true);
  });
});

describe('the receipt comes first (§4.6)', () => {
  it('records the receipt with the review, and accepts only a t.me link when one is given', () => {
    const ctx = context({ inspection: inspection({ receiptStatus: 'missing', receivedAt: null, source: null }) });
    const missing = planReview({ ...emptyDraft(), result: 'no_issues' }, ctx);
    expect(missing.problems).not.toContain('Paste the Telegram message link before reviewing');
    expect(missing.receipt).toEqual({ messageUrl: '', chatTitle: '', senderName: '' });
    const drive = planReview(
      { ...emptyDraft(), result: 'no_issues', source: { messageUrl: 'https://drive.google.com/x', chatTitle: '', senderName: '' } },
      ctx,
    );
    expect(drive.problems).toContain('The source has to be a t.me message link');
    const ok = planReview(
      { ...emptyDraft(), result: 'no_issues', source: { messageUrl: 'https://t.me/c/1/9', chatTitle: 'NWF Drivers', senderName: 'Luis' } },
      ctx,
    );
    expect(ok.canSave).toBe(true);
    expect(ok.receipt).toEqual({ messageUrl: 'https://t.me/c/1/9', chatTitle: 'NWF Drivers', senderName: 'Luis' });
    expect(ok.effects[0]).toBe('Marks the video received from NWF Drivers (Luis)');
  });
});
