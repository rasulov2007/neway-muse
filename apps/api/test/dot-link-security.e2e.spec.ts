import fsCjs from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DotLinkCreated, Lead } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { hiringDotApplications } from '../src/database/schema/hiring';
import { auditLogs } from '../src/database/schema/people';

/*
 * The DOT link as production runs it: HTTPS required (judged through the trusted proxy), and real
 * logging on. Proves a social security number sent through the link appears in no response, no
 * stored column but the sealed one, no audit row and no log line. Its own file, so the app is
 * built with this environment (the env is read once, when the module loads).
 */
// Hoisted above the imports below, so the environment is in place when config/env.ts loads.
vi.hoisted(() => {
  process.env.LOG_LEVEL = 'trace';
  process.env.PUBLIC_LINKS_REQUIRE_HTTPS = 'true';
  process.env.TRUST_PROXY_ADDRESSES = '127.0.0.1';
});

const HIRING = '/api/v1/hiring';
const PUBLIC = '/api/v1/public/dot-application';
const GONE = 'This link has expired or was turned off. Contact your recruiter for a new one.';
const SSN = '987-65-4329';
const SSN_DIGITS = '987654329';

// Everything the process writes to stdout/stderr (pino writes through fs to fd 1; the default
// import is the CommonJS module object every require('fs') shares, so it can be wrapped).
const captured: string[] = [];
const keep = (chunk: unknown) => {
  if (typeof chunk === 'string') captured.push(chunk);
  else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf8'));
};
const originalWriteSync = fsCjs.writeSync;
const originalWrite = fsCjs.write;
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);

describe('DOT link security (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let token = '';
  let caseId = '';
  const stamp = Date.now();

  beforeAll(async () => {
    (fsCjs as { writeSync: unknown }).writeSync = (fd: number, buffer: unknown, ...rest: unknown[]) => {
      if (fd === 1 || fd === 2) keep(buffer);
      return (originalWriteSync as (...a: unknown[]) => number)(fd, buffer, ...rest);
    };
    (fsCjs as { write: unknown }).write = (fd: number, buffer: unknown, ...rest: unknown[]) => {
      if (fd === 1 || fd === 2) keep(buffer);
      return (originalWrite as (...a: unknown[]) => void)(fd, buffer, ...rest);
    };
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      keep(chunk);
      return (originalStdout as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      keep(chunk);
      return (originalStderr as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    app = await createApp();
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
  });

  afterAll(async () => {
    await app?.close();
    (fsCjs as { writeSync: unknown }).writeSync = originalWriteSync;
    (fsCjs as { write: unknown }).write = originalWrite;
    process.stdout.write = originalStdout as typeof process.stdout.write;
    process.stderr.write = originalStderr as typeof process.stderr.write;
  });

  /** Through the proxy: the peer is the trusted nginx, the edge said https. */
  const viaTls = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.7',
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const staff = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload !== undefined ? { 'content-type': 'application/json' } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('makes a link for a new candidate', async () => {
    const lead = (await staff('POST', `${HIRING}/leads`, { firstName: 'Sec', lastName: `Driver${stamp}`, phone: `+1469557${String(stamp).slice(-4)}`, email: `sec.${stamp}@example.com`, source: 'referral' })).json() as Lead;
    await staff('POST', `${HIRING}/leads/${lead.id}/prequalify`, { age23Plus: true, cdlHeldYears: 6, otrExperienceYears: 5, accidents36mo: 0, movingViolations36mo: 0, duiEver: false, endorsements: [], payTypePreference: 'company', homeState: 'TX', earliestStartDate: null });
    caseId = ((await staff('POST', `${HIRING}/leads/${lead.id}/convert`, {})).json() as Lead).hiringCaseId as string;
    const created = (await staff('POST', `${HIRING}/cases/${caseId}/dot-application/link`, {})).json() as DotLinkCreated;
    token = created.url.slice(created.url.lastIndexOf('/') + 1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('answers only over HTTPS, and a client cannot claim HTTPS itself', async () => {
    expect((await viaTls('GET', `${PUBLIC}/${token}`)).statusCode).toBe(200);
    // Plain http straight to the API.
    const plain = await app.inject({ method: 'GET', url: `${PUBLIC}/${token}`, remoteAddress: '127.0.0.1' });
    expect(plain.statusCode).toBe(404);
    expect((plain.json() as { detail: string }).detail).toBe(GONE);
    // An untrusted peer sending X-Forwarded-Proto: https is still plain http.
    const forged = await app.inject({ method: 'GET', url: `${PUBLIC}/${token}`, remoteAddress: '198.51.100.9', headers: { 'x-forwarded-proto': 'https' } });
    expect(forged.statusCode).toBe(404);
    expect((forged.json() as { detail: string }).detail).toBe(GONE);
    // Writes too.
    expect((await app.inject({ method: 'PUT', url: `${PUBLIC}/${token}`, remoteAddress: '198.51.100.9', headers: { 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, payload: { legalFirstName: 'X' } })).statusCode).toBe(404);
  });

  it('an SSN sent through the link is sealed, and never appears in a response, the row, the audit or the logs', async () => {
    const from = captured.length;
    const saved = await viaTls('PUT', `${PUBLIC}/${token}`, { legalFirstName: 'Sec', legalLastName: `Driver${stamp}`, ssn: SSN });
    expect(saved.statusCode, saved.body).toBe(200);
    const bad = await viaTls('PUT', `${PUBLIC}/${token}`, { legalFirstName: 'Sec', ssn: '987-65-43' });
    expect(bad.statusCode).toBe(422);
    const read = await viaTls('GET', `${PUBLIC}/${token}`);
    const staffRead = await staff('GET', `${HIRING}/cases/${caseId}/dot-application`);
    const submit = await viaTls('POST', `${PUBLIC}/${token}/submit`, {});
    expect(submit.statusCode).toBe(422);
    for (const res of [saved, bad, read, staffRead, submit]) {
      expect(res.body).not.toContain(SSN);
      expect(res.body).not.toContain(SSN_DIGITS);
      expect(res.body).not.toContain('987-65-43');
    }
    expect((read.json() as { ssnLast4: string; hasSsn: boolean }).ssnLast4).toBe('4329');

    const [row] = await db.select().from(hiringDotApplications).where(eq(hiringDotApplications.hiringCaseId, caseId));
    expect(row!.ssnLast4).toBe('4329');
    const sealed = JSON.stringify(row!.ssnSealed);
    expect(sealed).toMatch(/[A-Za-z0-9+/=]{16,}/);
    const everythingElse = JSON.stringify({ ...row, ssnSealed: undefined });
    for (const text of [sealed, everythingElse]) {
      expect(text).not.toContain(SSN);
      expect(text).not.toContain(SSN_DIGITS);
    }
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.companyId, row!.companyId));
    const auditText = JSON.stringify(audits);
    expect(auditText).not.toContain(SSN);
    expect(auditText).not.toContain(SSN_DIGITS);

    const logs = captured.slice(from).join('');
    // Logging really was on and saw these requests…
    expect(logs).toContain('/public/dot-application/');
    // …and never the number.
    expect(logs).not.toContain(SSN);
    expect(logs).not.toContain(SSN_DIGITS);
  });
});
