import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsGroup, SettingsRow, Toggle, useSettings } from '@/features/settings';
import { t } from '@/i18n';
import { BackLink } from '@/ui/layout';
import { StatusSymbol, Text } from '@/ui/primitives';
import { color, gutter, space } from '@/ui/tokens';

/**
 * Notifications. The TMS has no per-topic notification preferences, so the page offers only what
 * is real: push on this phone (registers or revokes the device with the server) and the sound for
 * a push that arrives while the app is open (this phone only). The bell inside the app always
 * shows every notification.
 */
export default function NotificationSettings() {
  const { draft, set, pushAvailable } = useSettings();
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: space.sm, paddingBottom: 120 }}>
        <BackLink label={t('Settings')} />
        <Text variant="hero" accessibilityRole="header">
          {t('Notifications')}
        </Text>
        {!pushAvailable ? (
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg, backgroundColor: color.infoBg, borderRadius: 12, padding: space.md }}>
            <StatusSymbol tone="info" size={18} />
            <Text variant="small" tint={color.info} style={{ flex: 1 }}>
              {t('Push needs the installed NeWay app. Expo Go and the web preview cannot receive it; the bell inside the app still shows everything.')}
            </Text>
          </View>
        ) : null}
        <SettingsGroup title={t('THIS PHONE')}>
          <SettingsRow
            icon="bell-ring-outline"
            title={t('Push notifications')}
            subtitle={t('Loads, documents, pay and messages from the office')}
            right={<Toggle label={t('Push notifications')} value={draft.push} onChange={(v) => set('push', v)} disabled={!pushAvailable} />}
          />
          <SettingsRow
            icon="volume-high"
            title={t('Sound while the app is open')}
            subtitle={t('On this phone only')}
            right={<Toggle label={t('Sound while the app is open')} value={draft.sound} onChange={(v) => set('sound', v)} disabled={!pushAvailable || !draft.push} />}
            last
          />
        </SettingsGroup>
        <SettingsGroup title={t('IN THE APP')}>
          <SettingsRow icon="bell-outline" title={t('Notification bell')} subtitle={t('Always on: every notification the TMS sends you')} last />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}
