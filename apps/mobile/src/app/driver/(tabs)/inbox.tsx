import { router } from 'expo-router';

import { InboxList } from '@/features/messaging';
import { Button } from '@/ui/controls';
import { Screen } from '@/ui/layout';
import { t } from '@/i18n';

/** Sheet 06 — the driver's conversations with dispatch, safety, fleet and accounting. */
export default function DriverInbox() {
  return (
    <Screen title={t('Inbox')} titleRight={<Button compact icon="pencil-outline" label={t('New message')} onPress={() => router.push('/driver/new-message')} />}>
      <InboxList shell="driver" />
    </Screen>
  );
}
