import { spokenLanguage, type DriverMe } from '@neway/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import { historyFrom } from './driver-assistant.controller';
import { DriverAssistantService, intentOf, voiceRules } from './driver-assistant.service';
import { MetaTranscribeClient, isWav } from './meta-transcribe.client';
import { readWav, toMetaWav } from './wav';

/**
 * Ask NeWay by voice (hackathon, Meta Muse) without a database: the WAV check, the Meta client's
 * request, the language guess, and the voice path end to end with stand-in services.
 */

/** A PCM WAV: `samples` frames of a 440 Hz tone (int16, or float32 when `float`). */
function wav(samples = 160, rate = 16_000, channels = 1, float = false): Buffer {
  const bytesPer = float ? 4 : 2;
  const data = Buffer.alloc(samples * channels * bytesPer);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * bytesPer;
      if (float) data.writeFloatLE(v, at);
      else data.writeInt16LE(Math.round(v * 32767), at);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * bytesPer, 28);
  header.writeUInt16LE(channels * bytesPer, 32);
  header.writeUInt16LE(bytesPer * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const principal = { companyId: 'co_test', userId: 'usr_test' } as Principal;

describe('toMetaWav', () => {
  it('keeps a 16/24 kHz mono 16-bit WAV as it is', () => {
    const a = wav(160, 16_000);
    expect(toMetaWav(a)).toBe(a);
    const b = wav(240, 24_000);
    expect(toMetaWav(b)).toBe(b);
  });

  it('turns a 48 kHz stereo float WAV (a browser or phone) into 16 kHz mono 16-bit', () => {
    const out = toMetaWav(wav(4800, 48_000, 2, true))!;
    const info = readWav(out)!;
    expect(info).toMatchObject({ format: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16 });
    expect(info.data.length).toBe(1600 * 2);
    // The tone survives: peak near half scale.
    let peak = 0;
    for (let i = 0; i < 1600; i++) peak = Math.max(peak, Math.abs(info.data.readInt16LE(i * 2)));
    expect(peak).toBeGreaterThan(14_000);
    expect(peak).toBeLessThan(17_000);
  });

  it('a header with no length (a recorder still writing) still reads; not a WAV is null', () => {
    const open = wav(4410, 44_100);
    open.writeUInt32LE(0, 40);
    expect(readWav(toMetaWav(open)!)!.data.length).toBe(1600 * 2);
    expect(toMetaWav(Buffer.from('ftypM4A not a wav'))).toBeNull();
  });
});

describe('spokenLanguage', () => {
  it('tells English, Russian and Uzbek (Latin and Cyrillic) apart', () => {
    expect(spokenLanguage('When is my next pickup?')).toBe('en');
    expect(spokenLanguage("What's the dog's name at 7 o'clock?")).toBe('en');
    expect(spokenLanguage('Когда у меня следующая погрузка?')).toBe('ru');
    expect(spokenLanguage('Keyingi pikap qachon?')).toBe('uz');
    expect(spokenLanguage("To'lov qachon bo'ladi?")).toBe('uz');
    expect(spokenLanguage('Кейинги юк қачон?')).toBe('uz');
    // What Meta's speech engine wrote for "Keyingi pikap qachon? Necha mil qoldi?" (2026-11-03).
    expect(spokenLanguage('Кинги Кинги пикап качон. Нича мил колди.')).toBe('uz');
    expect(spokenLanguage('Сколько миль осталось до доставки?')).toBe('ru');
    expect(spokenLanguage('')).toBe('en');
  });
});

describe('intentOf for spoken questions', () => {
  it('a pickup or "miles left" question is about the load ahead, in all three languages', () => {
    expect(intentOf('When is my next pickup, and how many miles are left?')).toBe('current_load');
    expect(intentOf('Когда у меня следующая погрузка и сколько миль осталось?')).toBe('current_load');
    expect(intentOf('Кинги пикап качон. Нича мил колди.')).toBe('current_load');
    expect(intentOf('How many miles did I drive?')).toBe('miles');
    expect(intentOf('When is my next pay?')).toBe('next_pay');
  });
});

describe('voice helpers', () => {
  it('knows a WAV; reads the optional history header', () => {
    expect(isWav(wav())).toBe(true);
    expect(isWav(Buffer.from('ftypM4A not a wav'))).toBe(false);
    expect(historyFrom(undefined)).toBeUndefined();
    expect(historyFrom('%E0%A4%A')).toBeUndefined();
    expect(historyFrom(encodeURIComponent(JSON.stringify([{ role: 'user', text: 'hi' }])))).toEqual([{ role: 'user', text: 'hi' }]);
    expect(historyFrom(encodeURIComponent(JSON.stringify([{ role: 'boss', text: 'x' }])))).toBeUndefined();
  });

  it('voice rules name the language and the Uzbek script', () => {
    expect(voiceRules('ru')[0]).toContain('ASKED BY VOICE in Russian');
    expect(voiceRules('uz')[0]).toContain('Latin script');
  });
});

describe('MetaTranscribeClient', () => {
  it('posts request + audio parts to /asr/transcribe and returns the transcript', async () => {
    const client = new MetaTranscribeClient();
    let seen: { url: string; request: Record<string, unknown>; size: number; auth: string | null } | null = null;
    client.setFetch(async (url, init) => {
      const form = init!.body as FormData;
      seen = {
        url: String(url),
        request: JSON.parse(await (form.get('request') as Blob).text()) as Record<string, unknown>,
        size: (form.get('audio') as Blob).size,
        auth: new Headers(init!.headers).get('authorization'),
      };
      return new Response(JSON.stringify({ transcript: ' Keyingi pikap qachon? ', audioDurationMs: 2300, turns: [] }), { status: 200 });
    });
    expect(client.configured()).toBe(true);
    const out = await client.transcribe(wav());
    expect(out).toEqual({ text: 'Keyingi pikap qachon?', audioDurationMs: 2300 });
    expect(seen!.url).toMatch(/\/asr\/transcribe$/);
    expect(seen!.request).toMatchObject({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV' });
    expect(seen!.size).toBe(wav().length);
    expect(seen!.auth).toBe('Bearer test-key');
  });

  it('throws with Meta\'s message on an error; not configured without a key', async () => {
    const client = new MetaTranscribeClient();
    client.setFetch(async () => new Response(JSON.stringify({ error: { message: 'Malformed request' } }), { status: 400 }));
    await expect(client.transcribe(wav())).rejects.toThrow('Malformed request');
    client.setFetch(async () => new Response('{}'), null);
    expect(client.configured()).toBe(false);
  });
});

describe('DriverAssistantService.voice', () => {
  function service(opts: { transcript: string; aiText: string | null; azure?: boolean }) {
    const prompts: string[] = [];
    const me = {
      today: '2026-11-03',
      driver: { firstName: 'Test', preferredLanguage: null },
      company: { name: 'Demo Freight' },
      truck: { unitNumber: '101' },
      trailer: null,
      dispatch: null,
    } as unknown as DriverMe;
    const load = {
      id: 'ld1', loadNumber: 'L-1001', reference: null, status: 'dispatched', statusLabel: 'Dispatched', scope: 'active', stopCount: 2,
      firstPickup: { stopId: 's1', kind: 'pickup', facilityName: 'Shipper', city: 'Chicago', state: 'IL', appointmentStartAt: '2026-11-04T19:00:00.000Z', appointmentEndAt: '', timezone: 'America/Chicago' },
      lastDelivery: { stopId: 's2', kind: 'delivery', facilityName: 'Receiver', city: 'Atlanta', state: 'GA', appointmentStartAt: '2026-11-05T15:00:00.000Z', appointmentEndAt: '', timezone: 'America/New_York' },
      nextStop: { stopId: 's1', kind: 'pickup', facilityName: 'Shipper', city: 'Chicago', state: 'IL', appointmentStartAt: '2026-11-04T19:00:00.000Z', appointmentEndAt: '', timezone: 'America/Chicago' },
      loadedMiles: 717, deadheadMiles: 40, truckUnit: '101', trailerUnit: null, acknowledgedAt: null, correctionsRequested: 0, updatedAt: '2026-11-03T10:00:00Z',
    };
    const loads = { me: async () => me, list: async (_p: unknown, scope: string) => ({ loads: scope === 'active' ? [load] : [] }) };
    const money = { mySettlements: async () => ({ settlements: [] }), myReceipts: async () => ({ reimbursements: [] }), mySettlement: async () => null };
    const settlements = { settings: async () => ({ payPeriodCutoffTime: '12:00', payDay: 'friday', payPeriodTimezone: 'America/New_York' }) };
    const ai = {
      configured: () => opts.aiText !== null,
      complete: async (_p: unknown, input: { system: string }) => {
        prompts.push(input.system);
        return opts.aiText;
      },
    };
    const speech = {
      speaker: async () => (opts.azure ? { accountId: 'acc', client: { transcribe: async () => 'from azure' } } : null),
      recordFailure: async () => undefined,
    };
    const meta = new MetaTranscribeClient();
    meta.setFetch(async () => new Response(JSON.stringify({ transcript: opts.transcript, audioDurationMs: 2000 }), { status: 200 }));
    const svc = new DriverAssistantService(loads as never, money as never, settlements as never, ai as never, speech as never, { clock: () => new Date() } as never, meta);
    return { svc, prompts };
  }

  it('Uzbek question: answered by the model, told to answer in Uzbek, with the load\'s miles and appointments', async () => {
    const { svc, prompts } = service({ transcript: 'Keyingi pikap qachon?', aiText: 'Keyingi pikap ertaga Chikagoda.' });
    const out = await svc.voice(principal, wav(), 'q.wav', 'audio/wav', undefined);
    expect(out).toMatchObject({ transcript: 'Keyingi pikap qachon?', language: 'uz', transcribedBy: 'meta' });
    expect(out.answer).toMatchObject({ source: 'ai', answer: 'Keyingi pikap ertaga Chikagoda.' });
    expect(prompts[0]).toContain('ASKED BY VOICE in Uzbek');
    expect(prompts[0]).toContain('"loadedMiles":717');
    expect(prompts[0]).toContain('"appointmentLocal":"Wed, Nov 4, 1:00 PM CST"');
    expect(prompts[0]).toContain('Wed, Nov 4, 2:00 PM ET');
  });

  it('without AI the data answer still comes back (the key-less path)', async () => {
    const { svc, prompts } = service({ transcript: 'When is my next pickup?', aiText: null });
    const out = await svc.voice(principal, wav(), 'q.wav', 'audio/wav', undefined);
    expect(out.language).toBe('en');
    expect(out.answer.source).toBe('data');
    expect(out.answer.answer).toContain('L-1001');
    expect(prompts).toHaveLength(0);
  });

  it('nothing heard is 422; a non-WAV recording goes to Azure when the company has it, else 415', async () => {
    await expect(service({ transcript: '', aiText: 'x' }).svc.voice(principal, wav(), 'q.wav', 'audio/wav', undefined)).rejects.toMatchObject({ status: 422 });
    const viaAzure = await service({ transcript: 'unused', aiText: 'ok', azure: true }).svc.transcribe(principal, Buffer.from('m4a bytes'), 'q.m4a', 'audio/mp4');
    expect(viaAzure.text).toBe('from azure');
    await expect(service({ transcript: 'unused', aiText: 'ok' }).svc.transcribe(principal, Buffer.from('m4a bytes'), 'q.m4a', 'audio/mp4')).rejects.toMatchObject({ status: 415 });
  });
});
