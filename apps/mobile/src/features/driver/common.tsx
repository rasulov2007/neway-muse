import { useState } from 'react';
import { ActivityIndicator, Pressable, View, StyleSheet } from 'react-native';

import type { DriverLocation } from '@neway/shared/mobile/breakdowns';
import { inEastern } from '@/lib/clock';
import { captureLocation, manualLocation } from '@/lib/location';
import { TextField } from '@/ui/controls';
import { Icon, StatusSymbol, Text } from '@/ui/primitives';
import { color, radius, space, type StatusTone } from '@/ui/tokens';
import { t } from '@/i18n';

/** A row of equal choices (who paid, report kind): navy outline on the chosen one. */
export function ChoiceRow<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ key: K; label: string }>;
  value: K;
  onChange: (key: K) => void;
  label?: string;
}) {
  return (
    <View style={{ gap: space.xs }}>
      {label ? (
        <Text variant="smallStrong" tint={color.text2}>
          {label}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => onChange(o.key)}
              style={{
                flex: 1,
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.md,
                borderWidth: on ? 1.5 : 1,
                borderColor: on ? color.primary : color.border,
                backgroundColor: on ? color.subtle : color.background,
                paddingHorizontal: space.xs,
              }}
            >
              <Text variant={on ? 'smallStrong' : 'small'} tint={on ? color.primary : color.text2} numberOfLines={1}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A read-only prefilled box with an icon (Unit / Trailer / Load on sheet 08). */
export function ReadOnlyBox({ label, icon, value }: { label: string; icon: React.ComponentProps<typeof Icon>['name']; value: string | null }) {
  return (
    <View style={{ flex: 1, gap: space.xs }}>
      <Text variant="smallStrong" tint={color.text2}>
        {label}
      </Text>
      <View style={{ minHeight: 48, borderWidth: 1, borderColor: color.border, borderRadius: radius.md, backgroundColor: color.subtle, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md }}>
        <Icon name={icon} size={20} tint={color.text2} />
        <Text tint={value ? color.ink : color.text3} numberOfLines={1} style={{ flex: 1 }}>
          {value ?? t('None')}
        </Text>
      </View>
    </View>
  );
}

/**
 * Location with source and capture time: the crosshairs button reads GPS (permission asked then);
 * typing switches the source to manual. A refused permission says so and leaves the text field.
 */
export function LocationField({
  value,
  onChange,
  label,
  optional,
}: {
  value: DriverLocation | null;
  onChange: (value: DriverLocation | null) => void;
  label?: string;
  optional?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const locate = async () => {
    setBusy(true);
    setMessage(null);
    const result = await captureLocation();
    setBusy(false);
    if (result.ok) onChange(result.location);
    else setMessage(result.message);
  };
  const source =
    value && value.text
      ? value.source === 'gps'
        ? t('GPS · captured {time}', { time: value.captured_at ? inEastern(value.captured_at) : '' })
        : t('Typed by you')
      : null;
  return (
    <View style={{ gap: space.xs }}>
      <TextField
        label={optional ? t('{label} (optional)', { label: label ?? t('Location') }) : (label ?? t('Location'))}
        icon="map-marker-outline"
        placeholder={t('City, state or highway exit')}
        value={value?.text ?? ''}
        onChangeText={(t) => onChange(t.trim() ? manualLocation(t) : null)}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel={t('Use my location')} onPress={locate} hitSlop={10} disabled={busy}>
            {busy ? <ActivityIndicator size="small" color={color.text2} /> : <Icon name="crosshairs-gps" size={22} tint={color.primary} />}
          </Pressable>
        }
      />
      {source ? (
        <Text variant="caption" tint={color.text3}>
          {source}
        </Text>
      ) : null}
      {message ? (
        <View style={{ flexDirection: 'row', gap: space.xs, alignItems: 'center' }}>
          <StatusSymbol tone="warning" size={14} />
          <Text variant="caption" tint={color.warning} style={{ flex: 1 }}>
            {message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A checkbox row ("Keys handed over"). */
export function CheckRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.divider }}
    >
      <Icon name={value ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} tint={value ? color.primary : color.text3} />
      <Text style={{ flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

/** Dollars typed by the driver ("35", "35.5", "$1,200.00") → cents; null when not a positive amount. */
export function dollarsToCents(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return cents > 0 ? cents : null;
}

/** Tones for the request words (INTEGRATION.md family table; unknown words stay neutral). */
export function requestTone(kind: string, status: string): StatusTone {
  switch (kind) {
    case 'breakdown':
      return status === 'received' ? 'warning' : status === 'ready' ? 'success' : status === 'closed' ? 'neutral' : 'moving';
    case 'reimbursement':
      return status === 'rejected' ? 'danger' : status === 'paid' || status === 'approved' || status === 'added_to_settlement' ? 'success' : status === 'company_expense' ? 'neutral' : 'warning';
    case 'care':
      return status === 'resolved' ? 'success' : status === 'in_progress' ? 'moving' : 'warning';
    case 'vacation':
      return status === 'requested' ? 'warning' : status === 'approved' ? 'moving' : status === 'rejected' ? 'danger' : status === 'started' ? 'success' : 'neutral';
    case 'referral':
      return status === 'hired' ? 'success' : status === 'closed' ? 'neutral' : status === 'received' ? 'warning' : 'moving';
    default:
      return 'info';
  }
}
