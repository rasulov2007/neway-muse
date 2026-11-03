import { NotificationsList } from '@/features/notifications';
import { t } from '@/i18n';
import { Screen } from '@/ui/layout';

/** Sheet 24 — GET /mobile/notifications (M1). */
export default function OfficeNotifications() {
  return (
    <Screen back title={t('Notifications')} subtitle={t('Stay on top of what needs your attention.')}>
      <NotificationsList shell="office" />
    </Screen>
  );
}
