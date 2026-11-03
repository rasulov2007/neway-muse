import { Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { AzureSpeechError } from '../admin/connectors/azure-speech.client';
import { AzureSpeechService } from '../admin/connectors/azure-speech.service';
import { AudioCache, buildSsml, detectLang, normaliseLang, speakableText, TTS_MAX_CHARS, ttsCacheKey, voiceFor } from './tts';

export interface TtsResult {
  audio: Buffer;
  voice: string;
  cached: boolean;
}

/**
 * Read aloud through the company's Azure Speech account. Nothing here logs the text or the key.
 * With no account the answer is a 404 the browser recognises (`tts_not_configured`) and falls
 * back to its own voices.
 */
@Injectable()
export class AiTtsService {
  private readonly cache = new AudioCache();
  /** Modest: a person pressing Read aloud on every answer stays well inside it. */
  private readonly limiter = new RateLimiter(20, 60_000);

  constructor(private readonly azure: AzureSpeechService) {}

  async speak(principal: Principal, input: { text: string; lang?: string }): Promise<TtsResult> {
    this.limiter.hit(`${principal.companyId}:${principal.userId}`, 'Too many read-aloud requests. Wait a minute and try again.');
    if (input.text.length > TTS_MAX_CHARS) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `Read aloud takes up to ${TTS_MAX_CHARS} characters.` });
    }
    const text = speakableText(input.text);
    if (!text) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'There is nothing to read aloud.' });

    const speaker = await this.azure.speaker(principal.companyId);
    if (!speaker) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        type: '/problems/tts-not-configured',
        detail: 'Read aloud on the server is not set up: no Azure Speech account in Administration › Integrations.',
        extensions: { code: 'tts_not_configured' },
      });
    }

    const lang = normaliseLang(input.lang) ?? detectLang(text);
    const voice = voiceFor(lang, speaker.voiceUz);
    const key = ttsCacheKey(voice, text);
    const hit = this.cache.get(key);
    if (hit) return { audio: hit, voice, cached: true };

    try {
      const audio = await speaker.client.synthesize(buildSsml(text, lang, voice));
      this.cache.set(key, audio);
      return { audio, voice, cached: false };
    } catch (error) {
      const e = error instanceof AzureSpeechError ? error : new AzureSpeechError('Azure Speech failed.', 0, true);
      await this.azure.recordFailure(speaker.accountId, null, e).catch(() => undefined);
      throw new AppError({
        status: e.retryable ? 503 : 502,
        title: e.retryable ? 'Service Unavailable' : 'Bad Gateway',
        type: '/problems/tts-provider',
        detail: e.message,
        extensions: { code: e.status === 401 || e.status === 403 ? 'tts_key_rejected' : 'tts_provider_failed' },
      });
    }
  }
}
