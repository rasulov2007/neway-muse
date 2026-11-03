import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { SessionFactory, bearer } from './authz/sessions';

/**
 * The workspace snapshot, and the rule that stops it being lost.
 *
 * The bug this suite exists for: work entered in the app reverted to generated demo data a couple
 * of minutes later. The cause was a browser that had failed to read the snapshot writing its own
 * freshly generated dataset over the stored one. The server half of the fix is here — a write that
 * would bury newer work is refused — and the client half is that a browser which could not read
 * the snapshot does not write at all.
 *
 * Since 2026-10-25 every key has its own read/write policy and unknown keys are refused, so the
 * suite writes a real collection (ws2-tasks) in a throwaway company as its administrator.
 */
describe('Workspace state (e2e)', () => {
  let app: NestFastifyApplication;
  const tag = Date.now().toString(36);
  const company = `co_e2e_state_${tag}`;
  const key = 'ws2-tasks';
  let sessions: SessionFactory;
  let token = '';

  async function boot(): Promise<void> {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeAll(async () => {
    await boot();
    sessions = new SessionFactory(app, tag);
    await sessions.company(company, `E2E State ${tag}`);
    token = (await sessions.signIn(company, 'administrator', 'Owner')).token;
  }, 120_000);

  afterAll(async () => {
    await sessions?.archiveAll();
    await app.close();
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/v1/state/${key}`, payload, headers: bearer(token) });
  const get = () => app.inject({ method: 'GET', url: `/api/v1/state/${key}`, headers: bearer(token) });

  it('stores a snapshot and hands back when it was stored', async () => {
    const first = await put({ value: JSON.stringify([{ id: 'one' }]) });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { updatedAt: string }).updatedAt).toBeTruthy();

    const read = await get();
    expect(read.statusCode).toBe(200);
    expect(JSON.parse((read.json() as { value: string }).value)).toEqual([{ id: 'one' }]);
  });

  it('refuses a write from a browser holding an older copy', async () => {
    const stale = (await get()).json() as { updatedAt: string };

    // Somebody else saves newer work.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newer = await put({ value: JSON.stringify([{ id: 'one' }, { id: 'two' }]) });
    expect(newer.statusCode).toBe(200);

    // The first browser, still holding the older copy, tries to save the dataset it has.
    const refused = await put({ value: JSON.stringify([]), ifUnchangedSince: stale.updatedAt });
    expect(refused.statusCode).toBe(409);

    // The newer work is still there, which is the whole point.
    const after = (await get()).json() as { value: string };
    expect(JSON.parse(after.value)).toEqual([{ id: 'one' }, { id: 'two' }]);
  });

  it('accepts a write from a browser that read the current copy', async () => {
    const current = (await get()).json() as { updatedAt: string };
    const accepted = await put({
      value: JSON.stringify([{ id: 'one' }, { id: 'two' }, { id: 'three' }]),
      ifUnchangedSince: current.updatedAt,
    });
    expect(accepted.statusCode).toBe(200);

    const after = (await get()).json() as { value: string };
    expect(JSON.parse(after.value)).toHaveLength(3);
  });

  it('refuses an unknown key, and a value that is not a JSON list or object', async () => {
    const unknown = await app.inject({ method: 'PUT', url: '/api/v1/state/test-snapshot-x', payload: { value: '[]' }, headers: bearer(token) });
    expect(unknown.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/state/test-snapshot-x', headers: bearer(token) })).statusCode).toBe(403);
    expect((await put({ value: 'not json' })).statusCode).toBe(422);
    expect((await put({ value: '42' })).statusCode).toBe(422);
    expect((await put({ value: JSON.stringify([1, 2]) })).statusCode).toBe(422);
  });

  it('keeps the snapshot across a restart of the API', async () => {
    const before = (await get()).json() as { value: string };
    await app.close();
    await boot();
    const after = (await get()).json() as { value: string };
    expect(after.value).toBe(before.value);
  }, 120_000);
});
