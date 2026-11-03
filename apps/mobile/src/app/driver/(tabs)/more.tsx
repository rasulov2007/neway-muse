import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';

import { AccountSection, SignOutRow } from '@/features/components';
import { useQueue } from '@/offline/queue';
import { ListRow } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { Icon, Text, type IconName } from '@/ui/primitives';
import { color } from '@/ui/tokens';
import { t } from '@/i18n';

/** English here; translated where it is drawn. */
const LINKS: Array<{ href: Href; icon: IconName; title: string; subtitle: string }> = [
  { href: '/driver/documents', icon: 'card-account-details-outline', title: 'Documents & profile', subtitle: 'CDL, medical card, work authorization' },
  { href: '/driver/pti', icon: 'clipboard-check-outline', title: 'Pre-trip inspection', subtitle: 'Weekly walk-around for Safety' },
  { href: '/driver/care', icon: 'hand-heart-outline', title: 'Driver Care', subtitle: 'Pay questions, referrals, feedback' },
  { href: '/driver/report-problem', icon: 'alert-outline', title: 'Report a problem', subtitle: 'Breakdown, accident, inspection, ticket' },
  { href: '/driver/reimbursement', icon: 'receipt-text-outline', title: 'Reimbursement', subtitle: 'File a receipt you paid' },
  { href: '/driver/vacation', icon: 'calendar-blank-outline', title: 'Vacation request', subtitle: 'Time off and return review' },
  { href: '/driver/requests', icon: 'timeline-check-outline', title: 'My requests', subtitle: 'Track what you sent' },
  { href: '/driver/notifications', icon: 'bell-outline', title: 'Notifications', subtitle: 'Everything the TMS told you' },
];

export default function DriverMore() {
  const { items } = useQueue();
  const pending = items.filter((i) => i.status !== 'received').length;
  return (
    <Screen title={t('More')}>
      <AccountSection shell="driver" />
      <Section title={t('Your work')}>
        <ListRow
          left={<Icon name="cloud-upload-outline" tint={color.primary} />}
          title={t('Uploads on this phone')}
          subtitle={pending ? t('{count} not yet received by the TMS', { count: pending }) : t('Everything has reached the TMS')}
          onPress={() => router.push('/driver/uploads')}
        />
        {LINKS.map((l, i) => (
          <ListRow key={l.title} left={<Icon name={l.icon} tint={color.primary} />} title={t(l.title)} subtitle={t(l.subtitle)} divider={i < LINKS.length - 1} onPress={() => router.push(l.href)} />
        ))}
      </Section>
      <Section>
        <SignOutRow />
      </Section>
      <Text variant="caption" tint={color.text3} style={{ marginTop: 24, textAlign: 'center' }}>
        NeWay TMS {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
