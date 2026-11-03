import { router } from 'expo-router';
import { Pressable, View, StyleSheet } from 'react-native';

import type { OfficeAttentionItem } from '@/api/contract';
import { now } from '@/lib/clock';
import { hrefFor } from '@/lib/deep-link';
import { ageSince } from '@/lib/format';
import { Icon, StatusPill, StatusSymbol, Text } from '@/ui/primitives';
import { t, tn } from '@/i18n';
import { color, radius, space } from '@/ui/tokens';

import { severityTone } from './common';

/** "N needs attention ›" — the red strip of sheet 13; a tap opens or closes the full list. */
export function AttentionStrip({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.dangerBg, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 44 }}
    >
      <StatusSymbol tone="danger" size={22} />
      <Text variant="bodyStrong" style={{ flex: 1 }}>
        {tn(count, '{count} needs attention', '{count} need attention')}
      </Text>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={22} tint={color.text2} />
    </Pressable>
  );
}

/** One attention line: symbol, pill, title, subtitle and how long it has been a problem. */
export function AttentionRow({ item, last }: { item: OfficeAttentionItem; last?: boolean }) {
  const tone = severityTone(item.severity);
  const age = ageSince(item.since, now().getTime());
  const ageText = age ? (item.kind === 'late_pickup' ? t('{age} late', { age }) : t('{age} ago', { age })) : null;
  // The server's words are English; the known ones are translated.
  const label = t(item.label);
  const href = hrefFor('office', item.target);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${item.title}`}
      disabled={!href}
      onPress={() => href && router.push(href)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space.md,
        paddingVertical: space.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: pressed ? color.subtle : 'transparent',
      })}
    >
      <View style={{ paddingTop: 2 }}>
        <StatusSymbol tone={tone} size={24} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <StatusPill tone={tone} label={label} />
        <Text variant="smallStrong">{item.title}</Text>
        {item.subtitle ? (
          <Text variant="caption" tint={color.text2}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
        {ageText ? (
          <Text variant="captionStrong" tint={tone === 'danger' ? color.danger : color.text2}>
            {ageText}
          </Text>
        ) : (
          <View />
        )}
        {href ? <Icon name="chevron-right" size={20} tint={color.text3} /> : null}
      </View>
    </Pressable>
  );
}

export function AttentionList({ items }: { items: OfficeAttentionItem[] }) {
  return (
    <View>
      {items.map((a, i) => (
        <AttentionRow key={`${a.kind}:${a.target?.id ?? a.title}:${i}`} item={a} last={i === items.length - 1} />
      ))}
    </View>
  );
}
