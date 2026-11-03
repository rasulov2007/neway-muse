import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type ConversationThread, type DriverLoadsResponse } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { driverPostItem } from '@/features/submit';
import { t, tn } from '@/i18n';
import type { PickedMedia } from '@/lib/media';
import { MESSAGE_DEPARTMENTS, MESSAGE_DEPARTMENT_LABEL, type MessageDepartment } from '@neway/shared/mobile/messages';
import { useQueue, waitForItem } from '@/offline/queue';
import { Button, Select, TextField } from '@/ui/controls';
import { Screen, Section, useToast } from '@/ui/layout';
import { MediaStrip } from '@/ui/media';
import { space } from '@/ui/tokens';

const NO_LOAD = '_none';

/**
 * Start a conversation with a department, optionally about one of the driver's own loads
 * (POST /driver/conversations, find-or-create). Sent through the queue; when it reaches the TMS
 * the thread opens, otherwise it waits on the phone.
 */
export default function NewMessage() {
  const params = useLocalSearchParams<{ department?: string; loadId?: string }>();
  const [department, setDepartment] = useState<MessageDepartment>((MESSAGE_DEPARTMENTS as readonly string[]).includes(params.department ?? '') ? (params.department as MessageDepartment) : 'dispatch');
  const [loadId, setLoadId] = useState<string>(params.loadId || NO_LOAD);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<PickedMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useResource<DriverLoadsResponse>(routes.driverLoads('active'));
  const upcoming = useResource<DriverLoadsResponse>(routes.driverLoads('upcoming'));
  const queue = useQueue();
  const toast = useToast();
  const loads = [...(active.status === 'ready' ? active.data.loads : []), ...(upcoming.status === 'ready' ? upcoming.data.loads : [])];

  const send = async () => {
    setBusy(true);
    try {
      const subject = loadId !== NO_LOAD ? { subjectType: 'load', subjectId: loadId } : {};
      const item = await queue.enqueue(
        driverPostItem({
          kind: 'conversation',
          title: t("New message · {department}", { department: t(MESSAGE_DEPARTMENT_LABEL[department]) }),
          subtitle: body.slice(0, 80) || tn(files.length, "{count} photo", "{count} photos"),
          route: routes.driverConversations,
          body: { department, ...subject, body, attachmentFileIds: [] },
          files,
          fileField: 'attachmentFileIds',
        }),
      );
      const done = await waitForItem(item.id);
      if (done?.status === 'received') {
        const thread = done.result as ConversationThread | null;
        if (thread?.conversation?.id) {
          router.replace(`/driver/conversation/${thread.conversation.id}`);
          return;
        }
      }
      if (done?.status === 'failed') toast(done.lastError ?? t("The message was not accepted."), 'danger');
      else toast(t("Saved on the phone; it is sent when you're online."), 'info');
      router.replace('/driver/uploads');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t("New message")} subtitle={t("Write to a department. Link a load if it is about one.")}>
      <View style={{ gap: space.md }}>
        <Select<MessageDepartment>
          label={t("To")}
          value={department}
          onChange={setDepartment}
          options={MESSAGE_DEPARTMENTS.map((d) => ({ value: d, label: t(MESSAGE_DEPARTMENT_LABEL[d]) }))}
        />
        <Select<string>
          label={t("About a load (optional)")}
          value={loadId}
          onChange={setLoadId}
          options={[{ value: NO_LOAD, label: t("Not about a load") }, ...loads.map((l) => ({ value: l.id, label: `#${l.loadNumber}`, description: l.statusLabel }))]}
        />
        <TextField label={t("Message")} value={body} onChangeText={(v) => setBody(v.slice(0, 4000))} multiline placeholder={t("Type your message")} />
      </View>
      <Section title={t("Photos (optional)")}>
        <MediaStrip items={files} onChange={setFiles} max={10} prefix="message" />
      </Section>
      <Button style={{ marginTop: space.xl }} icon="send" label={t("Send")} disabled={!body.trim() && !files.length} loading={busy} onPress={send} />
    </Screen>
  );
}
