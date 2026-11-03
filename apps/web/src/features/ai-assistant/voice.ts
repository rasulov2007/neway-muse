/**
 * Voice for NeWay AI, free and in the browser (owner, 2026-10-20): the browser's own speech
 * recognition turns speech into an editable transcript - nothing is sent until the person presses
 * Send - and its own speech synthesis reads an answer aloud. Where a browser has neither, the
 * buttons say so instead of pretending.
 *
 * Read aloud tries the server first (owner, 2026-10-22): Windows has no Uzbek voice, so the
 * company's Azure Speech account reads the answer and the browser plays the MP3. With no account
 * (404 tts_not_configured) or any failure, the browser's own voice reads it as before.
 */

import { API_PREFIX } from '@neway/shared';
import { sessionToken } from '@/lib/session';

export const VOICE_LANGS = [
  { code: 'uz-UZ', label: 'UZ' },
  { code: 'ru-RU', label: 'RU' },
  { code: 'en-US', label: 'EN' },
] as const;
export type VoiceLang = (typeof VOICE_LANGS)[number]['code'];

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => RecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canListen = () => typeof window !== 'undefined' && recognitionCtor() !== null;

/** Errors in words a person can act on. */
export function voiceError(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was refused. Allow it in the browser’s site settings.';
  if (code === 'no-speech') return 'Nothing was heard. Try again a little closer to the microphone.';
  if (code === 'audio-capture') return 'No microphone was found.';
  if (code === 'network') return 'The speech service could not be reached. Check the connection and try again.';
  if (code === 'language-not-supported') return 'This browser does not recognise speech in that language.';
  return 'Speech could not be turned into text. Try again.';
}

/** Up to two minutes of speech; returns the controller. Text arrives as the person speaks. */
export function listen(lang: VoiceLang, on: { text: (text: string) => void; error: (message: string) => void; end: () => void }) {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    on.error('This browser cannot turn speech into text. Use Chrome or Edge, or type.');
    on.end();
    return null;
  }
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
    on.text(text.trim());
  };
  rec.onerror = (e) => on.error(voiceError(e.error));
  rec.onend = () => on.end();
  rec.start();
  const limit = window.setTimeout(() => rec.stop(), 120_000);
  return {
    stop: () => {
      window.clearTimeout(limit);
      rec.stop();
    },
    cancel: () => {
      window.clearTimeout(limit);
      rec.abort();
    },
  };
}

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Reads the text aloud in the voice that fits it best; false when no voice speaks that language. */
export function speak(text: string, onEnd?: () => void): boolean {
  if (!canSpeak()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const lang = /[ʻʼ‘’]|\b(va|bu|uchun|qil|ko'r|yuk)\b/i.test(text) ? 'uz' : /[а-яё]/i.test(text) ? 'ru' : 'en';
  const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
  if (!voice && lang !== 'en') return false;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  if (onEnd) {
    u.onend = onEnd;
    u.onerror = onEnd;
  }
  synth.speak(u);
  return true;
}

/** The server's limit on one read-aloud request. */
const SERVER_MAX_CHARS = 4000;

/** After a "not set up" answer the server is not asked again for a while. */
const NOT_CONFIGURED_PAUSE_MS = 5 * 60_000;
let serverSkipUntil = 0;

let playing: { audio: HTMLAudioElement; url: string; onEnd?: () => void } | null = null;

function releasePlayer(): void {
  if (!playing) return;
  const { audio, url, onEnd } = playing;
  playing = null;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  URL.revokeObjectURL(url);
  onEnd?.();
}

/** The answer as MP3 from the server, or null when the server has no voice for it (or failed). */
async function serverSpeech(text: string): Promise<Blob | null> {
  if (Date.now() < serverSkipUntil) return null;
  try {
    const token = sessionToken();
    const response = await fetch(`/${API_PREFIX}/ai/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text: text.slice(0, SERVER_MAX_CHARS) }),
    });
    if (response.status === 404) {
      serverSkipUntil = Date.now() + NOT_CONFIGURED_PAUSE_MS;
      return null;
    }
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

/** 'stopped': stopped (or another answer started) before the voice arrived. */
export type ReadAloudOutcome = 'server' | 'browser' | 'none' | 'stopped';

/** Bumped by every stop, so a voice that arrives after it is not played. */
let generation = 0;

/** What to say when neither the server nor this computer has a voice for the answer. */
export const NO_VOICE_MESSAGE = {
  title: 'No voice for this language on this computer.',
  description: 'An administrator can connect Azure Speech in Administration › Integrations to read Uzbek aloud.',
} as const;

/**
 * Reads an answer aloud: the server's voice first, the browser's own as the fallback. `onEnd`
 * runs once when it finishes or is stopped; 'none' means nothing could read it.
 */
export async function readAloud(text: string, onEnd?: () => void): Promise<ReadAloudOutcome> {
  stopSpeaking();
  const mine = generation;
  const blob = await serverSpeech(text);
  if (mine !== generation) {
    onEnd?.();
    return 'stopped';
  }
  if (blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    playing = { audio, url, onEnd };
    audio.onended = releasePlayer;
    audio.onerror = releasePlayer;
    try {
      await audio.play();
      return 'server';
    } catch {
      // Autoplay refused or the audio could not be decoded: the browser's voice instead.
      if (playing?.audio === audio) {
        playing.onEnd = undefined;
        releasePlayer();
      }
    }
  }
  return speak(text.replace(/[*`#|]/g, '').replace(/-{3,}/g, ''), onEnd) ? 'browser' : 'none';
}

export const stopSpeaking = () => {
  generation += 1;
  releasePlayer();
  if (canSpeak()) window.speechSynthesis.cancel();
};
