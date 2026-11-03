import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
  StyleSheet,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/i18n/core';

import { Divider, Icon, Text, fontFor, type IconName } from './primitives';
import { color, elevation, gutter, radius, space, touch } from './tokens';

// ------------------------------------------------------------------------------------- Button

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  style,
  compact,
}: {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'outline' | 'link';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const primary = variant === 'primary';
  const link = variant === 'link';
  const inactive = disabled || loading;
  const fg = primary ? color.onPrimary : link ? color.link : color.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: link ? 40 : compact ? 44 : touch,
          borderRadius: 12,
          paddingHorizontal: link ? 0 : compact ? space.sm : space.lg,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: link ? 'flex-start' : 'center',
          gap: space.sm,
          backgroundColor: primary ? (pressed ? color.primaryPressed : color.primary) : pressed && !link ? color.subtle : 'transparent',
          borderWidth: variant === 'outline' ? 1 : 0,
          borderColor: color.primary,
          opacity: inactive && !loading ? 0.45 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={20} tint={fg} /> : null}
      <Text variant={link || compact ? 'smallStrong' : 'bodyStrong'} tint={fg} numberOfLines={compact ? 1 : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------------------------ ListRow

export function ListRow({
  title,
  subtitle,
  meta,
  left,
  right,
  onPress,
  chevron = Boolean(onPress),
  divider = true,
  style,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  divider?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const body = (
    <View style={[{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: space.md, gap: space.md }, style]}>
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === 'string' ? <Text variant="rowTitle">{title}</Text> : title}
        {typeof subtitle === 'string' ? (
          <Text variant="small" tint={color.text2}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
        {typeof meta === 'string' ? (
          <Text variant="caption" tint={color.text3}>
            {meta}
          </Text>
        ) : (
          meta
        )}
      </View>
      {right}
      {chevron ? <Icon name="chevron-right" size={22} tint={color.text3} /> : null}
    </View>
  );
  return (
    <View>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => ({ backgroundColor: pressed ? color.subtle : 'transparent' })}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {divider ? <Divider /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------ SegmentedTabs

export interface SegmentOption<K extends string> {
  key: K;
  label: string;
}

/**
 * Two looks from the sheets: `filled` (Trips: navy active segment in a gray track) and
 * `underline` (office tabs, Pre-trip Truck / Trailer).
 */
export function SegmentedTabs<K extends string>({
  options,
  value,
  onChange,
  variant = 'filled',
}: {
  options: SegmentOption<K>[];
  value: K;
  onChange: (key: K) => void;
  variant?: 'filled' | 'underline';
}) {
  if (variant === 'underline') {
    // More than four tabs do not fit a phone's width: they scroll sideways at their own width.
    const scrolls = options.length > 4;
    const tabs = (
      <View style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.divider, minWidth: scrolls ? undefined : '100%' }}>
        {options.map((o) => {
          const active = o.key === value;
          return (
            <Pressable
              key={o.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(o.key)}
              style={scrolls ? { alignItems: 'center', paddingVertical: space.md, paddingHorizontal: space.md, minHeight: 44 } : { flex: 1, alignItems: 'center', paddingVertical: space.md, minHeight: 44 }}
            >
              <Text variant={active ? 'smallStrong' : 'small'} tint={active ? color.primary : color.text2}>
                {o.label}
              </Text>
              <View
                style={{
                  position: 'absolute',
                  bottom: -StyleSheet.hairlineWidth,
                  left: space.md,
                  right: space.md,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: active ? color.primary : 'transparent',
                }}
              />
            </Pressable>
          );
        })}
      </View>
    );
    return scrolls ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
        {tabs}
      </ScrollView>
    ) : (
      tabs
    );
  }
  return (
    <View style={{ flexDirection: 'row', backgroundColor: color.subtle, borderRadius: radius.md, padding: 3 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.key)}
            style={[
              {
                flex: 1,
                minHeight: 40,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.sm,
                backgroundColor: active ? color.primary : 'transparent',
              },
              active ? elevation.overlay : null,
              active ? { shadowOpacity: 0.12, shadowRadius: 4, elevation: 2 } : null,
            ]}
          >
            <Text variant="smallStrong" tint={active ? color.onPrimary : color.ink}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------------------------- Fields

function FieldFrame({
  label,
  error,
  hint,
  children,
}: {
  label?: string;
  error?: string | null;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space.xs }}>
      {label ? (
        <Text variant="smallStrong" tint={color.text2}>
          {label}
        </Text>
      ) : null}
      {children}
      {error ? (
        <Text variant="small" tint={color.danger} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tint={color.text3}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const fieldBox = (focused: boolean, error: boolean, readOnly: boolean): ViewStyle => ({
  minHeight: touch,
  borderWidth: 1,
  borderColor: error ? color.danger : focused ? color.focus : color.border,
  borderRadius: 12,
  backgroundColor: readOnly ? color.subtle : color.field,
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: space.md,
  gap: space.sm,
});

export function TextField({
  label,
  error,
  hint,
  icon,
  readOnly,
  right,
  multiline,
  ...input
}: TextInputProps & {
  label?: string;
  error?: string | null;
  hint?: string | null;
  icon?: IconName;
  readOnly?: boolean;
  right?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <FieldFrame label={label} error={error} hint={hint}>
      <View style={[fieldBox(focused, Boolean(error), Boolean(readOnly)), multiline ? { alignItems: 'flex-start', paddingVertical: space.sm } : null]}>
        {icon ? <Icon name={icon} size={20} tint={color.text2} /> : null}
        <TextInput
          {...input}
          multiline={multiline}
          editable={!readOnly && input.editable !== false}
          accessibilityLabel={label ?? input.placeholder}
          placeholderTextColor={color.text3}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          style={[
            { flex: 1, fontSize: 16, color: color.ink, paddingVertical: space.sm, minHeight: multiline ? 88 : undefined, ...fontFor('500') },
            multiline ? { textAlignVertical: 'top' } : null,
            // The web build draws its own focus ring around the frame instead of the input's.
            { outlineStyle: 'none' } as object,
          ]}
        />
        {right}
      </View>
    </FieldFrame>
  );
}

/** A bottom sheet with a title; used by Select, DateField and the company switcher. */
export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel={t('Close')} onPress={onClose} style={{ flex: 1, backgroundColor: color.overlay }} />
      <View
        style={[
          {
            backgroundColor: color.background,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingBottom: insets.bottom + space.md,
            maxHeight: '75%',
          },
          elevation.overlay,
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: gutter, paddingVertical: space.md }}>
          <Text variant="heading" style={{ flex: 1 }}>
            {title}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose} hitSlop={12} style={{ padding: space.xs }}>
            <Icon name="close" size={22} tint={color.text2} />
          </Pressable>
        </View>
        <Divider />
        <ScrollView contentContainerStyle={{ paddingHorizontal: gutter }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}

export interface SelectOption<K extends string> {
  value: K;
  label: string;
  description?: string;
}

export function Select<K extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = t('Choose…'),
  error,
  icon,
}: {
  label?: string;
  value: K | null;
  options: SelectOption<K>[];
  onChange: (value: K) => void;
  placeholder?: string;
  error?: string | null;
  icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <FieldFrame label={label} error={error}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${selected?.label ?? placeholder}` : selected?.label ?? placeholder}
        onPress={() => setOpen(true)}
        style={fieldBox(open, Boolean(error), false)}
      >
        {icon ? <Icon name={icon} size={20} tint={color.text2} /> : null}
        <Text style={{ flex: 1 }} tint={selected ? color.ink : color.text3}>
          {selected?.label ?? placeholder}
        </Text>
        <Icon name="chevron-down" size={22} tint={color.text2} />
      </Pressable>
      <Sheet visible={open} title={label ?? t('Choose')} onClose={() => setOpen(false)}>
        {options.map((o, i) => (
          <ListRow
            key={o.value}
            title={o.label}
            subtitle={o.description}
            chevron={false}
            divider={i < options.length - 1}
            right={o.value === value ? <Icon name="check" size={22} tint={color.primary} /> : null}
            onPress={() => {
              onChange(o.value);
              setOpen(false);
            }}
          />
        ))}
      </Sheet>
    </FieldFrame>
  );
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseDay(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function formatDay(day: string): string {
  const [y, m, d] = parseDay(day);
  return `${t(MONTH_NAMES[m - 1]!).slice(0, 3)} ${d}, ${y}`;
}

/**
 * A calendar day (YYYY-MM-DD, a business date — no time, no zone). `today` comes from the
 * Eastern business clock, passed in by the screen.
 */
export function DateField({
  label,
  value,
  onChange,
  today,
  error,
}: {
  label?: string;
  value: string | null;
  onChange: (day: string) => void;
  today: string;
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => (value ?? today).slice(0, 7));
  const [cy, cm] = cursor.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(cy, cm - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const cells: Array<string | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => `${cursor}-${String(i + 1).padStart(2, '0')}`),
  ];
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(cy, cm - 1 + delta, 1));
    setCursor(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  return (
    <FieldFrame label={label} error={error}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={fieldBox(open, Boolean(error), false)}>
        <Icon name="calendar-blank-outline" size={20} tint={color.text2} />
        <Text style={{ flex: 1 }} tint={value ? color.ink : color.text3}>
          {value ? formatDay(value) : t('Choose a date')}
        </Text>
      </Pressable>
      <Sheet visible={open} title={label ?? t('Date')} onClose={() => setOpen(false)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.md }}>
          <Pressable accessibilityLabel={t('Previous month')} onPress={() => shift(-1)} style={{ padding: space.sm }}>
            <Icon name="chevron-left" />
          </Pressable>
          <Text variant="subheading" style={{ flex: 1, textAlign: 'center' }}>
            {t(MONTH_NAMES[cm - 1]!)} {cy}
          </Text>
          <Pressable accessibilityLabel={t('Next month')} onPress={() => shift(1)} style={{ padding: space.sm }}>
            <Icon name="chevron-right" />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {WEEKDAYS.map((w) => (
            <View key={w} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingVertical: space.xs }}>
              <Text variant="caption" tint={color.text3}>
                {t(w)}
              </Text>
            </View>
          ))}
          {cells.map((day, i) => {
            const selected = day === value;
            const isToday = day === today;
            return (
              <View key={day ?? `pad${i}`} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2 }}>
                {day ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={formatDay(day)}
                    onPress={() => {
                      onChange(day);
                      setOpen(false);
                    }}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: selected ? color.primary : 'transparent',
                      borderWidth: isToday && !selected ? 1 : 0,
                      borderColor: color.primary,
                    }}
                  >
                    <Text variant="small" tint={selected ? color.onPrimary : color.ink}>
                      {Number(day.slice(8))}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      </Sheet>
    </FieldFrame>
  );
}

// ---------------------------------------------------------------------------------- WeekPicker

/** ‹ Oct 19 – 25, 2026 › on a gray bar (sheet 05). */
export function WeekPicker({
  label,
  onPrev,
  onNext,
  nextDisabled,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: color.subtle, borderRadius: radius.md, minHeight: touch }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Previous week')} onPress={onPrev} style={{ padding: space.md }}>
        <Icon name="chevron-left" size={24} />
      </Pressable>
      <Text variant="bodyStrong" style={{ flex: 1, textAlign: 'center' }}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Next week')}
        accessibilityState={{ disabled: Boolean(nextDisabled) }}
        disabled={nextDisabled}
        onPress={onNext}
        style={{ padding: space.md, opacity: nextDisabled ? 0.3 : 1 }}
      >
        <Icon name="chevron-right" size={24} />
      </Pressable>
    </View>
  );
}
