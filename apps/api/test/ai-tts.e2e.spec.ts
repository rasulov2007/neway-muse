import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { AzureSpeechService } from '../src/modules/admin/connectors/azure-speech.service';

const ADMIN = '/api/v1/admin';
const TTS = '/api/v1/ai/tts';
const KEY = `e2e-azure-key-${Date.now()}`;

/**
 * Read aloud on the server (owner, 2026-10-22), end to end through HTTP with Azure answered by a
 * fake: 404 tts_not_configured with no account, the Azure Speech account stored and tested, SSML
 * with the voice chosen per language, MP3 back, and a 401 from Azure mapped to "Azure rejected the
 * key". Runs as the default principal (the company owner). Its account is disconnected and
 * archived before it finishes.
 */
describe('NeWay AI read aloud (e2e)', () => {
  let app: NestFastifyApplication;
  let azure: AzureSpeechService;
  let accountId: string | null = null;
  let azureStatus = 200;
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) }, body: String(init?.body ?? '') });
    if (azureStatus !== 200) return new Response('', { status: azureStatus });
    if (url.endsWith('/voices/list')) {
      return new Response(
        JSON.stringify([
          { ShortName: 'uz-UZ-SardorNeural', Locale: 'uz-UZ', Gender: 'Male' },
          { ShortName: 'uz-UZ-MadinaNeural', Locale: 'uz-UZ', Gender: 'Female' },
          { ShortName: 'en-US-AvaMultilingualNeural', Locale: 'en-US', Gender: 'Female' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: payload as Record<string, unknown> });

  /** Azure Speech accounts the company could already speak through (left by someone else). */
  const usableAccounts = async () => {
    const body = (await app.inject({ method: 'GET', url: `${ADMIN}/integrations` })).json() as { integrations: { provider: string; accounts: { id: string; status: string }[] }[] };
    return body.integrations.find((i) => i.provider === 'azure_speech')?.accounts.filter((a) => a.status === 'connected' || a.status === 'credentials_stored') ?? [];
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    azure = app.get(AzureSpeechService);
    azure.setFetch(fakeFetch);
  }, 120_000);

  afterAll(async () => {
    azure?.setFetch(undefined);
    if (accountId) {
      await app.inject({ method: 'POST', url: `${ADMIN}/integrations/accounts/${accountId}/disconnect` });
      await post(`${ADMIN}/integrations/accounts/${accountId}/archive`, { reason: 'e2e read-aloud account' });
    }
    await app?.close();
  });

  it('is 404 tts_not_configured while the company has no Azure Speech account', async () => {
    if ((await usableAccounts()).length > 0) return; // someone connected one here: nothing to prove
    const r = await post(TTS, { text: 'Salom, bu sinov.' });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { code?: string }).code).toBe('tts_not_configured');
  });

  it('lists Azure Speech under AI & voice with an optional Uzbek voice, and stores it without the voice', async () => {
    const list = (await app.inject({ method: 'GET', url: `${ADMIN}/integrations` })).json() as {
      integrations: { provider: string; category: string; connector: { implemented: boolean }; credentialFields: { name: string; kind: string; optional?: boolean }[] }[];
    };
    const provider = list.integrations.find((i) => i.provider === 'azure_speech')!;
    expect(provider.category).toBe('ai');
    expect(provider.connector.implemented).toBe(true);
    expect(provider.credentialFields.map((f) => [f.name, f.kind, f.optional ?? false])).toEqual([
      ['key', 'secret', false],
      ['region', 'text', false],
      ['voiceUz', 'text', true],
    ]);

    const missing = await post(`${ADMIN}/integrations/connect`, { provider: 'azure_speech', credentials: { key: KEY } });
    expect(missing.statusCode).toBe(422);
    expect(missing.body).toContain('Region');

    const created = await post(`${ADMIN}/integrations/connect`, { provider: 'azure_speech', name: 'Azure Speech e2e', credentials: { key: KEY, region: 'eastus' } });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(KEY);
    const account = (created.json() as { account: { id: string; status: string; config: Record<string, string> } }).account;
    accountId = account.id;
    expect(account.status).toBe('credentials_stored');
    expect(account.config).toEqual({ region: 'eastus' });
  });

  it('Test lists the voices with the key header and earns connected', async () => {
    sent.length = 0;
    const r = await post(`${ADMIN}/integrations/accounts/${accountId}/test`, {});
    expect(r.statusCode).toBeLessThan(300);
    expect(r.body).toContain('uz-UZ-SardorNeural');
    expect(r.body).not.toContain(KEY);
    expect(sent[0]!.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(sent[0]!.headers['Ocp-Apim-Subscription-Key']).toBe(KEY);
    const detail = (await app.inject({ method: 'GET', url: `${ADMIN}/integrations/accounts/${accountId}` })).json() as { account: { status: string } };
    expect(detail.account.status).toBe('connected');
  });

  it('speaks Uzbek in the Uzbek voice and English in Ava: MP3 back, SSML escaped, markdown gone', async () => {
    sent.length = 0;
    const uz = await post(TTS, { text: `**Bu haftada** 3 ta yuk & <kechikdi> ${Date.now()}` });
    expect(uz.statusCode).toBe(200);
    expect(uz.headers['content-type']).toContain('audio/mpeg');
    expect(uz.rawPayload.subarray(0, 3).toString()).toBe('ID3');
    const ssml = sent.at(-1)!;
    expect(ssml.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(ssml.headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(ssml.body).toContain('<voice name="uz-UZ-SardorNeural">Bu haftada 3 ta yuk &amp; &lt;kechikdi&gt;');
    expect(ssml.body).toContain('xml:lang="uz-UZ"');

    const en = await post(TTS, { text: `Here are the unpaid invoices ${Date.now()}` });
    expect(en.statusCode).toBe(200);
    expect(sent.at(-1)!.body).toContain('<voice name="en-US-AvaMultilingualNeural">');

    const tooLong = await post(TTS, { text: 'a'.repeat(4001) });
    expect(tooLong.statusCode).toBe(422);
  });

  it('maps a 401 from Azure to "Azure rejected the key" and marks the account', async () => {
    azureStatus = 401;
    try {
      const r = await post(TTS, { text: `Yangi matn ${Date.now()} uchun` });
      expect(r.statusCode).toBe(502);
      expect(r.body).toContain('Azure rejected the key');
      expect(r.body).not.toContain(KEY);
      const detail = (await app.inject({ method: 'GET', url: `${ADMIN}/integrations/accounts/${accountId}` })).json() as { account: { status: string; lastError: string } };
      expect(detail.account.status).toBe('error');
      expect(detail.account.lastError).toContain('Azure rejected the key');

      const test = await post(`${ADMIN}/integrations/accounts/${accountId}/test`, {});
      expect(test.statusCode).toBe(422);
      expect(test.body).toContain('Azure rejected the key');
    } finally {
      azureStatus = 200;
    }
  });
});
