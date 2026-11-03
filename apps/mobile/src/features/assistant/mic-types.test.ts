import { spokenLanguage } from '@neway/shared/mobile/assistant';

import { encodeWav, loudnessOfFloatRms, loudnessOfPcm16 } from './mic-types';
import { speechLanguage } from '@/lib/voice';

test('encodeWav writes a 16-bit mono PCM WAV the server can read', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const view = new DataView(encodeWav(samples, 48000));
  const ascii = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  expect(ascii(0)).toBe('RIFF');
  expect(ascii(8)).toBe('WAVE');
  expect(view.getUint16(20, true)).toBe(1); // PCM
  expect(view.getUint16(22, true)).toBe(1); // mono
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(10);
  expect(view.getInt16(44 + 2, true)).toBe(16384);
  expect(view.getInt16(44 + 6, true)).toBe(32767);
  expect(view.getInt16(44 + 8, true)).toBe(-32768);
});

test('loudness: silence is 0, a loud signal is near 1', () => {
  expect(loudnessOfFloatRms(0)).toBe(0);
  expect(loudnessOfFloatRms(0.7)).toBeGreaterThan(0.9);
  const loud = new Int16Array(1024).fill(20000);
  expect(loudnessOfPcm16(loud.buffer)).toBeGreaterThan(0.9);
  expect(loudnessOfPcm16(new ArrayBuffer(0))).toBeNull();
});

test('the answer is read with a voice for its own language', () => {
  expect(speechLanguage('Your next pickup is Wednesday 2 PM.')).toBe('en-US');
  expect(speechLanguage('Следующая погрузка в среду.')).toBe('ru-RU');
  expect(speechLanguage('Keyingi pikapingiz Jolietda chorshanba kuni.')).toBe('uz-UZ');
  expect(spokenLanguage('Кинги пикап качон. Нича мил колди.')).toBe('uz');
});
