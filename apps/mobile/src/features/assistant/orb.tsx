import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { useReducedMotion } from '@/features/brand';
import { color } from '@/ui/tokens';

/**
 * The Ask NeWay orb (mobile M6): a glowing accent sphere, a ring of radial ticks that moves like an
 * audio ring, and a waveform row. One shared set of wave values drives every tick and bar, all on
 * the native driver, so it stays smooth on a modest phone. Reduced motion holds it still.
 */
export type OrbMode = 'idle' | 'listening' | 'thinking' | 'speaking';

const WAVES = 8;
const LEVEL: Record<OrbMode, number> = { idle: 0.18, listening: 0.55, thinking: 0.45, speaking: 0.85 };

/** The shared motion: wave values (0..1, staggered loops) and the current loudness. */
export function useOrbMotion(mode: OrbMode, loudness?: number | null) {
  const reduced = useReducedMotion();
  const waves = useRef(Array.from({ length: WAVES }, () => new Animated.Value(0.5))).current;
  const level = useRef(new Animated.Value(LEVEL.idle)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) return;
    const speed = mode === 'thinking' ? 380 : mode === 'speaking' ? 300 : mode === 'listening' ? 260 : 900;
    const loops = waves.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((i * speed) / WAVES),
          Animated.timing(v, { toValue: 1, duration: speed + (i % 3) * 60, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: speed + ((i + 1) % 3) * 60, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ),
    );
    const turn = Animated.loop(Animated.timing(spin, { toValue: 1, duration: mode === 'thinking' ? 2600 : 9000, easing: Easing.linear, useNativeDriver: true }));
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: mode === 'idle' ? 1800 : 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: mode === 'idle' ? 1800 : 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    [...loops, turn, pulse].forEach((a) => a.start());
    return () => [...loops, turn, pulse].forEach((a) => a.stop());
  }, [mode, reduced, waves, spin, breathe]);

  // Listening follows the microphone when it reports a level; otherwise the mode's own level.
  useEffect(() => {
    const target = mode === 'listening' && typeof loudness === 'number' ? Math.max(0.2, Math.min(1, loudness)) : LEVEL[mode];
    Animated.timing(level, { toValue: target, duration: 120, useNativeDriver: true }).start();
  }, [mode, loudness, level]);

  return { waves, level, spin, breathe, reduced };
}

type Motion = ReturnType<typeof useOrbMotion>;

/** The sphere itself, without ticks: also the small mark on Home. */
export function OrbSphere({ size, motion, glow = true }: { size: number; motion?: Motion; glow?: boolean }) {
  const id = useMemo(() => `orb${Math.random().toString(36).slice(2, 8)}`, []);
  const rotate = motion ? motion.spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) : '0deg';
  const scale = motion ? Animated.add(1, Animated.multiply(motion.breathe, Animated.multiply(motion.level, 0.08))) : 1;
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scale }] }}>
      {glow ? (
        <View style={{ position: 'absolute', left: -size * 0.25, top: -size * 0.25 }}>
          <Svg width={size * 1.5} height={size * 1.5}>
            <Defs>
              <RadialGradient id={`${id}g`} cx="50%" cy="50%" r="50%">
                <Stop offset="0.45" stopColor={color.orbGlow} stopOpacity={0.45} />
                <Stop offset="1" stopColor={color.orbGlow} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={size * 0.75} cy={size * 0.75} r={size * 0.75} fill={`url(#${id}g)`} />
          </Svg>
        </View>
      ) : null}
      <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id={`${id}c`} cx="34%" cy="30%" r="75%" fx="34%" fy="30%">
              <Stop offset="0" stopColor={color.orbHighlight} stopOpacity={1} />
              <Stop offset="0.45" stopColor={color.orbGlow} stopOpacity={1} />
              <Stop offset="0.8" stopColor={color.orbCore} stopOpacity={1} />
              <Stop offset="1" stopColor={color.orbEdge} stopOpacity={1} />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id}c)`} />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

/** The ring of radial ticks around the orb. */
export function TickRing({ size, motion, count = 64 }: { size: number; motion: Motion; count?: number }) {
  const r = size / 2;
  const rotate = motion.spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }} pointerEvents="none">
      {Array.from({ length: count }, (_, i) => {
        const wave = motion.waves[i % WAVES]!;
        const scaleY = Animated.add(0.35, Animated.multiply(wave, Animated.multiply(motion.level, 1.1)));
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: r - 1.5,
              top: r - 9,
              width: 3,
              height: 18,
              transform: [{ rotate: `${(360 / count) * i}deg` }, { translateY: -r + 12 }],
            }}
          >
            <Animated.View style={{ flex: 1, borderRadius: 2, backgroundColor: color.tick, opacity: i % 2 ? 0.55 : 0.9, transform: [{ scaleY }] }} />
          </View>
        );
      })}
    </Animated.View>
  );
}

/** Orb + ring, centred. */
export function Orb({ size = 220, mode, loudness, style }: { size?: number; mode: OrbMode; loudness?: number | null; style?: StyleProp<ViewStyle> }) {
  const motion = useOrbMotion(mode, loudness);
  const sphere = size * 0.62;
  return (
    <View style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]} accessible={false}>
      <View style={{ position: 'absolute' }}>
        <TickRing size={size} motion={motion} />
      </View>
      <OrbSphere size={sphere} motion={motion} />
    </View>
  );
}

/** The waveform row near the bottom of the voice screen. */
export function Waveform({ mode, loudness, bars = 28, height = 36 }: { mode: OrbMode; loudness?: number | null; bars?: number; height?: number }) {
  const motion = useOrbMotion(mode, loudness);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height }} accessible={false}>
      {Array.from({ length: bars }, (_, i) => {
        const centre = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2);
        const scaleY = Animated.add(0.12, Animated.multiply(motion.waves[(i * 3) % WAVES]!, Animated.multiply(motion.level, 0.4 + centre * 0.6)));
        return <Animated.View key={i} style={{ width: 4, height, borderRadius: 2, backgroundColor: color.primary, opacity: 0.35 + centre * 0.6, transform: [{ scaleY }] }} />;
      })}
    </View>
  );
}

/** A small, slowly breathing orb for buttons and the Home card. */
export function MiniOrb({ size = 44 }: { size?: number }) {
  const motion = useOrbMotion('idle');
  return <OrbSphere size={size} motion={motion} glow={false} />;
}
