import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PtiBoard, PtiDefect, PtiInspection } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';

const BASE = '/api/v1/fleet/pti';

/** A 1×1 PNG, the smallest image that is one. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * The walk-around, end to end: one defect from found to verified, with every rule the brief
 * calls the point of the rebuild exercised against the real API and the real database.
 *
 * Runs as the company owner (administrator, every permission) unless a header says otherwise.
 * Everything it creates it leaves closed, so a second run starts clean.
 */
describe('PTI (e2e)', () => {
  let app: NestFastifyApplication;
  let unitId = '';
  let unitNumber = '';
  let inspection: PtiInspection;
  let defect: PtiDefect;
  let thisWeek = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // A truck with nothing on it yet this week: unreviewed, no open defect, not in the shop. The
    // suite shares the development database, so each run takes the next clean unit.
    const board = (await call('GET', `${BASE}/board`)).json() as PtiBoard;
    const row = board.rows.find(
      (r) => r.inspection.reviewState === 'unreviewed' && r.openDefects.length === 0 && r.inspection.receiptStatus !== 'exempt_in_shop',
    );
    if (!row) throw new Error('No unit on the board is clean enough to test with');
    unitId = row.inspection.unitId;
    unitNumber = row.inspection.unitNumber;
  });

  afterAll(async () => {
    await app.close();
  });

  it('opens the week for every eligible truck, with counts that equal the rows', async () => {
    const response = await call('GET', `${BASE}/board`);
    expect(response.statusCode).toBe(200);
    const board = response.json() as PtiBoard;
    thisWeek = board.weekStart;
    expect(board.rows.length).toBeGreaterThan(0);

    const row = board.rows.find((r) => r.inspection.unitId === unitId);
    expect(row, `a row for unit ${unitNumber}`).toBeDefined();
    inspection = (row as NonNullable<typeof row>).inspection;
    expect(inspection.reviewState).toBe('unreviewed');
    expect(inspection.reviewResult).toBeNull();

    // The queue counts are counts of rows, and reconcile with the rows themselves (§7.1).
    const chase = board.rows.filter((r) => r.inspection.receiptStatus === 'missing').length;
    expect(board.queues.chase).toBe(chase);
    const review = board.rows.filter(
      (r) => ['received', 'late'].includes(r.inspection.receiptStatus) && r.inspection.reviewState !== 'reviewed',
    ).length;
    expect(board.queues.review).toBe(review);
  });

  it('rejects a source that is not a Telegram message link, and accepts one that is', async () => {
    const bad = await call('POST', `${BASE}/inspections/${inspection.id}/receipt`, {
      version: inspection.version,
      receivedAt: new Date().toISOString(),
      source: { chatTitle: 'NWF Drivers', messageUrl: 'https://drive.google.com/file/d/abc' },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.body).toMatch(/t\.me/);

    const good = await call('POST', `${BASE}/inspections/${inspection.id}/receipt`, {
      version: inspection.version,
      receivedAt: new Date().toISOString(),
      source: { chatTitle: 'NWF Drivers', messageUrl: 'https://t.me/c/1234567890/456', senderName: 'Luis' },
    });
    expect(good.statusCode, good.body).toBe(201);
    inspection = good.json() as PtiInspection;
    expect(inspection.source?.messageUrl).toBe('https://t.me/c/1234567890/456');
    // Received after Wednesday of the week is late - a fact about receipt, not about review.
    expect(['received', 'late']).toContain(inspection.receiptStatus);
    expect(inspection.reviewState).toBe('unreviewed');
  });

  // The screenshot rule (§3.3) was lifted by the owner on 2026-10-05: no defect is refused for
  // lacking one, so the old "refuses an out-of-service defect with no screenshot" case is gone.

  it('refuses the junk descriptions that were live on the board, by any path', async () => {
    for (const text of ['65', '.+6.', '111111111111', '2222222222222222222', '65464']) {
      const direct = await call('POST', `${BASE}/defects`, { unitId, component: 'brakes', description: text, severity: 'monitor' });
      expect(direct.statusCode, `${text}: ${direct.body}`).toBe(422);
      expect(direct.body, text).toMatch(/description/i);
      const viaReview = await call('POST', `${BASE}/inspections/${inspection.id}/review`, {
        version: inspection.version,
        result: 'issues_found',
        defects: [{ component: 'brakes', description: text, severity: 'monitor' }],
      });
      expect(viaReview.statusCode, `${text}: ${viaReview.body}`).toBe(422);
    }
  });

  it('saves the defect with a screenshot, dated for today, and the unit goes out of service', async () => {
    const upload = await call('POST', '/api/v1/files', { fileName: 'brakes-04-18.png', content: PNG });
    expect(upload.statusCode, upload.body).toBe(201);
    const file = upload.json() as { id: string; fileName: string };

    const response = await call('POST', `${BASE}/inspections/${inspection.id}/review`, {
      version: inspection.version,
      result: 'issues_found',
      defects: [
        {
          component: 'brakes',
          description: 'Slack adjuster out of stroke on axle 3',
          severity: 'oos_risk',
          evidence: {
            clipTime: '04:18',
            screenshots: [{ fileId: file.id, fileName: file.fileName, uploadedAt: new Date().toISOString(), uploadedBy: 'test' }],
          },
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(201);
    const saved = response.json() as { inspection: PtiInspection; defects: PtiDefect[] };
    inspection = saved.inspection;
    expect(inspection.reviewState).toBe('reviewed');
    expect(inspection.reviewResult).toBe('issues_found');
    expect(saved.defects).toHaveLength(1);
    defect = saved.defects[0] as PtiDefect;
    expect(defect.defectNumber).toMatch(/^DEF-\d{4}$/);
    expect(defect.state).toBe('open');
    expect(defect.severity).toBe('oos_risk');
    expect(defect.component).toBe('brakes');
    expect(defect.evidence.screenshots[0]?.fileId).toBe(file.id);
    expect(defect.dueAt?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));

    const status = (await call('GET', `${BASE}/units/${unitId}/status`)).json() as { verdict: { status: string; reason: string; dispatchBlocked: boolean } };
    expect(status.verdict.status).toBe('out_of_service');
    expect(status.verdict.dispatchBlocked).toBe(true);
    expect(status.verdict.reason).toBe(`hold: ${defect.defectNumber}`);
  });

  it('a defect is given to an account, which is the step out of "open"', async () => {
    const assignees = (await call('GET', `${BASE}/assignees`)).json() as { id: string; name: string; roles: string[] }[];
    expect(assignees.length).toBeGreaterThan(0);
    expect(assignees.every((a) => a.name.trim().length > 0 && Array.isArray(a.roles))).toBe(true);
    const owner = assignees.find((a) => a.roles.includes('administrator')) ?? assignees[0];
    if (!owner) throw new Error('no assignee');

    const stranger = await call('PATCH', `${BASE}/defects/${defect.id}`, { version: defect.version, ownerId: 'usr_nobody' });
    expect(stranger.statusCode, stranger.body).toBe(422);

    const assigned = await call('PATCH', `${BASE}/defects/${defect.id}`, { version: defect.version, ownerId: owner.id });
    expect(assigned.statusCode, assigned.body).toBe(200);
    defect = assigned.json() as PtiDefect;
    expect(defect.ownerId).toBe(owner.id);
    expect(defect.ownerName).toBe(owner.name);
    expect(defect.state).toBe('assigned');
  });

  it('dispatching over the hold is a named, reasoned, logged decision that releases nothing (§9.1)', async () => {
    const url = `${BASE}/units/${unitId}/dispatch-override`;
    const unsaid = await call('POST', url, { loadRef: 'L-2049', reason: '' });
    expect(unsaid.statusCode, unsaid.body).toBe(422);
    const junk = await call('POST', url, { loadRef: 'L-2049', reason: '111111' });
    expect(junk.statusCode, junk.body).toBe(422);

    const overridden = await call('POST', url, { loadRef: 'L-2049', reason: 'Loaded and 40 miles from the shop; brakes checked by hand at the yard' });
    expect(overridden.statusCode, overridden.body).toBe(201);
    const result = overridden.json() as { overridden: boolean; verdict: { status: string } };
    expect(result.overridden).toBe(true);
    // The hold stands. The override is on the defect's history, not in its state.
    expect(result.verdict.status).toBe('out_of_service');
    const after = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    expect(after.state).toBe('assigned');
    expect(after.history.at(-1)?.note).toMatch(/Dispatched on L-2049 over the hold/);
    expect(after.history.at(-1)?.note).toMatch(/40 miles/);
  });

  it('a work order opened for the defect is linked both ways, and closing it releases nothing (WP6)', async () => {
    const current = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    const wrongUnit = (await call('GET', '/api/v1/trucks?pageSize=200')).json() as { data: { id: string }[] };
    const other = wrongUnit.data.find((t) => t.id !== unitId);
    if (other) {
      const refused = await call('POST', '/api/v1/fleet/work-orders', {
        assetType: 'truck',
        unitId: other.id,
        status: 'in_shop',
        workType: 'repair',
        defectId: defect.id,
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.body).toContain(current.defectNumber);
    }

    const opened = await call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'truck',
      unitId,
      status: 'in_shop',
      workType: 'repair',
      notes: `Raised from ${current.defectNumber}`,
      defectId: defect.id,
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const order = opened.json() as { id: string; number: string; defectId: string | null };
    expect(order.defectId).toBe(defect.id);

    // The defect points back, and followed the order into the shop.
    const linked = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    expect(linked.workOrderId).toBe(order.id);
    expect(linked.workOrderNumber).toBe(order.number);
    expect(linked.state).toBe('in_repair');
    const detail = (await call('GET', `/api/v1/fleet/work-orders/${order.id}`)).json() as { defectId: string | null };
    expect(detail.defectId).toBe(defect.id);

    // The shop closes the order: the defect is proposed for verification and the hold stands.
    const closed = await call('POST', `/api/v1/fleet/work-orders/${order.id}/complete`, { workDone: 'Slack adjuster replaced, brakes adjusted' });
    expect(closed.statusCode, closed.body).toBe(201);
    const after = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    expect(after.state).toBe('fixed_pending_verify');
    expect(after.resolution.fixedVia).toBe('work_order');
    expect(after.resolution.verifiedAt).toBeNull();
    const status = (await call('GET', `${BASE}/units/${unitId}/status`)).json() as { verdict: { status: string } };
    expect(status.verdict.status).toBe('out_of_service');
    defect = after;
  });

  it('is not there when fleet_v2 is off', async () => {
    setFeatureFlagForTests('fleet_v2', false);
    try {
      const response = await call('GET', `${BASE}/board`);
      expect(response.statusCode).toBe(404);
    } finally {
      setFeatureFlagForTests('fleet_v2', null);
    }
  });

  it('a clean review the next week cannot save until the open defect is dispositioned, and then resolves nothing (§4.3)', async () => {
    const next = new Date(`${thisWeek}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    const board = (await call('GET', `${BASE}/board?week=${next.toISOString().slice(0, 10)}`)).json() as PtiBoard;
    const row = board.rows.find((r) => r.inspection.unitId === unitId) as NonNullable<(typeof board.rows)[number]>;
    expect(row.openDefects.map((d) => d.id)).toContain(defect.id);
    expect(row.verdict.status).toBe('out_of_service');

    const blocked = await call('POST', `${BASE}/inspections/${row.inspection.id}/review`, {
      version: row.inspection.version,
      result: 'no_issues',
    });
    expect(blocked.statusCode, blocked.body).toBe(422);
    expect(blocked.body).toContain(defect.defectNumber);

    const clean = await call('POST', `${BASE}/inspections/${row.inspection.id}/review`, {
      version: row.inspection.version,
      result: 'no_issues',
      dispositions: [{ defectId: defect.id, seen: 'still_present' }],
    });
    expect(clean.statusCode, clean.body).toBe(201);
    // "Still present" changes nothing: the defect is where the shop left it, awaiting verification.
    const after = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    expect(after.state).toBe('fixed_pending_verify');
    const status = (await call('GET', `${BASE}/units/${unitId}/status`)).json() as { verdict: { status: string } };
    expect(status.verdict.status).toBe('out_of_service');
  });

  it('"looks fixed" proposes closure and lifts nothing (§4.4)', async () => {
    // Back in repair first: the shop found more to do. Then the reviewer sees it fixed on a video.
    let current = (await call('GET', `${BASE}/defects/${defect.id}`)).json() as PtiDefect;
    const reopened = await call('POST', `${BASE}/defects/${defect.id}/transition`, { version: current.version, to: 'in_repair', note: 'More to do' });
    expect(reopened.statusCode, reopened.body).toBe(201);
    current = reopened.json() as PtiDefect;
    const proposed = await call('POST', `${BASE}/defects/${defect.id}/transition`, {
      version: current.version,
      to: 'fixed_pending_verify',
      fixedVia: 'yard',
      note: 'Adjusted at the yard',
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    defect = proposed.json() as PtiDefect;
    expect(defect.state).toBe('fixed_pending_verify');
    expect(defect.resolution.fixedVia).toBe('yard');
    expect(defect.resolution.verifiedAt).toBeNull();

    const status = (await call('GET', `${BASE}/units/${unitId}/status`)).json() as { verdict: { status: string } };
    expect(status.verdict.status).toBe('out_of_service');
  });

  it('only a person with safety.manage verifies, and only that lifts the hold', async () => {
    // Somebody who works the board but is not safety: maintenance.edit without safety.manage.
    // The shop proposes; it does not verify its own work (§4.4).
    const accounts = (await call('GET', '/api/v1/admin/users?pageSize=100')).json() as {
      data: { membershipId: string; status: string; isOwner: boolean }[];
    };
    let shop: string | null = null;
    for (const account of accounts.data.filter((a) => a.status === 'active' && !a.isOwner)) {
      const permissions = (await call('GET', `/api/v1/admin/users/${account.membershipId}/permissions`)).json() as string[];
      if (permissions.includes('maintenance.edit') && !permissions.includes('safety.manage')) {
        shop = account.membershipId;
        break;
      }
    }
    if (shop) {
      const denied = await call(
        'POST',
        `${BASE}/defects/${defect.id}/transition`,
        { version: defect.version, to: 'verified' },
        { 'x-account': shop },
      );
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toMatch(/safety\.manage/);
    }
    // And somebody with no fleet permission at all is stopped at the door.
    const stranger = await call(
      'POST',
      `${BASE}/defects/${defect.id}/transition`,
      { version: defect.version, to: 'verified' },
      { 'x-demo-role': 'operations' },
    );
    expect(stranger.statusCode).toBe(403);

    const verified = await call('POST', `${BASE}/defects/${defect.id}/transition`, { version: defect.version, to: 'verified' });
    expect(verified.statusCode, verified.body).toBe(201);
    defect = verified.json() as PtiDefect;
    expect(defect.state).toBe('verified');
    expect(defect.resolution.verifiedAt).not.toBeNull();
    expect(defect.history.map((h) => h.to)).toEqual(['open', 'assigned', 'assigned', 'in_repair', 'fixed_pending_verify', 'fixed_pending_verify', 'in_repair', 'fixed_pending_verify', 'verified']);

    const status = (await call('GET', `${BASE}/units/${unitId}/status`)).json() as { verdict: { status: string; defectIds: string[] } };
    expect(status.verdict.status).toBe('cleared');
    expect(status.verdict.defectIds).toEqual([]);

    // Terminal: nothing reopens it.
    const reopened = await call('POST', `${BASE}/defects/${defect.id}/transition`, { version: defect.version, to: 'open' });
    expect(reopened.statusCode, reopened.body).toBe(409);
  });

  it('refuses a stale version rather than overwriting somebody else', async () => {
    const stale = await call('PATCH', `${BASE}/defects/${defect.id}`, { version: 1, ownerId: null });
    expect(stale.statusCode, stale.body).toBe(409);
  });
});
