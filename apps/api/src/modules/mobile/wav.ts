/**
 * Meta's /asr/transcribe takes WAV only as "mono s16le at 16000 or 24000 Hz" (its own error text,
 * 2026-11-03). Phones and browsers record at 44.1/48 kHz, sometimes stereo or float. This turns
 * any PCM WAV (16-bit integer or 32-bit float, any channels, any rate) into mono 16-bit 16 kHz;
 * a WAV already in an accepted shape is returned untouched. Not a WAV, or a WAV it cannot read
 * (compressed codecs): null.
 */
export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

export function readWav(bytes: Buffer): WavInfo | null {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt: Omit<WavInfo, 'data'> | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const declared = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    // A recorder still writing (or one that never patched the header) leaves 0 or 0xFFFFFFFF: take the rest.
    const size = declared === 0 || declared === 0xffffffff || start + declared > bytes.length ? bytes.length - start : declared;
    if (id === 'fmt ' && size >= 16) {
      let format = bytes.readUInt16LE(start);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 26) format = bytes.readUInt16LE(start + 24);
      fmt = { format, channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bitsPerSample: bytes.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      data = bytes.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { ...fmt, data };
}

const TARGET_RATE = 16_000;

export function toMetaWav(bytes: Buffer): Buffer | null {
  const wav = readWav(bytes);
  if (!wav || wav.channels < 1 || wav.sampleRate < 1) return null;
  const pcm16 = wav.format === 1 && wav.bitsPerSample === 16;
  const float32 = wav.format === 3 && wav.bitsPerSample === 32;
  if (!pcm16 && !float32) return null;
  if (pcm16 && wav.channels === 1 && (wav.sampleRate === 16_000 || wav.sampleRate === 24_000)) return bytes;

  const frameBytes = (wav.bitsPerSample / 8) * wav.channels;
  const frames = Math.floor(wav.data.length / frameBytes);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) {
      const at = i * frameBytes + c * (wav.bitsPerSample / 8);
      sum += pcm16 ? wav.data.readInt16LE(at) / 32768 : wav.data.readFloatLE(at);
    }
    mono[i] = sum / wav.channels;
  }

  // Box-filter resample: each output sample is the mean of the input samples it covers (enough for speech).
  const ratio = wav.sampleRate / TARGET_RATE;
  const outFrames = Math.max(0, Math.floor(frames / ratio));
  const out = Buffer.alloc(44 + outFrames * 2);
  for (let j = 0; j < outFrames; j++) {
    const from = j * ratio;
    const to = Math.min(frames, (j + 1) * ratio);
    let sum = 0;
    let n = 0;
    for (let k = Math.floor(from); k < Math.ceil(to); k++) {
      sum += mono[k] ?? 0;
      n++;
    }
    const v = Math.max(-1, Math.min(1, n ? sum / n : 0));
    out.writeInt16LE(Math.round(v * 32767), 44 + j * 2);
  }
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + outFrames * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(TARGET_RATE, 24);
  out.writeUInt32LE(TARGET_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(outFrames * 2, 40);
  return out;
}
