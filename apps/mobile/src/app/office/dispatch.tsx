import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { routes, type OfficeDispatch, type OfficeDispatchRow, type OfficeDispatchTab } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { unitStatus } from '@/features/office/common';
import { loadStatus } from '@/features/loads';
import { SegmentedTabs, TextField } from '@/ui/controls';
import { Screen } from '@/ui/layout';
import { Icon, StatusPill, Text, type IconName } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space } from '@/ui/tokens';

const ICON: Record<OfficeDispatchTab, IconName> = { trucks: 'truck', drivers: 'account', loads: 'package-variant-closed' };
const LOAD_CODES = new Set(['booked', 'assigned', 'dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading', 'delivered', 'closed', 'cancelled', 'tonu']);

function statusOf(tab: OfficeDispatchTab, status: string) {
  return tab === 'loads' || LOAD_CODES.has(status) ? loadStatus(status) : unitStatus(status);
}

function DispatchRow({ row, tab, last }: { row: OfficeDispatchRow; tab: OfficeDispatchTab; last: boolean }) {
  const raw = statusOf(tab, row.status);
  const status = { ...raw, label: t(raw.label) };
  const target = row.loadId ?? (tab === 'loads' ? row.id : null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${status.label}`}
      disabled={!target}
      onPress={() => target && router.push(`/office/load/${target}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: pressed ? color.subtle : 'transparent',
      })}
    >
      <Icon name={ICON[tab]} size={28} tint={color.ink} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="rowTitle">{row.title}</Text>
        {row.subtitle ? (
          <Text variant="caption" tint={color.text2}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4, maxWidth: '50%' }}>
        <StatusPill tone={status.tone} label={status.label} />
        {row.lane ? (
          <Text variant="caption" tint={color.text2} numberOfLines={2} style={{ textAlign: 'right' }}>
            {row.lane}
          </Text>
        ) : null}
        {row.loadNumber && tab !== 'loads' ? (
          <Text variant="caption" tint={color.text3}>
            {t('Load {number}', { number: row.loadNumber })}
          </Text>
        ) : null}
      </View>
      {target ? <Icon name="chevron-right" size={20} tint={color.text3} /> : <View style={{ width: 20 }} />}
    </Pressable>
  );
}

/** Sheet 14 — trucks, drivers and loads on the move (GET /office/dispatch?tab=&q=). */
export default function Dispatch() {
  const [tab, setTab] = useState<OfficeDispatchTab>('trucks');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState<'active' | 'unassigned'>('active');
  useEffect(() => {
    const id = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);
  const board = useResource<OfficeDispatch>(routes.officeDispatch(tab, q));

  return (
    <Screen back title={t('Dispatch')} onRefresh={board.reload}>
      <SegmentedTabs
        variant="underline"
        options={[
          { key: 'trucks', label: t('Trucks') },
          { key: 'drivers', label: t('Drivers') },
          { key: 'loads', label: t('Loads') },
        ]}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setList('active');
        }}
      />
      <View style={{ marginTop: space.md }}>
        <TextField icon="magnify" placeholder={t('Search by unit, driver or load number')} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} />
      </View>
      <ResourceView resource={board} what={t('Dispatch')}>
        {(b) => {
          const rows = list === 'active' ? b.active : b.unassigned;
          return (
            <>
              <View style={{ marginTop: space.sm }}>
                <SegmentedTabs
                  variant="underline"
                  options={[
                    { key: 'active', label: t('Active ({count})', { count: b.counts.active }) },
                    { key: 'unassigned', label: t('Unassigned ({count})', { count: b.counts.unassigned }) },
                  ]}
                  value={list}
                  onChange={setList}
                />
              </View>
              {rows.length ? (
                rows.map((r, i) => <DispatchRow key={r.id} row={r} tab={tab} last={i === rows.length - 1} />)
              ) : (
                <EmptyState
                  compact
                  icon={tab === 'drivers' ? 'account-outline' : 'truck-outline'}
                  title={
                    q
                      ? t('Nothing matches “{q}”', { q })
                      : list === 'active'
                        ? { trucks: t('No active trucks'), drivers: t('No active drivers'), loads: t('No active loads') }[tab]
                        : { trucks: t('No unassigned trucks'), drivers: t('No unassigned drivers'), loads: t('No unassigned loads') }[tab]
                  }
                />
              )}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
