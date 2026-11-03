import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type MobileNotificationsResponse } from '@/api/contract';
import { useSession } from '@/auth/session';
import { headerDate, headerTime } from '@/lib/clock';
import { APP_NAME } from '@/lib/config';

import { t } from '@/i18n/core';

import { ListRow, Sheet } from './controls';
import { Avatar, Icon, Logo, Text } from './primitives';
import { color, gutter, space } from './tokens';

export function useUnreadCount(enabled: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  const load = useCallback(() => {
    if (!enabled) return;
    api
      .get<MobileNotificationsResponse>(routes.notificationsHead)
      .then((v) => setCount(v?.unread ?? null))
      .catch(() => setCount(null));
  }, [enabled]);
  useFocusEffect(load);
  useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);
  return count;
}

function Clock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={{ alignItems: 'flex-end' }} accessibilityLabel={t('{date}, {time}, Eastern time', { date: headerDate(), time: headerTime() })}>
      <Text variant="caption" tint={color.text2}>
        {headerDate()}
      </Text>
      <Text variant="caption" tint={color.text2}>
        {headerTime()}
      </Text>
    </View>
  );
}

/**
 * The top bar from the sheets. Driver: logo, name, bell, the Eastern date and time. Office: logo,
 * name, the company switcher, bell and the person's initials.
 */
export function AppHeader() {
  const { account, shell, switchCompany } = useSession();
  const unread = useUnreadCount(Boolean(account));
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const companies = account?.companies ?? [];
  const base = shell === 'driver' ? '/driver' : '/office';

  const bell = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread ? t('Notifications, {count} unread', { count: unread }) : t('Notifications')}
      onPress={() => router.push(`${base}/notifications`)}
      hitSlop={8}
      style={{ padding: space.xs }}
    >
      <Icon name="bell-outline" size={22} tint={color.ink} />
      {unread ? (
        <View style={{ position: 'absolute', top: 3, right: 3, width: 8, height: 8, borderRadius: 4, backgroundColor: color.danger }} />
      ) : null}
    </Pressable>
  );

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: gutter,
        paddingVertical: space.sm,
        minHeight: 52,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: color.background,
      }}
    >
      <Logo />
      <Text variant="smallStrong" style={{ flexShrink: 1 }} numberOfLines={1}>
        {APP_NAME}
      </Text>
      <View style={{ flex: 1 }} />
      {shell === 'office' && account ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Company: {name}. Switch company', { name: account.companyName ?? t('current company') })}
            disabled={companies.length < 2}
            onPress={() => setSwitcherOpen(true)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 2, maxWidth: 150, paddingVertical: space.xs }}
          >
            <Text variant="captionStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {(account.companyName ?? '').toUpperCase()}
            </Text>
            {companies.length > 1 ? <Icon name="chevron-down" size={16} tint={color.ink} /> : null}
          </Pressable>
          {bell}
          <Pressable accessibilityRole="button" accessibilityLabel={t('Account')} onPress={() => router.push('/office/more')}>
            <Avatar name={account.name} size={32} />
          </Pressable>
          <Sheet visible={switcherOpen} title={t('Switch company')} onClose={() => setSwitcherOpen(false)}>
            {companies.map((c, i) => (
              <ListRow
                key={c.companyId}
                title={c.companyName}
                chevron={false}
                divider={i < companies.length - 1}
                right={
                  c.companyId === account.companyId ? (
                    <Icon name="check" size={22} tint={color.primary} />
                  ) : switching === c.companyId ? (
                    <Text variant="caption" tint={color.text2}>
                      {t('Switching…')}
                    </Text>
                  ) : null
                }
                onPress={async () => {
                  if (c.companyId === account.companyId) return setSwitcherOpen(false);
                  setSwitching(c.companyId);
                  try {
                    await switchCompany(c.companyId);
                    setSwitcherOpen(false);
                    router.replace('/');
                  } finally {
                    setSwitching(null);
                  }
                }}
              />
            ))}
          </Sheet>
        </>
      ) : (
        <>
          {account ? bell : null}
          <Clock />
        </>
      )}
    </View>
  );
}
