import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { biometricSupport, type BiometricKind, type BiometricResult } from '@/auth/biometric';
import { useSession } from '@/auth/session';
import { t } from '@/i18n';
import { Icon, Text } from '@/ui/primitives';
import { color, elevation, radius, space } from '@/ui/tokens';

import { useReducedMotion, Wordmark } from './brand';

type GlyphState = 'scanning' | 'success' | 'failed';

/** The Face ID mark: four corner brackets, eyes, nose and smile; a fingerprint for finger readers. */
export function FaceIdGlyph({ size = 88, state = 'scanning', kind = 'face' }: { size?: number; state?: GlyphState; kind?: BiometricKind }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || state !== 'scanning') return;
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [reduced, state, pulse]);
  useEffect(() => {
    if (state === 'success') Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 5 }).start();
    else pop.setValue(0);
  }, [state, pop]);

  const tint = state === 'failed' ? color.dangerIcon : color.primary;
  if (state === 'success') {
    return (
      <Animated.View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }}>
        <Icon name="check-circle" size={size * 0.9} tint={color.successIcon} />
      </Animated.View>
    );
  }
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      {kind === 'fingerprint' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="fingerprint" size={size * 0.92} tint={tint} />
        </View>
      ) : (
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {/* corners */}
          <Path d="M 8 30 V 18 A 10 10 0 0 1 18 8 H 30" stroke={tint} strokeWidth={6} strokeLinecap="round" fill="none" />
          <Path d="M 70 8 H 82 A 10 10 0 0 1 92 18 V 30" stroke={tint} strokeWidth={6} strokeLinecap="round" fill="none" />
          <Path d="M 92 70 V 82 A 10 10 0 0 1 82 92 H 70" stroke={tint} strokeWidth={6} strokeLinecap="round" fill="none" />
          <Path d="M 30 92 H 18 A 10 10 0 0 1 8 82 V 70" stroke={tint} strokeWidth={6} strokeLinecap="round" fill="none" />
          {/* face */}
          <Path d="M 34 36 V 44" stroke={tint} strokeWidth={6} strokeLinecap="round" />
          <Path d="M 66 36 V 44" stroke={tint} strokeWidth={6} strokeLinecap="round" />
          <Path d="M 50 36 V 56 H 45" stroke={tint} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={state === 'failed' ? 'M 36 70 Q 50 62 64 70' : 'M 34 64 Q 50 78 66 64'} stroke={tint} strokeWidth={6} strokeLinecap="round" fill="none" />
        </Svg>
      )}
    </Animated.View>
  );
}

/**
 * The lock at start (Face ID / fingerprint on): the brand behind a white sheet with the glyph.
 * It asks the phone at once; Cancel goes to the password form and keeps the stored session for
 * another try from there.
 */
export function LockScreen({ preview = false }: { preview?: boolean }) {
  const { unlock, skipUnlock } = useSession();
  const [kind, setKind] = useState<BiometricKind>('face');
  const [label, setLabel] = useState(t('Face ID'));
  const [state, setState] = useState<GlyphState>('scanning');
  const [message, setMessage] = useState(t('Looking for you…'));
  const rise = useRef(new Animated.Value(0)).current;
  const started = useRef(false);

  const run = useCallback(async () => {
    setState('scanning');
    setMessage(t('Looking for you…'));
    const support = await biometricSupport();
    setKind(support.kind);
    setLabel(support.label);
    const result: BiometricResult = await unlock(t('Unlock NeWay with {label}', { label: support.label }));
    if (result === 'success') {
      setState('success');
      setMessage(t('Welcome back'));
      return;
    }
    if (result === 'cancel' || result === 'unavailable') {
      skipUnlock();
      return;
    }
    setState('failed');
    setMessage(t('Not recognised. Try again or use your password.'));
  }, [unlock, skipUnlock]);

  useEffect(() => {
    Animated.spring(rise, { toValue: 1, useNativeDriver: true, friction: 8, tension: 70 }).start();
    if (started.current || preview) return;
    started.current = true;
    const timer = setTimeout(() => void run(), 350);
    return () => clearTimeout(timer);
  }, [rise, run, preview]);

  return (
    <LinearGradient colors={[color.heroFrom, color.heroTo]} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
      <View style={{ position: 'absolute', top: '16%' }}>
        <Wordmark size={40} />
      </View>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color.overlay }]} />
      <Animated.View
        accessibilityViewIsModal
        style={[
          {
            width: '100%',
            maxWidth: 300,
            backgroundColor: color.panel,
            borderRadius: radius.xxl,
            paddingVertical: space.xxl,
            paddingHorizontal: space.xl,
            alignItems: 'center',
            gap: space.md,
            opacity: rise,
            transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }, { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
          },
          elevation.overlay,
        ]}
      >
        <FaceIdGlyph state={state} kind={kind} />
        <Text variant="heading">{label}</Text>
        <Text variant="small" tint={state === 'failed' ? color.danger : color.text2} style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
          {message}
        </Text>
        {state === 'failed' ? (
          <Pressable accessibilityRole="button" onPress={() => void run()} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg }}>
            <Text variant="bodyStrong" tint={color.primary}>
              {t('Try again')}
            </Text>
          </Pressable>
        ) : null}
        {state !== 'success' ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('Cancel and use your password')} onPress={skipUnlock} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg }}>
            <Text variant="bodyStrong" tint={color.link}>
              {t('Cancel')}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </LinearGradient>
  );
}
