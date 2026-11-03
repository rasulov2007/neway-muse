import type Anthropic from '@anthropic-ai/sdk';

/**
 * Meta Muse (muse-spark-1.3, muse-wonder-1.0) behind the same `create(params)` the assistant's
 * loop already uses: the loop speaks the Anthropic Messages shape, this adapter translates it to
 * Meta's OpenAI-compatible `POST /v1/chat/completions` and the answer back. Tool calls, tool
 * results, images and PDFs survive the trip, so server tools and the screen_* tools (which pause
 * the loop and resume from the browser's results) work unchanged.
 */

type Params = Anthropic.MessageCreateParamsNonStreaming;

export const MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const isMuseModel = (id: string): boolean => id.startsWith('muse-');

// ------------------------------------------------------------------------------ the wire format

export interface ChatTextPart {
  type: 'text';
  text: string;
}
export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export interface ChatFilePart {
  type: 'file';
  file: { filename: string; file_data: string };
}
export type ChatPart = ChatTextPart | ChatImagePart | ChatFilePart;

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  reasoning_effort?: string;
  temperature?: number;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters: unknown } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null; refusal?: string | null; tool_calls?: ChatToolCall[] | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ------------------------------------------------------------------------------ Anthropic → Meta

const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

/** Anthropic tool_use ids allow only [A-Za-z0-9_-]; Meta's are close but not promised. */
export const safeToolId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';

function systemText(system: Params['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n');
}

/** A content block the person (or a tool result) sends, as Meta reads it; null = not carried. */
function part(block: Anthropic.ContentBlockParam): ChatPart | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      if (block.source.type === 'base64') return { type: 'image_url', image_url: { url: dataUrl(block.source.media_type, block.source.data) } };
      if (block.source.type === 'url') return { type: 'image_url', image_url: { url: block.source.url } };
      return null;
    case 'document': {
      const src = block.source;
      // Meta takes PDFs as an OpenAI-style file part (image_url refuses application/pdf; tested 2026-11-03).
      if (src.type === 'base64') return { type: 'file', file: { filename: block.title || 'document.pdf', file_data: dataUrl(src.media_type, src.data) } };
      if (src.type === 'text') return { type: 'text', text: `${block.title ? `${block.title}:\n` : ''}${src.data}` };
      return null;
    }
    default:
      return null;
  }
}

/** A tool result: Meta's tool message holds text only, so images it carries follow as a user turn. */
function toolResult(block: Anthropic.ToolResultBlockParam): { message: ChatMessage; images: ChatPart[] } {
  const texts: string[] = [];
  const images: ChatPart[] = [];
  if (typeof block.content === 'string') texts.push(block.content);
  else
    for (const b of block.content ?? []) {
      const p = part(b as Anthropic.ContentBlockParam);
      if (!p) continue;
      if (p.type === 'text') texts.push(p.text);
      else images.push(p);
    }
  let content = texts.join('\n');
  if (block.is_error) content = `Error: ${content}`;
  return { message: { role: 'tool', tool_call_id: safeToolId(block.tool_use_id), content: content || '(no output)' }, images };
}

function messages(turns: Anthropic.MessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const turn of turns) {
    if (typeof turn.content === 'string') {
      out.push(turn.role === 'user' ? { role: 'user', content: turn.content } : { role: 'assistant', content: turn.content });
      continue;
    }
    if (turn.role === 'assistant') {
      const text = turn.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const calls: ChatToolCall[] = turn.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: safeToolId(b.id), type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      // Thinking blocks and server-tool blocks from Claude turns are not carried.
      out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    // A user turn: tool results first (each its own 'tool' message), then whatever else it carries.
    const parts: ChatPart[] = [];
    const images: ChatPart[] = [];
    for (const b of turn.content) {
      if (b.type === 'tool_result') {
        const r = toolResult(b);
        out.push(r.message);
        images.push(...r.images);
        continue;
      }
      const p = part(b);
      if (p) parts.push(p);
    }
    if (images.length) parts.unshift({ type: 'text', text: 'Images returned by the tools above:' }, ...images);
    if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as ChatTextPart).text).join('\n') : parts });
  }
  return out;
}

function toolChoice(choice: Params['tool_choice']): ChatRequest['tool_choice'] | undefined {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return undefined;
}

export function toChatRequest(params: Params, opts: { reasoningEffort?: string } = {}): ChatRequest {
  const req: ChatRequest = { model: params.model, messages: [], max_tokens: params.max_tokens };
  const sys = systemText(params.system);
  if (sys) req.messages.push({ role: 'system', content: sys });
  req.messages.push(...messages(params.messages));
  if (opts.reasoningEffort) req.reasoning_effort = opts.reasoningEffort;
  if (params.temperature !== undefined) req.temperature = params.temperature;
  const tools = (params.tools ?? []).flatMap((t) =>
    'input_schema' in t && t.input_schema ? [{ type: 'function' as const, function: { name: t.name, ...('description' in t && t.description ? { description: t.description } : {}), parameters: t.input_schema } }] : [],
  );
  if (tools.length) req.tools = tools;
  const choice = toolChoice(params.tool_choice);
  if (choice && tools.length) req.tool_choice = choice;
  return req;
}

// ------------------------------------------------------------------------------ Meta → Anthropic

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function fromChatResponse(resp: ChatResponse, requestedModel: string): Anthropic.Message {
  const choice = resp.choices?.[0];
  const msg = choice?.message ?? {};
  const raw = msg.content;
  const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '').trim() || (msg.refusal ?? '').trim();
  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: 'text', text, citations: null } as Anthropic.TextBlock);
  for (const call of msg.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: safeToolId(call.id), name: call.function.name, input: parseArgs(call.function.arguments) } as Anthropic.ToolUseBlock);
  }
  const hasCalls = content.some((b) => b.type === 'tool_use');
  const finish = choice?.finish_reason ?? 'stop';
  const stop: Anthropic.StopReason = hasCalls && finish !== 'length' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: resp.id ?? `muse_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: resp.model ?? requestedModel,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0 },
  } as Anthropic.Message;
}

// ------------------------------------------------------------------------------ the client

/** A failed Muse call. status 0 = no HTTP answer (timeout or network). */
export class MuseApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MuseApiError';
    this.status = status;
  }
  /** Worth another try, or a fallback model: the service failed, not the request. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface MuseClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Muse thinks a lot; 'low' keeps an interactive answer quick (brief, 2026-11-03). */
  reasoningEffort?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class MuseClient {
  private readonly opts: MuseClientOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  // No parameter properties in this file: scripts/muse-smoke.mjs loads it with Node's type stripping.
  constructor(opts: MuseClientOptions) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? MUSE_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async create(params: Params): Promise<Anthropic.Message> {
    const body = JSON.stringify(toChatRequest(params, { reasoningEffort: this.opts.reasoningEffort ?? 'low' }));
    const tries = 1 + (this.opts.retries ?? 1);
    let last: MuseApiError | null = null;
    for (let i = 0; i < tries; i++) {
      try {
        return fromChatResponse(await this.post(body), params.model);
      } catch (error) {
        last = error instanceof MuseApiError ? error : new MuseApiError(0, String(error));
        if (!last.transient) throw last;
      }
    }
    throw last!;
  }

  private async post(body: string): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 90_000),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      throw new MuseApiError(0, name === 'TimeoutError' || name === 'AbortError' ? 'Muse did not answer in time.' : `Muse could not be reached: ${(error as Error)?.message ?? error}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        /* not JSON */
      }
      throw new MuseApiError(res.status, `Muse answered ${res.status}: ${detail}`);
    }
    try {
      return JSON.parse(text) as ChatResponse;
    } catch {
      throw new MuseApiError(502, 'Muse sent an answer that is not JSON.');
    }
  }
}

// ------------------------------------------------------------------------------ routing

export interface ModelCreate {
  create(params: Params): Promise<Anthropic.Message>;
}

/**
 * One client for every model id: muse-* goes to Meta, the rest to Anthropic. A Muse call that
 * fails on Meta's side (5xx, timeout, network) is answered once by the Claude fallback model.
 */
export function routeModels(deps: {
  muse: () => ModelCreate | null;
  anthropic: () => ModelCreate | null;
  fallbackModel: string;
  onFallback?: (from: string, error: unknown) => void;
}): ModelCreate {
  return {
    async create(params) {
      if (!isMuseModel(params.model)) {
        const claude = deps.anthropic();
        if (!claude) throw new MuseApiError(503, 'NeWay AI is not set up: the server has no Anthropic key.');
        return claude.create(params);
      }
      const muse = deps.muse();
      if (!muse) throw new MuseApiError(503, 'NeWay AI is not set up: the server has no Meta key.');
      try {
        return await muse.create(params);
      } catch (error) {
        const claude = deps.anthropic();
        if (!(error instanceof MuseApiError && error.transient) || !claude) throw error;
        deps.onFallback?.(params.model, error);
        return claude.create({ ...params, model: deps.fallbackModel });
      }
    },
  };
}
