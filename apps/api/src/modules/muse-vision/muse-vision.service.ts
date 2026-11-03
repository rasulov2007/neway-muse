import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';

/**
 * Meta Muse vision (hackathon, 2026-11-03): one file in, JSON out, held to a zod schema.
 *
 * Self-contained on purpose - NeWay AI's chat adapter is a separate thing. This one sends a
 * single document (photo or PDF) with instructions, asks for structured output, and returns the
 * parsed value or an AppError the screen can say in words. It writes nothing anywhere.
 *
 * How Muse takes a file (tested 2026-11-03 against api.meta.ai):
 * - photos travel as `image_url` with a data URL (JPEG, PNG, GIF, WebP);
 * - PDFs are refused as `image_url` but accepted as an OpenAI-style `file` part with `file_data`.
 * `response_format: json_schema` with `strict: true` works with zod 4's `toJSONSchema` output.
 */

export const MUSE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export interface MuseFile {
  fileName: string;
  contentType: string;
  /** Base64, or a data URL. */
  content: string;
}

export interface MuseJsonResult<T> {
  data: T;
  model: string;
  ms: number;
  usage: { promptTokens: number; outputTokens: number; reasoningTokens: number };
}

type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

/** The message part a file travels in. Exported for the tests. */
export function museFilePart(file: MuseFile): ChatPart {
  const base64 = file.content.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const url = `data:${file.contentType};base64,${base64}`;
  if (file.contentType === 'application/pdf') {
    return { type: 'file', file: { filename: file.fileName, file_data: url } };
  }
  if ((MUSE_IMAGE_TYPES as readonly string[]).includes(file.contentType)) {
    return { type: 'image_url', image_url: { url } };
  }
  throw new AppError({
    status: 422,
    title: 'This file type cannot be read',
    detail: 'Send a PDF or a photo (JPEG, PNG or WebP).',
  });
}

/** The JSON schema Muse is held to, from the zod schema. */
export function museJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * Muse's answer text as a value: plain JSON, or JSON in a code fence, or the first {...} block.
 * Exported for the tests.
 */
export function parseMuseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [trimmed, fenced, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  throw new SyntaxError('Muse did not answer with JSON');
}

@Injectable()
export class MuseVisionService {
  private readonly logger = new Logger(MuseVisionService.name);

  get configured(): boolean {
    return Boolean(env.META_API_KEY);
  }

  get model(): string {
    return env.MUSE_VISION_MODEL;
  }

  /**
   * Reads one file and returns what `schema` describes. One retry when the answer does not parse
   * or does not match the schema - the model occasionally drops a field.
   */
  async readJson<T>(options: {
    file: MuseFile;
    schema: z.ZodType<T>;
    schemaName: string;
    instructions: string;
    prompt: string;
    /** For the log line only. */
    companyId?: string;
  }): Promise<MuseJsonResult<T>> {
    if (!env.META_API_KEY) {
      throw new AppError({
        status: 503,
        title: 'Muse is not set up',
        detail: 'The Meta API key is not set on this server.',
      });
    }
    const part = museFilePart(options.file);
    const body = {
      model: env.MUSE_VISION_MODEL,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: options.instructions },
        { role: 'user', content: [part, { type: 'text', text: options.prompt }] },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: options.schemaName, strict: true, schema: museJsonSchema(options.schema) },
      },
    };

    const started = Date.now();
    let lastIssue = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const answer = await this.call(body);
      const text = answer.choices?.[0]?.message?.content ?? '';
      let parsed: unknown;
      try {
        parsed = parseMuseJson(text);
      } catch {
        lastIssue = 'not JSON';
        continue;
      }
      const checked = options.schema.safeParse(parsed);
      if (!checked.success) {
        lastIssue = z.prettifyError(checked.error).slice(0, 300);
        continue;
      }
      const ms = Date.now() - started;
      const usage = {
        promptTokens: answer.usage?.prompt_tokens ?? 0,
        outputTokens: answer.usage?.completion_tokens ?? 0,
        reasoningTokens: answer.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      };
      this.logger.log({ companyId: options.companyId, schema: options.schemaName, ms, attempt, ...usage }, 'Muse read');
      return { data: checked.data, model: answer.model ?? env.MUSE_VISION_MODEL, ms, usage };
    }
    this.logger.warn({ companyId: options.companyId, schema: options.schemaName, issue: lastIssue }, 'Muse answer unusable');
    throw new AppError({
      status: 422,
      title: 'Muse could not read this file',
      detail: 'Try a clearer copy, or fill the fields by hand.',
    });
  }

  private async call(body: unknown): Promise<MuseChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${env.META_API_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.META_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.MUSE_VISION_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AppError({
        status: 502,
        title: timedOut ? 'Muse took too long' : 'Muse did not answer',
        detail: 'Try again, or fill the fields by hand.',
        cause: error,
      });
    }
    if (response.ok) return (await response.json()) as MuseChatResponse;
    // The body says why; it never carries the key, but keep the log short anyway.
    const reason = (await response.text().catch(() => '')).slice(0, 300);
    this.logger.warn({ status: response.status, reason }, 'Muse refused the request');
    if (response.status === 401 || response.status === 403) {
      throw new AppError({ status: 503, title: 'Muse is not set up', detail: 'The Meta API key was refused.' });
    }
    if (response.status === 429) {
      throw new AppError({ status: 503, title: 'Muse is busy', detail: 'Try again in a minute.' });
    }
    if (response.status === 400 || response.status === 413 || response.status === 415) {
      throw new AppError({
        status: 422,
        title: 'Muse could not open this file',
        detail: 'Check it is a readable PDF or photo.',
      });
    }
    throw new AppError({ status: 502, title: 'Muse did not answer', detail: 'Try again, or fill the fields by hand.' });
  }
}

interface MuseChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}
