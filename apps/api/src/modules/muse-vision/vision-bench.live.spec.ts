import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CDL_READ_FIELDS, CDL_MUSE_INSTRUCTIONS, CdlMuseAnswerSchema, cdlReadingFromAnswer } from '@neway/shared';
import { env } from '../../config/env';
import { RateConfirmationReaderService } from '../loads/rate-confirmation-reader.service';
import { MuseVisionService } from './muse-vision.service';

/**
 * The Muse vision benchmark (hackathon, 2026-11-03). Live: it calls api.meta.ai, so it runs only
 * with MUSE_LIVE=1 and a key - META_API_KEY, or META_KEY_FILE pointing at a file holding
 * LLAMA_API_KEY=... (read here at runtime, never printed). Reads the fake samples in
 * docs/hackathon/samples, scores every field against truth.json and writes
 * docs/hackathon/vision-results.json.
 *
 *   MUSE_LIVE=1 META_KEY_FILE=... npx vitest run src/modules/muse-vision/vision-bench.live.spec.ts
 */

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SAMPLES = join(ROOT, 'docs', 'hackathon', 'samples');
const live = process.env.MUSE_LIVE === '1';

function loadKey() {
  const e = env as { META_API_KEY?: string; RC_READER_PROVIDER: string; ANTHROPIC_API_KEY?: string; OLLAMA_URL?: string; RC_CARRIER_NUMBERS?: string };
  if (!e.META_API_KEY && process.env.META_KEY_FILE && existsSync(process.env.META_KEY_FILE)) {
    e.META_API_KEY = readFileSync(process.env.META_KEY_FILE, 'utf8').match(/(?:LLAMA|META)_API_KEY=(.+)/)?.[1]?.trim();
  }
  e.RC_READER_PROVIDER = 'muse';
  // Muse alone: no Claude, no Ollama, so a failure shows as a failure.
  e.ANTHROPIC_API_KEY = undefined;
  e.OLLAMA_URL = undefined;
  e.RC_CARRIER_NUMBERS = '100200,3004005';
  return Boolean(e.META_API_KEY);
}

const norm = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : Array.isArray(v)
      ? [...v].map(norm).sort().join(',')
      : typeof v === 'number'
        ? String(Math.round(v * 100) / 100)
        : String(v).toLowerCase().replace(/º/g, '°').replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();

function score(expected: Record<string, unknown>, got: Record<string, unknown>, fields: string[], prefix = '') {
  const misses: string[] = [];
  for (const f of fields) if (norm(expected[f]) !== norm(got[f])) misses.push(`${prefix}${f}: expected "${norm(expected[f])}" got "${norm(got[f])}"`);
  return { right: fields.length - misses.length, total: fields.length, misses };
}

const mime = (file: string) =>
  file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';

const RC_FIELDS = ['brokerName', 'brokerMc', 'brokerLoadNumber', 'totalRate', 'linehaulRate', 'commodity', 'weightLbs', 'equipment', 'hazmat', 'temperature', 'miles'];
const STOP_FIELDS = ['kind', 'facilityName', 'street', 'city', 'state', 'zip', 'date', 'time', 'endTime', 'reference'];

describe.runIf(live)('Muse vision benchmark (live)', () => {
  it('reads every sample and records accuracy and time', { timeout: 30 * 60_000 }, async () => {
    expect(loadKey()).toBe(true);
    const truth = JSON.parse(readFileSync(join(SAMPLES, 'truth.json'), 'utf8')) as {
      cdl: Record<string, Record<string, unknown>>;
      rc: Record<string, Record<string, unknown> & { stops: Record<string, unknown>[] }>;
    };
    const muse = new MuseVisionService();
    const results: Record<string, unknown>[] = [];

    for (const [file, expected] of Object.entries(truth.cdl)) {
      const started = Date.now();
      try {
        const read = await muse.readJson({
          file: { fileName: file, contentType: mime(file), content: readFileSync(join(SAMPLES, file)).toString('base64') },
          schema: CdlMuseAnswerSchema,
          schemaName: 'cdl_reading',
          instructions: CDL_MUSE_INSTRUCTIONS,
          prompt: `Read this driver licence (${file}).`,
        });
        const proposal = cdlReadingFromAnswer(read.data, { application: null, today: '2026-11-03' });
        const s = score(expected, proposal.extract as unknown as Record<string, unknown>, [...CDL_READ_FIELDS]);
        results.push({ kind: 'cdl', file, seconds: (Date.now() - started) / 1000, ...s, needsReview: proposal.extract.needsReview, warnings: proposal.warnings.map((w) => w.message), usage: read.usage });
      } catch (error) {
        results.push({ kind: 'cdl', file, seconds: (Date.now() - started) / 1000, right: 0, total: CDL_READ_FIELDS.length, error: String(error) });
      }
    }

    const reader = new RateConfirmationReaderService(muse);
    for (const [file, expected] of Object.entries(truth.rc)) {
      const started = Date.now();
      const total = RC_FIELDS.length + expected.stops.length * STOP_FIELDS.length;
      try {
        const read = await reader.read('co_bench', { fileName: file, contentType: mime(file) as 'application/pdf', content: readFileSync(join(SAMPLES, file)).toString('base64') });
        const header = score(expected, read.extract as unknown as Record<string, unknown>, RC_FIELDS);
        let right = header.right;
        const misses = [...header.misses];
        expected.stops.forEach((stop, i) => {
          const got = (read.extract.stops[i] ?? {}) as Record<string, unknown>;
          const s = score(stop, got, STOP_FIELDS, `stop${i + 1}.`);
          right += s.right;
          misses.push(...s.misses);
        });
        if (read.extract.stops.length !== expected.stops.length) misses.push(`stops: expected ${expected.stops.length} got ${read.extract.stops.length}`);
        results.push({ kind: 'rc', file, model: read.model, seconds: (Date.now() - started) / 1000, right, total, misses, warnings: read.extract.warnings });
      } catch (error) {
        results.push({ kind: 'rc', file, seconds: (Date.now() - started) / 1000, right: 0, total, error: String(error) });
      }
    }

    const out = { ranAt: new Date().toISOString(), model: env.MUSE_VISION_MODEL, reasoningEffort: 'low', results };
    writeFileSync(join(ROOT, 'docs', 'hackathon', 'vision-results.json'), JSON.stringify(out, null, 2) + '\n');
    for (const r of results) console.log(`${r.kind} ${r.file}: ${r.right}/${r.total} in ${r.seconds}s ${r.error ?? ''}`);
  });
});
