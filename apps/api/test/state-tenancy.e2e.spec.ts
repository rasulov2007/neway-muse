import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { LEGACY_WORKSPACE_COMPANY, StateService, storageKeyFor } from '../src/modules/state/state.service';

/**
 * One company's workspace is invisible to another (owner, 2026-10-02).
 *
 * The workspace table had no company: Harbor Line, the second customer, opened NORTHWIND FREIGHT's
 * notifications. NORTHWIND FREIGHT keeps the bare keys it always had; every other company is stored
 * under its own prefix, and nothing one company writes or lists reaches the other.
 */
describe('Workspace state is per company (e2e)', () => {
  let app: NestFastifyApplication;
  let state: StateService;
  const key = `ws2-tenancytest${Date.now().toString(36)}`;
  const other = 'co_tenancy_probe';

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    state = app.get(StateService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the legacy company on its bare keys and prefixes every other company', () => {
    expect(storageKeyFor(LEGACY_WORKSPACE_COMPANY, 'ws2-loads')).toBe('ws2-loads');
    expect(storageKeyFor('co_aj', 'ws2-loads')).toBe('t.co_aj.ws2-loads');
  });

  it('a second company neither reads nor overwrites the first one', async () => {
    await state.putFor(LEGACY_WORKSPACE_COMPANY, key, '"legacy"');
    expect(await state.getFor(other, key)).toBeNull();
    expect((await state.listFor(other, key)).length).toBe(0);
    expect(await state.getManyFor(other, [key])).toEqual([]);

    await state.putFor(other, key, '"other"');
    expect((await state.getFor(LEGACY_WORKSPACE_COMPANY, key))?.value).toBe('"legacy"');
    expect((await state.getFor(other, key))?.value).toBe('"other"');

    // Each list answers in client keys, and only its own.
    expect((await state.listFor(LEGACY_WORKSPACE_COMPANY, key)).map((r) => r.key)).toEqual([key]);
    expect((await state.listFor(other, key)).map((r) => r.key)).toEqual([key]);
    expect((await state.listFor(LEGACY_WORKSPACE_COMPANY, 't')).some((r) => r.key.startsWith('t.'))).toBe(false);
  });

  it('assembles the workspace from the company own rows only', async () => {
    const ws = await state.workspace('co_tenancy_nobody');
    expect(ws).toBeNull();
  });
});
