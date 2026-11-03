import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguageList } from '@/features/language-picker';
import { LANGUAGES, t, useLanguage } from '@/i18n';
import { BackLink } from '@/ui/layout';
import { Text } from '@/ui/primitives';
import { color, gutter, radius, space } from '@/ui/tokens';

/**
 * Language (mobile M7): English, O'zbekcha, Русский, Español, Türkçe, Қазақша. A tap switches the
 * whole app at once and is kept on this phone; it is not part of the Save bar. Ask NeWay answers in
 * the language the driver writes in.
 */
export default function Language() {
  const { lang } = useLanguage();
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: space.sm, paddingBottom: 120 }}>
        <BackLink label={t('Settings')} />
        <Text variant="hero" accessibilityRole="header">
          {t('Language')}
        </Text>
        <View style={{ marginTop: space.xl, backgroundColor: color.primaryTint, borderRadius: radius.xl, padding: space.xl, gap: space.xs }}>
          <Text style={{ fontSize: 40, lineHeight: 46, fontWeight: '800' }} tint={color.primaryInk}>
            {current.hello}
          </Text>
          <Text variant="small" tint={color.primaryInk}>
            {t('This is how NeWay talks to you.')}
          </Text>
        </View>
        <View style={{ marginTop: space.xl, backgroundColor: color.panel, borderRadius: radius.xl, paddingHorizontal: space.md }}>
          <LanguageList />
        </View>
        <Text variant="small" tint={color.text2} style={{ marginTop: space.lg }}>
          {t('The change applies at once and is kept on this phone. Ask NeWay answers in the language you write in.')}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
