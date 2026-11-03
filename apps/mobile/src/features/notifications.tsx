import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type MobileNotification, type MobileNotificationsResponse } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { notificationGroupOf } from '@neway/shared/mobile/notifications';
import { t } from '@/i18n/core';
import { relativeStamp } from '@/lib/clock';
import { hrefFor, type ShellName } from '@/lib/deep-link';
import { Button } from '@/ui/controls';
import { Section } from '@/ui/layout';
import { Icon, StatusSymbol, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, radius, space, type StatusTone } from '@/ui/tokens';

function severityTone(severity: string): StatusTone {
  switch (severity) {
    case 'critical':
    case 'error':
    case 'urgent':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'success':
      return 'success';
    default:
      return 'info';
  }
}

type Filter = 'all' | 'action' | 'update';

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
        borderColor: active ? color.primary : color.border,
        backgroundColor: color.background,
        paddingHorizontal: space.xs,
      }}
    >
      <Text variant={active ? 'captionStrong' : 'caption'} tint={active ? color.primary : color.text2} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Sheet 24: Action required (warning / critical) and Updates, from GET /mobile/notifications —
 * only the rows addressed to this person. A tap marks it read and opens the record, which the
 * screen reads again with this session (permissions are checked there, not here).
 */
export function NotificationsList({ shell }: { shell: ShellName }) {
  const resource = useResource<MobileNotificationsResponse>(routes.notifications);
  const [filter, setFilter] = useState<Filter>('all');
  const [marking, setMarking] = useState(false);
  return (
    <ResourceView resource={resource} what={t('Notifications')}>
      {({ notifications: items, unread }) => {
        if (!items.length) return <EmptyState icon="bell-check-outline" title={t('No notifications')} body={t('When something needs you, it shows up here.')} />;
        const groupOf = (n: MobileNotification) => n.group ?? notificationGroupOf(n.severity);
        const action = items.filter((n) => groupOf(n) === 'action');
        const updates = items.filter((n) => groupOf(n) === 'update');
        const row = (n: MobileNotification, i: number, list: MobileNotification[]) => {
          const tone = severityTone(n.severity);
          const href = hrefFor(shell, n.target);
          return (
            <View key={n.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={n.readAt ? n.title : t('Unread. {title}', { title: n.title })}
                onPress={() => {
                  if (!n.readAt) void api.post(routes.notificationRead(n.id)).then(resource.reload, () => undefined);
                  if (href) router.push(href);
                }}
                style={({ pressed }) => ({ flexDirection: 'row', gap: space.sm, paddingVertical: space.md, backgroundColor: pressed ? color.subtle : 'transparent' })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.xs, paddingTop: 3 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, marginTop: 6, backgroundColor: n.readAt ? 'transparent' : tone === 'danger' ? color.danger : tone === 'warning' ? color.warningIcon : color.info }} />
                  <StatusSymbol tone={tone} size={24} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant={n.readAt ? 'small' : 'smallStrong'}>{n.title}</Text>
                  {n.body ? (
                    <Text variant="caption" tint={color.text2}>
                      {n.body}
                    </Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end', gap: space.xs }}>
                  <Text variant="caption" tint={color.text3}>
                    {relativeStamp(n.createdAt)}
                  </Text>
                  {href ? <Icon name="chevron-right" size={18} tint={color.text3} /> : null}
                </View>
              </Pressable>
              {i < list.length - 1 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.divider }} /> : null}
            </View>
          );
        };
        return (
          <>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <FilterChip label={t('All ({count})', { count: items.length })} active={filter === 'all'} onPress={() => setFilter('all')} />
              <FilterChip label={t('Action required ({count})', { count: action.length })} active={filter === 'action'} onPress={() => setFilter('action')} />
              <FilterChip label={t('Updates ({count})', { count: updates.length })} active={filter === 'update'} onPress={() => setFilter('update')} />
            </View>
            {filter !== 'update' ? (
              <Section title={t('Action required ({count})', { count: action.length })}>
                {action.length ? action.map(row) : <Text variant="small" tint={color.text2}>{t('Nothing needs you right now.')}</Text>}
              </Section>
            ) : null}
            {filter !== 'action' ? (
              <Section title={t('Updates ({count})', { count: updates.length })}>
                {updates.length ? updates.map(row) : <Text variant="small" tint={color.text2}>{t('No updates.')}</Text>}
              </Section>
            ) : null}
            {unread ? (
              <Button
                style={{ marginTop: space.lg }}
                variant="outline"
                icon="check-all"
                label={t('Mark all as read')}
                loading={marking}
                onPress={async () => {
                  setMarking(true);
                  try {
                    await api.post(routes.notificationsReadAll);
                    resource.reload();
                  } catch {
                    // the list stays as it is
                  } finally {
                    setMarking(false);
                  }
                }}
              />
            ) : null}
          </>
        );
      }}
    </ResourceView>
  );
}
