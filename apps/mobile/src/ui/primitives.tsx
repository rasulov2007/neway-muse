import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';
import { Text as RNText, View, StyleSheet, type TextProps, type TextStyle, type StyleProp, type ViewStyle } from 'react-native';

import { color, fontFamily, radius, space, tone as tones, type as typeScale, type StatusTone, type TypeVariant } from './tokens';

/** Manrope is used once the root layout has loaded it; until then (or if it fails) the system font. */
let fontsReady = false;
export function setFontsReady(ready: boolean): void {
  fontsReady = ready;
}

/** The Manrope face for a weight, with the weight itself dropped (each face is its own family). */
export function fontFor(weight: unknown): { fontFamily?: string; fontWeight?: undefined } {
  if (!fontsReady) return {};
  const key = weight === 'bold' ? '700' : weight === 'normal' || weight === undefined ? '400' : String(weight);
  const family = fontFamily[key] ?? (Number(key) >= 700 ? fontFamily['700'] : fontFamily['400']);
  return { fontFamily: family, fontWeight: undefined };
}

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, tint = color.ink, style }: { name: IconName; size?: number; tint?: string; style?: StyleProp<ViewStyle> }) {
  return <MaterialCommunityIcons name={name} size={size} color={tint} style={style as never} />;
}

export function Text({
  variant = 'body',
  tint,
  style,
  ...rest
}: TextProps & { variant?: TypeVariant; tint?: string }) {
  const flat = (StyleSheet.flatten([typeScale[variant], { color: tint ?? color.ink }, style]) ?? {}) as TextStyle;
  return <RNText {...rest} style={[flat, flat.fontFamily ? null : fontFor(flat.fontWeight)]} />;
}

export function Divider({ inset = 0, style }: { inset?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: color.divider, marginLeft: inset }, style]} />;
}

/** The small "n" in a rounded square from the sheets, in the accent. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <View
      accessibilityLabel="NeWay"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        backgroundColor: color.primary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <RNText style={{ color: color.onPrimary, fontSize: size * 0.68, lineHeight: size * 0.8, fontWeight: '800', marginTop: -size * 0.06, ...fontFor('800') }}>
        n
      </RNText>
    </View>
  );
}

/**
 * The status shape (never colour alone): octagon = urgent, diamond = warning, check circle =
 * done, arrow circle = moving, "i" circle = info, dashed ring = neutral.
 */
export function StatusSymbol({ tone, size = 14 }: { tone: StatusTone; size?: number }) {
  const t = tones[tone];
  if (tone === 'neutral') {
    return (
      <View
        style={{
          width: size - 2,
          height: size - 2,
          margin: 1,
          borderRadius: size,
          borderWidth: 1.5,
          borderStyle: 'dashed',
          borderColor: t.icon,
        }}
      />
    );
  }
  const name: IconName =
    tone === 'danger'
      ? 'alert-octagon'
      : tone === 'warning'
        ? 'alert-rhombus'
        : tone === 'success'
          ? 'check-circle'
          : tone === 'moving'
            ? 'arrow-right-circle'
            : 'information';
  return <Icon name={name} size={size} tint={t.icon} />;
}

/** A restrained status pill: soft background, symbol and word in the tone's colour. */
export function StatusPill({ tone, label, style }: { tone: StatusTone; label: string; style?: StyleProp<ViewStyle> }) {
  const t = tones[tone];
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: space.xs,
          backgroundColor: t.bg,
          borderRadius: radius.sm,
          paddingHorizontal: space.sm,
          paddingVertical: 3,
        },
        style,
      ]}
    >
      <StatusSymbol tone={tone} size={12} />
      <Text variant="captionStrong" tint={t.fg}>
        {label}
      </Text>
    </View>
  );
}

/** Initials in a circle: the office avatar ("JD") and the inbox department marks. */
export function Avatar({ name, size = 36, tone }: { name: string; size?: number; tone?: StatusTone }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  const filled = tone ? tones[tone] : null;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: filled ? filled.icon : color.subtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text variant={size >= 48 ? 'heading' : 'smallStrong'} tint={filled ? color.onPrimary : color.ink}>
        {initials}
      </Text>
    </View>
  );
}

export function Row({ children, style, gap = space.sm }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Spacer({ size = space.lg }: { size?: number }) {
  return <View style={{ height: size }} />;
}
