import { QueueItemRow } from '@/features/components';
import { useQueue } from '@/offline/queue';
import { Screen, Section } from '@/ui/layout';
import { Text } from '@/ui/primitives';
import { EmptyState } from '@/ui/states';
import { color } from '@/ui/tokens';
import { t } from '@/i18n';

/**
 * Everything this membership has saved or sent from the phone, with the five statuses
 * (Saved on phone · Waiting to upload · Uploading · Received by TMS · Upload failed).
 */
export default function Uploads() {
  const { items, retry, discard } = useQueue();
  const open = items.filter((i) => i.status !== 'received');
  const done = items.filter((i) => i.status === 'received');
  return (
    <Screen back title={t('Uploads')} subtitle={t('Kept on this phone until the TMS confirms it received them.')}>
      {items.length === 0 ? <EmptyState icon="cloud-check-outline" title={t('Nothing waiting')} body={t('Documents and reports you send from the phone show up here with their status.')} /> : null}
      {open.length ? (
        <Section title={t('On the way ({count})', { count: open.length })}>
          {open.map((item, i) => (
            <QueueItemRow key={item.id} item={item} divider={i < open.length - 1} onRetry={() => void retry(item.id)} onDiscard={() => void discard(item.id)} />
          ))}
        </Section>
      ) : null}
      {done.length ? (
        <Section title={t('Received by TMS ({count})', { count: done.length })}>
          {done.map((item, i) => (
            <QueueItemRow key={item.id} item={item} divider={i < done.length - 1} onDiscard={() => void discard(item.id)} />
          ))}
          <Text variant="caption" tint={color.text3} style={{ marginTop: 8 }}>
            {t("Received items leave this list after a week. The office's review shows on the load.")}
          </Text>
        </Section>
      ) : null}
    </Screen>
  );
}
