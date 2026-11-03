import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { CompanyProfileView } from '@neway/shared';
import { gte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { companyDocuments, companyProfiles } from '../src/database/schema';

/**
 * Company info (owner, 2026-10-19): a stale profile save is refused, a newer W-9 replaces the old
 * one on the page and both stay, an expired COI keeps the broker packet from going out. Removes
 * the rows it wrote.
 */
describe('Company info (e2e)', () => {
  let app: NestFastifyApplication;
  const started = new Date();
  const headers = { 'content-type': 'application/json' };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const upload = async (name: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/files/raw', headers: { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4 test') });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return (res.json() as { id: string }).id;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 120_000);

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    await db.delete(companyDocuments).where(gte(companyDocuments.createdAt, started));
    await db.delete(companyProfiles).where(gte(companyProfiles.updatedAt, started));
    await app?.close();
  });

  it('saves the profile with a version check and refuses a stale save', async () => {
    const first = (await call('GET', '/api/v1/company/profile')).json() as CompanyProfileView;
    const saved = await call('PATCH', '/api/v1/company/profile', { version: first.version, mcNumber: '123456', trailerYards: [{ id: 'y1', name: 'Joliet yard', address: '100 Yard Rd, Joliet, IL', note: '' }] });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json() as CompanyProfileView;
    expect(after.profile.mcNumber).toBe('123456');
    expect(after.profile.trailerYards[0]?.name).toBe('Joliet yard');
    const stale = await call('PATCH', '/api/v1/company/profile', { version: first.version, mcNumber: '999' });
    expect(stale.statusCode).toBe(409);
  });

  it('keeps every W-9, shows the newest, and holds the packet while a COI is expired', async () => {
    const first = await call('POST', '/api/v1/company/documents', { kind: 'w9', fileId: await upload('w9-old.pdf') });
    expect(first.statusCode, first.body).toBe(201);
    const second = (await call('POST', '/api/v1/company/documents', { kind: 'w9', fileId: await upload('w9-new.pdf') })).json() as CompanyProfileView;
    const w9 = second.documents.find((d) => d.kind === 'w9')!;
    expect(w9.current?.fileName).toBe('w9-new.pdf');
    expect(w9.history.map((h) => h.fileName)).toEqual(['w9-old.pdf']);

    const noExpiry = await call('POST', '/api/v1/company/documents', { kind: 'coi', fileId: await upload('coi.pdf') });
    expect(noExpiry.statusCode).toBe(422);
    const expired = (await call('POST', '/api/v1/company/documents', { kind: 'coi', fileId: await upload('coi.pdf'), expiresOn: '2020-01-01' })).json() as CompanyProfileView;
    expect(expired.documents.find((d) => d.kind === 'coi')?.status).toBe('expired');
    expect(expired.packet.ready).toBe(false);
    expect((await call('POST', '/api/v1/company/packet', {})).statusCode).toBe(422);
  });
});
