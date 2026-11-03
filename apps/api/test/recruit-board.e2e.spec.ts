import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { RECRUIT_BOARD_COLUMN_OF, RECRUIT_PROGRESS, recruitBoardColumnOf } from '@neway/shared';
import { ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { hiringLeads } from '../src/database/schema';
import { RecruitService } from '../src/modules/hiring/recruit.service';

/**
 * The candidate pipeline board (owner mockup, 2026-10-15): every active candidate once, in the
 * column its progress maps to, the same people the list counts as active, scoped to the company.
 */
describe('Recruiting board (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  const manager = (): Principal =>
    ({ userId: 'usr_e2e_board', userName: 'E2E Board', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['recruiting.view', 'recruiting.manage']) }) as Principal;

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    const [l] = await app.get(DatabaseService).db.select({ companyId: hiringLeads.companyId }).from(hiringLeads).where(ne(hiringLeads.status, 'dead')).limit(1);
    if (!l) throw new Error('A lead is needed');
    companyId = l.companyId;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('maps every active progress to exactly one column and leaves hired / closed off', () => {
    for (const p of RECRUIT_PROGRESS) {
      if (p === 'hired' || p === 'closed') expect(recruitBoardColumnOf(p)).toBeNull();
      else expect(recruitBoardColumnOf(p)).toBe(RECRUIT_BOARD_COLUMN_OF[p]);
    }
  });

  it('shows each active candidate once, the same set the list counts as active', async () => {
    const recruit = app.get(RecruitService);
    const board = await recruit.board(manager(), { scope: 'all' });
    const keys = board.cards.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Disqualified people sit in their own column (owner, 2026-10-16); everyone else by progress.
    const working = board.cards.filter((c) => c.column !== 'disqualified');
    expect(working.every((c) => c.column === recruitBoardColumnOf(c.progress))).toBe(true);
    expect(board.cards.filter((c) => c.column === 'disqualified').every((c) => c.progress === 'closed')).toBe(true);
    const list = await recruit.list(manager(), { scope: 'all', filter: 'active', page: 1, pageSize: 100 });
    expect(working.length).toBe(list.counts.active);
    // A cost shows only from saved records; none is invented.
    expect(board.cards.every((c) => c.costCents === null || c.costCents >= 0)).toBe(true);
  });

  it('is scoped to the company', async () => {
    const other = { ...manager(), companyId: 'co_does_not_exist' } as Principal;
    const board = await app.get(RecruitService).board(other, { scope: 'all' });
    expect(board.cards).toHaveLength(0);
  });

  it('says how long every card has been on its step, and keeps it on the next read (owner, 2026-10-19)', async () => {
    const svc = app.get(RecruitService);
    const first = await svc.board(manager(), { scope: 'all' });
    for (const c of first.cards) expect(c.stageSince, c.key).toBeTruthy();
    const again = await svc.board(manager(), { scope: 'all' });
    const before = new Map(first.cards.map((c) => [c.key, c.stageSince]));
    for (const c of again.cards) expect(c.stageSince).toBe(before.get(c.key));
  });
});
