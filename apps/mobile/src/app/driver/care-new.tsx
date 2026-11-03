import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes } from '@/api/contract';
import { driverPostItem } from '@/features/submit';
import { t } from '@/i18n';
import {
  COMPLIANCE_SUBJECTS,
  COMPLIANCE_SUBJECT_LABELS,
  DRIVER_RELATION_TOPICS,
  DRIVER_RELATION_TOPIC_LABELS,
  MANAGEMENT_CALL_TOPICS,
  MANAGEMENT_CALL_TOPIC_LABELS,
  type DriverRelationTopic,
} from '@neway/shared/driver-relations/index';
import { DRIVER_CARE_TEAM_LABEL, careTeamFor } from '@neway/shared/mobile/care';
import { easternDay, weekStart } from '@/lib/clock';
import type { PickedMedia } from '@/lib/media';
import { useQueue } from '@/offline/queue';
import { Button, DateField, Select, TextField } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { Icon, Text } from '@/ui/primitives';
import { MediaStrip } from '@/ui/media';
import { color, space } from '@/ui/tokens';

/**
 * A Driver Care message (POST /driver/care): the server files it as a Driver Relations request
 * for the signed-in driver and routes it to the team that answers the topic.
 */
export default function CareNew() {
  const params = useLocalSearchParams<{ topic?: string }>();
  const topic: DriverRelationTopic = (DRIVER_RELATION_TOPICS as readonly string[]).includes(params.topic ?? '') ? (params.topic as DriverRelationTopic) : 'complaint_feedback';
  const [message, setMessage] = useState('');
  const [subtopic, setSubtopic] = useState<string | null>(null);
  const [preferredTime, setPreferredTime] = useState('');
  const [week, setWeek] = useState<string | null>(null);
  const [loadNumber, setLoadNumber] = useState('');
  const [files, setFiles] = useState<PickedMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();
  const team = t(DRIVER_CARE_TEAM_LABEL[careTeamFor(topic)]);
  const today = easternDay();

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { topic, message: message.trim(), attachments: [] };
      if (subtopic) body.subtopic = subtopic;
      if (topic === 'management_call' && preferredTime.trim()) body.preferredTime = preferredTime.trim();
      if (topic === 'pay_statement') {
        if (week) body.weekStart = weekStart(week);
        if (loadNumber.trim()) body.loadNumber = loadNumber.trim();
      }
      await queue.enqueue(
        driverPostItem({
          kind: 'care',
          title: t("Driver Care · {topic}", { topic: t(DRIVER_RELATION_TOPIC_LABELS[topic]) }),
          subtitle: message.trim().slice(0, 80),
          route: routes.driverCare,
          body,
          files,
          fileField: 'attachments',
        }),
      );
      toast(t("Saved. {team} receives it as soon as the phone is online.", { team }), 'success');
      router.replace('/driver/requests');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t(DRIVER_RELATION_TOPIC_LABELS[topic])} subtitle={t("Answered by {team}.", { team })}>
      <View style={{ gap: space.md }}>
        {topic === 'complaint_feedback' || (topic === 'management_call' && subtopic === 'confidential') ? (
          <Panel tinted>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Icon name="lock-outline" size={18} tint={color.text2} />
              <Text variant="small" tint={color.text2} style={{ flex: 1 }}>
                {t("This stays confidential: only the Driver Relations staff allowed to read confidential requests see it.")}
              </Text>
            </View>
          </Panel>
        ) : null}
        {topic === 'compliance' ? (
          <Select label={t("What do you need help with?")} value={subtopic} onChange={setSubtopic} options={COMPLIANCE_SUBJECTS.map((s) => ({ value: s, label: t(COMPLIANCE_SUBJECT_LABELS[s]) }))} />
        ) : null}
        {topic === 'management_call' ? (
          <>
            <Select label={t("Topic")} value={subtopic} onChange={setSubtopic} options={MANAGEMENT_CALL_TOPICS.map((s) => ({ value: s, label: t(MANAGEMENT_CALL_TOPIC_LABELS[s]) }))} />
            <TextField label={t("When can you talk? (optional)")} value={preferredTime} onChangeText={(v) => setPreferredTime(v.slice(0, 150))} placeholder={t("e.g. weekdays after 6 PM Central")} />
          </>
        ) : null}
        {topic === 'pay_statement' ? (
          <>
            <DateField label={t("Pay week (optional)")} value={week} onChange={setWeek} today={today} />
            <TextField label={t("Load number (optional)")} value={loadNumber} onChangeText={(v) => setLoadNumber(v.slice(0, 40))} autoCapitalize="characters" />
          </>
        ) : null}
        <TextField label={t("Message")} value={message} onChangeText={(v) => setMessage(v.slice(0, 4000))} multiline placeholder={t("Tell us what you need")} hint={`${message.length}/4000`} />
      </View>
      <Section title={t("Photos (optional)")}>
        <MediaStrip items={files} onChange={setFiles} max={5} prefix="care" />
      </Section>
      <Button style={{ marginTop: space.xl }} label={t("Send to {team}", { team })} disabled={message.trim().length < 3} loading={busy} onPress={save} />
    </Screen>
  );
}
