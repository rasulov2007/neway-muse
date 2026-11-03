import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  RC_READER_MAX_BYTES,
  RateConfirmationExtractSchema,
  tidyRcExtract,
  type ReadRateConfirmationInput,
  type RateConfirmationExtract,
  type RateConfirmationReadResult,
} from '@neway/shared';
import { env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';
import { RC_INSTRUCTIONS } from './rc-instructions';
import { MuseVisionService } from '../muse-vision/muse-vision.service';
import { readWithOllama, readWithOllamaV2 } from './rc-ollama';
import { readWithTemplate } from './rc-templates';
import { compactRcText, compactRcTextV2, hasTextLayer, pdfOcrText, pdfText } from './rc-text';

/**
 * Reads a rate confirmation and hands back what it says. It writes nothing: the dispatcher checks
 * the filled form and books the load as always.
 *
 * Order, cheapest first (owner, 2026-09-30):
 * 1. A PDF with text goes to the local model in Ollama on our own server - free, nothing leaves.
 * 2. Claude, only when an Anthropic key is set - for scans and photos, or when the local model is
 *    off or fails.
 * Every answer passes the same checks (`tidyRcExtract`).
 */
/**
 * What Claude is held to. Structured output allows at most 16 nullable fields and the extract has
 * 21, so a stop's text fields travel as plain strings ("" = not on the RC) and are turned back
 * into nulls here (2026-10-17).
 */
const RcWireStopSchema = z.object({
  kind: z.enum(['pickup', 'delivery']),
  facilityName: z.string(),
  street: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  date: z.string(),
  time: z.string(),
  endTime: z.string(),
  reference: z.string(),
});
const RcWireSchema = RateConfirmationExtractSchema.extend({ stops: z.array(RcWireStopSchema) });
const RC_WIRE_NOTE =
  '\n\nFor each stop, write an empty string for anything the RC does not give (facility, street, city, state, zip, date, time, end time, reference).';

function fromWire(w: z.infer<typeof RcWireSchema>): RateConfirmationExtract {
  const n = (v: string) => (v.trim() === '' ? null : v.trim());
  return { ...w, stops: w.stops.map((s) => ({ kind: s.kind, facilityName: n(s.facilityName), street: n(s.street), city: n(s.city), state: n(s.state), zip: n(s.zip), date: n(s.date), time: n(s.time), endTime: n(s.endTime), reference: n(s.reference) })) };
}

@Injectable()
export class RateConfirmationReaderService {
  private readonly logger = new Logger(RateConfirmationReaderService.name);
  private client: Anthropic | null = null;
  /** The local model reads one RC at a time; the next one waits its turn. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Meta Muse (hackathon, 2026-11-03): optional so the reader still builds on its own in tests. */
  constructor(@Optional() private readonly muse?: MuseVisionService) {}

  private carrierNumbers(): string[] {
    return (env.RC_CARRIER_NUMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  async read(companyId: string, input: ReadRateConfirmationInput): Promise<RateConfirmationReadResult> {
    const data = input.content.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    const bytes = Math.floor((data.length * 3) / 4);
    if (bytes === 0) throw new AppError({ status: 422, title: 'The file is empty' });
    if (bytes > RC_READER_MAX_BYTES) {
      throw new AppError({ status: 422, title: 'The file is too large', detail: 'The RC reader takes files up to 20 MB.' });
    }
    let text = '';
    if (input.contentType === 'application/pdf') {
      try {
        text = await pdfText(Buffer.from(data, 'base64'));
      } catch (error) {
        this.logger.warn({ companyId, error: String(error) }, 'pdftotext failed');
      }
    }

    // A broker we have a template for: exact, instant, free.
    const templated = hasTextLayer(text) ? readWithTemplate(text) : null;
    if (templated) {
      this.logger.log({ companyId, template: templated.template }, 'RC read (template)');
      return { extract: tidyRcExtract(templated.extract, this.carrierNumbers()), model: `template:${templated.template}` };
    }

    // Muse first when the server asks for it (RC_READER_PROVIDER=muse, hackathon 2026-11-03): a
    // vision model reads PDFs and photos alike in seconds. When Muse cannot answer, the readers
    // below take over exactly as they did before.
    if (env.RC_READER_PROVIDER === 'muse' && this.muse?.configured) {
      try {
        const read = await this.readWithMuse(companyId, input, data);
        return { extract: tidyRcExtract(read.extract, this.carrierNumbers()), model: read.model };
      } catch (error) {
        const fallback = Boolean(env.ANTHROPIC_API_KEY || env.OLLAMA_URL);
        if (!fallback || !(error instanceof AppError) || error.status === 422) throw error;
        this.logger.warn({ companyId, error: String(error) }, 'Muse unavailable; reading with the other readers');
      }
    }

    // Claude first once a key is set (owner, 2026-10-17): seconds instead of the local model's
    // minutes, scans and photos included. When Claude cannot answer - no credit on the account,
    // the key refused, busy - the local reader below takes over instead of failing the form.
    const claudeFirst = Boolean(env.ANTHROPIC_API_KEY) && env.RC_READER_PREFER === 'claude';
    if (claudeFirst) {
      try {
        const extract = await this.readWithClaude(companyId, input, data);
        return { extract: tidyRcExtract(extract.extract, this.carrierNumbers()), model: extract.model };
      } catch (error) {
        const unavailable = error instanceof AppError && (error.status === 503 || error.status === 502);
        if (!unavailable || !env.OLLAMA_URL) throw error;
        this.logger.warn({ companyId, error: String(error) }, 'Claude unavailable; reading with the local model');
      }
    }

    // v2 reads scans too: their text comes from OCR, the way its training examples were made.
    if (env.OLLAMA_URL && env.RC_READER_VERSION === 'v2') {
      try {
        let source = text;
        if (!hasTextLayer(text) && input.contentType === 'application/pdf') {
          const t = Date.now();
          source = await pdfOcrText(Buffer.from(data, 'base64'));
          this.logger.log({ companyId, ms: Date.now() - t, chars: source.length }, 'RC OCR');
        }
        if (hasTextLayer(source)) {
          const result = await this.inTurn(() => readWithOllamaV2(env.OLLAMA_URL!, env.RC_READER_OLLAMA_MODEL, compactRcTextV2(source)));
          this.logger.log({ companyId, model: result.model, ms: result.ms, prompt: result.promptTokens, output: result.outputTokens }, 'RC read (local v2)');
          return { extract: tidyRcExtract(result.extract, this.carrierNumbers()), model: result.model };
        }
      } catch (error) {
        this.logger.warn({ companyId, error: String(error) }, 'RC read (local v2) failed');
        if (!env.ANTHROPIC_API_KEY || claudeFirst) {
          throw new AppError({ status: 502, title: 'The RC reader did not answer', detail: 'Try again, or fill the form by hand.', cause: error });
        }
      }
    }

    if (env.OLLAMA_URL && env.RC_READER_VERSION === 'v1' && hasTextLayer(text)) {
      try {
        const result = await this.inTurn(() => readWithOllama(env.OLLAMA_URL!, env.RC_READER_OLLAMA_MODEL, compactRcText(text)));
        this.logger.log({ companyId, model: result.model, ms: result.ms, prompt: result.promptTokens, output: result.outputTokens }, 'RC read (local)');
        return { extract: tidyRcExtract(result.extract, this.carrierNumbers()), model: result.model };
      } catch (error) {
        this.logger.warn({ companyId, error: String(error) }, 'RC read (local) failed');
        if (!env.ANTHROPIC_API_KEY || claudeFirst) {
          throw new AppError({ status: 502, title: 'The RC reader did not answer', detail: 'Try again, or fill the form by hand.', cause: error });
        }
      }
    }

    if (!env.ANTHROPIC_API_KEY || claudeFirst) {
      throw hasTextLayer(text)
        ? new AppError({
            status: 422,
            title: "This broker's RC is not known yet",
            detail: 'Fill the form by hand for this one; send the RC so the reader learns this broker.',
          })
        : new AppError({
            status: 422,
            title: 'This RC is a scan or a photo',
            detail: 'The reader reads PDFs with text only. Fill the form by hand for this one.',
          });
    }
    const extract = await this.readWithClaude(companyId, input, data);
    return { extract: tidyRcExtract(extract.extract, this.carrierNumbers()), model: extract.model };
  }

  /** One RC through Muse vision: the same instructions and the same wire shape Claude gets. */
  async readWithMuse(
    companyId: string,
    input: ReadRateConfirmationInput,
    data: string,
  ): Promise<{ extract: RateConfirmationExtract; model: string; ms: number }> {
    if (!this.muse) throw new AppError({ status: 503, title: 'Muse is not set up' });
    const result = await this.muse.readJson({
      file: { fileName: input.fileName, contentType: input.contentType, content: data },
      schema: RcWireSchema,
      schemaName: 'rate_confirmation',
      instructions: RC_INSTRUCTIONS + RC_WIRE_NOTE,
      prompt: `Read this rate confirmation (${input.fileName}).`,
      companyId,
    });
    this.logger.log({ companyId, model: result.model, ms: result.ms, ...result.usage }, 'RC read (Muse)');
    return { extract: fromWire(result.data), model: `muse:${result.model}`, ms: result.ms };
  }

  private inTurn<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readWithClaude(
    companyId: string,
    input: ReadRateConfirmationInput,
    data: string,
  ): Promise<{ extract: RateConfirmationExtract; model: string }> {
    this.client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
    const file: Anthropic.Beta.BetaContentBlockParam =
      input.contentType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: input.contentType, data } };

    const model = env.ANTHROPIC_MODEL ?? env.RC_READER_MODEL;
    // Haiku 4.5 (the owner's choice, 2026-10-17) takes no effort setting and no server-side
    // fallback: plain structured output on the stable Messages API.
    const light = /haiku/i.test(model);
    let response;
    try {
      response = light
        ? await this.client.messages.parse({
            model,
            max_tokens: 8000,
            output_config: { format: zodOutputFormat(RcWireSchema) },
            system: RC_INSTRUCTIONS + RC_WIRE_NOTE,
            messages: [{ role: 'user', content: [file as Anthropic.ContentBlockParam, { type: 'text', text: `Read this rate confirmation (${input.fileName}).` }] }],
          })
        : await this.client.beta.messages.parse({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(RcWireSchema) },
        system: RC_INSTRUCTIONS + RC_WIRE_NOTE,
        messages: [{ role: 'user', content: [file, { type: 'text', text: `Read this rate confirmation (${input.fileName}).` }] }],
      });
    } catch (error) {
      this.logger.warn({ companyId, fileName: input.fileName, error: String(error) }, 'RC read failed');
      if (error instanceof Anthropic.AuthenticationError) {
        throw new AppError({ status: 503, title: 'The RC reader is not set up', detail: 'The Anthropic API key on the server was refused.', cause: error });
      }
      // An account with no credit answers 400; it is the service being unavailable, not the file.
      if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
        throw new AppError({ status: 503, title: 'The RC reader is not available', detail: 'The Anthropic account has no credit left.', cause: error });
      }
      if (error instanceof Anthropic.BadRequestError) {
        throw new AppError({ status: 422, title: 'This file could not be read', detail: 'Check it is a readable PDF or photo of the RC.', cause: error });
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new AppError({ status: 503, title: 'The RC reader is busy', detail: 'Try again in a minute.', cause: error });
      }
      throw new AppError({ status: 502, title: 'The RC reader did not answer', detail: 'Try again, or fill the form by hand.', cause: error });
    }

    this.logger.log(
      { companyId, model: response.model, input: response.usage.input_tokens, output: response.usage.output_tokens, stop: response.stop_reason },
      'RC read',
    );
    if (response.stop_reason !== 'end_turn' || !response.parsed_output) {
      throw new AppError({ status: 422, title: 'This RC could not be read', detail: 'Fill the form by hand, or try a clearer copy.' });
    }
    return { extract: fromWire(response.parsed_output), model: response.model };
  }
}
