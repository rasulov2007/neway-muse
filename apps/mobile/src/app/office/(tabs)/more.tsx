import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';

import type { OfficeWorkspace } from '@/api/contract';
import { AccountSection, SignOutRow } from '@/features/components';
import { useOfficeMe } from '@/features/office/common';
import { ListRow } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { Icon, Text, type IconName } from '@/ui/primitives';
import { t } from '@/i18n';
import { color } from '@/ui/tokens';

const WORKSPACES: Array<{ key: OfficeWorkspace; href: Href; icon: IconName; title: string }> = [
  { key: 'dispatch', href: '/office/dispatch', icon: 'truck-fast-outline', title: 'Dispatch' },
  { key: 'safety', href: '/office/safety', icon: 'shield-check-outline', title: 'Safety' },
  { key: 'fleet', href: '/office/fleet', icon: 'wrench-outline', title: 'Fleet' },
  { key: 'accounting', href: '/office/accounting', icon: 'calculator-variant-outline', title: 'Accounting' },
  { key: 'recruiting', href: '/office/recruiting', icon: 'account-plus-outline', title: 'Recruiting' },
  { key: 'owner', href: '/office/owner', icon: 'chart-box-outline', title: 'Owner overview' },
];

export default function OfficeMore() {
  const me = useOfficeMe();
  const allowed = me.status === 'ready' ? WORKSPACES.filter((w) => me.data.workspaces.includes(w.key)) : [];
  return (
    <Screen title={t('More')}>
      <AccountSection shell="office" />
      <Section title={t('App')}>
        <ListRow left={<Icon name="bell-outline" tint={color.primary} />} title={t('Notifications')} onPress={() => router.push('/office/notifications')} />
        <ListRow left={<Icon name="briefcase-outline" tint={color.primary} />} title={t('My work')} divider={allowed.length > 0} onPress={() => router.push('/office/work')} />
      </Section>
      {allowed.length ? (
        <Section title={t('Workspaces')}>
          {allowed.map((w, i) => (
            <ListRow key={w.key} left={<Icon name={w.icon} tint={color.primary} />} title={t(w.title)} divider={i < allowed.length - 1} onPress={() => router.push(w.href)} />
          ))}
        </Section>
      ) : null}
      <Section>
        <SignOutRow />
      </Section>
      <Text variant="caption" tint={color.text3} style={{ marginTop: 24, textAlign: 'center' }}>
        NeWay TMS {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
