import type Anthropic from '@anthropic-ai/sdk';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverAssistantAnswer, GiveAppAccessResponse } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads as loadsTable } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';
import { AccountingStore } from '../src/modules/accounting/store.service';
import { AiAssistantService, type AiModelClient } from '../src/modules/ai-assistant/ai-assistant.service';
import { intentOf, weeksBack } from '../src/modules/mobile/driver-assistant.service';

const API = '/api/v1';

/**
 * Ask NeWay (mobile M6, POST /driver/assistant/ask): a driver asks about their own pay. The
 * answer and everything sent to the model come from that driver's own statements and loads; the
 * other driver's figures never appear. Office accounts are refused; voice input says when it is
 * not set up.
 */
describe('Mobile driver assistant (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let store: AccountingStore;
  let ai: AiAssistantService;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const digits = String(Date.now()).slice(-9);
  let company = '';
  const D1 = `drv_as1_${stamp}`;
  const D2 = `drv_as2_${stamp}`;
  const L1 = `ld_as1_${stamp}`;
  let token1 = '';
  let token2 = '';
  // This Eastern week, so "this week" finds the statement.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const plus = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const START = plus(today, -2);
  const END = plus(today, 4);

  const as = (bearer: string, url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method: 'POST', url: `${API}${url}`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(headers ?? {}) }, payload: (payload ?? {}) as object });
  const office = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url: `${API}${url}`, headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function signIn(login: string, temporary: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: { email: login, password: temporary, client: 'mobile' } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { token: string };
    const replaced = await as(body.token, '/auth/password/temporary', { newPassword: 'Driver-pass-1234', confirmPassword: 'Driver-pass-1234' });
    expect(replaced.statusCode, replaced.body).toBeLessThan(300);
    return body.token;
  }

  const driverRow = (id: string, first: string, ph: string, email: string) => ({
    id, companyId: company, driverNumber: id, firstName: first, lastName: 'Asks', phone: ph, email, driverType: 'company', cdlState: 'OH', cdlClass: 'A', cdlNumber: id,
    cdlExpiresOn: '2028-01-01', cdlStatus: 'valid', medicalCardStatus: 'valid', hireDate: '2026-01-01', status: 'available', dispatcherId: 'disp_as', dispatcherName: 'Assist Dispatcher',
    homeCity: 'Columbus', homeState: 'OH', payPlanKind: 'percent_of_linehaul', payPlanRate: '30', currentTruckId: null, currentTrailerId: null,
  });
  const statement = (n: string, driverId: string, netCents: number, deductionCents: number, loadNumber: string) => ({
    id: `stm_as_${n}_${stamp}`, sourceKey: `e2e-as:${stamp}:${n}`, settlementNumber: `ST-AS-${n}-${stamp}`, batchId: `stb_as_${stamp}`, kind: 'cd', partyType: 'driver', partyId: driverId, partyName: n,
    truckId: null, unitNumber: null, periodStart: START, periodEnd: END, cutoffAt: `${END}T16:00:00.000Z`, payDate: plus(END, 4), status: 'approved',
    netCents, payableCents: netCents, carryCents: 0,
    computation: {
      grossCents: netCents + deductionCents, reimbursementsCents: 0, deductionsCents: deductionCents, escrowCents: 0, loadCount: 1, totalMiles: 812, notes: [],
      earnings: [{ kind: 'linehaul', loadNumber, description: 'Linehaul', cents: netCents + deductionCents }],
      deductions: [{ description: 'Fuel advance', cents: deductionCents }],
    },
    vendor: null, snapshot: null, loadIds: [], exceptions: [], approvedAt: new Date().toISOString(), approvedBy: 'e2e', paidAt: null, paymentId: null, paidCents: null, reversedAt: null, notes: null, versions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const S1 = () => statement('one', D1, 123456, 20000, `L-AS1-${stamp}`);
  const S2 = () => statement('two', D2, 987654, 33300, `L-AS2-${stamp}`);

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    store = app.get(AccountingStore);
    ai = app.get(AiAssistantService);
    company = ((await office('GET', '/auth/me')).json() as { companyId: string }).companyId;
    await db.insert(drivers).values([driverRow(D1, 'Ana', `7${digits}`, `ana.as.${stamp}@example.test`), driverRow(D2, 'Ben', `8${digits}`, `ben.as.${stamp}@example.test`)] as never);
    await db.insert(loadsTable).values({
      id: L1, companyId: company, loadNumber: `L-AS1-${stamp}`, status: 'in_transit', dispatcherId: 'disp_as', driverId: D1, version: 1,
      record: {
        id: L1, loadNumber: `L-AS1-${stamp}`, status: 'in_transit', schemaVersion: 2, driverId: D1, driverName: 'Ana Asks', updatedAt: new Date().toISOString(), charges: [], timeline: [], notes: [], documents: [],
        stops: [
          { id: `${L1}_s1`, sequence: 1, kind: 'pickup', facilityName: 'Shipper', city: 'Chicago', state: 'IL', timezone: 'America/Chicago', appointmentStartAt: `${today}T13:00:00.000Z`, appointmentEndAt: null, status: 'departed' },
          { id: `${L1}_s2`, sequence: 2, kind: 'delivery', facilityName: 'Receiver', city: 'Atlanta', state: 'GA', timezone: 'America/New_York', appointmentStartAt: `${plus(today, 1)}T15:00:00.000Z`, appointmentEndAt: null, status: 'pending' },
        ],
      },
    } as never);
    await store.insert('acct_settlements', company, S1());
    await store.insert('acct_settlements', company, S2());
    const a = (await office('POST', `/drivers/${D1}/app-access`, {})).json() as GiveAppAccessResponse;
    token1 = await signIn(`ana.as.${stamp}@example.test`, a.temporaryPassword!);
    const b = (await office('POST', `/drivers/${D2}/app-access`, {})).json() as GiveAppAccessResponse;
    token2 = await signIn(`ben.as.${stamp}@example.test`, b.temporaryPassword!);
  }, 120_000);

  afterAll(async () => {
    ai?.setClient(null);
    await app?.close();
  });

  it('reads the question: pay, deductions, next pay, miles, how-to; last week', () => {
    expect(intentOf('How much is my pay this week?')).toBe('pay');
    expect(intentOf('What was deducted last week?')).toBe('deductions');
    expect(intentOf('When is my next pay?')).toBe('next_pay');
    expect(intentOf('How many miles did I drive?')).toBe('miles');
    expect(intentOf('How do I upload a POD?')).toBe('howto_docs');
    expect(intentOf('Bu hafta maoshim qancha?')).toBe('pay');
    expect(weeksBack('What was deducted last week?')).toBe(1);
    expect(weeksBack('pay this week')).toBe(0);
  });

  it('without a model answer, the driver gets their own figures built from their statement', async () => {
    // A model that fails: the endpoint still answers, from the data.
    ai.setClient({ create: async () => { throw new Error('model down'); } });
    const res = await as(token1, '/driver/assistant/ask', { question: 'How much is my pay this week?' });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json() as DriverAssistantAnswer;
    expect(a.source).toBe('data');
    expect(a.answer).toContain('$1,234.56');
    expect(a.facts.find((f) => f.label === 'Net pay')?.value).toBe('$1,234.56');
    expect(res.body).not.toContain('9,876.54');
    expect(res.body).not.toContain(`ST-AS-two-${stamp}`);

    const ded = (await as(token1, '/driver/assistant/ask', { question: 'What was deducted?' })).json() as DriverAssistantAnswer;
    expect(ded.answer).toContain('$200.00');
    expect(ded.answer).toContain('Fuel advance');
    const next = (await as(token1, '/driver/assistant/ask', { question: 'When is my next pay?' })).json() as DriverAssistantAnswer;
    expect(next.answer).toContain('$1,234.56');
    const load = (await as(token1, '/driver/assistant/ask', { question: 'Where is my next stop?' })).json() as DriverAssistantAnswer;
    expect(load.answer).toContain(`L-AS1-${stamp}`);
    expect(load.answer).toContain('Atlanta');

    // The other driver: their own figures only.
    const other = await as(token2, '/driver/assistant/ask', { question: 'How much is my pay this week?' });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.body).toContain('$9,876.54');
    expect(other.body).not.toContain('1,234.56');
    expect(other.body).not.toContain(`L-AS1-${stamp}`);
  });

  it('with NeWay AI, the model sees only this driver\'s data and its words are returned', async () => {
    const prompts: string[] = [];
    const fake: AiModelClient = {
      create: async (params) => {
        prompts.push(String(params.system));
        expect(params.tools).toBeUndefined();
        return {
          id: 'msg_test', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: 'text', text: 'Your net pay this week is $1,234.56.', citations: null }],
        } as unknown as Anthropic.Message;
      },
    };
    ai.setClient(fake);
    const res = await as(token1, '/driver/assistant/ask', { question: 'Bu hafta maoshim qancha?', history: [{ role: 'assistant', text: 'Hello' }, { role: 'user', text: 'hi' }, { role: 'assistant', text: 'How can I help?' }] });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json() as DriverAssistantAnswer;
    expect(a).toMatchObject({ source: 'ai', aiConfigured: true, answer: 'Your net pay this week is $1,234.56.' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`ST-AS-one-${stamp}`);
    expect(prompts[0]).toContain('$1,234.56');
    expect(prompts[0]).not.toContain(`ST-AS-two-${stamp}`);
    expect(prompts[0]).not.toContain('9,876.54');
    expect(prompts[0]).not.toContain(D2);

    await as(token2, '/driver/assistant/ask', { question: 'pay?' });
    expect(prompts[1]).toContain(`ST-AS-two-${stamp}`);
    expect(prompts[1]).not.toContain(`ST-AS-one-${stamp}`);
    expect(prompts[1]).not.toContain(`L-AS1-${stamp}`);
  });

  it('office accounts are refused; an empty question is invalid; voice input says when it is not set up', async () => {
    // An administrator holds every permission but is no driver: 403 from the driver resolution.
    expect((await office('POST', '/driver/assistant/ask', { question: 'pay?' })).statusCode).toBe(403);
    expect((await office('POST', '/driver/assistant/ask', { question: 'pay?' }, { 'x-demo-role': 'operations' })).statusCode).toBe(403);
    expect((await as(token1, '/driver/assistant/ask', { question: '   ' })).statusCode).toBe(422);
    expect((await as(token1, '/driver/assistant/ask', { question: 'pay?', driverId: D2 })).statusCode).toBe(422);
    const stt = await app.inject({ method: 'POST', url: `${API}/driver/assistant/transcribe`, headers: { authorization: `Bearer ${token1}`, 'content-type': 'application/octet-stream', 'x-file-name': 'speech.m4a', 'x-file-type': 'audio/mp4' }, payload: Buffer.from('not really audio') });
    expect([404, 503]).toContain(stt.statusCode);
    if (stt.statusCode === 404) expect(stt.body).toContain('stt_not_configured');
    const officeStt = await app.inject({ method: 'POST', url: `${API}/driver/assistant/transcribe`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(officeStt.statusCode).toBe(403);
  });
});
