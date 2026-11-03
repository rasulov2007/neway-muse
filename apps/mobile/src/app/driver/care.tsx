import { router, type Href } from 'expo-router';
import { View } from 'react-native';

import { routes, type DriverReferralList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { t } from '@/i18n';
import { useAccount } from '@/auth/session';
import { DRIVER_RELATION_TOPICS, DRIVER_RELATION_TOPIC_HINTS, DRIVER_RELATION_TOPIC_LABELS, type DriverRelationTopic } from '@neway/shared/driver-relations/index';
import { moneyCents } from '@/lib/format';
import { ListRow } from '@/ui/controls';
import { Screen } from '@/ui/layout';
import { Icon, StatusPill, type IconName } from '@/ui/primitives';
import { color } from '@/ui/tokens';

const ICON: Record<DriverRelationTopic, IconName> = {
  referral: 'gift-outline',
  complaint_feedback: 'message-text-outline',
  reimbursement: 'receipt-text-outline',
  pay_statement: 'help-circle-outline',
  compliance: 'shield-check-outline',
  management_call: 'phone-outline',
};

function hrefFor(topic: DriverRelationTopic): Href {
  if (topic === 'referral') return '/driver/referral';
  if (topic === 'reimbursement') return '/driver/reimbursement';
  return { pathname: '/driver/care-new', params: { topic } };
}

/** "$900" for a whole amount, "$912.50" otherwise. */
function bonusText(cents: number): string {
  return cents % 100 === 0 ? moneyCents(cents).replace(/\.00$/, '') : moneyCents(cents);
}

/**
 * Sheet 07. The topics are Driver Relations' own (the server contract); each opens its form. The
 * referral bonus shows only when the company has set one (`referral.bonus_amount`).
 */
export default function DriverCare() {
  const account = useAccount();
  const referrals = useResource<DriverReferralList>(routes.driverReferrals);
  const bonus = referrals.status === 'ready' ? referrals.data.bonusAmountCents : null;
  const company = account.companyName ?? t('Your company');
  return (
    <Screen back title={t("Driver Care")} subtitle={t("{company} always cares about its drivers.", { company })}>
      <View style={{ borderWidth: 1, borderColor: color.divider, borderRadius: 10, paddingHorizontal: 12 }}>
        {DRIVER_RELATION_TOPICS.map((topic, i) => (
          <ListRow
            key={topic}
            left={<Icon name={ICON[topic]} size={26} tint={color.primary} />}
            title={t(DRIVER_RELATION_TOPIC_LABELS[topic])}
            subtitle={topic === 'referral' && bonus ? t("Earn {amount} per hired driver", { amount: bonusText(bonus) }) : t(DRIVER_RELATION_TOPIC_HINTS[topic])}
            right={topic === 'referral' && bonus ? <StatusPill tone="success" label={bonusText(bonus)} /> : null}
            divider={i < DRIVER_RELATION_TOPICS.length - 1}
            onPress={() => router.push(hrefFor(topic))}
          />
        ))}
      </View>
      <ListRow
        style={{ marginTop: 8 }}
        left={<Icon name="timeline-check-outline" size={24} tint={color.primary} />}
        title={t("My requests")}
        subtitle={t("Follow what you sent and the answers")}
        divider={false}
        onPress={() => router.push('/driver/requests')}
      />
    </Screen>
  );
}
