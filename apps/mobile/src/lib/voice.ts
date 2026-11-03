import type * as AudioModule from 'expo-audio';
import type * as SpeechModule from 'expo-speech';
import { DRIVER_ASSISTANT_SPEECH_TAG, spokenLanguage } from '@neway/shared/mobile/assistant';

/**
 * Voice for Ask NeWay (mobile M6). Both modules ship in Expo Go: expo-speech reads answers aloud
 * with the phone's own voices; expo-audio records the question as WAV, which the server turns into
 * text with Meta Muse (POST /driver/assistant/voice; Azure Speech for older m4a builds). They are loaded
 * lazily so a build without them still opens the assistant in typing mode.
 */
let audio: typeof AudioModule | null | undefined;
let speech: typeof SpeechModule | null | undefined;

export function audioModule(): typeof AudioModule | null {
  if (audio !== undefined) return audio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    audio = require('expo-audio') as typeof AudioModule;
  } catch {
    audio = null;
  }
  return audio;
}

function speechModule(): typeof SpeechModule | null {
  if (speech !== undefined) return speech;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    speech = require('expo-speech') as typeof SpeechModule;
  } catch {
    speech = null;
  }
  return speech;
}

/** A best guess at the answer's language, so the phone picks a fitting voice. */
export function speechLanguage(text: string): string {
  return DRIVER_ASSISTANT_SPEECH_TAG[spokenLanguage(text)];
}

/**
 * Reads an answer aloud with the phone's (or browser's) own voices. Meta's Model API has no
 * text-to-speech, so this stays on the device; a phone without an Uzbek voice reads Uzbek with
 * its default one.
 */
export function speak(text: string, handlers: { onStart?: () => void; onDone?: () => void; language?: string } = {}): boolean {
  const s = speechModule();
  if (!s) return false;
  try {
    s.stop();
    s.speak(text, {
      language: handlers.language ?? speechLanguage(text),
      rate: 1.0,
      onStart: handlers.onStart,
      onDone: handlers.onDone,
      onStopped: handlers.onDone,
      onError: handlers.onDone,
    });
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking(): void {
  try {
    speechModule()?.stop();
  } catch {
    // nothing to stop
  }
}

/** Metering in dBFS (about -60 quiet … 0 loud) to 0..1 for the orb. */
export function loudnessOf(metering: number | undefined | null): number | null {
  if (typeof metering !== 'number' || !Number.isFinite(metering)) return null;
  return Math.max(0, Math.min(1, (metering + 55) / 50));
}
