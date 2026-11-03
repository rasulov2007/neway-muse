import { NotificationsList } from '@/features/notifications';
import { t } from '@/i18n';
import { Screen } from '@/ui/layout';

export default function DriverNotifications() {
  return (
    <Screen back title={t("Notifications")} subtitle={t("Stay on top of what needs your attention.")}>
      <NotificationsList shell="driver" />
    </Screen>
  );
}
