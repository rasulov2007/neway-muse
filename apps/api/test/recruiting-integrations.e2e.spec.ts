import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { CandidateJourney, ConsentFormContext, LinkDeliveryView } from '@neway/shared';
import { SAFETY_SCREENING_QUESTIONS } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { env } from '../src/config/env';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { integrationAccounts, memberships, membershipRoles, notifications, users } from '../src/database/schema/admin';
import { auditLogs } from '../src/database/schema/people';
import { hiringConsentDocuments, hiringConsentSessions, hiringLinkDeliveries, smsPreferences } from '../src/database/schema/hiring';
import { companies } from '../src/database/schema/roster';
import { twilioSignature } from '../src/modules/admin/connectors/twilio.client';
import { hashPassword } from '../src/modules/auth/password.util';
import { CLEARINGHOUSE_OFFICIAL_SENTENCES } from '../src/modules/hiring/consent-disclosures';
import { isSignedDocumentUrl, signedGet } from './authz/signed-get';

const R = '/api/v1/hiring/recruiting';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.4\n% report\n1 0 obj << >> endobj\n%%EOF\n');
const SID = `AC${'1'.repeat(32)}`;
const TOKEN = `tok_${randomBytes(12).toString('hex')}`;
const FROM = '+15125550100';
const FROM_SID = `PN${'2'.repeat(32)}`;
const SERVICE = `MG${'3'.repeat(32)}`;
const BAD_NUMBER = '+15005550001';
const UNSUBSCRIBED = '+15005550004';
const EMPLOYER = 'NORTHWIND FREIGHT INC.';

type Part = { name: string; value: string } | { name: string; fileName: string; type: string; bytes: Buffer };
function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----NewayIntegrations${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('value' in p) chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`), Buffer.from(p.value, 'utf8'));
    else chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.fileName}"\r\nContent-Type: ${p.type}\r\n\r\n`), p.bytes);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Local stand-ins for Twilio (REST + Messaging API) and Microsoft 365 (sign-in + Graph sendMail):
 * the real client code runs against them and nothing leaves the machine.
 */
class FakeProviders {
  server!: Server;
  url = '';
  sent: Record<string, string>[] = [];
  statusOf = new Map<string, string>();
  campaign = 'PENDING';
  mails: { from: string; body: Record<string, unknown> }[] = [];
  graphRefuses = false;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    // Microsoft 365
    if (req.method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(url)) return json(200, { access_token: 'graph-token', expires_in: 3600 });
    const mail = url.match(/^\/v1\.0\/users\/([^/]+)\/sendMail$/);
    if (req.method === 'POST' && mail) {
      if (req.headers.authorization !== 'Bearer graph-token') return json(401, { error: { code: 'InvalidAuthenticationToken' } });
      if (this.graphRefuses) return json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } });
      this.mails.push({ from: decodeURIComponent(mail[1]!), body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(202, { 'request-id': randomUUID() });
      return void res.end();
    }
    // Twilio
    if (req.headers.authorization !== `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`) return json(401, { code: 20003, message: 'Authenticate', status: 401 });
    const base = `/2010-04-01/Accounts/${SID}`;
    if (req.method === 'GET' && url === `${base}.json`) return json(200, { sid: SID, friendly_name: 'Northwind Recruiting', status: 'active' });
    if (req.method === 'GET' && url.startsWith(`${base}/IncomingPhoneNumbers.json`)) {
      return json(200, { incoming_phone_numbers: url.includes(encodeURIComponent(FROM)) ? [{ sid: FROM_SID, phone_number: FROM, capabilities: { sms: true } }] : [] });
    }
    if (req.method === 'GET' && url.startsWith('/v1/Services?')) return json(200, { services: [{ sid: SERVICE }], meta: {} });
    if (req.method === 'GET' && url.startsWith(`/v1/Services/${SERVICE}/PhoneNumbers`)) return json(200, { phone_numbers: [{ sid: FROM_SID, phone_number: FROM }] });
    if (req.method === 'GET' && url === `/v1/Services/${SERVICE}/Compliance/Usa2p`) return json(200, { compliance: [{ sid: 'QE1', campaign_status: this.campaign }] });
    if (req.method === 'POST' && url === `${base}/Messages.json`) {
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (form.To === BAD_NUMBER) return json(400, { code: 21211, message: "The 'To' number +15005550001 is not a valid phone number.", status: 400 });
      if (form.To === UNSUBSCRIBED) return json(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 });
      const sid = `SM${randomBytes(16).toString('hex')}`;
      this.sent.push({ ...form, sid });
      this.statusOf.set(sid, 'queued');
      return json(201, { sid, status: 'queued', error_code: null, error_message: null });
    }
    const m = url.match(/\/Messages\/(SM[0-9a-f]{32})\.json$/);
    if (req.method === 'GET' && m) return json(200, { sid: m[1], status: this.statusOf.get(m[1]!) ?? 'queued', error_code: null, error_message: null });
    json(404, { code: 20404, message: 'Not found' });
  }
}

/**
 * Recruiting integrations (owner brief, 2026-10-11, parts two and three), in a company of its own so
 * nothing here (a connected Twilio account above all) leaks into other suites: links sent by SMS and
 * email with Sent / Delivered / Failed; a failed resend leaves the earlier link working; SMS only
 * with a recorded opt-in, never after STOP, and only from a sender carriers will accept; email through
 * Microsoft 365; the FMCSA limited consent signed word for word with the company scope; the
 * pre-employment full query as its own requirement; Safety checks Requested → Reviewed.
 */
describe('Recruiting integrations (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const fake = new FakeProviders();
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const companyId = `co_e2e_int_${stamp}`;
  const ownerEmail = `int.owner.${stamp}@test.local`;
  const recruiterEmail = `int.recruiter.${stamp}@test.local`;
  const password = `Int-${randomBytes(12).toString('base64url')}`;
  // Real sign-ins: the dev account header only reaches the demo company, and this suite has its own.
  const owner: Record<string, string> = {};
  const recruiter: Record<string, string> = {};
  let ipSeq = 1;
  const nextIp = () => `10.62.${Math.floor(ipSeq / 250)}.${(ipSeq += 1) % 250}`;
  const saved = { ...env };
  let twilioAccountId = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = owner) =>
    method === 'GET' && isSignedDocumentUrl(url) ? signedGet(app, url, headers) : app.inject({ method, url, remoteAddress: nextIp(), headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers }, payload: payload as object | undefined });
  const postForm = (url: string, parts: Part[]) => {
    const { body, contentType } = multipart(parts);
    return app.inject({ method: 'POST', url, remoteAddress: nextIp(), headers: { 'content-type': contentType }, payload: body });
  };
  const journey = async (key: string, headers: Record<string, string> = owner) => (await call('GET', `${R}/candidates/${key}/journey`, undefined, headers)).json() as CandidateJourney;
  const sendLink = (key: string, body: Record<string, unknown>, headers = recruiter) => call('POST', `${R}/candidates/${key}/journey/deliveries`, body, headers);
  const form = (token: string) => call('POST', '/api/v1/public/consent/form', { token }, {});
  const lastToken = () => fake.sent.at(-1)!.Body!.match(/#token=([A-Za-z0-9_-]{43})/)![1]!;

  async function lead(name: string): Promise<string> {
    // A number no lead has yet in this database (other suites add 469 leads too).
    let phone = '';
    for (let i = 0; i < 50 && !phone; i += 1) {
      const candidate = `+1469${String(Math.floor(2_000_000 + Math.random() * 7_999_999))}`;
      const found = (await call('GET', `/api/v1/hiring/leads?search=${candidate.slice(2)}&pageSize=5`)).json() as { data: unknown[] };
      if (found.data.length === 0) phone = candidate;
    }
    const res = await call('POST', `${R}/leads`, { fullName: `${name} Int${stamp}`, phone, email: `${name.toLowerCase()}.${stamp}@example.com`, source: 'instagram' });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { key: string }).key;
  }

  async function signConsent(token: string, opts: { withClearinghouse?: boolean } = {}): Promise<ConsentFormContext> {
    const ctx = (await form(token)).json() as ConsentFormContext;
    const docs = ctx.disclosures.filter((d) => opts.withClearinghouse !== false || d.type !== 'clearinghouse');
    const parts: Part[] = Object.entries({
      token,
      submissionKey: randomUUID(),
      firstName: ctx.firstName,
      lastName: ctx.lastName,
      phone: '(469) 555-0177',
      email: `signed.${stamp}@example.com`,
      confirmed: 'true',
      signatureMethod: 'typed',
      signatureText: `${ctx.firstName} ${ctx.lastName}`,
      clientSignedAt: new Date().toISOString(),
      documents: JSON.stringify(docs.map((d) => ({ type: d.type, version: d.version, sha256: d.sha256 }))),
      safetyAnswers: JSON.stringify(Object.fromEntries(SAFETY_SCREENING_QUESTIONS.map((q) => [q.key, false]))),
    }).map(([name, value]) => ({ name, value }));
    parts.push({ name: 'cdlFront', fileName: 'cdl-front.jpg', type: 'image/jpeg', bytes: JPEG }, { name: 'cdlBack', fileName: 'cdl-back.jpg', type: 'image/jpeg', bytes: JPEG });
    const res = await postForm('/api/v1/public/consent/submit', parts);
    expect(res.statusCode, res.body).toBe(201);
    return ctx;
  }

  beforeAll(async () => {
    await fake.start();
    Object.assign(env, {
      TWILIO_API_BASE: fake.url,
      TWILIO_MESSAGING_API_BASE: fake.url,
      GRAPH_API_BASE: fake.url,
      GRAPH_LOGIN_BASE: fake.url,
      // Twilio only calls public HTTPS addresses; the links and the callbacks are built from this.
      PUBLIC_APP_BASE_URL: 'https://tms.example.test',
      EMAIL_TRANSPORT: undefined,
    });
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;

    // A company of its own, with an administrator, so nothing here reaches another suite.
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: `TEST · Integrations ${stamp}`, timezone: 'America/New_York', weekStart: 'monday' });
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id: `usr_int_${stamp}`, email: ownerEmail, firstName: 'Ida', lastName: `Owner${stamp}`, phone: null, passwordHash, mustChangePassword: false, isActive: true });
    await db.insert(memberships).values({ id: `mbr_int_${stamp}`, companyId, userId: `usr_int_${stamp}`, employeeId: null, status: 'active', isOwner: true, acceptedAt: now });
    await db.insert(membershipRoles).values({ membershipId: `mbr_int_${stamp}`, roleId: 'rol_administrator', assignedByName: 'integrations e2e' });
    const signIn = async (email: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: nextIp(), payload: { email, password } });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
    };
    Object.assign(owner, await signIn(ownerEmail));

    const role = await call('POST', '/api/v1/admin/roles', { name: `Integrations recruiter ${stamp}`, permissions: ['recruiting.view', 'recruiting.manage'] });
    expect(role.statusCode, role.body).toBe(201);
    const created = await call('POST', '/api/v1/admin/users', { firstName: 'Rae', lastName: `Int${stamp}`, email: recruiterEmail, phone: null, employeeId: null, roleIds: [(role.json() as { id: string }).id], invite: false });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'integrations e2e' })).statusCode).toBe(200);
    await db.update(users).set({ mustChangePassword: false, passwordHash }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    Object.assign(recruiter, await signIn(recruiterEmail));
    expect((await call('PATCH', '/api/v1/admin/settings', { values: { 'hiring.clearinghouse_employer_name': EMPLOYER } })).statusCode).toBeLessThan(300);
  }, 180_000);

  afterAll(async () => {
    if (twilioAccountId) await db.update(integrationAccounts).set({ status: 'disabled' }).where(eq(integrationAccounts.id, twilioAccountId));
    Object.assign(env, saved);
    await app.close();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  let key = '';
  let phone = '';
  it('without a provider nothing is sent and nothing says "sent"; the reason is exact and Copy link still works', async () => {
    key = await lead('Casey');
    const j = await journey(key);
    phone = j.deliveries.sms.phone!;
    expect(j.deliveries.channels.sms).toMatchObject({ available: false, reason: expect.stringMatching(/no Twilio account/) });
    expect(j.deliveries.channels.email).toMatchObject({ available: false, reason: expect.stringMatching(/EMAIL_TRANSPORT=graph/) });
    for (const channel of ['sms', 'email'] as const) {
      const res = await sendLink(key, { link: 'consent', channel });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { detail: string }).detail).toMatch(/Copy the link/);
    }
    expect(await db.select().from(hiringConsentSessions).where(eq(hiringConsentSessions.leadId, key))).toHaveLength(0);
    expect((await journey(key)).deliveries.items).toHaveLength(0);
    expect((await call('POST', `${R}/candidates/${key}/journey/consent/link`, {}, recruiter)).statusCode).toBe(201);
  });

  it('Twilio: the token is sealed; "Test" proves the credential and, separately, whether carriers will take the sender', async () => {
    const res = await call('POST', '/api/v1/admin/integrations/connect', { provider: 'twilio', name: `Twilio ${stamp}`, credentials: { accountSid: SID, authToken: TOKEN, fromNumber: FROM } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.body).not.toContain(TOKEN);
    twilioAccountId = (res.json() as { account: { id: string } }).account.id;
    const [row] = await db.select().from(integrationAccounts).where(eq(integrationAccounts.id, twilioAccountId));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect((await journey(key)).deliveries.channels.sms.reason).toMatch(/Test connection/);

    // The A2P 10DLC campaign is still pending: the credential works, SMS stays off.
    const pending = await call('POST', `/api/v1/admin/integrations/accounts/${twilioAccountId}/test`, {});
    expect(pending.statusCode, pending.body).toBeLessThan(300);
    expect(pending.body).toMatch(/SMS stays off/);
    expect(pending.body).toContain(`/api/v1/public/sms/twilio/inbound/${twilioAccountId}`);
    expect((await journey(key)).deliveries.channels.sms).toMatchObject({ available: false, reason: expect.stringMatching(/A2P 10DLC campaign is not verified/) });

    fake.campaign = 'VERIFIED';
    const ready = await call('POST', `/api/v1/admin/integrations/accounts/${twilioAccountId}/test`, {});
    expect(ready.body).toMatch(/sender ready/);
    const j = await journey(key);
    expect(j.deliveries.channels.sms).toMatchObject({ available: true, via: expect.stringMatching(/^Twilio/) });
    expect(JSON.stringify(j)).not.toContain(TOKEN);
  });

  it('a text needs the recorded opt-in; STOP ends it and only START brings it back; staff cannot override a STOP', async () => {
    const none = await sendLink(key, { link: 'consent', channel: 'sms' });
    expect(none.statusCode).toBe(409);
    expect((none.json() as { detail: string }).detail).toMatch(/No texting consent/);
    expect((await call('POST', `${R}/candidates/${key}/journey/sms-consent`, { action: 'opt_in' }, recruiter)).statusCode).toBe(422);
    const optIn = await call('POST', `${R}/candidates/${key}/journey/sms-consent`, { action: 'opt_in', source: 'verbal', note: 'Agreed on the intro call' }, recruiter);
    expect(optIn.statusCode, optIn.body).toBe(200);
    expect(optIn.json()).toMatchObject({ status: 'opted_in', optedInSource: 'verbal' });

    const url = `https://tms.example.test/api/v1/public/sms/twilio/inbound/${twilioAccountId}`;
    const reply = (Body: string, sign = true) => {
      const params = { From: phone, To: FROM, Body, AccountSid: SID, MessageSid: `SM${'9'.repeat(32)}` };
      return app.inject({ method: 'POST', url: `/api/v1/public/sms/twilio/inbound/${twilioAccountId}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign ? twilioSignature(TOKEN, url, params) : 'forged' }, payload: new URLSearchParams(params).toString() });
    };
    expect((await reply('STOP', false)).statusCode).toBe(403);
    expect((await journey(key)).deliveries.sms.status).toBe('opted_in');
    const stop = await reply('Stop');
    expect(stop.statusCode).toBe(200);
    expect(stop.body).toContain('<Response>');
    expect((await journey(key)).deliveries.sms).toMatchObject({ status: 'opted_out', optedOutSource: 'reply_stop' });
    const blocked = await sendLink(key, { link: 'consent', channel: 'sms' });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { detail: string }).detail).toMatch(/opted out of texts \(STOP\)/);
    expect((await call('POST', `${R}/candidates/${key}/journey/sms-consent`, { action: 'opt_in', source: 'verbal' }, recruiter)).statusCode).toBe(409);
    expect((await reply('START')).statusCode).toBe(200);
    expect((await journey(key)).deliveries.sms.status).toBe('opted_in');
  });

  let first: LinkDeliveryView;
  it('Send consent by SMS: Sent, then Delivered on Check status; the token lives only in the text', async () => {
    const res = await sendLink(key, { link: 'consent', channel: 'sms' });
    expect(res.statusCode, res.body).toBe(200);
    first = res.json() as LinkDeliveryView;
    expect(first).toMatchObject({ link: 'consent', channel: 'sms', status: 'sent', provider: 'twilio', linkLive: true, recipient: phone });
    const msg = fake.sent.at(-1)!;
    expect(msg.From).toBe(FROM);
    expect(msg.Body).toMatch(/https:\/\/tms\.example\.test\/consent\/#token=[A-Za-z0-9_-]{43}/);
    expect(msg.StatusCallback).toBe(`https://tms.example.test/api/v1/public/sms/twilio/status/${first.id}`);
    const token = lastToken();
    const [row] = await db.select().from(hiringLinkDeliveries).where(eq(hiringLinkDeliveries.id, first.id));
    expect(JSON.stringify(row)).not.toContain(token);
    expect((await form(token)).statusCode).toBe(200);
    fake.statusOf.set(row!.providerMessageId!, 'delivered');
    const checked = await call('POST', `${R}/candidates/${key}/journey/deliveries/${first.id}/refresh`, {}, recruiter);
    expect(checked.json()).toMatchObject({ status: 'delivered' });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.action, 'link_delivery_delivered')));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('a resend that fails leaves the earlier link working; Twilio’s reasons are kept; 21610 records the STOP', async () => {
    const working = lastToken();
    // Both stand-in numbers carry an opt-in, so what is tested is Twilio's answer.
    for (const n of [BAD_NUMBER, UNSUBSCRIBED]) {
      await db.insert(smsPreferences).values({ companyId, phone: n, status: 'opted_in', optedInAt: new Date(), optedInBy: 'e2e', optedInSource: 'written' }).onConflictDoNothing();
    }
    const failed = (await sendLink(key, { link: 'consent', channel: 'sms', to: BAD_NUMBER })).json() as LinkDeliveryView;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/not a valid phone number\. \(code 21211\)/);
    // Nothing was accepted, so the driver's current link still opens.
    expect((await form(working)).statusCode).toBe(200);
    expect((await journey(key)).consent.session?.state).toBe('live');
    expect((await journey(key)).deliveries.items.find((d) => d.id === first.id)?.linkLive).toBe(true);

    // The unsubscribed number: Twilio says 21610, which becomes that number's STOP.

    const unsub = (await sendLink(key, { link: 'consent', channel: 'sms', to: UNSUBSCRIBED })).json() as LinkDeliveryView;
    expect(unsub.status).toBe('failed');
    const blockedAfter = await sendLink(key, { link: 'consent', channel: 'sms', to: UNSUBSCRIBED });
    expect((blockedAfter.json() as { detail: string }).detail).toMatch(/opted out/);
    expect((await form(working)).statusCode).toBe(200);

    // A resend that is accepted turns the earlier link off.
    const again = (await call('POST', `${R}/candidates/${key}/journey/deliveries/${first.id}/resend`, {}, recruiter)).json() as LinkDeliveryView;
    expect(again).toMatchObject({ status: 'sent', resendOfId: first.id, linkLive: true });
    expect((await form(working)).statusCode).not.toBe(200);
  });

  it('Twilio callbacks are believed only when signed, and never move a message backwards', async () => {
    const latest = (await journey(key)).deliveries.items.find((d) => d.status === 'sent' && d.channel === 'sms')!;
    const [row] = await db.select().from(hiringLinkDeliveries).where(eq(hiringLinkDeliveries.id, latest.id));
    const url = `https://tms.example.test/api/v1/public/sms/twilio/status/${latest.id}`;
    const post = (params: Record<string, string>, signature: string) =>
      app.inject({ method: 'POST', url: `/api/v1/public/sms/twilio/status/${latest.id}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, payload: new URLSearchParams(params).toString() });
    const delivered = { MessageSid: row!.providerMessageId!, MessageStatus: 'delivered', AccountSid: SID };
    expect((await post(delivered, 'forged')).statusCode).toBe(403);
    expect((await post(delivered, twilioSignature(TOKEN, url, delivered))).statusCode).toBe(204);
    const late = { ...delivered, MessageStatus: 'sent' };
    expect((await post(late, twilioSignature(TOKEN, url, late))).statusCode).toBe(204);
    expect((await journey(key)).deliveries.items.find((d) => d.id === latest.id)?.status).toBe('delivered');
  });

  it('email through Microsoft 365 (Graph): an HTML email, recorded as Sent — accepted, not delivered; a refusal says why', async () => {
    Object.assign(env, { EMAIL_TRANSPORT: 'graph', GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'secret-1', SMTP_FROM: 'recruiting@northwind-freight.example' });
    try {
      const status = (await call('GET', '/api/v1/admin/email')).json() as { kind: string; detail: string };
      expect(status).toMatchObject({ kind: 'graph' });
      expect(JSON.stringify(status)).not.toContain('secret-1');
      const test = (await call('POST', '/api/v1/admin/email/test', { to: 'owner@example.com' })).json() as { ok: boolean; detail: string };
      expect(test.ok).toBe(true);
      expect(test.detail).toMatch(/Accepted is not delivered/);

      const res = await sendLink(key, { link: 'consent', channel: 'email' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ channel: 'email', status: 'sent', provider: 'graph', recipient: `casey.${stamp}@example.com` });
      const m = fake.mails.at(-1)!;
      expect(m.from).toBe('recruiting@northwind-freight.example');
      const message = m.body.message as { body: { contentType: string; content: string }; toRecipients: { emailAddress: { address: string } }[] };
      expect(message.body.contentType).toBe('HTML');
      expect(message.body.content).toMatch(/href="https:\/\/tms\.example\.test\/consent\/#token=[A-Za-z0-9_-]{43}"/);
      expect(message.body.content).toContain('name="viewport"');
      expect((await call('POST', `${R}/candidates/${key}/journey/deliveries/${(res.json() as LinkDeliveryView).id}/refresh`, {}, recruiter)).statusCode).toBe(409);

      fake.graphRefuses = true;
      const refused = (await call('POST', '/api/v1/admin/email/test', { to: 'owner@example.com' })).json() as { ok: boolean; detail: string };
      expect(refused).toMatchObject({ ok: false, detail: expect.stringMatching(/ErrorAccessDenied/) });
      const failedMail = (await sendLink(key, { link: 'consent', channel: 'email' })).json() as LinkDeliveryView;
      expect(failedMail.status).toBe('failed');
    } finally {
      fake.graphRefuses = false;
      Object.assign(env, { EMAIL_TRANSPORT: undefined, GRAPH_TENANT_ID: undefined, GRAPH_CLIENT_ID: undefined, GRAPH_CLIENT_SECRET: undefined, SMTP_FROM: saved.SMTP_FROM });
    }
  });

  it('a message of one candidate cannot be resent or checked through another', async () => {
    const other = await lead('Corin');
    expect((await call('POST', `${R}/candidates/${other}/journey/deliveries/${first.id}/resend`, {}, recruiter)).statusCode).toBe(404);
    expect((await call('POST', `${R}/candidates/${other}/journey/deliveries/${first.id}/refresh`, {}, recruiter)).statusCode).toBe(404);
  });

  let docText = '';
  it('the FMCSA limited consent: official text word for word, the employer and the driver filled in, the company scope, kept as signed', async () => {
    const link = await call('POST', `${R}/candidates/${key}/journey/consent/link`, {}, recruiter);
    const token = (link.json() as { url: string }).url.split('#token=')[1]!;
    const ctx = (await form(token)).json() as ConsentFormContext;
    expect(ctx.disclosures.map((d) => d.type)).toEqual(['mvr', 'psp', 'clearinghouse']);
    expect(ctx.pending).toEqual([]);
    const ch = ctx.disclosures.find((d) => d.type === 'clearinghouse')!;
    expect(ch.text).toContain(`hereby provide consent to ${EMPLOYER} to conduct a limited query`);
    expect(ch.driverNamePlaceholder).toBe('(Driver Name)');
    expect(ch.text).not.toContain('[Employers');
    expect(ch.text).toContain('one (1) limited query');
    await signConsent(token);
    const j = await journey(key);
    const doc = j.consent.submission!.documents.find((d) => d.type === 'clearinghouse')!;
    expect(doc.scope).toMatch(/One limited query within 30 days/);
    expect(new Date(doc.validUntil!).getTime() - new Date(doc.signedAt).getTime()).toBe(30 * 86_400_000);
    const [row] = await db.select().from(hiringConsentDocuments).where(eq(hiringConsentDocuments.id, doc.id));
    docText = row!.disclosureText;
    expect(docText).toContain(`I, ${ctx.firstName} ${ctx.lastName}, hereby provide consent to ${EMPLOYER}`);
    expect(docText).not.toContain('(Driver Name)');
    expect(docText).not.toContain('(Company Name)');
    for (const sentence of CLEARINGHOUSE_OFFICIAL_SENTENCES) {
      expect(docText).toContain(sentence.split('(Company Name)').join(EMPLOYER).split('(Driver Name)').join(`${ctx.firstName} ${ctx.lastName}`));
    }
    const pdf = await call('GET', `${R}/candidates/${key}/journey/consent/documents/${doc.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await journey(key, recruiter)).consent.submission?.audit.ipAddress).toBeNull();
    // A later change of the employer name never touches what was signed.
    await call('PATCH', '/api/v1/admin/settings', { values: { 'hiring.clearinghouse_employer_name': 'Another Name LLC' } });
    const [after] = await db.select().from(hiringConsentDocuments).where(eq(hiringConsentDocuments.id, doc.id));
    expect(after!.disclosureText).toBe(docText);
    await call('PATCH', '/api/v1/admin/settings', { values: { 'hiring.clearinghouse_employer_name': EMPLOYER } });
  });

  it('Safety: checks Requested → Pending → Received → Reviewed; the limited consent is one query in 30 days; pre-employment needs the full query', async () => {
    // Reports first, then Send to Safety (owner, 2026-10-13): the checks are ordered before sending.
    let j = await journey(key);
    expect(j.safety.checks.map((c) => [c.kind, c.status])).toEqual([
      ['mvr', 'not_requested'],
      ['psp', 'not_requested'],
      ['clearinghouse_limited', 'not_requested'],
      ['clearinghouse_full', 'not_requested'],
    ]);
    expect(j.safety.checks.find((c) => c.kind === 'clearinghouse_limited')).toMatchObject({ blockedReason: null, authorization: { given: true } });
    expect(j.safety.checks.find((c) => c.kind === 'clearinghouse_full')?.authorization).toMatchObject({ given: false, detail: expect.stringMatching(/does not replace/) });

    // Recruiting orders the checks and files the reports now (owner, 2026-10-12); Safety decides.
    const requested = await call('POST', `${R}/candidates/${key}/journey/safety/checks`, { kind: 'mvr', provider: 'Texas DPS', orderRef: 'ORD-77' }, recruiter);
    expect(requested.statusCode, requested.body).toBe(200);
    expect(requested.json()).toMatchObject({ status: 'requested', provider: 'Texas DPS', orderRef: 'ORD-77' });
    const v = (requested.json() as { version: number }).version;
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/checks/mvr/pending`, { version: v })).json()).toMatchObject({ status: 'pending' });
    for (const kind of ['mvr', 'psp', 'clearinghouse_full'] as const) {
      expect((await call('POST', `${R}/candidates/${key}/journey/safety/reports`, { kind, fileName: `${kind}.pdf`, contentType: 'application/pdf', content: PDF.toString('base64') })).statusCode).toBe(201);
    }
    expect((await call('POST', `${R}/candidates/${key}/journey/safety`, { note: 'Run them' }, recruiter)).statusCode).toBe(200);
    j = await journey(key);
    expect(j.safety.checks.find((c) => c.kind === 'mvr')).toMatchObject({ status: 'received', result: null });
    for (const r of j.safety.reports) {
      expect((await call('PATCH', `${R}/candidates/${key}/journey/safety/reports/${r.id}`, { result: 'clear', note: 'Reviewed', version: r.version })).statusCode).toBe(200);
    }
    j = await journey(key);
    expect(j.safety.checks.find((c) => c.kind === 'mvr')).toMatchObject({ status: 'reviewed', result: 'clear', requestedAt: expect.any(String), pendingAt: expect.any(String) });
    // Safety's desk: the candidate waits there with the signed consents; a recruiter cannot open it.
    const D = '/api/v1/hiring/safety-desk';
    const desk = (await call('GET', D)).json() as { waiting: { caseId: string; name: string; consentsSigned: string[]; reportsWithResult: number }[] };
    const mine = desk.waiting.find((r) => r.name === `Casey Int${stamp}`)!;
    expect(mine.consentsSigned).toEqual(expect.arrayContaining(['mvr', 'psp', 'clearinghouse']));
    expect(mine.reportsWithResult).toBe(3);
    expect((await call('GET', D, undefined, recruiter)).statusCode).toBe(403);
    const detail = (await call('GET', `${D}/${mine.caseId}`)).json() as { consent: CandidateJourney['consent']; safety: CandidateJourney['safety'] };
    const mvrDoc = detail.consent.submission!.documents.find((d) => d.type === 'mvr')!;
    const pdf = await call('GET', `${D}/${mine.caseId}/consent/documents/${mvrDoc.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const alert = (await db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.entityType, 'hiring_safety'))))[0];
    expect(alert).toMatchObject({ entityId: mine.caseId, title: expect.stringMatching(/Safety decision needed/) });

    // Qualified: MVR and PSP reviewed is enough; the pre-employment full query waits for hire.
    const qualified = await call('POST', `${D}/${mine.caseId}/decision`, { status: 'approved', note: 'Clear', version: detail.safety.review?.version });
    expect(qualified.statusCode, qualified.body).toBe(200);
    expect(qualified.json()).toMatchObject({ status: 'approved', decidedByName: expect.any(String) });
    expect(((await call('GET', D)).json() as { decided: { caseId: string }[] }).decided.map((r) => r.caseId)).toContain(mine.caseId);
    const told = await db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.title, `Qualified by Safety — Casey Int${stamp}`)));
    expect(told.length).toBeGreaterThan(0);
    j = await journey(key);
    expect(j.application.canSend).toBe(true);
    // The full query is optional since 2026-10-12 (owner): it does not hold the hire on its own.
    expect(j.hire.items.find((i) => i.code === 'clearinghouse_full')).toMatchObject({ ok: true, label: expect.stringMatching(/optional/) });
    expect((await call('POST', `${R}/candidates/${key}/journey/safety/full-query`, { status: 'received', version: j.safety.review?.version })).statusCode).toBe(200);
    j = await journey(key);

    // The limited consent: one query within 30 days of signing (company scope).
    await db.update(hiringConsentDocuments).set({ validUntil: new Date(Date.now() - 86_400_000) }).where(and(eq(hiringConsentDocuments.companyId, companyId), eq(hiringConsentDocuments.documentType, 'clearinghouse')));
    j = await journey(key);
    expect(j.safety.checks.find((c) => c.kind === 'clearinghouse_limited')?.blockedReason).toMatch(/expired/);
    // Pre-employment full query: its own line on the hire checklist, satisfied by the driver's consent in the Clearinghouse and a full query Safety reviewed clear.
    expect(j.hire.items.find((i) => i.code === 'clearinghouse_full')).toMatchObject({ ok: true });
  });
});
