import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * Speech to text through Meta Muse (muse-voice-transcribe-1.0), for the driver app's voice
 * questions (hackathon 2026-11-03).
 *
 * The Model API's recording endpoint is POST {base}/asr/transcribe, multipart with two parts:
 * `request` (JSON: model, audioEncoding) and `audio` (the bytes); it detects the language itself. Tested
 * 2026-11-03: it accepts `audioEncoding: "WAV"` only (mono 16-bit PCM; MP3, M4A/AAC, WebM, Opus,
 * FLAC are "Malformed request"), so the phone records WAV. Answer: `{ transcript, audioDurationMs }`.
 * The key never leaves the server and is never logged.
 */
export interface MetaTranscript {
  text: string;
  audioDurationMs: number | null;
}

/** RIFF....WAVE: the only container the endpoint takes. */
export function isWav(bytes: Buffer): boolean {
  return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
}

type Fetch = typeof fetch;

@Injectable()
export class MetaTranscribeClient {
  private fetcher: Fetch = (...args) => fetch(...args);
  private keyOverride: string | null | undefined;

  /** Tests: a fake fetch and key; null puts the real ones back. */
  setFetch(fetcher: Fetch | null, key: string | null = 'test-key'): void {
    this.fetcher = fetcher ?? ((...args) => fetch(...args));
    this.keyOverride = fetcher ? key : undefined;
  }

  private key(): string | undefined {
    return this.keyOverride === undefined ? env.META_API_KEY : (this.keyOverride ?? undefined);
  }

  configured(): boolean {
    return Boolean(this.key());
  }

  /**
   * muse-voice-transcribe-1.0 does not know Uzbek (owner's voice note, 2026-11-03: "Keyingi pikap
   * qachon?" came back as "Kingebikap which mile holded"), while Muse Spark heard it right from the
   * same WAV. So Muse Spark listens first; the transcribe endpoint is the fallback.
   */
  async transcribe(audio: Buffer, fileName = 'question.wav'): Promise<MetaTranscript> {
    const key = this.key();
    if (!key) throw new Error('Meta transcription is not set up');
    try {
      const text = await this.listen(key, audio, fileName);
      if (text) return { text, audioDurationMs: null };
    } catch {
      // fall through to the transcribe endpoint
    }
    return this.asr(key, audio, fileName);
  }

  private async listen(key: string, audio: Buffer, fileName: string): Promise<string> {
    const response = await this.fetcher(`${env.META_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'muse-spark-1.3',
        reasoning_effort: 'low',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'A truck driver asks a question in this recording. Write down exactly what they say, in the language they speak: Uzbek in Latin script, Russian in Cyrillic, English as is. Only the words, nothing else.',
              },
              { type: 'file', file: { filename: fileName, file_data: `data:audio/wav;base64,${audio.toString('base64')}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim().replace(/^["“]|["”]$/g, '') : '';
  }

  private async asr(key: string, audio: Buffer, fileName: string): Promise<MetaTranscript> {
    const form = new FormData();
    const request = { model: env.META_TRANSCRIBE_MODEL, audioEncoding: 'WAV' };
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
    form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), fileName);
    const response = await this.fetcher(`${env.META_API_BASE}/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as { transcript?: unknown; audioDurationMs?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok) {
      const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
      throw new Error(`Meta transcription failed: ${message}`);
    }
    return {
      text: typeof body?.transcript === 'string' ? body.transcript.trim() : '',
      audioDurationMs: typeof body?.audioDurationMs === 'number' ? body.audioDurationMs : null,
    };
  }
}
