import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { fromChatResponse, MuseApiError, MuseClient, routeModels, toChatRequest, type ChatResponse } from './muse-client';

type Params = Anthropic.MessageCreateParamsNonStreaming;

const tools: Anthropic.Tool[] = [
  { name: 'find_load', description: 'One load by its number', input_schema: { type: 'object', properties: { load_number: { type: 'string' } }, required: ['load_number'] } },
  { name: 'screen_read', description: 'Read the screen', input_schema: { type: 'object', properties: {} } },
];

const reply = (message: NonNullable<NonNullable<ChatResponse['choices']>[number]['message']>, finish = 'stop'): ChatResponse => ({
  id: 'chatcmpl-1',
  model: 'muse-spark-1.3',
  choices: [{ finish_reason: finish, message }],
  usage: { prompt_tokens: 535, completion_tokens: 101 },
});

/** A Meta that answers from a script, recording every request body. */
function fakeMeta(answers: Array<{ status: number; body: unknown } | Error>) {
  const sent: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, sent, headers };
}

describe('Muse adapter: Anthropic request → chat/completions', () => {
  it('carries system, tools, text, images, PDFs, tool calls and tool results', () => {
    const params: Params = {
      model: 'muse-spark-1.3',
      max_tokens: 3000,
      system: 'You are NeWay AI.',
      tools,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0' }, title: 'rc.pdf' },
            { type: 'text', text: 'Find load L-100005 and read the screen' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden', signature: 'sig' },
            { type: 'text', text: 'Looking it up.' },
            { type: 'tool_use', id: 'tu1', name: 'find_load', input: { load_number: 'L-100005' } },
            { type: 'tool_use', id: 'tu2', name: 'screen_read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: '{"status":"delivered"}' },
            { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'Route /loads' }], is_error: true },
          ],
        },
      ],
    };
    const req = toChatRequest(params, { reasoningEffort: 'low' });
    expect(req.model).toBe('muse-spark-1.3');
    expect(req.max_tokens).toBe(3000);
    expect(req.reasoning_effort).toBe('low');
    expect(req.tools).toEqual([
      { type: 'function', function: { name: 'find_load', description: 'One load by its number', parameters: tools[0]!.input_schema } },
      { type: 'function', function: { name: 'screen_read', description: 'Read the screen', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(req.messages).toEqual([
      { role: 'system', content: 'You are NeWay AI.' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'file', file: { filename: 'rc.pdf', file_data: 'data:application/pdf;base64,JVBERi0' } },
          { type: 'text', text: 'Find load L-100005 and read the screen' },
        ],
      },
      {
        role: 'assistant',
        content: 'Looking it up.',
        tool_calls: [
          { id: 'tu1', type: 'function', function: { name: 'find_load', arguments: '{"load_number":"L-100005"}' } },
          { id: 'tu2', type: 'function', function: { name: 'screen_read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tu1', content: '{"status":"delivered"}' },
      { role: 'tool', tool_call_id: 'tu2', content: 'Error: Route /loads' },
    ]);
  });

  it('plain string turns stay strings; a tool image follows the tool messages as a user turn', () => {
    const req = toChatRequest({
      model: 'muse-spark-1.3',
      max_tokens: 800,
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'screen_read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }] }] },
      ],
    });
    expect(req.messages[0]).toEqual({ role: 'system', content: 'A\nB' });
    expect(req.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(req.messages[2]).toMatchObject({ role: 'assistant', content: null });
    expect(req.messages[3]).toEqual({ role: 'tool', tool_call_id: 'x', content: '(no output)' });
    expect(req.messages[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tools above:' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] });
    expect(req.tools).toBeUndefined();
  });
});

describe('Muse adapter: chat/completions → Anthropic message', () => {
  it('tool calls become tool_use blocks with ids and stop_reason tool_use', () => {
    const msg = fromChatResponse(
      reply({ content: "I'll pull up load L-100005.", tool_calls: [{ id: 'call_6eb2-dd30', type: 'function', function: { name: 'find_load', arguments: '{"load_number":"L-100005"}' } }] }, 'tool_calls'),
      'muse-spark-1.3',
    );
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.model).toBe('muse-spark-1.3');
    expect(msg.usage).toMatchObject({ input_tokens: 535, output_tokens: 101 });
    expect(msg.content).toEqual([
      { type: 'text', text: "I'll pull up load L-100005.", citations: null },
      { type: 'tool_use', id: 'call_6eb2-dd30', name: 'find_load', input: { load_number: 'L-100005' } },
    ]);
  });

  it('end_turn, max_tokens, odd ids and broken arguments', () => {
    expect(fromChatResponse(reply({ content: 'Done.' }), 'm').stop_reason).toBe('end_turn');
    expect(fromChatResponse(reply({ content: 'Cut' }, 'length'), 'm').stop_reason).toBe('max_tokens');
    const odd = fromChatResponse(reply({ content: null, tool_calls: [{ id: 'call:1/2', type: 'function', function: { name: 'screen_read', arguments: 'not json' } }] }, 'tool_calls'), 'm');
    expect(odd.content).toEqual([{ type: 'tool_use', id: 'call_1_2', name: 'screen_read', input: {} }]);
    expect(fromChatResponse({}, 'muse-spark-1.3')).toMatchObject({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
  });
});

describe('MuseClient', () => {
  const params: Params = { model: 'muse-spark-1.3', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

  it('posts with the bearer key and low reasoning, retries once on a 5xx', async () => {
    const meta = fakeMeta([{ status: 502, body: { error: { message: 'bad gateway' } } }, { status: 200, body: reply({ content: 'Hello' }) }]);
    const client = new MuseClient({ apiKey: 'k-test', fetchImpl: meta.fetchImpl });
    const msg = await client.create(params);
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello', citations: null }]);
    expect(meta.sent).toHaveLength(2);
    expect(meta.sent[0]).toMatchObject({ model: 'muse-spark-1.3', reasoning_effort: 'low', max_tokens: 100 });
    expect(meta.headers[0]!.authorization).toBe('Bearer k-test');
  });

  it('a 400 is not retried and says what Meta said', async () => {
    const meta = fakeMeta([{ status: 400, body: { error: { message: 'unsupported media type' } } }]);
    const err = await new MuseClient({ apiKey: 'k', fetchImpl: meta.fetchImpl }).create(params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuseApiError);
    expect((err as MuseApiError).status).toBe(400);
    expect((err as MuseApiError).message).toContain('unsupported media type');
    expect(meta.sent).toHaveLength(1);
  });

  it('a timeout counts as transient', async () => {
    const meta = fakeMeta([Object.assign(new Error('t'), { name: 'TimeoutError' }), Object.assign(new Error('t'), { name: 'TimeoutError' })]);
    const err = (await new MuseClient({ apiKey: 'k', fetchImpl: meta.fetchImpl }).create(params).catch((e: unknown) => e)) as MuseApiError;
    expect(err.status).toBe(0);
    expect(err.transient).toBe(true);
    expect(meta.sent).toHaveLength(2);
  });
});

describe('routeModels', () => {
  const answer = (model: string): Anthropic.Message => ({ id: 'm', type: 'message', role: 'assistant', model, content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message;

  it('sends muse-* to Meta, claude-* to Anthropic', async () => {
    const asked: string[] = [];
    const router = routeModels({
      muse: () => ({ create: async (p) => (asked.push(`meta:${p.model}`), answer(p.model)) }),
      anthropic: () => ({ create: async (p) => (asked.push(`anthropic:${p.model}`), answer(p.model)) }),
      fallbackModel: 'claude-haiku-4-5',
    });
    await router.create({ model: 'muse-spark-1.3', max_tokens: 1, messages: [] });
    await router.create({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [] });
    expect(asked).toEqual(['meta:muse-spark-1.3', 'anthropic:claude-sonnet-5-5']);
  });

  it('a Muse 5xx falls back to the Claude default once; a 4xx does not', async () => {
    const fellBack: string[] = [];
    let museStatus = 503;
    const router = routeModels({
      muse: () => ({
        create: async () => {
          throw new MuseApiError(museStatus, 'down');
        },
      }),
      anthropic: () => ({ create: async (p) => answer(p.model) }),
      fallbackModel: 'claude-haiku-4-5',
      onFallback: (from) => fellBack.push(from),
    });
    expect((await router.create({ model: 'muse-spark-1.3', max_tokens: 1, messages: [] })).model).toBe('claude-haiku-4-5');
    expect(fellBack).toEqual(['muse-spark-1.3']);
    museStatus = 400;
    await expect(router.create({ model: 'muse-spark-1.3', max_tokens: 1, messages: [] })).rejects.toBeInstanceOf(MuseApiError);
  });

  it('no Anthropic key: the Muse error stands', async () => {
    const router = routeModels({
      muse: () => ({
        create: async () => {
          throw new MuseApiError(0, 'timeout');
        },
      }),
      anthropic: () => null,
      fallbackModel: 'claude-haiku-4-5',
    });
    await expect(router.create({ model: 'muse-spark-1.3', max_tokens: 1, messages: [] })).rejects.toMatchObject({ status: 0 });
  });
});
