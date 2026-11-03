import type { Appearance } from '@neway/shared/auth/index';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { authenticate, biometricEnabled, biometricSupport, setBiometricEnabled, type BiometricSupport } from '@/auth/biometric';
import { tokenIsStored } from '@/api/client';
import { pushPreferences, pushSupported, setPushPreferences } from '@/lib/push';
import { t, tn } from '@/i18n';
import { useToast } from '@/ui/layout';
import { Icon, Text, type IconName } from '@/ui/primitives';
import { color, elevation, radius, space } from '@/ui/tokens';

/**
 * Settings (mobile M6, after the owner's reference): Face ID / fingerprint, push and the alert
 * sound are staged, a floating bar counts them ("● 2 changes · Discard · Save") and Save applies
 * them together; they belong to this phone. Appearance and language are not staged (owner,
 * 2026-10-28): one tap applies them at once (appearance also goes to the profile through
 * PATCH /auth/me/preferences, see ui/theme.tsx).
 */
export interface SettingsValues {
  biometric: boolean;
  push: boolean;
  sound: boolean;
}

interface SettingsApi {
  ready: boolean;
  saved: SettingsValues;
  draft: SettingsValues;
  set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void;
  changes: Array<keyof SettingsValues>;
  discard(): void;
  save(): Promise<void>;
  saving: boolean;
  support: BiometricSupport | null;
  /** Face ID needs the session kept on the phone ("Keep me signed in"). */
  sessionStored: boolean;
  pushAvailable: boolean;
}

const Ctx = createContext<SettingsApi | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SettingsValues>({ biometric: false, push: false, sound: false });
  const [draft, setDraft] = useState<SettingsValues>(saved);
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [sessionStored, setSessionStored] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [bio, push, s, stored] = await Promise.all([biometricEnabled(), pushPreferences(), biometricSupport(), tokenIsStored()]);
      if (!alive) return;
      const base = { biometric: bio, push: push.on, sound: push.sound };
      setSaved(base);
      setDraft(base);
      setSupport(s);
      setSessionStored(stored);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const set = useCallback(<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => setDraft((d) => ({ ...d, [key]: value })), []);
  const changes = (Object.keys(draft) as Array<keyof SettingsValues>).filter((k) => draft[k] !== saved[k]);
  const discard = useCallback(() => setDraft(saved), [saved]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      let next = { ...saved };
      if (draft.biometric !== saved.biometric) {
        if (draft.biometric) {
          const ok = (await authenticate(t('Turn on {label} for NeWay', { label: support?.label ?? t('Face ID') }))) === 'success';
          if (ok) await setBiometricEnabled(true);
          else toast(t('{label} was not turned on.', { label: support?.label ?? t('Face ID') }), 'warning');
          next = { ...next, biometric: ok };
        } else {
          await setBiometricEnabled(false);
          next = { ...next, biometric: false };
        }
      }
      if (draft.push !== saved.push || draft.sound !== saved.sound) {
        await setPushPreferences({ on: draft.push, sound: draft.sound });
        next = { ...next, push: draft.push, sound: draft.sound };
      }
      setSaved(next);
      setDraft(next);
      toast(t('Settings saved'), 'success');
    } finally {
      setSaving(false);
    }
  }, [draft, saved, support, toast]);

  const value = useMemo<SettingsApi>(
    () => ({ ready, saved, draft, set, changes, discard, save, saving, support, sessionStored, pushAvailable: pushSupported() }),
    [ready, saved, draft, set, changes, discard, save, saving, support, sessionStored],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}

// --------------------------------------------------------------------------------- pieces

/** The floating "● N changes · Discard · Save" bar; it rises in when something changed. */
export function ChangesBar() {
  const { changes, discard, save, saving } = useSettings();
  const insets = useSafeAreaInsets();
  const shown = changes.length > 0;
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(rise, { toValue: shown ? 1 : 0, useNativeDriver: true, friction: 9, tension: 80 }).start();
  }, [shown, rise]);
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      style={{
        position: 'absolute',
        left: space.lg,
        right: space.lg,
        bottom: Math.max(insets.bottom, space.sm) + space.sm,
        opacity: rise,
        transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [90, 0] }) }],
      }}
    >
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.dock, borderRadius: radius.pill, paddingLeft: space.lg, paddingRight: space.xs, height: 60 }, elevation.card]}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.warningIcon }} />
        <Text variant="smallStrong" tint={color.onDock} style={{ flex: 1 }} accessibilityLiveRegion="polite">
          {tn(changes.length, '{count} change', '{count} changes')}
        </Text>
        <Pressable accessibilityRole="button" onPress={discard} disabled={saving} hitSlop={6} style={{ paddingHorizontal: space.sm, minHeight: 44, justifyContent: 'center' }}>
          <Text variant="smallStrong" tint={color.dockMuted}>
            {t('Discard')}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void save()} disabled={saving} style={({ pressed }) => ({ backgroundColor: pressed ? color.primaryPressed : color.primary, borderRadius: radius.pill, paddingHorizontal: space.xl, height: 48, justifyContent: 'center' })}>
          <Text variant="smallStrong" tint={color.onPrimary}>
            {saving ? t('Saving…') : t('Save')}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

/** A small animated switch. */
export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, { toValue: value ? 1 : 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [value, x]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={8}
      style={{ width: 52, height: 32, borderRadius: 16, padding: 3, backgroundColor: value ? color.primary : color.borderStrong, opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: color.onPrimary, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] }} />
    </Pressable>
  );
}

/** The Dark mode switch with the moon and stars (the reference's top card). */
export function MoonToggle({ dark, onChange }: { dark: boolean; onChange: (dark: boolean) => void }) {
  const x = useRef(new Animated.Value(dark ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: dark ? 1 : 0, useNativeDriver: false, friction: 7, tension: 70 }).start();
  }, [dark, x]);
  const bg = x.interpolate({ inputRange: [0, 1], outputRange: [color.warningBg, color.dock] });
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={t('Dark mode')} accessibilityState={{ checked: dark }} onPress={() => onChange(!dark)} hitSlop={8}>
      <Animated.View style={{ width: 76, height: 40, borderRadius: 20, padding: 4, backgroundColor: bg, overflow: 'hidden' }}>
        {[{ l: 14, t: 9, s: 3 }, { l: 24, t: 22, s: 2 }, { l: 34, t: 11, s: 2.5 }].map((st, i) => (
          <Animated.View key={i} style={{ position: 'absolute', left: st.l, top: st.t, width: st.s * 2, height: st.s * 2, borderRadius: st.s, backgroundColor: color.onDock, opacity: x }} />
        ))}
        <Animated.View
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: dark ? color.panel : color.warningIcon,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 36] }) }, { rotate: x.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-200deg'] }) }],
          }}
        >
          <Icon name={dark ? 'moon-waning-crescent' : 'white-balance-sunny'} size={18} tint={dark ? color.warningIcon : color.onPrimary} />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ marginTop: space.xl }}>
      <Text variant="overline" tint={color.text3} style={{ marginBottom: space.sm, marginLeft: space.xs }} accessibilityRole="header">
        {title}
      </Text>
      <View style={{ backgroundColor: color.panel, borderRadius: radius.xl, paddingHorizontal: space.md }}>{children}</View>
    </View>
  );
}

export function SettingsRow({
  icon,
  tint = color.primary,
  title,
  subtitle,
  value,
  right,
  onPress,
  last,
  danger,
}: {
  icon: IconName;
  tint?: string;
  title: string;
  subtitle?: string | null;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 60, paddingVertical: space.sm, borderBottomWidth: last ? 0 : 1, borderColor: color.divider, opacity: pressed ? 0.75 : 1 })}
    >
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: danger ? color.dangerBg : color.primaryTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} tint={danger ? color.dangerIcon : tint} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="rowTitle" tint={danger ? color.danger : color.ink}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tint={color.text3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="small" tint={color.text2}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress && !right ? <Icon name="chevron-right" size={20} tint={color.text3} /> : null}
    </Pressable>
  );
}

export function appearanceLabel(a: Appearance): string {
  return { light: t('Light'), dark: t('Dark'), system: t('System') }[a];
}
