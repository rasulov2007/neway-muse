import { useEffect, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { t } from '@/i18n/core';

import { Button, Sheet, TextField } from './controls';
import { Icon, StatusSymbol, Text } from './primitives';
import { color, radius, space, type StatusTone } from './tokens';

/**
 * Asks for the words a decision needs: a rejection, a correction request or "Request changes"
 * always carries a reason the other person reads (at least 3 characters); an approval may carry an
 * optional note.
 */
export function ReasonSheet({
  visible,
  title,
  body,
  label = t('Reason'),
  placeholder = t('Say what needs to change'),
  confirmLabel,
  required = true,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  body?: string;
  label?: string;
  placeholder?: string;
  confirmLabel: string;
  required?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (visible) setText('');
  }, [visible]);
  const ok = !required || text.trim().length >= 3;
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <View style={{ gap: space.md, paddingVertical: space.md }}>
        {body ? (
          <Text variant="small" tint={color.text2}>
            {body}
          </Text>
        ) : null}
        <TextField label={required ? label : t('{label} (optional)', { label })} value={text} onChangeText={(v) => setText(v.slice(0, 500))} placeholder={placeholder} multiline hint={`${text.length}/500`} />
        {error ? (
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
            <StatusSymbol tone="danger" size={16} />
            <Text variant="small" tint={color.danger} style={{ flex: 1 }}>
              {error}
            </Text>
          </View>
        ) : null}
        <Button label={confirmLabel} disabled={!ok} loading={busy} onPress={() => onConfirm(text.trim())} />
        {required && !ok ? (
          <Text variant="caption" tint={color.text3} style={{ textAlign: 'center' }}>
            {t('A reason is required.')}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

/** A number card (sheets 19 / 21 / 23): big number in the tone's colour, label under it. */
export function StatTile({ value, label, tone = 'neutral', onPress, selected }: { value: string | number | null; label: string; tone?: StatusTone; onPress?: () => void; selected?: boolean }) {
  const bg = tone === 'danger' ? color.dangerBg : tone === 'warning' ? color.warningBg : tone === 'success' || tone === 'moving' ? color.successBg : tone === 'info' ? color.infoBg : color.subtle;
  const fg = tone === 'danger' ? color.danger : tone === 'warning' ? color.warning : tone === 'success' || tone === 'moving' ? color.success : tone === 'info' ? color.info : color.ink;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${value ?? ''} ${label}`}
      accessibilityState={onPress ? { selected: Boolean(selected) } : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 76,
        borderRadius: radius.lg,
        backgroundColor: bg,
        padding: space.md,
        gap: 2,
        borderWidth: selected ? 1.5 : 0,
        borderColor: fg,
      }}
    >
      <Text variant="title" tint={fg}>
        {value === null ? '…' : value}
      </Text>
      <Text variant="caption" tint={color.ink}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "1 of 4  ‹ ›" — walks one item at a time through a queue. */
export function Pager({ index, total, onChange }: { index: number; total: number; onChange: (index: number) => void }) {
  if (total <= 0) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
      <Text variant="caption" tint={color.text2}>
        {t('{n} of {total}', { n: index + 1, total })}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Previous')} disabled={index <= 0} onPress={() => onChange(index - 1)} hitSlop={8} style={{ padding: space.xs, opacity: index <= 0 ? 0.3 : 1 }}>
        <Icon name="chevron-left" size={20} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Next')} disabled={index >= total - 1} onPress={() => onChange(index + 1)} hitSlop={8} style={{ padding: space.xs, opacity: index >= total - 1 ? 0.3 : 1 }}>
        <Icon name="chevron-right" size={20} />
      </Pressable>
    </View>
  );
}

/** Three or four counters in a row, split by hairlines (sheet 13 footer). */
export function CounterRow({ counters }: { counters: Array<{ key: string; label: string; value: number | string }> }) {
  if (!counters.length) return null;
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.divider, paddingTop: space.md, marginTop: space.md }}>
      {counters.map((c, i) => (
        <View key={c.key} style={{ flex: 1, alignItems: 'center', gap: space.xs, borderLeftWidth: i ? StyleSheet.hairlineWidth : 0, borderColor: color.divider, paddingHorizontal: space.xs }}>
          <Text variant="caption" tint={color.text2} style={{ textAlign: 'center' }} numberOfLines={2}>
            {c.label}
          </Text>
          <Text variant="heading">{c.value}</Text>
        </View>
      ))}
    </View>
  );
}
