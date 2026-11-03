import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read aloud's order (owner, 2026-10-22): the server's voice (Azure Speech) first; with no
 * account (404) or any failure, the browser's own voice; with neither, a message that says how to
 * get one.
 */

type VoiceModule = typeof import('./voice');

const plays: string[] = [];
let playRejects = false;
const spoken: Array<{ text: string; lang: string }> = [];
let installedVoices: Array<{ lang: string; name: string }> = [];

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly src: string) {}
  play() {
    if (playRejects) return Promise.reject(new Error('NotAllowedError'));
    plays.push(this.src);
    return Promise.resolve();
  }
  pause() {}
}

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function answer(status: number) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    blob: async () => new Blob([new Uint8Array([0x49, 0x44, 0x33])], { type: 'audio/mpeg' }),
  }));
}

async function load(fetchImpl: ReturnType<typeof answer>): Promise<VoiceModule> {
  vi.stubGlobal('fetch', fetchImpl);
  vi.resetModules();
  return import('./voice');
}

beforeEach(() => {
  plays.length = 0;
  spoken.length = 0;
  playRejects = false;
  installedVoices = [{ lang: 'en-US', name: 'Microsoft Aria' }];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speaking: false,
      cancel: vi.fn(),
      getVoices: () => installedVoices,
      speak: (u: FakeUtterance) => spoken.push({ text: u.text, lang: u.lang }),
    },
  });
  URL.createObjectURL = vi.fn(() => 'blob:tts-1');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readAloud', () => {
  it('plays the server voice first and does not touch the browser voice', async () => {
    const fetchImpl = answer(200);
    const voice = await load(fetchImpl);
    expect(await voice.readAloud('Bu haftada 3 ta yuk kechikdi.')).toBe('server');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/ai/tts');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'Bu haftada 3 ta yuk kechikdi.' });
    expect(plays).toEqual(['blob:tts-1']);
    expect(spoken).toEqual([]);
  });

  it('falls back to the browser voice when the server has no Azure Speech account (404), and stops asking for a while', async () => {
    const fetchImpl = answer(404);
    const voice = await load(fetchImpl);
    expect(await voice.readAloud('Here are the unpaid invoices.')).toBe('browser');
    expect(spoken).toEqual([{ text: 'Here are the unpaid invoices.', lang: 'en-US' }]);
    expect(await voice.readAloud('And the overdue ones.')).toBe('browser');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the browser voice when the server fails or the audio will not play', async () => {
    let voice = await load(answer(503));
    expect(await voice.readAloud('Server is down.')).toBe('browser');
    playRejects = true;
    voice = await load(answer(200));
    expect(await voice.readAloud('Autoplay refused.')).toBe('browser');
    expect(plays).toEqual([]);
  });

  it('says how to get a voice when neither the server nor the computer has one', async () => {
    const voice = await load(answer(404));
    expect(await voice.readAloud('Toʻlanmagan hisoblar roʻyxati')).toBe('none');
    expect(spoken).toEqual([]);
    expect(`${voice.NO_VOICE_MESSAGE.title} ${voice.NO_VOICE_MESSAGE.description}`).toBe(
      'No voice for this language on this computer. An administrator can connect Azure Speech in Administration › Integrations to read Uzbek aloud.',
    );
  });

  it('a stop before the server answers means nothing plays', async () => {
    const voice = await load(answer(200));
    const pending = voice.readAloud('Bu uzun javob.');
    voice.stopSpeaking();
    expect(await pending).toBe('stopped');
    expect(plays).toEqual([]);
  });
});
