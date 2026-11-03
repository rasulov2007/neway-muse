import { useCallback, useEffect, useRef, useState } from 'react';

import { audioModule, loudnessOf } from '@/lib/voice';

import { loudnessOfPcm16, type Mic, type Recording } from './mic-types';

/**
 * The Ask NeWay microphone on a phone. expo-audio's AudioStream records 16-bit mono WAV (what Meta
 * Muse's speech engine needs; the server brings any rate down to 16 kHz). A build without
 * AudioStream falls back to the m4a recorder, which only the company's Azure Speech can read.
 * The hook is chosen once, so the hook order never changes between renders.
 */
const audio = audioModule();

function useNoMic(): Mic {
  return { available: false, wav: false, recording: false, loudness: null, seconds: 0, start: async () => false, stop: async () => null };
}

async function allowRecording(): Promise<boolean> {
  const mod = audio!;
  const permission = await mod.requestRecordingPermissionsAsync();
  if (!permission.granted) return false;
  await mod.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  return true;
}

function useStreamMic(): Mic {
  const mod = audio!;
  const level = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [loudness, setLoudness] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const { stream } = mod.useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buffer) => {
      level.current = loudnessOfPcm16(buffer.data);
    },
  });

  // The orb and the seconds counter, ten times a second while recording.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const id = setInterval(() => {
      setLoudness(level.current);
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 100);
    return () => clearInterval(id);
  }, [recording]);

  const start = useCallback(async () => {
    try {
      if (!(await allowRecording())) return false;
      await stream.start();
      await stream.startFileRecordingAsync({ format: 'wav' });
      setSeconds(0);
      setRecording(true);
      return true;
    } catch {
      return false;
    }
  }, [stream]);

  const stop = useCallback(async (): Promise<Recording | null> => {
    try {
      const file = await stream.stopFileRecordingAsync();
      stream.stop();
      await mod.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      return { uri: file.uri, fileName: 'question.wav', contentType: 'audio/wav' };
    } catch {
      return null;
    } finally {
      setRecording(false);
      setLoudness(null);
    }
  }, [mod, stream]);

  return { available: true, wav: true, recording, loudness, seconds, start, stop };
}

/** The m4a recorder (builds without AudioStream): only the company's Azure Speech reads it. */
function useM4aMic(): Mic {
  const mod = audio!;
  const recorder = mod.useAudioRecorder({ ...mod.RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, sampleRate: 16000, bitRate: 64000, isMeteringEnabled: true });
  const state = mod.useAudioRecorderState(recorder, 100);
  const start = useCallback(async () => {
    try {
      if (!(await allowRecording())) return false;
      await recorder.prepareToRecordAsync();
      recorder.record();
      return true;
    } catch {
      return false;
    }
  }, [recorder]);
  const stop = useCallback(async (): Promise<Recording | null> => {
    try {
      await recorder.stop();
      await mod.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
      return recorder.uri ? { uri: recorder.uri, fileName: 'question.m4a', contentType: 'audio/mp4' } : null;
    } catch {
      return null;
    }
  }, [mod, recorder]);
  return { available: true, wav: false, recording: state.isRecording, loudness: loudnessOf(state.metering), seconds: Math.floor((state.durationMillis ?? 0) / 1000), start, stop };
}

export const useMic: () => Mic = !audio ? useNoMic : typeof audio.useAudioStream === 'function' ? useStreamMic : useM4aMic;
