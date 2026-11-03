import type Anthropic from '@anthropic-ai/sdk';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverAssistantVoiceAnswer, GiveAppAccessResponse } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads as loadsTable } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';
import { AiAssistantService, type AiModelClient } from '../src/modules/ai-assistant/ai-assistant.service';
import { historyFrom } from '../src/modules/mobile/driver-assistant.controller';
import { MetaTranscribeClient, isWav } from '../src/modules/mobile/meta-transcribe.client';

const API = '/api/v1';

/** A tiny valid WAV header (RIFF....WAVE) with a few silent samples: what the phone sends. */
function wav(): Buffer {
  const data = Buffer.alloc(320);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Ask NeWay by voice (hackathon, Meta Muse): POST /driver/assistant/voice. The recording goes to
 * Meta's /asr/transcribe as WAV, the words go through the same answer path as typed questions, and
 * the model is told to answer in the language the driver spoke. The driver's own load reaches the
 * prompt with its miles and appointments; office accounts are refused.
 */
describe('Mobile driver assistant by voice (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let ai: AiAssistantService;
  let meta: MetaTranscribeClient;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const digits = String(Date.now()).slice(-9);
  let company = '';
  const D1 = `drv_av1_${stamp}`;
  const L1 = `ld_av1_${stamp}`;
  let token = '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const plus = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const json = (bearer: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `${API}${url}`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, payload: payload as object });
  const voice = (headers: Record<string, string>, payload: Buffer) =>
    app.inject({ method: 'POST', url: `${API}/driver/assistant/voice`, headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'question.wav', 'x-file-type': 'audio/wav', ...headers }, payload });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    ai = app.get(AiAssistantService);
    meta = app.get(MetaTranscribeClient);
    company = ((await app.inject({ method: 'GET', url: `${API}/auth/me` })).json() as { companyId: string }).companyId;
    await db.insert(drivers).values({
      id: D1, companyId: company, driverNumber: D1, firstName: 'Vova', lastName: 'Voice', phone: `6${digits}`, email: `vova.av.${stamp}@example.test`, driverType: 'company', cdlState: 'OH', cdlClass: 'A', cdlNumber: D1,
      cdlExpiresOn: '2028-01-01', cdlStatus: 'valid', medicalCardStatus: 'valid', hireDate: '2026-01-01', status: 'available', dispatcherId: 'disp_av', dispatcherName: 'Voice Dispatcher',
      homeCity: 'Columbus', homeState: 'OH', payPlanKind: 'percent_of_linehaul', payPlanRate: '30', currentTruckId: null, currentTrailerId: null,
    } as never);
    await db.insert(loadsTable).values({
      id: L1, companyId: company, loadNumber: `L-AV1-${stamp}`, status: 'dispatched', dispatcherId: 'disp_av', driverId: D1, version: 1,
      record: {
        id: L1, loadNumber: `L-AV1-${stamp}`, status: 'dispatched', schemaVersion: 2, driverId: D1, driverName: 'Vova Voice', updatedAt: new Date().toISOString(), charges: [], timeline: [], notes: [], documents: [],
        loadedMiles: 717,
        stops: [
          { id: `${L1}_s1`, sequence: 1, kind: 'pickup', facilityName: 'Shipper', city: 'Chicago', state: 'IL', timezone: 'America/Chicago', appointmentStartAt: `${plus(today, 1)}T19:00:00.000Z`, appointmentEndAt: null, status: 'pending' },
          { id: `${L1}_s2`, sequence: 2, kind: 'delivery', facilityName: 'Receiver', city: 'Atlanta', state: 'GA', timezone: 'America/New_York', appointmentStartAt: `${plus(today, 2)}T15:00:00.000Z`, appointmentEndAt: null, status: 'pending' },
        ],
      },
    } as never);
    const access = (await app.inject({ method: 'POST', url: `${API}/drivers/${D1}/app-access`, headers: { 'content-type': 'application/json' }, payload: {} })).json() as GiveAppAccessResponse;
    const login = await app.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: { email: `vova.av.${stamp}@example.test`, password: access.temporaryPassword!, client: 'mobile' } });
    expect(login.statusCode, login.body).toBe(201);
    token = (login.json() as { token: string }).token;
    const replaced = await json(token, '/auth/password/temporary', { newPassword: 'Driver-pass-1234', confirmPassword: 'Driver-pass-1234' });
    expect(replaced.statusCode, replaced.body).toBeLessThan(300);
  }, 120_000);

  afterAll(async () => {
    ai?.setClient(null);
    meta?.setFetch(null);
    await app?.close();
  });

  it('knows a WAV when it sees one; the history header is optional and checked', () => {
    expect(isWav(wav())).toBe(true);
    expect(isWav(Buffer.from('not really audio'))).toBe(false);
    expect(historyFrom(undefined)).toBeUndefined();
    expect(historyFrom('garbage%')).toBeUndefined();
    expect(historyFrom(encodeURIComponent(JSON.stringify([{ role: 'user', text: 'hi' }])))).toEqual([{ role: 'user', text: 'hi' }]);
    expect(historyFrom(encodeURIComponent(JSON.stringify([{ role: 'boss', text: 'x' }])))).toBeUndefined();
  });

  it('Russian speech: Meta hears it, the model is told to answer in Russian with this driver\'s load', async () => {
    const sent: Array<{ url: string; request: Record<string, unknown>; audioBytes: number; auth: string | null }> = [];
    meta.setFetch(async (url, init) => {
      const form = init!.body as FormData;
      const request = JSON.parse(await (form.get('request') as Blob).text()) as Record<string, unknown>;
      sent.push({ url: String(url), request, audioBytes: (form.get('audio') as Blob).size, auth: new Headers(init!.headers).get('authorization') });
      return new Response(JSON.stringify({ transcript: 'Когда у меня следующая погрузка?', audioDurationMs: 2100, turns: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const prompts: string[] = [];
    const fake: AiModelClient = {
      create: async (params) => {
        prompts.push(String(params.system));
        return {
          id: 'msg_test', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: 'text', text: 'Погрузка завтра в Чикаго.', citations: null }],
        } as unknown as Anthropic.Message;
      },
    };
    ai.setClient(fake);

    const res = await voice({ authorization: `Bearer ${token}` }, wav());
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as DriverAssistantVoiceAnswer;
    expect(out).toMatchObject({ transcript: 'Когда у меня следующая погрузка?', language: 'ru', transcribedBy: 'meta' });
    expect(out.answer).toMatchObject({ source: 'ai', answer: 'Погрузка завтра в Чикаго.' });
    expect(out.timings.transcribeMs).toBeGreaterThanOrEqual(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/asr\/transcribe$/);
    expect(sent[0]!.request).toMatchObject({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' });
    expect(sent[0]!.audioBytes).toBe(wav().length);
    expect(sent[0]!.auth).toBe('Bearer test-key');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('ASKED BY VOICE in Russian');
    expect(prompts[0]).toContain(`L-AV1-${stamp}`);
    expect(prompts[0]).toContain('"loadedMiles":717');
    expect(prompts[0]).toContain('Chicago, IL');
  });

  it('nothing heard is 422; a non-WAV recording with no Azure account is 415; office accounts are refused', async () => {
    meta.setFetch(async () => new Response(JSON.stringify({ transcript: '', audioDurationMs: 900 }), { status: 200 }));
    const empty = await voice({ authorization: `Bearer ${token}` }, wav());
    expect(empty.statusCode, empty.body).toBe(422);
    expect(empty.body).toContain('nothing_heard');

    const m4a = await voice({ authorization: `Bearer ${token}`, 'x-file-name': 'q.m4a', 'x-file-type': 'audio/mp4' }, Buffer.from('not really audio'));
    expect([415, 503]).toContain(m4a.statusCode); // 503 only if this database has an Azure Speech account

    expect((await voice({}, wav())).statusCode).toBe(403);
  });
});
