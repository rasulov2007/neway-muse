/**
 * Ask NeWay by voice against the REAL Meta Model API (hackathon, 2026-11-03): the sample clips in
 * docs/hackathon/samples/voice go through DriverAssistantService.voice with the real Meta
 * transcription client; the answer model is Muse (muse-spark-1.3) called the way NeWay AI's
 * complete() will call it once the Muse adapter lands. The driver's facts are a made-up demo
 * driver (no database needed). Skips unless asked:
 *
 *   VOICE_EVAL=1 META_API_KEY=... npx vitest run test/voice-eval.spec.ts
 *
 * One JSON line per clip (transcript, language, answer, seconds) for voice-results.md, appended
 * to VOICE_EVAL_OUT when set (vitest may swallow console output).
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DriverMe } from '@neway/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { DriverAssistantService } from '../src/modules/mobile/driver-assistant.service';
import { MetaTranscribeClient } from '../src/modules/mobile/meta-transcribe.client';

const DIR = join(__dirname, '..', '..', '..', 'docs', 'hackathon', 'samples', 'voice');
const KEY = process.env.META_API_KEY;
const MODEL = process.env.VOICE_EVAL_MODEL ?? 'muse-spark-1.3';
const ready = process.env.VOICE_EVAL === '1' && Boolean(KEY);

const iso = (daysFromNow: number, hourUtc: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

function demoService() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const me = { today, driver: { firstName: 'Demo', preferredLanguage: null }, company: { name: 'Demo Freight' }, truck: { unitNumber: '1042' }, trailer: { unitNumber: 'T-310' }, dispatch: { name: 'Dispatch desk', phone: null, email: null } } as unknown as DriverMe;
  const pickup = { stopId: 's1', kind: 'pickup', facilityName: 'Demo Foods DC', city: 'Joliet', state: 'IL', appointmentStartAt: iso(1, 19), appointmentEndAt: '', timezone: 'America/Chicago' };
  const delivery = { stopId: 's2', kind: 'delivery', facilityName: 'Demo Grocers', city: 'Atlanta', state: 'GA', appointmentStartAt: iso(3, 14), appointmentEndAt: '', timezone: 'America/New_York' };
  const load = { id: 'ld_demo', loadNumber: 'L-24817', reference: null, status: 'dispatched', statusLabel: 'Dispatched', scope: 'active', stopCount: 2, firstPickup: pickup, lastDelivery: delivery, nextStop: pickup, loadedMiles: 717, deadheadMiles: 38, truckUnit: '1042', trailerUnit: 'T-310', acknowledgedAt: null, correctionsRequested: 0, updatedAt: new Date().toISOString() };
  const loads = { me: async () => me, list: async (_p: unknown, scope: string) => ({ loads: scope === 'active' ? [load] : [] }) };
  const money = { mySettlements: async () => ({ settlements: [] }), myReceipts: async () => ({ reimbursements: [] }), mySettlement: async () => null };
  const settlements = { settings: async () => ({ payPeriodCutoffTime: '12:00', payDay: 'friday', payPeriodTimezone: 'America/New_York' }) };
  // NeWay AI's complete(), as A1's Muse adapter makes it: OpenAI-compatible chat, low reasoning.
  const ai = {
    configured: () => true,
    complete: async (_p: unknown, input: { system: string; messages: Array<{ role: string; text: string }>; maxTokens?: number }) => {
      const res = await fetch('https://api.meta.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, reasoning_effort: 'low', max_completion_tokens: 2000, messages: [{ role: 'system', content: input.system }, ...input.messages.map((m) => ({ role: m.role, content: m.text }))] }),
      });
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content?.trim() || null;
    },
  };
  const speech = { speaker: async () => null, recordFailure: async () => undefined };
  return new DriverAssistantService(loads as never, money as never, settlements as never, ai as never, speech as never, { clock: () => new Date() } as never, new MetaTranscribeClient());
}

describe.skipIf(!ready)('Ask NeWay by voice on the real Meta API', () => {
  it('hears each sample clip and answers in its language', async () => {
    const svc = demoService();
    const principal = { companyId: 'co_demo', userId: 'usr_demo' } as Principal;
    const clips = readdirSync(DIR).filter((f) => f.endsWith('.wav')).sort();
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      const t0 = Date.now();
      const out = await svc.voice(principal, readFileSync(join(DIR, clip)), clip, 'audio/wav', undefined);
      const total = Date.now() - t0;
      const line = JSON.stringify({ clip, transcript: out.transcript, language: out.language, source: out.answer.source, answer: out.answer.answer, transcribeS: out.timings.transcribeMs / 1000, answerS: out.timings.answerMs / 1000, totalS: total / 1000 });
      if (process.env.VOICE_EVAL_OUT) appendFileSync(process.env.VOICE_EVAL_OUT, `${line}\n`);
      else console.log(line);
      expect(out.transcript.length).toBeGreaterThan(0);
    }
  }, 300_000);
});
