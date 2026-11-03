import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { routes, type FleetBreakdown, type FleetBreakdownList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { BREAKDOWN_TONE } from '@/features/office/breakdowns';
import { BREAKDOWN_STATUS_LABEL, type BreakdownStatus } from '@neway/shared/mobile/breakdowns';
import { now } from '@/lib/clock';
import { ageSince } from '@/lib/format';
import { Screen, Section } from '@/ui/layout';
import { Icon, StatusPill, Text } from '@/ui/primitives';
import { StatTile } from '@/ui/sheets';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space } from '@/ui/tokens';

const FILTERS: Array<{ key: 'all' | BreakdownStatus; label: string }> = [
  { key: 'all', label: 'Open' },
  { key: 'received', label: 'New' },
  { key: 'in_repair', label: 'In repair' },
];

function CaseRow({ c, last }: { c: FleetBreakdown; last: boolean }) {
  const age = ageSince(c.createdAt, now().getTime());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${c.number}, ${t(c.statusLabel)}`}
      onPress={() => router.push(`/office/breakdown/${c.id}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space.md,
        paddingVertical: space.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: pressed ? color.subtle : 'transparent',
      })}
    >
      <Icon name={c.category === 'trailer' || c.category === 'reefer' ? 'truck-trailer' : 'truck'} size={26} tint={color.ink} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="rowTitle">
          {c.truck ? t('Unit {number}', { number: c.truck.unitNumber }) : c.trailer ? t('Trailer {number}', { number: c.trailer.unitNumber }) : c.number} · {t(c.categoryLabel)}
        </Text>
        <Text variant="caption" tint={color.text2} numberOfLines={1}>
          {[c.number, c.driver?.name, c.location?.text].filter(Boolean).join(' · ')}
        </Text>
        {c.responsible || c.shopName ? (
          <Text variant="caption" tint={color.text3} numberOfLines={1}>
            {[c.responsible?.name, c.shopName].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <StatusPill tone={BREAKDOWN_TONE[c.status]} label={t(c.statusLabel || BREAKDOWN_STATUS_LABEL[c.status])} />
        {age ? (
          <Text variant="caption" tint={color.text2}>
            {t('{age} ago', { age })}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={20} tint={color.text3} />
    </Pressable>
  );
}

/** Sheet 20 — breakdown cases drivers reported (GET /fleet/breakdowns?open=true, maintenance.view). */
export default function FleetWorkspace() {
  const list = useResource<FleetBreakdownList>(routes.fleetBreakdowns(true));
  const [filter, setFilter] = useState<'all' | BreakdownStatus>('all');
  return (
    <Screen back title={t('Fleet')} subtitle={t('Keep equipment on the road and downtime under control.')} onRefresh={list.reload}>
      <ResourceView resource={list} what={t('Breakdown cases')}>
        {(l) => {
          const rows = filter === 'all' ? l.breakdowns : l.breakdowns.filter((b) => b.status === filter);
          const count = (k: 'all' | BreakdownStatus) => (k === 'all' ? l.counts.open : (l.counts.byStatus[k] ?? 0));
          return (
            <>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {FILTERS.map((f) => (
                  <StatTile
                    key={f.key}
                    value={count(f.key)}
                    label={f.key === 'all' ? t('Open cases') : t(f.label)}
                    tone={f.key === 'received' ? 'warning' : f.key === 'in_repair' ? 'info' : 'neutral'}
                    selected={filter === f.key}
                    onPress={() => setFilter(f.key)}
                  />
                ))}
              </View>
              <Section title={t('Cases ({count})', { count: rows.length })}>
                {rows.length ? (
                  rows.map((c, i) => <CaseRow key={c.id} c={c} last={i === rows.length - 1} />)
                ) : (
                  <EmptyState compact icon="truck-check-outline" title={t('No open breakdown cases')} body={t('When a driver reports a breakdown from the app, it appears here.')} />
                )}
              </Section>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
