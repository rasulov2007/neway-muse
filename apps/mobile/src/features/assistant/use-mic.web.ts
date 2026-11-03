import { useCallback, useEffect, useRef, useState } from 'react';

import { encodeWav, loudnessOfFloatRms, type Mic, type Recording } from './mic-types';

/**
 * The Ask NeWay microphone in a browser (the web build used for demos). expo-audio records WebM
 * there, which Meta Muse's speech engine does not take, so this captures raw samples with the Web
 * Audio API and writes a 16-bit mono WAV at the browser's rate; the server brings it to 16 kHz.
 */
interface Session {
  context: AudioContext;
  media: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: ScriptProcessorNode;
  chunks: Float32Array[];
}

const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== 'undefined';

export function useMic(): Mic {
  const session = useRef<Session | null>(null);
  const level = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [loudness, setLoudness] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const id = setInterval(() => {
      setLoudness(level.current);
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 100);
    return () => clearInterval(id);
  }, [recording]);

  const release = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    s.node.onaudioprocess = null;
    try {
      s.source.disconnect();
      s.node.disconnect();
    } catch {
      // already disconnected
    }
    s.media.getTracks().forEach((track) => track.stop());
    void s.context.close().catch(() => undefined);
  }, []);

  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    if (!supported) return false;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(media);
      const node = context.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (event) => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        chunks.push(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 8) sum += (samples[i] ?? 0) ** 2;
        level.current = loudnessOfFloatRms(Math.sqrt(sum / Math.max(1, samples.length / 8)));
      };
      source.connect(node);
      node.connect(context.destination);
      session.current = { context, media, source, node, chunks };
      setSeconds(0);
      setRecording(true);
      return true;
    } catch {
      release();
      return false;
    }
  }, [release]);

  const stop = useCallback(async (): Promise<Recording | null> => {
    const s = session.current;
    setRecording(false);
    setLoudness(null);
    if (!s) return null;
    const rate = s.context.sampleRate;
    const total = s.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let at = 0;
    for (const chunk of s.chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    release();
    if (!total) return null;
    const blob = new Blob([encodeWav(samples, rate)], { type: 'audio/wav' });
    return { uri: URL.createObjectURL(blob), fileName: 'question.wav', contentType: 'audio/wav' };
  }, [release]);

  return { available: supported, wav: true, recording, loudness, seconds, start, stop };
}
