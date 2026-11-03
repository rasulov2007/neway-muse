/** A finished recording, ready for POST /driver/assistant/voice. */
export interface Recording {
  uri: string;
  fileName: string;
  contentType: string;
}

/**
 * The Ask NeWay microphone. `wav` is true when the recording is WAV, which Meta Muse's speech
 * engine needs (the server converts any WAV to 16 kHz mono); an m4a recording only works with
 * the company's Azure Speech account.
 */
export interface Mic {
  available: boolean;
  wav: boolean;
  recording: boolean;
  loudness: number | null;
  seconds: number;
  start(): Promise<boolean>;
  stop(): Promise<Recording | null>;
}

/** Loudness 0..1 of 16-bit little-endian PCM (RMS in dBFS, mapped like the recorder's metering). */
export function loudnessOfPcm16(data: ArrayBuffer): number | null {
  const samples = new Int16Array(data);
  if (!samples.length) return null;
  let sum = 0;
  const step = Math.max(1, Math.floor(samples.length / 512));
  let n = 0;
  for (let i = 0; i < samples.length; i += step) {
    const v = (samples[i] ?? 0) / 32768;
    sum += v * v;
    n++;
  }
  return loudnessOfFloatRms(Math.sqrt(sum / n));
}

/** RMS (0..1) → 0..1 for the orb, the same curve as loudnessOf(metering). */
export function loudnessOfFloatRms(rms: number): number {
  const db = rms > 0 ? 20 * Math.log10(rms) : -160;
  return Math.max(0, Math.min(1, (db + 55) / 50));
}

/** 16-bit PCM WAV bytes from float samples (-1..1) at `sampleRate`, mono. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return buffer;
}
