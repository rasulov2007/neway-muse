import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, hasToken } from '@/api/client';
import { authenticate, biometricEnabled, biometricOffered, biometricSupport, markBiometricOffered, setBiometricEnabled, type BiometricSupport } from '@/auth/biometric';
import { useSession } from '@/auth/session';
import { FaceIdGlyph } from '@/features/biometric-sheet';
import { tagline, Wordmark } from '@/features/brand';
import { LanguageChip } from '@/features/language-picker';
import { t } from '@/i18n';
import { Button, TextField } from '@/ui/controls';
import { Icon, StatusSymbol, Text } from '@/ui/primitives';
import { OfflineBanner } from '@/ui/states';
import { color, elevation, gutter, radius, space } from '@/ui/tokens';

function Checkbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => onChange(!checked)}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 40 }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: checked ? 0 : 1.5,
          borderColor: color.borderStrong,
          backgroundColor: checked ? color.primary : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Icon name="check-bold" size={15} tint={color.onPrimary} /> : null}
      </View>
      <Text variant="small" tint={color.text2}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Sign in (mobile M6 redesign, M7 hero): the large NeWay wordmark waving letter by letter and the
 * tagline on a light accent wash, a language chip, then a sheet with
 * "Welcome back", the two fields, "Keep me signed in", Log in, and — when the person turned it on
 * — Sign in with Face ID / fingerprint. There is no self-service password reset in the TMS, so
 * the office resets it (said under the form). No social or guest sign-in: the TMS has none.
 */
export default function Login() {
  const { state, login, unlock } = useSession();
  const insets = useSafeAreaInsets();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<BiometricSupport | null>(null);
  const [canUnlock, setCanUnlock] = useState(false);
  const [offer, setOffer] = useState<'pending' | 'open' | null>(null);
  const [enabling, setEnabling] = useState(false);
  const sheet = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(sheet, { toValue: 1, useNativeDriver: true, friction: 9, tension: 60 }).start();
    let alive = true;
    (async () => {
      const s = await biometricSupport();
      const on = await biometricEnabled();
      if (!alive) return;
      setSupport(s);
      setCanUnlock(s.available && on && hasToken());
    })();
    return () => {
      alive = false;
    };
  }, [sheet]);

  if (state.status === 'signedIn' && !offer) return <Redirect href="/" />;
  if (state.status === 'locked') return <Redirect href="/" />;
  const expired = state.status === 'signedOut' && state.reason === 'expired';

  const submit = async () => {
    if (!identifier.trim() || !password) {
      setError(t('Enter your email or username and your password.'));
      return;
    }
    setBusy(true);
    setError(null);
    // Ask once, after the first password sign-in on this phone, whether to use the face next time.
    const ask = keep && Boolean(support?.available) && !(await biometricEnabled()) && !(await biometricOffered());
    if (ask) setOffer('pending');
    try {
      await login(identifier, password, { keep });
      if (ask) setOffer('open');
      else router.replace('/');
    } catch (e) {
      setOffer(null);
      const err = e instanceof ApiError ? e : null;
      setError(
        err?.kind === 'offline'
          ? t('No connection. Signing in needs the internet.')
          : err?.status === 401 || err?.status === 400
            ? t('That email or password is not right.')
            : err?.status === 429
              ? t('Too many tries. Wait a minute and try again.')
              : (err?.detail ?? t('Could not sign in. Try again.')),
      );
    } finally {
      setBusy(false);
    }
  };

  const finishOffer = async (turnOn: boolean) => {
    if (turnOn && support) {
      setEnabling(true);
      const ok = (await authenticate(t('Turn on {label} for NeWay', { label: support.label }))) === 'success';
      setEnabling(false);
      if (ok) await setBiometricEnabled(true);
      else await markBiometricOffered();
    } else {
      await markBiometricOffered();
    }
    setOffer(null);
    router.replace('/');
  };

  const faceUnlock = async () => {
    if (!support) return;
    setError(null);
    const result = await unlock(t('Sign in to NeWay with {label}', { label: support.label }));
    if (result === 'success') router.replace('/');
    else if (result === 'failed') setError(t('{label} did not recognise you. Use your password.', { label: support.label }));
  };

  const label = support?.label ?? t('Face ID');
  return (
    <View style={{ flex: 1, backgroundColor: color.panel }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }} bounces={false}>
          <LinearGradient colors={[color.auraFrom, color.panel]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ paddingTop: insets.top + space.sm, paddingBottom: space.xxxl + space.xl, paddingHorizontal: gutter }}>
            <View style={{ alignItems: 'flex-end', minHeight: 44 }}>
              <LanguageChip />
            </View>
            <View style={{ alignItems: 'center', paddingTop: space.lg }}>
              <Wordmark size={68} tone="gradient" tagline={tagline()} wave />
            </View>
          </LinearGradient>

          <Animated.View
            style={{
              flex: 1,
              marginTop: -space.xxxl,
              backgroundColor: color.panel,
              borderTopLeftRadius: radius.xxl + 4,
              borderTopRightRadius: radius.xxl + 4,
              paddingHorizontal: gutter + space.xs,
              paddingTop: space.xxl,
              paddingBottom: insets.bottom + space.xxl,
              opacity: sheet,
              transform: [{ translateY: sheet.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }],
            }}
          >
            <OfflineBanner />
            <Text variant="display" accessibilityRole="header">
              {t('Welcome back')}
            </Text>
            <Text variant="body" tint={color.text2} style={{ marginTop: space.xs, marginBottom: space.xl }}>
              {t('Sign in to your NeWay account')}
            </Text>

            {expired ? (
              <View style={{ flexDirection: 'row', gap: space.sm, backgroundColor: color.infoBg, borderRadius: 12, padding: space.md, marginBottom: space.lg }}>
                <StatusSymbol tone="info" size={18} />
                <Text variant="small" tint={color.info} style={{ flex: 1 }}>
                  {t('Your session ended. Sign in again — anything waiting to upload is kept on this phone.')}
                </Text>
              </View>
            ) : null}

            <View style={{ gap: space.md }}>
              <TextField
                label={t('Email or username')}
                placeholder="you@company.com"
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                keyboardType="email-address"
                returnKeyType="next"
                icon="email-outline"
              />
              <TextField
                label={t('Password')}
                placeholder={t('Your password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!show}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
                icon="lock-outline"
                right={
                  <Pressable accessibilityRole="button" accessibilityLabel={show ? t('Hide password') : t('Show password')} onPress={() => setShow((s) => !s)} hitSlop={10}>
                    <Icon name={show ? 'eye-off-outline' : 'eye-outline'} size={22} tint={color.text2} />
                  </Pressable>
                }
              />
              <Checkbox checked={keep} label={t('Keep me signed in')} onChange={setKeep} />
              {error ? (
                <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }} accessibilityLiveRegion="polite">
                  <StatusSymbol tone="danger" size={16} />
                  <Text variant="small" tint={color.danger} style={{ flex: 1 }}>
                    {error}
                  </Text>
                </View>
              ) : null}
              <Button label={t('Log in')} onPress={submit} loading={busy} style={{ minHeight: 56, borderRadius: 16 }} />
            </View>

            {canUnlock ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.xl }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.divider }} />
                  <Text variant="caption" tint={color.text3}>
                    {t('Or continue with')}
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.divider }} />
                </View>
                <Button label={t('Sign in with {label}', { label })} icon={support?.kind === 'fingerprint' ? 'fingerprint' : 'face-recognition'} variant="outline" onPress={faceUnlock} style={{ minHeight: 52, borderRadius: 16 }} />
              </>
            ) : null}

            <Text variant="caption" tint={color.text3} style={{ textAlign: 'center', marginTop: space.xxl }}>
              {t('Forgot your password? Ask your dispatcher or administrator to reset it.')}
            </Text>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={offer === 'open'} transparent animationType="fade" onRequestClose={() => void finishOffer(false)}>
        <View style={{ flex: 1, backgroundColor: color.overlay, alignItems: 'center', justifyContent: 'center', padding: space.xxl }}>
          <View style={[{ width: '100%', maxWidth: 320, backgroundColor: color.panel, borderRadius: radius.xxl, padding: space.xl, alignItems: 'center', gap: space.md }, elevation.overlay]}>
            <FaceIdGlyph kind={support?.kind ?? 'face'} size={72} />
            <Text variant="heading" style={{ textAlign: 'center' }}>
              {t('Use {label} next time?', { label })}
            </Text>
            <Text variant="small" tint={color.text2} style={{ textAlign: 'center' }}>
              {t('Unlock NeWay with {label} instead of typing your password. Your password is never saved on the phone. You can change this in Settings.', { label })}
            </Text>
            <Button label={t('Turn on {label}', { label })} loading={enabling} onPress={() => void finishOffer(true)} style={{ alignSelf: 'stretch', borderRadius: 14 }} />
            <Button label={t('Not now')} variant="link" onPress={() => void finishOffer(false)} style={{ alignSelf: 'center' }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}
