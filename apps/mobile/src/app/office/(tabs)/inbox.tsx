import { InboxList } from '@/features/messaging';
import { t } from '@/i18n';
import { Screen } from '@/ui/layout';

/** Sheet 16's list: the team inbox (GET /conversations). */
export default function OfficeInbox() {
  return (
    <Screen title={t('Inbox')}>
      <InboxList shell="office" />
    </Screen>
  );
}
