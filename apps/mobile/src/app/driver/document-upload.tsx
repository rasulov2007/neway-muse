import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes } from '@/api/contract';
import { DRIVER_APP_DOCUMENT_CODES, DRIVER_APP_DOCUMENT_LABEL, type DriverAppDocumentCode } from '@neway/shared/mobile/documents';
import { driverPostItem } from '@/features/submit';
import { easternDay } from '@/lib/clock';
import type { PickedMedia } from '@/lib/media';
import { useQueue } from '@/offline/queue';
import { Button, DateField, TextField } from '@/ui/controls';
import { Screen, Section, useToast } from '@/ui/layout';
import { DocumentPhotoCard } from '@/ui/media';
import { Text } from '@/ui/primitives';
import { color, space } from '@/ui/tokens';
import { t } from '@/i18n';

const EXPIRING: readonly DriverAppDocumentCode[] = ['cdl', 'cdl_back', 'medical_card', 'work_authorization'];

/**
 * A new version of one qualification paper (POST /driver/documents): Safety reviews it; the
 * earlier version stays on file. A past expiry is refused here as on the server.
 */
export default function DocumentUpload() {
  const params = useLocalSearchParams<{ type?: string }>();
  const type: DriverAppDocumentCode = (DRIVER_APP_DOCUMENT_CODES as readonly string[]).includes(params.type ?? '') ? (params.type as DriverAppDocumentCode) : 'cdl';
  const [photo, setPhoto] = useState<PickedMedia[]>([]);
  const [expires, setExpires] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();
  const today = easternDay();
  const expiryError = expires && expires < today ? t('This date has passed. Send the current document.') : null;
  const issuedError = issued && issued > today ? t('The issue date cannot be in the future.') : null;
  const ok = photo.length === 1 && !expiryError && !issuedError;

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { type };
      if (expires) body.expiresOn = expires;
      if (issued) body.issuedOn = issued;
      if (note.trim()) body.note = note.trim();
      await queue.enqueue(
        driverPostItem({
          kind: 'driver-document',
          title: t(DRIVER_APP_DOCUMENT_LABEL[type]),
          subtitle: expires ? t('Expires {date}', { date: expires }) : t('New version'),
          route: routes.driverDocuments,
          body,
          files: photo,
          fileField: 'fileId',
          fileMode: 'single',
        }),
      );
      toast(t('Saved. Safety reviews it once the phone is online.'), 'success');
      router.back();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t(DRIVER_APP_DOCUMENT_LABEL[type])} subtitle={t('Send a clear photo of the whole document. Safety checks it before it counts.')}>
      <Section title={t('Photo')} style={{ marginTop: 0 }}>
        <DocumentPhotoCard value={photo[0] ?? null} onChange={(m) => setPhoto(m ? [m] : [])} what={t(DRIVER_APP_DOCUMENT_LABEL[type])} prefix={type} shape={type === 'cdl' || type === 'cdl_back' || type === 'medical_card' ? 'card' : 'page'} />
      </Section>
      <View style={{ gap: space.md, marginTop: space.lg }}>
        {EXPIRING.includes(type) ? <DateField label={t('Expires on')} value={expires} onChange={setExpires} today={today} error={expiryError} /> : null}
        <DateField label={t('Issued on (optional)')} value={issued} onChange={setIssued} today={today} error={issuedError} />
        <TextField label={t('Note (optional)')} value={note} onChangeText={(text) => setNote(text.slice(0, 1000))} multiline />
      </View>
      <Button style={{ marginTop: space.xl }} label={t('Send to Safety')} disabled={!ok} loading={busy} onPress={save} />
      {photo.length === 0 ? (
        <Text variant="caption" tint={color.text3} style={{ textAlign: 'center', marginTop: space.sm }}>
          {t('Add the photo first.')}
        </Text>
      ) : null}
    </Screen>
  );
}
