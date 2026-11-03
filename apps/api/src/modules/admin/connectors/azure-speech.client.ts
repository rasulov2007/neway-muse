/** An Azure Speech refusal or outage, in words an administrator can act on. Never carries the key. */
export class AzureSpeechError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** A 5xx, a 429 or a network failure may succeed later; a 4xx will not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AzureSpeechError';
  }
}

export interface AzureVoice {
  shortName: string;
  locale: string;
  gender: string;
}

const TIMEOUT_MS = 20_000;

/** Azure regions are short lower-case words (eastus, westeurope, southeastasia). Anything else never reaches a URL. */
export const isAzureRegion = (region: string) => /^[a-z][a-z0-9]{2,30}$/.test(region);

/**
 * Microsoft Azure Speech, text-to-speech over its REST API. No SDK: two calls do not justify one.
 * The key lives only in this object for the length of a request; nothing here logs it or the text.
 */
export class AzureSpeechClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly key: string,
    private readonly region: string,
    options: { fetchImpl?: typeof fetch } = {},
  ) {
    if (!isAzureRegion(region)) throw new AzureSpeechError(`"${region}" is not an Azure region name (e.g. eastus).`, 422, false);
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private get base(): string {
    return `https://${this.region}.tts.speech.microsoft.com/cognitiveservices`;
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { 'Ocp-Apim-Subscription-Key': this.key, 'User-Agent': 'NeWay', ...(init.headers ?? {}) },
        body: init.body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new AzureSpeechError(`Azure Speech could not be reached (${(error as Error).name}).`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // The body is not read into the message: it may echo the request.
      await response.body?.cancel().catch(() => undefined);
      throw AzureSpeechClient.refusal(response.status);
    }
    return response;
  }

  static refusal(status: number): AzureSpeechError {
    if (status === 401 || status === 403) return new AzureSpeechError('Azure rejected the key. Check the Speech key and that it belongs to this region.', status, false);
    if (status === 400) return new AzureSpeechError('Azure could not read the request (a voice name may be wrong).', status, false);
    if (status === 404) return new AzureSpeechError('Azure has no Speech service at this region. Check the region name.', status, false);
    if (status === 429) return new AzureSpeechError('Azure Speech is busy (too many requests). Try again in a moment.', status, true);
    return new AzureSpeechError(`Azure Speech answered ${status}.`, status, status >= 500);
  }

  /** Every voice the region offers. Proves the key and the region. */
  async voices(): Promise<AzureVoice[]> {
    const response = await this.call('/voices/list', { method: 'GET' });
    const body = (await response.json().catch(() => [])) as unknown;
    if (!Array.isArray(body)) return [];
    return body.map((v: Record<string, unknown>) => ({ shortName: String(v.ShortName ?? ''), locale: String(v.Locale ?? ''), gender: String(v.Gender ?? '') }));
  }

  /**
   * Speech to text (the driver app's mic, mobile M6): Azure's fast transcription REST API, one
   * short recording in, its words out. `locales` lets Azure pick among the languages a driver
   * speaks. The audio is never stored or logged here.
   */
  async transcribe(audio: Buffer, fileName: string, contentType: string, locales: string[]): Promise<string> {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audio)], { type: contentType || 'application/octet-stream' }), fileName || 'speech.m4a');
    form.append('definition', JSON.stringify({ locales }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 2);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${this.region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': this.key, 'User-Agent': 'NeWay' },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      throw new AzureSpeechError(`Azure Speech could not be reached (${(error as Error).name}).`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw AzureSpeechClient.refusal(response.status);
    }
    const body = (await response.json().catch(() => ({}))) as { combinedPhrases?: Array<{ text?: string }> };
    return (body.combinedPhrases ?? []).map((p) => p.text ?? '').join(' ').trim();
  }

  /** SSML in, MP3 out (24 kHz, 48 kbit/s, mono). */
  async synthesize(ssml: string): Promise<Buffer> {
    const response = await this.call('/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3' },
      body: ssml,
    });
    return Buffer.from(await response.arrayBuffer());
  }
}
