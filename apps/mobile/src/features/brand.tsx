import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';

import { t } from '@/i18n';
import { Text } from '@/ui/primitives';
import { color, mixColor, space } from '@/ui/tokens';

/**
 * The NeWay wordmark (mobile M7, owner 2026-10-28): large letters coloured along the accent
 * gradient (teal into the violet edge, both Porcelain tokens), each letter bouncing in turn in a
 * gentle, continuous wave. Built with the Animated API on the native driver, so it runs in Expo Go
 * and costs nothing on the JS thread. Reduced motion shows the letters still.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduced(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

const LETTERS = 'NeWay'.split('');

/** The tagline under the wordmark, in the live language. */
export function tagline(): string {
  return t('Trucking, on time. Every mile.');
}

/**
 * "NeWay". `tone="gradient"` colours the letters from the accent into the violet edge (the login
 * page, on a light wash); `tone="onHero"` draws them white (on the teal hero, e.g. the lock).
 * `wave` keeps the letters bouncing one after another.
 */
export function Wordmark({ size = 44, tagline: line, tone = 'onHero', wave = false }: { size?: number; tagline?: string; tone?: 'onHero' | 'gradient'; wave?: boolean }) {
  const reduced = useReducedMotion();
  const values = useRef(LETTERS.map(() => new Animated.Value(0))).current;
  const enter = useRef(new Animated.Value(wave ? 0 : 1)).current;

  useEffect(() => {
    if (!wave || reduced) {
      values.forEach((v) => v.setValue(0));
      enter.setValue(1);
      return;
    }
    const lift = (v: Animated.Value) =>
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 520, easing: Easing.bounce, useNativeDriver: true }),
      ]);
    const intro = Animated.timing(enter, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([Animated.stagger(110, values.map(lift)), Animated.delay(1100)]));
    intro.start();
    loop.start();
    return () => {
      intro.stop();
      loop.stop();
    };
  }, [wave, reduced, values, enter]);

  const letterColor = (i: number) => (tone === 'onHero' ? color.onHero : mixColor(color.primary, color.orbEdge, i / (LETTERS.length - 1)));
  const rise = size * 0.28;

  return (
    <View style={{ alignItems: 'center', gap: space.sm }} accessible accessibilityRole="header" accessibilityLabel={line ? `NeWay. ${line}` : 'NeWay'}>
      <Animated.View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingTop: wave ? rise : 0, opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] }}>
        {LETTERS.map((l, i) => (
          <Animated.View
            key={i}
            style={{
              transform: [
                { translateY: values[i]!.interpolate({ inputRange: [0, 1], outputRange: [0, -rise] }) },
                { scale: values[i]!.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) },
              ],
            }}
          >
            <Text style={{ fontSize: size, lineHeight: size * 1.18, fontWeight: '800', letterSpacing: -size * 0.02 }} tint={letterColor(i)}>
              {l}
            </Text>
          </Animated.View>
        ))}
      </Animated.View>
      {line ? (
        <Text variant="bodyStrong" tint={tone === 'onHero' ? color.onHeroMuted : color.text2} style={{ textAlign: 'center', letterSpacing: 0.2 }}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}
