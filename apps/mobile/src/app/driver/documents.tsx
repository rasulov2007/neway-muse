import { router } from 'expo-router';
import { View } from 'react-native';

import { routes, type DriverDocumentList, type DriverMe, type DriverQualificationDocument } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { useAccount } from '@/auth/session';
import { dayLabel } from '@/lib/format';
import { useQueue } from '@/offline/queue';
import { ListRow } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { Avatar, Icon, StatusPill, Text, type IconName } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, space, type StatusTone } from '@/ui/tokens';
import { t, tn } from '@/i18n';

const ICON: Record<string, IconName> = {
  cdl: 'card-account-details-outline',
  cdl_back: 'card-account-details-outline',
  medical_card: 'heart-pulse',
  work_authorization: 'passport',
  driver_photo: 'account-box-outline',
};

function pill(d: DriverQualificationDocument): { tone: StatusTone; label: string } {
  if (d.state === 'verified' && d.reminder?.kind === 'expiring') return { tone: 'warning', label: t('Expiring') };
  switch (d.state) {
    case 'verified':
      return { tone: 'success', label: t('Valid') };
    case 'pending_review':
      return { tone: 'info', label: t('In review') };
    case 'rejected':
      return { tone: 'danger', label: t('Rejected') };
    case 'expired':
      return { tone: 'danger', label: t('Expired') };
    default:
      return { tone: 'neutral', label: t('Not on file') };
  }
}

function describe(d: DriverQualificationDocument): string {
  // Sheet 12: 'Expires in 24 days · Oct 18, 2024' or 'Valid through Aug 14, 2027'; the pill carries the state.
  if (d.state === 'missing') return t('Tap to send it');
  const parts: string[] = [];
  if (d.state === 'rejected' && d.rejectionReason) parts.push(d.rejectionReason);
  if (d.reminder?.kind === 'expiring' && d.expiresOn) parts.push(`${tn(d.reminder.daysLeft, 'Expires in {count} day', 'Expires in {count} days')} · ${dayLabel(d.expiresOn)}`);
  else if (d.expiresOn) parts.push(d.state === 'expired' || d.reminder?.kind === 'expired' ? t('Expired {date}', { date: dayLabel(d.expiresOn) }) : t('Valid through {date}', { date: dayLabel(d.expiresOn) }));
  if (d.previous.length) parts.push(tn(d.previous.length, '{count} earlier version kept', '{count} earlier versions kept'));
  return parts.join(' · ');
}

/**
 * Sheet 12. Profile from GET /driver/me; the qualification papers from GET /driver/documents with
 * Safety's state and the stored expiry. A tap sends a new version (it goes to Safety for review;
 * the previous one is kept).
 */
export default function DocumentsAndProfile() {
  const account = useAccount();
  const me = useResource<DriverMe>(routes.driverMe);
  const docs = useResource<DriverDocumentList>(routes.driverDocuments);
  const { items } = useQueue();
  const onPhone = items.filter((i) => i.status !== 'received');
  const bytes = onPhone.reduce((sum, i) => sum + i.files.reduce((s, f) => s + (f.size ?? 0), 0), 0);
  const queuedDocs = new Set(onPhone.filter((i) => i.kind === 'driver-document').map((i) => (i.payload as { body?: { type?: string } }).body?.type));

  return (
    <Screen back onRefresh={() => (me.reload(), docs.reload())}>
      <ListRow
        divider
        left={<Avatar name={account.name} size={56} tone="info" />}
        title={<Text variant="heading">{me.status === 'ready' ? me.data.driver.name : account.name}</Text>}
        subtitle={account.companyName ?? undefined}
        meta={me.status === 'ready' ? t('Driver ID {id}', { id: me.data.driver.driverNumber }) : me.status === 'loading' ? t('Loading…') : undefined}
        chevron={false}
      />
      <Section title={t('My documents')}>
        <ResourceView resource={docs} what={t('Your documents')} compact>
          {({ documents }) =>
            documents.length ? (
              documents.map((d, i) => {
                const p = pill(d);
                const waiting = queuedDocs.has(d.type);
                return (
                  <ListRow
                    key={d.type}
                    left={<Icon name={ICON[d.type] ?? 'file-document-outline'} size={24} tint={d.state === 'rejected' || d.state === 'expired' ? color.danger : color.primary} />}
                    title={t(d.label)}
                    subtitle={describe(d) || undefined}
                    right={<StatusPill tone={waiting ? 'neutral' : p.tone} label={waiting ? t('Waiting to upload') : p.label} />}
                    divider={i < documents.length - 1}
                    onPress={() => router.push({ pathname: '/driver/document-upload', params: { type: d.type } })}
                  />
                );
              })
            ) : (
              <EmptyState compact icon="card-account-details-outline" title={t('No documents on file')} />
            )
          }
        </ResourceView>
      </Section>
      <Section>
        <ListRow
          left={<Icon name="cloud-outline" size={24} tint={color.primary} />}
          title={t('Offline available files')}
          subtitle={onPhone.length ? `${tn(onPhone.length, '{count} item on this phone', '{count} items on this phone')}${bytes ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : ''}` : t('Nothing waiting on this phone')}
          onPress={() => router.push('/driver/uploads')}
        />
        <ListRow left={<Icon name="bell-outline" size={24} tint={color.primary} />} title={t('Notifications')} subtitle={t('Reviews, reminders and replies')} divider={false} onPress={() => router.push('/driver/notifications')} />
      </Section>
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
