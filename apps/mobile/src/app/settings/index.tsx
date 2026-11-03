import type { Appearance } from '@neway/shared/auth/index';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '@/auth/session';
import { appearanceLabel, MoonToggle, SettingsGroup, SettingsRow, Toggle, useSettings } from '@/features/settings';
import { LANGUAGES, t, useLanguage } from '@/i18n';
import { BackLink, useToast } from '@/ui/layout';
import { Text } from '@/ui/primitives';
import { LoadingState } from '@/ui/states';
import { useTheme } from '@/ui/theme';
import { color, gutter, radius, space } from '@/ui/tokens';

function AppearancePicker({ value, onChange }: { value: Appearance; onChange: (v: Appearance) => void }) {
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', backgroundColor: color.subtle, borderRadius: 12, padding: 3, marginBottom: space.md }}>
      {(['light', 'dark', 'system'] as Appearance[]).map((a) => {
        const on = a === value;
        return (
          <Pressable
            key={a}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(a)}
            style={[{ flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? color.panel : 'transparent' }, on ? { shadowColor: color.shadow, shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 } : null]}
          >
            <Text variant="smallStrong" tint={on ? color.ink : color.text2}>
              {appearanceLabel(a)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Settings (mobile M6): Dark mode card, Personalization, Alerts, Privacy & security, sign out. */
export default function Settings() {
  const { ready, draft, set, support, sessionStored } = useSettings();
  const theme = useTheme();
  const { scheme } = theme;
  // Appearance applies at once (no Save); the profile is updated in the background.
  const setAppearance = (a: Appearance) => {
    if (a === theme.preference) return;
    void theme.setPreference(a).catch(() => toast(t('Saved on this phone; the profile will update when you are online.'), 'warning'));
  };
  const { logout, account } = useSession();
  const toast = useToast();
  const { lang } = useLanguage();
  const langName = (LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0]).native;
  const dark = scheme === 'dark';
  const bioLabel = support?.label ?? t('Face ID / fingerprint');
  const bioNote = !support?.available
    ? t('Not set up on this phone (or not available in this app build)')
    : !sessionStored
      ? t('Needs "Keep me signed in" at your next sign-in')
      : t('Unlock NeWay without typing your password');

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: space.sm, paddingBottom: 120 }}>
        <BackLink />
        <Text variant="hero" accessibilityRole="header">
          {t('Settings')}
        </Text>
        <Text variant="body" tint={color.text2} style={{ marginTop: space.xs }}>
          {account?.name ? `${account.name} · ` : ''}
          {t('make NeWay work your way')}
        </Text>

        {!ready ? (
          <LoadingState />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl, backgroundColor: color.panel, borderRadius: radius.xl, padding: space.lg }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="heading">{t('Dark mode')}</Text>
                <Text variant="caption" tint={color.text3}>
                  {theme.preference === 'system' ? t('Following the phone') : dark ? t('Easy on the eyes at night') : t('Bright and clear in daylight')}
                </Text>
              </View>
              <MoonToggle dark={dark} onChange={(d) => setAppearance(d ? 'dark' : 'light')} />
            </View>

            <SettingsGroup title={t('PERSONALIZATION')}>
              <SettingsRow icon="palette-outline" title={t('Appearance')} subtitle={t('Light, Dark, or follow the phone')} value={appearanceLabel(theme.preference)} />
              <AppearancePicker value={theme.preference} onChange={setAppearance} />
              <SettingsRow icon="translate" title={t('Language')} value={langName} onPress={() => router.push('/settings/language')} last />
            </SettingsGroup>

            <SettingsGroup title={t('ALERTS')}>
              <SettingsRow icon="bell-outline" title={t('Notifications')} subtitle={t('Push and sound on this phone')} onPress={() => router.push('/settings/notifications')} last />
            </SettingsGroup>

            <SettingsGroup title={t('PRIVACY & SECURITY')}>
              <SettingsRow
                icon={support?.kind === 'fingerprint' ? 'fingerprint' : 'face-recognition'}
                title={bioLabel}
                subtitle={bioNote}
                right={<Toggle label={bioLabel} value={draft.biometric} onChange={(v) => set('biometric', v)} disabled={!support?.available || (!sessionStored && !draft.biometric)} />}
              />
              <SettingsRow icon="shield-lock-outline" title={t('Your data')} subtitle={t('NeWay shows you only your own loads and pay. Your password is never stored on the phone.')} last />
            </SettingsGroup>

            <SettingsGroup title={t('ACCOUNT')}>
              <SettingsRow
                icon="logout"
                title={t('Sign out')}
                subtitle={t('Removes your drafts and waiting uploads from this phone')}
                danger
                last
                onPress={async () => {
                  await logout();
                  router.replace('/login');
                }}
              />
            </SettingsGroup>

            <Text variant="caption" tint={color.text3} style={{ marginTop: space.xl, textAlign: 'center' }}>
              NeWay TMS {Constants.expoConfig?.version ?? ''}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
