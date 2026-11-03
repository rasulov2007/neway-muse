import { z } from 'zod';
import { RateConfirmationExtractSchema, type RateConfirmationExtract } from '@neway/shared';
import { RC_INSTRUCTIONS } from './rc-instructions';

/** The JSON schema the local model is held to (Ollama's structured outputs). */
const FORMAT = z.toJSONSchema(RateConfirmationExtractSchema);

export interface OllamaReadResult {
  extract: RateConfirmationExtract;
  model: string;
  ms: number;
  promptTokens: number;
  outputTokens: number;
}

/**
 * Reads an RC's text with a model running in Ollama on our own server. Nothing leaves the
 * server; one request at a time is enough, the caller queues.
 */
export async function readWithOllama(
  baseUrl: string,
  model: string,
  text: string,
  options: { timeoutMs?: number; numCtx?: number; threads?: number } = {},
): Promise<OllamaReadResult> {
  const started = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // A stock model was seen looping for 1 h 48 min on one RC; a read that runs past 6 minutes is
    // abandoned and the dispatcher fills the form by hand.
    signal: AbortSignal.timeout(options.timeoutMs ?? 360_000),
    // Streamed: a read on a small CPU can pass five minutes, and Node's fetch gives up on a
    // response whose headers have not arrived by then.
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: '5m',
      format: FORMAT,
      // num_predict caps the answer: a full RC reading is ~600-900 tokens.
      options: { temperature: 0, num_ctx: options.numCtx ?? 8192, num_predict: 1500, ...(options.threads ? { num_thread: options.threads } : {}) },
      messages: [
        { role: 'system', content: RC_INSTRUCTIONS },
        { role: 'user', content: `Rate confirmation text (columns separated by " | "):\n\n${text}\n\nReturn the JSON.` },
      ],
    }),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  let content = '';
  let tail = '';
  let promptTokens = 0;
  let outputTokens = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    tail += decoder.decode(chunk, { stream: true });
    const parts = tail.split('\n');
    tail = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const piece = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string; prompt_eval_count?: number; eval_count?: number };
      if (piece.error) throw new Error(`Ollama: ${piece.error}`);
      content += piece.message?.content ?? '';
      if (piece.done) {
        promptTokens = piece.prompt_eval_count ?? 0;
        outputTokens = piece.eval_count ?? 0;
      }
    }
  }
  const body = { prompt_eval_count: promptTokens, eval_count: outputTokens };
  const parsed = RateConfirmationExtractSchema.safeParse(JSON.parse(content || 'null'));
  if (!parsed.success) throw new Error('The local model returned something that is not an RC reading');
  return {
    extract: parsed.data,
    model,
    ms: Date.now() - started,
    promptTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
  };
}

/** The one-line instruction `neway-rc-v2` was trained with (rctrain/build_text_v2.py SYSTEM). */
export const RC_V2_SYSTEM = 'Read this freight rate confirmation and return its load as JSON.';

const STOP_KEYS = ['facilityName', 'street', 'city', 'state', 'zip', 'date', 'time', 'endTime', 'reference'] as const;
const TOP_KEYS = ['brokerName', 'brokerMc', 'brokerLoadNumber', 'totalRate', 'linehaulRate', 'commodity', 'weightLbs', 'equipment', 'hazmat', 'temperature', 'miles'] as const;

/**
 * v2 answers are compact: keys whose value is null are left out, and there are no notes or
 * warnings (free text was the slowest thing to generate). This puts the full shape back.
 */
export function expandV2Answer(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TOP_KEYS) out[k] = r[k] ?? null;
  if (typeof out.brokerMc === 'number') out.brokerMc = String(out.brokerMc);
  if (typeof out.brokerLoadNumber === 'number') out.brokerLoadNumber = String(out.brokerLoadNumber);
  out.stops = (Array.isArray(r.stops) ? r.stops : []).map((s) => {
    const stop = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
    const full: Record<string, unknown> = { kind: stop.kind === 'delivery' ? 'delivery' : 'pickup' };
    for (const k of STOP_KEYS) full[k] = stop[k] === undefined || stop[k] === null ? null : String(stop[k]);
    return full;
  });
  out.notes = null;
  out.warnings = [];
  return out;
}

/**
 * Reads an RC with the fine-tuned `neway-rc-v2`: short prompt, compact JSON answer, small context.
 * `text` must already be `compactRcTextV2` output (or OCR text through it).
 */
export async function readWithOllamaV2(
  baseUrl: string,
  model: string,
  text: string,
  options: { timeoutMs?: number; threads?: number } = {},
): Promise<OllamaReadResult> {
  const started = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '30m',
      format: 'json',
      options: { temperature: 0, num_ctx: 4096, num_predict: 700, ...(options.threads ? { num_thread: options.threads } : {}) },
      messages: [
        { role: 'system', content: RC_V2_SYSTEM },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  let json: unknown = null;
  try {
    json = JSON.parse(body.message?.content || 'null');
  } catch {
    throw new Error('The local model returned something that is not JSON');
  }
  const parsed = RateConfirmationExtractSchema.safeParse(expandV2Answer(json));
  if (!parsed.success) throw new Error('The local model returned something that is not an RC reading');
  return {
    extract: parsed.data,
    model,
    ms: Date.now() - started,
    promptTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
  };
}
