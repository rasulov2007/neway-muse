import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import {
  openPtiWeek,
  ptiWeek,
  raiseWorkOrder,
  receivePti,
  stateOf,
  summarisePti,
  updatePti,
  weekStartOf,
} from './pti-api';
import { isUnresolved } from './pti-types';

/**
 * The two rules the board rests on: a row exists for every truck that owes an inspection, and the
 * truck's state is read from the fleet rather than stored on the row.
 */
describe('the weekly inspection', () => {
  const week = '2026-09-07';

  beforeEach(() => {
    demoData.ptiRecords.length = 0;
    demoData.repairOrders.length = 0;
  });

  it('opens a row for every truck that is not inactive, and only one', () => {
    const first = openPtiWeek(week);
    const expected = demoData.trucks.filter(
      (t) => !['inactive', 'sold', 'out_of_service'].includes(t.status),
    ).length;
    expect(first).toHaveLength(expected);

    // Opening the same week again must not double the board.
    const second = openPtiWeek(week);
    expect(second).toHaveLength(expected);
  });

  it('follows the truck into the shop without anybody retyping it', () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0];
    const truck = demoData.trucks.find((t) => t.id === row?.truckId);
    if (!row || !truck) throw new Error('fixture');

    truck.status = 'available';
    expect(stateOf(row)).toBe('road');

    truck.status = 'in_shop';
    expect(stateOf(row)).toBe('shop');
  });

  it('marks a video that arrives after the due day as late', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0];
    if (!row) throw new Error('fixture');

    const onTime = await receivePti(row.id, '2026-09-08');
    expect(onTime.status).toBe('sent');

    const late = await receivePti(row.id, '2026-09-11');
    expect(late.status).toBe('late');
  });

  /**
   * Acceptance test A22. A finding used to clear the moment anybody typed in "Action taken", so
   * "will look at it" took a defect off the board while the defect was still on the truck.
   */
  it('is not closed by typing in the action box', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0];
    if (!row) throw new Error('fixture');
    const finding = {
      status: 'sent' as const,
      sentDate: '2026-09-08',
      result: 'issue_found' as const,
      issueCategory: 'Brakes' as const,
      issueNote: 'Slack adjuster out of stroke on axle 3',
      checkedById: demoData.users[0]?.id ?? null,
      checkedDate: '2026-09-08',
    };
    await updatePti(row.id, finding);

    await updatePti(row.id, { actionTaken: 'Will look at it' });
    expect(isUnresolved(ptiWeek(week).find((r) => r.id === row.id)!)).toBe(true);

    // It closes on a decision with a name and a reason on it.
    await updatePti(row.id, {
      noRepairNeeded: {
        reason: 'Within tolerance on re-measure',
        byId: 'usr_1',
        byName: 'Dana Whitfield',
        at: '2026-09-09T10:00:00.000Z',
      },
    });
    expect(isUnresolved(ptiWeek(week).find((r) => r.id === row.id)!)).toBe(false);
  });

  /** Brief WP7: none of the five strings that were live on the board can be saved by any path. */
  it('refuses an issue whose note is not a description, on the pre-flag path too', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[1];
    if (!row) throw new Error('fixture');
    for (const junk of ['65', '.+6.', '111111111111', '2222222222222222222', '65464']) {
      await expect(
        updatePti(row.id, { status: 'sent', sentDate: '2026-09-08', result: 'issue_found', issueCategory: 'Brakes', issueNote: junk }),
      ).rejects.toThrow(/Issue:/);
    }
    // Unit 2747's state - NO ISSUES beside "65464" - is unreachable: a clean result carries no note.
    const clean = await updatePti(row.id, { status: 'sent', sentDate: '2026-09-08', result: 'no_issues', issueNote: null });
    expect(clean.result).toBe('no_issues');
    expect(clean.issueNote).toBeNull();
    await expect(updatePti(row.id, { result: 'issue_found', issueNote: '65464' })).rejects.toThrow(/Issue:/);
  });

  it('records a brake finding against the Brakes rating, not only as free text', async () => {
    demoData.ptiRatings.length = 0;
    openPtiWeek(week);
    const row = ptiWeek(week)[0];
    if (!row) throw new Error('fixture');

    await updatePti(row.id, {
      status: 'sent',
      sentDate: '2026-09-08',
      result: 'issue_found',
      issueCategory: 'Brakes',
      issueNote: 'Air leak at the gladhand',
      checkedById: demoData.users[0]?.id ?? null,
      checkedDate: '2026-09-08',
    });

    const brakes = demoData.ptiComponents?.find((c) => c.name === 'Brakes');
    const rating = demoData.ptiRatings.find(
      (r) => r.truckId === row.truckId && r.componentId === brakes?.id && r.weekStart === week,
    );
    expect(rating?.rating).toBe('monitor');
    expect(rating?.note).toBe('Air leak at the gladhand');
  });

  it('flags an issue with nothing done about it, and clears the flag when a work order opens', async () => {
    openPtiWeek(week);
    const row = ptiWeek(week)[0];
    if (!row) throw new Error('fixture');

    await updatePti(row.id, {
      status: 'sent',
      sentDate: '2026-09-08',
      result: 'issue_found',
      issueCategory: 'Brakes',
      issueNote: 'Air leak at the gladhand',
      checkedById: demoData.users[0]?.id ?? null,
      checkedDate: '2026-09-08',
    });
    expect(isUnresolved(ptiWeek(week).find((r) => r.id === row.id)!)).toBe(true);
    expect(summarisePti(ptiWeek(week)).unresolved).toBe(1);

    const raised = await raiseWorkOrder(row.id);
    expect(raised.workOrderNumber).toMatch(/^RO-/);
    expect(isUnresolved(raised)).toBe(false);

    const order = demoData.repairOrders.find((o) => o.id === raised.workOrderId);
    expect(order, 'the work order lands in Maintenance').toBeTruthy();
    expect(order?.summary).toContain('Brakes');
    expect(order?.unitNumber).toBe(row.unitNumber);
  });

  it('leaves a truck in the shop out of the missing count', () => {
    openPtiWeek(week);
    const rows = ptiWeek(week);
    const row = rows[0];
    const truck = demoData.trucks.find((t) => t.id === row?.truckId);
    if (!row || !truck) throw new Error('fixture');

    truck.status = 'available';
    const before = summarisePti(ptiWeek(week)).missing;

    truck.status = 'in_shop';
    const after = summarisePti(ptiWeek(week)).missing;
    expect(after).toBe(before - 1);
  });

  it('defaults the week to the Sunday of the current cycle', () => {
    expect(weekStartOf('2026-09-12')).toBe('2026-09-06');
    expect(weekStartOf('2026-09-13')).toBe('2026-09-13');
  });
});
