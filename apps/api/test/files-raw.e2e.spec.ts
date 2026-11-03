import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { eq, sql } from 'drizzle-orm';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { restrictedAccessLog } from '../src/database/schema/accidents-v2';
import { safetyCaseDocuments } from '../src/database/schema/safety';
import { accountWithPermissions } from './fleet-reader-account';

/** Test-only cleanup: evidence rows are protected by a trigger (0072) that only the workspace reset may pass. */
async function removeSpecEvidence(db: DatabaseService['db'], ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('neway.workspace_reset', 'on', true)`);
    for (const id of ids) await tx.delete(safetyCaseDocuments).where(eq(safetyCaseDocuments.id, id));
  });
}

/**
 * Raw file uploads (owner, 2026-10-15): the bytes sent as they are, a third smaller than base64 on
 * the wire. Only `/files/raw` takes application/octet-stream; every other route still refuses it.
 */
describe('Files raw upload (e2e)', () => {
  let app: NestFastifyApplication;

  /** Bytes are read the way the browser reads them now: a signed link first, then the link (2026-10-25). */
  async function open(id: string, headers: Record<string, string> = {}) {
    const link = await app.inject({ method: 'GET', url: `/api/v1/files/${id}/link`, headers });
    if (link.statusCode !== 200) return link;
    return app.inject({ method: 'GET', url: (link.json() as { url: string }).url, headers });
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores the bytes with the name and type from the headers, and reads them back', async () => {
    const bytes = Buffer.from('%PDF-1.4 test bill of lading', 'utf8');
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/files/raw',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('BOL № 7 test.pdf'), 'x-file-type': 'application/pdf' },
      payload: bytes,
    });
    expect(up.statusCode).toBe(201);
    const stored = up.json() as { id: string; fileName: string; contentType: string; sizeBytes: number };
    expect(stored).toMatchObject({ fileName: 'BOL № 7 test.pdf', contentType: 'application/pdf', sizeBytes: bytes.byteLength });
    const back = await open(stored.id);
    expect(back.statusCode).toBe(200);
    expect(back.rawPayload.equals(bytes)).toBe(true);
  });

  it('never deletes a file that is evidence on a safety record; a loose one is soft-deleted and restorable (owner, 2026-10-21 / 2026-10-25)', async () => {
    const upload = async (name: string) =>
      (await app.inject({ method: 'POST', url: '/api/v1/files/raw', headers: { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-type': 'application/pdf' }, payload: Buffer.from(`%PDF ${name}`) })).json() as { id: string };
    const evidence = await upload('evidence.pdf');
    const loose = await upload('loose.pdf');
    const db = app.get(DatabaseService).db;
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me' })).json() as { companyId?: string };
    const [row] = (await db.execute(sql`select company_id from stored_files where id = ${evidence.id}`)) as unknown as Array<{ company_id: string }>;
    const docId = `scd_spec_${Date.now()}`;
    await db.insert(safetyCaseDocuments).values({ id: docId, companyId: row?.company_id ?? me.companyId ?? 'co_northwind', caseType: 'accident', caseId: 'acc_spec', fileId: evidence.id, fileName: 'evidence.pdf', contentType: 'application/pdf', title: 'Spec evidence' });
    try {
      // The hard delete is gone altogether.
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/files/${loose.id}` })).statusCode).toBe(404);
      const refused = await app.inject({ method: 'POST', url: `/api/v1/files/${evidence.id}/delete`, payload: { reason: 'spec: try evidence' } });
      expect(refused.statusCode).toBe(409);
      expect((await open(evidence.id)).statusCode).toBe(200);
      const gone = await app.inject({ method: 'POST', url: `/api/v1/files/${loose.id}/delete`, payload: { reason: 'spec: loose upload' } });
      expect(gone.statusCode).toBeLessThan(300);
      expect((await open(loose.id)).statusCode).toBe(404);
      const [kept] = (await db.execute(sql`select deleted_at, delete_reason from stored_files where id = ${loose.id}`)) as unknown as Array<{ deleted_at: string | null; delete_reason: string | null }>;
      expect(kept?.deleted_at).toBeTruthy();
      expect(kept?.delete_reason).toBe('spec: loose upload');
      expect((await app.inject({ method: 'POST', url: `/api/v1/files/${loose.id}/restore`, payload: {} })).statusCode).toBeLessThan(300);
      expect((await open(loose.id)).statusCode).toBe(200);
    } finally {
      await removeSpecEvidence(db, [docId]);
    }
  });

  it('refuses restricted accident evidence to a caller without accidents.restricted, logs the permitted read (go-live 2026-10-22)', async () => {
    const upload = async (name: string) =>
      (await app.inject({ method: 'POST', url: '/api/v1/files/raw', headers: { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-type': 'application/pdf' }, payload: Buffer.from(`%PDF ${name}`) })).json() as { id: string };
    const medical = await upload('medical.pdf');
    const legacyTest = await upload('legacy-test-record.pdf');
    const plain = await upload('scene.pdf');
    const db = app.get(DatabaseService).db;
    const [row] = (await db.execute(sql`select company_id from stored_files where id = ${medical.id}`)) as unknown as Array<{ company_id: string }>;
    const companyId = row!.company_id;
    const stamp = Date.now();
    const caseId = `acc_files_spec_${stamp}`;
    const doc = (id: string, fileId: string, extra: Record<string, unknown>) => ({ id, companyId, caseType: 'accident', caseId, fileId, fileName: 'x.pdf', contentType: 'application/pdf', title: 'Files spec evidence', ...extra });
    await db.insert(safetyCaseDocuments).values([
      doc(`scd_med_${stamp}`, medical.id, { category: 'Medical (restricted)', restricted: true }),
      doc(`scd_dat_${stamp}`, legacyTest.id, { kind: 'test_record' }),
      doc(`scd_scn_${stamp}`, plain.id, { category: 'Scene photo' }),
    ] as never);
    const fleet = { 'x-account': await accountWithPermissions(app, ['accidents.view', 'safety.view'], 'Files restricted fleet') };
    for (const f of [medical, legacyTest]) {
      const refused = await open(f.id, fleet);
      expect(refused.statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: `/api/v1/files/${f.id}`, headers: fleet })).statusCode).toBe(403);
      expect(refused.body).not.toContain('%PDF');
    }
    expect((await open(plain.id, fleet)).statusCode).toBe(200);
    const sm = { 'x-account': await accountWithPermissions(app, ['accidents.view', 'accidents.restricted'], 'Files restricted sm') };
    const ok = await open(medical.id, sm);
    expect(ok.statusCode).toBe(200);
    const logged = await db.select().from(restrictedAccessLog).where(eq(restrictedAccessLog.resource, `file:${medical.id}`));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.accidentId).toBe(caseId);
    await removeSpecEvidence(db, [`scd_med_${stamp}`, `scd_dat_${stamp}`, `scd_scn_${stamp}`]);
  });

  it('refuses an empty body and octet-stream anywhere else', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/v1/files/raw', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(0) });
    expect([400, 422]).toContain(empty.statusCode);
    const elsewhere = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(elsewhere.statusCode).toBe(415);
  });
});
