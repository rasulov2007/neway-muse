import { DRIVER_ASSISTANT_SPEECH_TAG, DRIVER_ASSISTANT_STARTERS, spokenLanguage } from '@neway/shared/mobile/assistant';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError, api, uploadRaw } from '@/api/client';
import { routes, type DriverAssistantAnswer, type DriverAssistantVoiceAnswer } from '@/api/contract';
import type { Recording } from '@/features/assistant/mic-types';
import { Orb, Waveform, type OrbMode } from '@/features/assistant/orb';
import { useMic } from '@/features/assistant/use-mic';
import { uuid } from '@/lib/uuid';
import { speak, stopSpeaking } from '@/lib/voice';
import { Icon, StatusSymbol, Text, fontFor, type IconName } from '@/ui/primitives';
import { color, elevation, gutter, radius, space } from '@/ui/tokens';
import { t } from '@/i18n';

/**
 * Ask NeWay (mobile M6): the driver's assistant for their OWN pay and work. A voice screen (the
 * orb, its ring and the waveform; keyboard · mic · close) and a typed chat. Answers come from
 * POST /driver/assistant/ask, which reads only this driver's statements and loads on the server;
 * they are read aloud with the phone's voice. Hold the mic to talk (or tap, then tap again to
 * send): the WAV recording goes to POST /driver/assistant/voice, where Meta Muse hears it in the
 * driver's own language (Uzbek, Russian, English) and the answer comes back in that language,
 * shown as text and read aloud. Without speech-to-text on the server the screen offers typing.
 */

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  answer?: DriverAssistantAnswer;
  failed?: boolean;
}

const MAX_SECONDS = 20;
/** A press held at least this long is hold-to-talk; shorter is a tap (tap again to send). */
const HOLD_MS = 450;

// ------------------------------------------------------------------------------------ pieces

function RoundButton({
  icon,
  label,
  onPress,
  onPressIn,
  onPressOut,
  big,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  big?: boolean;
  disabled?: boolean;
}) {
  const size = big ? 76 : 56;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: big ? (pressed ? color.primaryPressed : color.primary) : color.panel,
          borderWidth: big ? 0 : 1,
          borderColor: color.border,
          opacity: disabled ? 0.5 : 1,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        },
        big ? elevation.card : null,
      ]}
    >
      <Icon name={icon} size={big ? 32 : 24} tint={big ? color.onPrimary : color.ink} />
    </Pressable>
  );
}

/** The chat's send button: a normal-sized round icon button (owner, 2026-10-28), level with the field. */
function SendButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Send')}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        marginBottom: 2,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? color.primaryPressed : color.primary,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Icon name="send" size={20} tint={color.onPrimary} />
    </Pressable>
  );
}

function Facts({ answer }: { answer: DriverAssistantAnswer }) {
  if (!answer.facts.length) return null;
  return (
    <View style={{ marginTop: space.sm, borderRadius: 14, backgroundColor: color.subtle, paddingHorizontal: space.md, paddingVertical: space.xs }}>
      {answer.facts.slice(0, 8).map((f, i) => (
        <View key={`${f.label}-${i}`} style={{ flexDirection: 'row', gap: space.md, paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderColor: color.divider }}>
          <Text variant="caption" tint={color.text2} style={{ flex: 1 }}>
            {f.label}
          </Text>
          <Text variant="captionStrong">{f.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** Suggested questions, shown in the chosen language; the English original is what is asked (the answers without NeWay AI match on it). */
function Chips({ items, onPick }: { items: readonly string[]; onPick: (q: string, shown: string) => void }) {
  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: gutter, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
      {items.map((q) => (
        <Pressable key={q} accessibilityRole="button" onPress={() => onPick(q, t(q))} style={({ pressed }) => ({ borderRadius: radius.pill, borderWidth: 1, borderColor: color.border, backgroundColor: pressed ? color.subtle : color.panel, paddingHorizontal: space.md, minHeight: 36, justifyContent: 'center' })}>
          <Text variant="smallStrong" tint={color.primaryInk}>
            {t(q)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

// ------------------------------------------------------------------------------------ screen

export default function Assistant() {
  const mic = useMic();
  const [mode, setMode] = useState<'voice' | 'chat'>('voice');
  const [orb, setOrb] = useState<OrbMode>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [heard, setHeard] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [voiceOff, setVoiceOff] = useState(!mic.available);
  const [readAloud, setReadAloud] = useState(true);
  const [aiOn, setAiOn] = useState<boolean | null>(null);
  const [heardBy, setHeardBy] = useState<string | null>(null);
  const gesture = useRef<{ kind: 'none' | 'hold' | 'send'; at: number; starting: Promise<boolean> | null }>({ kind: 'none', at: 0, starting: null });
  const busy = orb === 'thinking';
  const scroll = useRef<ScrollViewInstance>(null);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 320, useNativeDriver: true }).start();
    return () => stopSpeaking();
  }, [fade]);

  const lastAnswer = [...turns].reverse().find((turn) => turn.role === 'assistant')?.answer;

  const ask = useCallback(
    async (question: string, viaVoice: boolean, shown?: string) => {
      const q = question.trim();
      if (!q || busy) return;
      stopSpeaking();
      setDraft('');
      setNote(null);
      const history = turns.filter((turn) => !turn.failed).slice(-6).map((turn) => ({ role: turn.role, text: turn.text }));
      setTurns((all) => [...all, { id: uuid(), role: 'user', text: shown ?? q }]);
      setHeard(shown ?? q);
      setOrb('thinking');
      try {
        const answer = await api.post<DriverAssistantAnswer>(routes.driverAssistantAsk, { question: q, history });
        setAiOn(answer.aiConfigured);
        setTurns((all) => [...all, { id: uuid(), role: 'assistant', text: answer.answer, answer }]);
        const shouldSpeak = viaVoice || readAloud;
        if (shouldSpeak && speak(answer.answer, { onStart: () => setOrb('speaking'), onDone: () => setOrb('idle') })) setOrb('speaking');
        else setOrb('idle');
      } catch (e) {
        const err = e instanceof ApiError ? e : null;
        const text =
          err?.kind === 'offline'
            ? t('No connection. Ask again when you have signal.')
            : err?.status === 429
              ? t('That was a lot of questions. Wait a moment and ask again.')
              : err?.kind === 'not_connected'
                ? t('Ask NeWay is not on this server yet.')
                : (err?.detail ?? t('Could not get an answer. Try again.'));
        setTurns((all) => [...all, { id: uuid(), role: 'assistant', text, failed: true }]);
        setOrb('idle');
      }
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    },
    [busy, turns, readAloud],
  );

  /**
   * One recording → POST /driver/assistant/voice: the words heard (Meta Muse) and the answer in the
   * driver's language, both shown as text; the answer is read aloud with a voice for its language.
   */
  const sendRecording = useCallback(
    async (rec: Recording) => {
      stopSpeaking();
      setOrb('thinking');
      setHeard('…');
      setHeardBy(null);
      setNote(null);
      // The last few turns ride in a header: kept short so the header stays small.
      const history = turns
        .filter((turn) => !turn.failed)
        .slice(-4)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 300) }));
      try {
        const out = await uploadRaw<DriverAssistantVoiceAnswer>(routes.driverAssistantVoice, {
          fileUri: rec.uri,
          fileName: rec.fileName,
          contentType: rec.contentType,
          idempotencyKey: uuid(),
          headers: history.length ? { 'x-assistant-history': encodeURIComponent(JSON.stringify(history)) } : undefined,
        });
        const answer = out.answer;
        setAiOn(answer.aiConfigured);
        setHeard(out.transcript);
        const seconds = (out.timings.transcribeMs / 1000).toFixed(1);
        setHeardBy(out.transcribedBy === 'meta' ? t('Heard by Meta Muse · {seconds} s', { seconds }) : t('Heard by Azure Speech · {seconds} s', { seconds }));
        setTurns((all) => [...all, { id: uuid(), role: 'user', text: out.transcript }, { id: uuid(), role: 'assistant', text: answer.answer, answer }]);
        const language = DRIVER_ASSISTANT_SPEECH_TAG[spokenLanguage(answer.answer)];
        if (speak(answer.answer, { language, onStart: () => setOrb('speaking'), onDone: () => setOrb('idle') })) setOrb('speaking');
        else setOrb('idle');
      } catch (e) {
        setOrb('idle');
        setHeard(null);
        const err = e instanceof ApiError ? e : null;
        if (err?.status === 415 || err?.kind === 'not_found' || err?.kind === 'not_connected') {
          // No speech-to-text this phone's recording can use: typing from now on.
          setVoiceOff(true);
          setMode('chat');
          setNote(
            err?.status === 415
              ? t('Voice questions need a newer app on this phone. Type your question — answers can still be read aloud.')
              : t('Voice questions are not switched on for your company yet. Type your question — answers can still be read aloud.'),
          );
        } else if (err?.status === 422) {
          setNote(t('I did not catch that. Try again, a little closer to the phone.'));
        } else if (err?.status === 429) {
          setNote(t('That was a lot of questions. Wait a moment and ask again.'));
        } else {
          setNote(err?.kind === 'offline' ? t('No connection. Try again when you have signal.') : (err?.detail ?? t('Could not hear that. Try again or type.')));
        }
      } finally {
        if (Platform.OS === 'web' && rec.uri.startsWith('blob:')) URL.revokeObjectURL(rec.uri);
      }
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    },
    [turns],
  );

  const stopAndSend = useCallback(async () => {
    const rec = await mic.stop();
    if (!rec) {
      setOrb('idle');
      setNote(t('The recording did not work. Try again or type your question.'));
      return;
    }
    await sendRecording(rec);
  }, [mic, sendRecording]);

  // A recording stops by itself after MAX_SECONDS.
  useEffect(() => {
    if (mic.recording && mic.seconds >= MAX_SECONDS) void stopAndSend();
  }, [mic.recording, mic.seconds, stopAndSend]);

  const beginRecording = async (): Promise<boolean> => {
    if (voiceOff) {
      setMode('chat');
      setNote(mic.available ? t('Voice questions are not switched on for your company yet. Type your question.') : t('Voice questions need microphone support on this phone. Type your question.'));
      return false;
    }
    stopSpeaking();
    setNote(null);
    const started = await mic.start();
    if (!started) {
      setNote(t('NeWay needs the microphone to hear you. Allow it in the phone settings, or type.'));
      return false;
    }
    setHeard(null);
    setHeardBy(null);
    setOrb('listening');
    return true;
  };

  // Hold to talk: pressing starts the recording, letting go sends it. A short tap starts it too,
  // and the next tap sends. While the answer is read aloud, a press stops the voice.
  const pressIn = async () => {
    if (busy) return;
    if (orb === 'speaking') {
      stopSpeaking();
      setOrb('idle');
      gesture.current = { kind: 'none', at: 0, starting: null };
      return;
    }
    if (mic.recording) {
      gesture.current = { kind: 'send', at: Date.now(), starting: null };
      return;
    }
    const starting = beginRecording();
    gesture.current = { kind: 'hold', at: Date.now(), starting };
    await starting;
  };

  const pressOut = async () => {
    const g = gesture.current;
    gesture.current = { kind: 'none', at: 0, starting: null };
    if (g.kind === 'send') {
      await stopAndSend();
      return;
    }
    if (g.kind === 'hold' && Date.now() - g.at >= HOLD_MS && (await g.starting)) await stopAndSend();
  };

  const close = () => {
    stopSpeaking();
    if (mic.recording) void mic.stop();
    if (router.canGoBack()) router.back();
    else router.replace('/driver/today');
  };

  const label =
    orb === 'listening'
      ? t('Listening… {seconds}s', { seconds: mic.seconds })
      : orb === 'thinking'
        ? t('Thinking…')
        : orb === 'speaking'
          ? t('Speaking…')
          : turns.length
            ? t('Hold the mic to ask again')
            : t('Ask in Uzbek, Russian or English');
  const bigWord = orb === 'listening' ? t('Go ahead') : heard ?? t('Hi, how can I help?');
  const lastTurn = turns[turns.length - 1];

  return (
    <LinearGradient colors={[color.auraFrom, color.auraTo]} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom', 'left', 'right']}>
        <Animated.View style={{ flex: 1, opacity: fade }}>
          {/* top bar */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: gutter, paddingVertical: space.sm, gap: space.sm }}>
            <Text variant="subheading" style={{ flex: 1 }} accessibilityRole="header">
              {t('Ask NeWay')}
            </Text>
            {mode === 'chat' ? (
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: readAloud }} accessibilityLabel={t('Read answers aloud')} onPress={() => setReadAloud((v) => !v)} hitSlop={8} style={{ padding: space.xs }}>
                <Icon name={readAloud ? 'volume-high' : 'volume-off'} size={22} tint={color.ink} />
              </Pressable>
            ) : null}
            {mode === 'chat' ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t('Voice mode')} onPress={() => setMode('voice')} hitSlop={8} style={{ padding: space.xs }}>
                <Icon name="microphone-outline" size={22} tint={color.ink} />
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={close} hitSlop={8} style={{ padding: space.xs }}>
              <Icon name="close" size={24} tint={color.ink} />
            </Pressable>
          </View>

          {aiOn === false ? (
            <View style={{ flexDirection: 'row', gap: space.sm, marginHorizontal: gutter, padding: space.sm, borderRadius: 12, backgroundColor: color.infoBg }}>
              <StatusSymbol tone="info" size={16} />
              <Text variant="caption" tint={color.info} style={{ flex: 1 }}>
                {t('NeWay AI is not switched on for your company yet, so answers cover the common pay and load questions.')}
              </Text>
            </View>
          ) : null}

          {mode === 'voice' ? (
            <>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: gutter }}>
                <Orb size={240} mode={orb} loudness={mic.loudness} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xl }} accessibilityLiveRegion="polite">
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: orb === 'listening' ? color.dangerIcon : color.primary }} />
                  <Text variant="smallStrong" tint={color.text2}>
                    {label}
                  </Text>
                </View>
                <Text style={{ fontSize: 28, lineHeight: 34, fontWeight: '800', textAlign: 'center', marginTop: space.sm }} numberOfLines={3}>
                  {bigWord}
                </Text>
                {lastTurn?.role === 'assistant' && orb !== 'listening' ? (
                  <ScrollView style={{ maxHeight: 160, alignSelf: 'stretch', marginTop: space.md }} contentContainerStyle={{ alignItems: 'center' }}>
                    <Text variant="body" tint={lastTurn.failed ? color.danger : color.text2} style={{ textAlign: 'center' }}>
                      {lastTurn.text}
                    </Text>
                  </ScrollView>
                ) : null}
                {heardBy && orb !== 'listening' ? (
                  <Text variant="caption" tint={color.text3} style={{ textAlign: 'center', marginTop: space.xs }}>
                    {heardBy}
                  </Text>
                ) : null}
                {note ? (
                  <Text variant="small" tint={color.warning} style={{ textAlign: 'center', marginTop: space.md }}>
                    {note}
                  </Text>
                ) : null}
              </View>
              {!turns.length && orb === 'idle' ? <Chips items={DRIVER_ASSISTANT_STARTERS.slice(0, 4)} onPick={(q, shown) => void ask(q, true, shown)} /> : lastAnswer && orb === 'idle' ? <Chips items={lastAnswer.suggestions} onPick={(q, shown) => void ask(q, true, shown)} /> : null}
              <View style={{ alignItems: 'center', marginTop: space.lg }}>
                <Waveform mode={orb} loudness={mic.loudness} />
                {!voiceOff && (orb === 'idle' || orb === 'listening') ? (
                  <Text variant="caption" tint={color.text2} style={{ marginTop: space.sm }}>
                    {orb === 'listening' ? t('Release to send') : t('Hold the mic and speak')}
                  </Text>
                ) : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingVertical: space.xl }}>
                <RoundButton icon="keyboard-outline" label={t('Type instead')} onPress={() => setMode('chat')} />
                <RoundButton
                  big
                  icon={mic.recording ? 'send' : orb === 'speaking' ? 'stop' : 'microphone'}
                  label={mic.recording ? t('Send your question') : orb === 'speaking' ? t('Stop speaking') : t('Hold to talk')}
                  onPressIn={() => void pressIn()}
                  onPressOut={() => void pressOut()}
                  disabled={busy}
                />
                <RoundButton icon="close" label={t('Close')} onPress={close} />
              </View>
            </>
          ) : (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
              <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ padding: gutter, gap: space.md }} keyboardShouldPersistTaps="handled">
                {!turns.length ? (
                  <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl }}>
                    <Orb size={120} mode="idle" />
                    <Text variant="heading">{t('Hi, how can I help?')}</Text>
                    <Text variant="small" tint={color.text2} style={{ textAlign: 'center' }}>
                      {t('Ask about your statements, deductions, miles, loads or how to use the app. I only see your own pay.')}
                    </Text>
                  </View>
                ) : null}
                {turns.map((turn) => (
                  <View key={turn.id} style={{ alignItems: turn.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <View
                      style={{
                        maxWidth: '88%',
                        borderRadius: 18,
                        borderBottomRightRadius: turn.role === 'user' ? 6 : 18,
                        borderBottomLeftRadius: turn.role === 'user' ? 18 : 6,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        backgroundColor: turn.role === 'user' ? color.primary : color.panel,
                      }}
                    >
                      <Text variant="body" tint={turn.role === 'user' ? color.onPrimary : turn.failed ? color.danger : color.ink}>
                        {turn.text}
                      </Text>
                      {turn.answer ? <Facts answer={turn.answer} /> : null}
                    </View>
                  </View>
                ))}
                {busy ? (
                  <Text variant="small" tint={color.text2}>
                    {t('Thinking…')}
                  </Text>
                ) : null}
                {note ? (
                  <Text variant="small" tint={color.warning}>
                    {note}
                  </Text>
                ) : null}
              </ScrollView>
              <View style={{ paddingVertical: space.sm }}>
                <Chips items={lastAnswer?.suggestions ?? DRIVER_ASSISTANT_STARTERS} onPick={(q) => void ask(q, false)} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, paddingHorizontal: gutter, paddingBottom: space.sm }}>
                <TextInput
                  accessibilityLabel={t('Your question')}
                  value={draft}
                  onChangeText={(text) => setDraft(text.slice(0, 1000))}
                  placeholder={t('Ask about your pay, loads…')}
                  placeholderTextColor={color.text3}
                  multiline
                  onSubmitEditing={() => void ask(draft, false)}
                  style={[
                    { flex: 1, minHeight: 48, maxHeight: 120, borderRadius: 24, backgroundColor: color.panel, borderWidth: 1, borderColor: color.border, paddingHorizontal: space.lg, paddingVertical: space.md, fontSize: 16, color: color.ink, ...fontFor('500') },
                    { outlineStyle: 'none' } as object,
                  ]}
                />
                <SendButton onPress={() => void ask(draft, false)} disabled={busy || !draft.trim()} />
              </View>
            </KeyboardAvoidingView>
          )}
        </Animated.View>
      </SafeAreaView>
    </LinearGradient>
  );
}
