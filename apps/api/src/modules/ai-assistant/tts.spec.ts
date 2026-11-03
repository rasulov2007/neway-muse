import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { AzureSpeechClient } from '../admin/connectors/azure-speech.client';
import type { AzureSpeechService, Speaker } from '../admin/connectors/azure-speech.service';
import { AiTtsService } from './ai-tts.service';
import { AudioCache, buildSsml, detectLang, normaliseLang, speakableText, voiceFor } from './tts';

const me: Principal = { userId: 'usr_tts', userName: 'TTS spec', companyId: 'co_tts', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['ai_assistant.use']) };

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** An Azure that answers what we tell it to, recording every request. */
function fakeAzure(status = 200) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers: { ...((init?.headers as Record<string, string>) ?? {}) }, body: String(init?.body ?? '') });
    if (status !== 200) return new Response('{"error":"nope"}', { status });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

function service(speaker: Speaker | null) {
  const failures: unknown[] = [];
  const azure = {
    speaker: async () => speaker,
    recordFailure: async (_id: string, _n: number | null, error: unknown) => {
      failures.push(error);
    },
  } as unknown as AzureSpeechService;
  return { tts: new AiTtsService(azure), failures };
}

const speakerWith = (fetchImpl: typeof fetch, voiceUz = 'uz-UZ-SardorNeural'): Speaker => ({
  accountId: 'int_test',
  client: new AzureSpeechClient('SECRET-KEY-123', 'eastus', { fetchImpl }),
  voiceUz,
});

describe('language detection', () => {
  it('reads Uzbek Latin from its letters and its common words', () => {
    expect(detectLang('Toʻlanmagan hisob-fakturalar roʻyxati')).toBe('uz');
    expect(detectLang('Bu haftada 12 ta yuk yetkazildi va 3 tasi kechikdi.')).toBe('uz');
    expect(detectLang("Hisobni yuborish uchun tugmani bosing")).toBe('uz');
    expect(detectLang("Iltimos, qiling")).toBe('uz');
    expect(detectLang("U bo'lim yopiq")).toBe('uz');
  });

  it('reads Cyrillic as Russian and anything else as English', () => {
    expect(detectLang('Неоплаченные счета за эту неделю')).toBe('ru');
    expect(detectLang('Here are the unpaid invoices for this week.')).toBe('en');
    expect(detectLang("The dog's invoice is overdue.")).toBe('en');
  });

  it('takes an explicit language before the text', () => {
    expect(normaliseLang('uz-UZ')).toBe('uz');
    expect(normaliseLang('RU')).toBe('ru');
    expect(normaliseLang('de')).toBeUndefined();
  });

  it('chooses a voice per language, Uzbek from the account', () => {
    expect(voiceFor('uz', 'uz-UZ-MadinaNeural')).toBe('uz-UZ-MadinaNeural');
    expect(voiceFor('en', 'uz-UZ-MadinaNeural')).toBe('en-US-AvaMultilingualNeural');
    expect(voiceFor('ru', 'uz-UZ-MadinaNeural')).toBe('ru-RU-SvetlanaNeural');
  });
});

describe('speakable text and SSML', () => {
  it('strips markdown and table syntax', () => {
    const md = '## Natija\n\n**3 ta** yuk `L-100` uchun:\n\n| Yuk | Summa |\n|---|---:|\n| L-1 | $500 |\n\n- [Ochish](https://x.test/a)\n---';
    const out = speakableText(md);
    expect(out).not.toMatch(/[#*`|]|---|https?:/);
    expect(out).toContain('Natija');
    expect(out).toContain('3 ta yuk L-100 uchun:');
    expect(out).toContain('Yuk, Summa.');
    expect(out).toContain('L-1, $500.');
    expect(out).toContain('Ochish');
  });

  it('escapes the text and the voice', () => {
    const ssml = buildSsml('A & B <c> "d" \'e\'', 'en', 'en-US-AvaMultilingualNeural');
    expect(ssml).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-AvaMultilingualNeural">A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;</voice></speak>',
    );
  });
});

describe('AudioCache', () => {
  it('keeps the most recently used entries within its bounds', () => {
    const cache = new AudioCache(2, 1000);
    cache.set('a', Buffer.alloc(10));
    cache.set('b', Buffer.alloc(10));
    cache.get('a');
    cache.set('c', Buffer.alloc(10));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    cache.set('big', Buffer.alloc(995));
    expect(cache.size).toBe(1);
  });
});

describe('AiTtsService', () => {
  it('sends Azure the SSML, the key header, the MP3 format and NeWay as the agent', async () => {
    const azure = fakeAzure();
    const { tts } = service(speakerWith(azure.fetchImpl, 'uz-UZ-MadinaNeural'));
    const r = await tts.speak(me, { text: '**Toʻlanmagan** hisoblar: 3 ta & <ok>' });
    expect(r.audio.subarray(0, 3).toString()).toBe('ID3');
    expect(r.voice).toBe('uz-UZ-MadinaNeural');
    const req = azure.sent[0]!;
    expect(req.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(req.method).toBe('POST');
    expect(req.headers['Ocp-Apim-Subscription-Key']).toBe('SECRET-KEY-123');
    expect(req.headers['Content-Type']).toBe('application/ssml+xml');
    expect(req.headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(req.headers['User-Agent']).toBe('NeWay');
    expect(req.body).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="uz-UZ"><voice name="uz-UZ-MadinaNeural">Toʻlanmagan hisoblar: 3 ta &amp; &lt;ok&gt;</voice></speak>',
    );
    // The key travels in the header only.
    expect(req.url + req.body).not.toContain('SECRET-KEY-123');
  });

  it('picks the voice by language, and the explicit language wins', async () => {
    const azure = fakeAzure();
    const { tts } = service(speakerWith(azure.fetchImpl));
    expect((await tts.speak(me, { text: 'Here are the unpaid invoices.' })).voice).toBe('en-US-AvaMultilingualNeural');
    expect((await tts.speak(me, { text: 'Вот неоплаченные счета.' })).voice).toBe('ru-RU-SvetlanaNeural');
    expect((await tts.speak(me, { text: 'Bu haftaning yuklari' })).voice).toBe('uz-UZ-SardorNeural');
    expect((await tts.speak(me, { text: 'Hello there', lang: 'uz' })).voice).toBe('uz-UZ-SardorNeural');
  });

  it('answers a repeat from the cache without calling Azure', async () => {
    const azure = fakeAzure();
    const { tts } = service(speakerWith(azure.fetchImpl));
    await tts.speak(me, { text: 'Same words twice.' });
    const again = await tts.speak(me, { text: 'Same words twice.' });
    expect(again.cached).toBe(true);
    expect(azure.sent).toHaveLength(1);
  });

  it('is a 404 tts_not_configured when the company has no Azure Speech account', async () => {
    const { tts } = service(null);
    const error = await tts.speak(me, { text: 'Salom' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(404);
    expect((error as AppError).extensions?.code).toBe('tts_not_configured');
  });

  it('maps an Azure 401 to "Azure rejected the key" and records it on the account', async () => {
    const azure = fakeAzure(401);
    const { tts, failures } = service(speakerWith(azure.fetchImpl));
    const error = (await tts.speak(me, { text: 'Salom, bu sinov' }).catch((e: unknown) => e)) as AppError;
    expect(error.status).toBe(502);
    expect(error.detail).toMatch(/Azure rejected the key/);
    expect(error.extensions?.code).toBe('tts_key_rejected');
    expect(error.detail).not.toContain('SECRET-KEY-123');
    expect(failures).toHaveLength(1);
  });

  it('refuses more than 4000 characters and empty speech, and rate-limits a person', async () => {
    const azure = fakeAzure();
    const { tts } = service(speakerWith(azure.fetchImpl));
    await expect(tts.speak(me, { text: 'a'.repeat(4001) })).rejects.toMatchObject({ status: 422 });
    await expect(tts.speak(me, { text: '| --- |' })).rejects.toMatchObject({ status: 422 });
    const other = { ...me, userId: 'usr_tts_flood' };
    for (let i = 0; i < 20; i++) await tts.speak(other, { text: `Line ${i}` });
    await expect(tts.speak(other, { text: 'One more' })).rejects.toMatchObject({ status: 429 });
  });
});

describe('AzureSpeechClient', () => {
  it('lists the voices with the key header, and maps a 401', async () => {
    const sent: Sent[] = [];
    const ok = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), method: init?.method ?? 'GET', headers: { ...((init?.headers as Record<string, string>) ?? {}) }, body: '' });
      return new Response(JSON.stringify([{ ShortName: 'uz-UZ-SardorNeural', Locale: 'uz-UZ', Gender: 'Male' }]), { status: 200 });
    }) as typeof fetch;
    const voices = await new AzureSpeechClient('K', 'westeurope', { fetchImpl: ok }).voices();
    expect(voices).toEqual([{ shortName: 'uz-UZ-SardorNeural', locale: 'uz-UZ', gender: 'Male' }]);
    expect(sent[0]!.url).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(sent[0]!.headers['Ocp-Apim-Subscription-Key']).toBe('K');
    await expect(new AzureSpeechClient('K', 'eastus', { fetchImpl: fakeAzure(401).fetchImpl }).voices()).rejects.toThrow(/Azure rejected the key/);
  });

  it('refuses a region that is not a region name', () => {
    expect(() => new AzureSpeechClient('K', 'evil.example.com/x')).toThrow(/not an Azure region/);
  });
});
