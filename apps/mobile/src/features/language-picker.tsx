import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { LANGUAGES, t, useLanguage, type Lang } from '@/i18n';
import { Sheet } from '@/ui/controls';
import { Icon, Text } from '@/ui/primitives';
import { color, radius, space } from '@/ui/tokens';

/** The languages as radio rows; a tap switches the whole app at once (no Save). */
export function LanguageList({ onPicked }: { onPicked?: (lang: Lang) => void }) {
  const { lang, setLang } = useLanguage();
  return (
    <View accessibilityRole="radiogroup">
      {LANGUAGES.map((l, i) => {
        const on = l.code === lang;
        return (
          <Pressable
            key={l.code}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${l.native} (${l.name})`}
            onPress={() => {
              onPicked?.(l.code);
              if (!on) setLang(l.code);
            }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 60, borderBottomWidth: i < LANGUAGES.length - 1 ? 1 : 0, borderColor: color.divider, opacity: pressed ? 0.7 : 1 })}
          >
            <View style={{ flex: 1 }}>
              <Text variant="rowTitle">{l.native}</Text>
              <Text variant="caption" tint={color.text3}>
                {l.name}
              </Text>
            </View>
            <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={24} tint={on ? color.primary : color.text3} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** A small pill with the current language; opens the list in a sheet (the login page). */
export function LanguageChip() {
  const { lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Language: {name}', { name: current.native })}
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 36, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: pressed ? color.subtlePressed : color.panel, borderWidth: 1, borderColor: color.border })}
      >
        <Icon name="translate" size={16} tint={color.primary} />
        <Text variant="captionStrong" tint={color.ink}>
          {current.native}
        </Text>
        <Icon name="chevron-down" size={16} tint={color.text3} />
      </Pressable>
      <Sheet visible={open} title={t('Language')} onClose={() => setOpen(false)}>
        <LanguageList onPicked={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
