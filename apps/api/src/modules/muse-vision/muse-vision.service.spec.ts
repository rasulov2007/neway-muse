import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from '../../config/env';
import { MuseVisionService, museFilePart, museJsonSchema, parseMuseJson } from './muse-vision.service';

const e = env as { META_API_KEY?: string };
const schema = z.object({ number: z.string().nullable(), total: z.number().nullable() });
const file = { fileName: 'a.png', contentType: 'image/png', content: 'data:image/png;base64,iVBORw0KGgo=' };

const answer = (content: string, status = 200) =>
  new Response(
    JSON.stringify({
      model: 'muse-spark-1.3',
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 15 } },
    }),
    { status },
  );

describe('Muse request shape', () => {
  it('sends a photo as image_url and a PDF as a file part', () => {
    expect(museFilePart(file)).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } });
    expect(museFilePart({ fileName: 'rc.pdf', contentType: 'application/pdf', content: 'JVBERi0=' })).toEqual({
      type: 'file',
      file: { filename: 'rc.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
    });
    expect(() => museFilePart({ fileName: 'x.doc', contentType: 'application/msword', content: 'AA==' })).toThrow();
  });

  it('turns the zod schema into a strict JSON schema without $schema', () => {
    const json = museJsonSchema(schema);
    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({ type: 'object', additionalProperties: false, required: ['number', 'total'] });
  });

  it('reads JSON plain, fenced or wrapped in words', () => {
    expect(parseMuseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMuseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseMuseJson('Here it is: {"a":3} done')).toEqual({ a: 3 });
    expect(() => parseMuseJson('no json')).toThrow();
  });
});

describe('MuseVisionService.readJson', () => {
  const saved = e.META_API_KEY;
  beforeEach(() => {
    e.META_API_KEY = 'test-key';
  });
  afterEach(() => {
    e.META_API_KEY = saved;
    vi.unstubAllGlobals();
  });
  const read = () =>
    new MuseVisionService().readJson({ file, schema, schemaName: 't', instructions: 'i', prompt: 'p' });

  it('returns the validated value and asks for low reasoning effort with a strict schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer('{"number":"7781","total":4250}'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await read();
    expect(result.data).toEqual({ number: '7781', total: 4250 });
    expect(result.usage).toEqual({ promptTokens: 10, outputTokens: 20, reasoningTokens: 15 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      model: 'muse-spark-1.3',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer test-key');
  });

  it('asks once more when the answer does not match the schema, then gives up with a 422', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(answer('{"number":7781}')).mockResolvedValueOnce(answer('{"number":"1","total":2}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(read()).resolves.toMatchObject({ data: { number: '1', total: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => answer('not json')));
    await expect(read()).rejects.toMatchObject({ status: 422 });
  });

  it('says it is not set up without a key, and when the key is refused', async () => {
    e.META_API_KEY = undefined;
    await expect(read()).rejects.toMatchObject({ status: 503, title: 'Muse is not set up' });
    e.META_API_KEY = 'bad';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"no"}', { status: 401 })));
    await expect(read()).rejects.toMatchObject({ status: 503 });
  });

  it('maps a refused file to 422 and a dead network to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad media', { status: 400 })));
    await expect(read()).rejects.toMatchObject({ status: 422 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    await expect(read()).rejects.toMatchObject({ status: 502, title: 'Muse took too long' });
  });
});
