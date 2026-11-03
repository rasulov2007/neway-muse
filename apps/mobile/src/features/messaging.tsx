import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, TextInput, View, StyleSheet } from 'react-native';

import { api, uploadRaw } from '@/api/client';
import { routes, type ConversationSummary, type ConversationThread, type ConversationsResponse, type MessageView } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { MESSAGE_DEPARTMENT_LABEL, type MessageDepartment } from '@neway/shared/mobile/messages';
import { t, tn } from '@/i18n/core';
import { relativeStamp } from '@/lib/clock';
import type { ShellName } from '@/lib/deep-link';
import type { PickedMedia } from '@/lib/media';
import { isDenied, pickMedia } from '@/lib/media';
import { uuid } from '@/lib/uuid';
import { useQueue } from '@/offline/queue';
import { STATUS_LABEL } from '@/offline/queue-core';
import { SegmentedTabs } from '@/ui/controls';
import { Screen, useToast } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { Avatar, Icon, StatusPill, Text, fontFor } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, radius, space, type StatusTone } from '@/ui/tokens';

import { driverPostItem, refOf } from './submit';

/** Department marks (sheet 06): Dispatch blue, Safety amber, Fleet green; the rest neutral. */
export const DEPARTMENT_TONE: Record<string, StatusTone> = {
  dispatch: 'info',
  safety: 'warning',
  fleet: 'success',
  accounting: 'neutral',
  driver_relations: 'neutral',
};

function conversationName(c: ConversationSummary, shell: ShellName): string {
  if (shell === 'driver') return c.departmentLabel ? t(c.departmentLabel) : c.title;
  return c.subject?.label ?? c.title;
}

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <View accessibilityLabel={t('{count} unread', { count })} style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}>
      <Text variant="captionStrong" tint={color.onPrimary}>
        {count}
      </Text>
    </View>
  );
}

function ConversationRow({ c, shell, last }: { c: ConversationSummary; shell: ShellName; last: boolean }) {
  const name = conversationName(c, shell);
  // Driver: what it is about (a load, a case), when anything. Office: the department, and the driver when the title does not already name them.
  const drivers = c.drivers.map((d) => d.name).filter((n) => !c.title.includes(n)).join(', ');
  const second = shell === 'driver' ? (c.subject?.label ?? null) : [c.departmentLabel ? t(c.departmentLabel) : null, drivers].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={c.unread ? t('{name}, {count} unread', { name, count: c.unread }) : name}
      onPress={() => router.push(`/${shell}/conversation/${c.id}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space.md,
        paddingVertical: space.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: pressed ? color.subtle : 'transparent',
      })}
    >
      <Avatar name={c.departmentLabel ?? c.title} size={44} tone={DEPARTMENT_TONE[c.department ?? ''] ?? 'info'} />
      <View style={{ flex: 1, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="rowTitle" style={{ flex: 1 }} numberOfLines={1}>
            {name}
          </Text>
          <Text variant="caption" tint={color.text3}>
            {relativeStamp(c.lastMessage?.at ?? c.updatedAt)}
          </Text>
        </View>
        {second ? (
          <Text variant="smallStrong" tint={color.ink} numberOfLines={1}>
            {second}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="small" tint={color.text2} style={{ flex: 1 }} numberOfLines={1}>
            {c.lastMessage ? `${c.lastMessage.body || (c.lastMessage.hasAttachments ? t('Photo') : '')}` : t('No messages yet')}
          </Text>
          <UnreadBadge count={c.unread} />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Sheets 06 / 16 list. Driver: GET /driver/conversations (only their own). Office: GET
 * /conversations — the ones they take part in and every conversation of a department they hold,
 * with a department filter.
 */
export function InboxList({ shell }: { shell: ShellName }) {
  const [department, setDepartment] = useState<string>('all');
  const path = shell === 'driver' ? routes.driverConversations : routes.conversations(null, department === 'all' ? null : department);
  const list = useResource<ConversationsResponse>(path);
  const departments = useMemo(() => {
    if (shell !== 'office' || list.status !== 'ready') return [];
    return Object.keys(list.data.unreadByDepartment).filter((d) => d !== 'all');
  }, [shell, list]);
  return (
    <>
      {shell === 'office' && (departments.length > 1 || department !== 'all') ? (
        <View style={{ marginBottom: space.sm }}>
          <SegmentedTabs
            variant="underline"
            value={department}
            onChange={setDepartment}
            options={[{ key: 'all', label: t('All') }, ...departments.map((d) => ({ key: d, label: MESSAGE_DEPARTMENT_LABEL[d as MessageDepartment] ? t(MESSAGE_DEPARTMENT_LABEL[d as MessageDepartment]) : d }))]}
          />
        </View>
      ) : null}
      <ResourceView resource={list} what={t('Messages')}>
        {({ conversations }) =>
          conversations.length ? (
            <View>
              {conversations.map((c, i) => (
                <ConversationRow key={c.id} c={c} shell={shell} last={i === conversations.length - 1} />
              ))}
            </View>
          ) : (
            <EmptyState
              icon="email-outline"
              title={t('No messages')}
              body={shell === 'driver' ? t('Write to dispatch, safety, fleet or accounting with New message.') : t('Conversations with drivers for your departments appear here.')}
            />
          )
        }
      </ResourceView>
    </>
  );
}

const STATE_WORD: Record<string, string> = { sent: 'Sent', received: 'Delivered', read: 'Read' };
const stateWord = (s: string) => (STATE_WORD[s] ? t(STATE_WORD[s]) : s);

function Bubble({ m, shell, conversationId }: { m: MessageView; shell: ShellName; conversationId: string }) {
  const mine = m.sender.isMe;
  const linkRoute = (fileId: string) => (shell === 'driver' ? routes.driverConversationFile(conversationId, fileId) : routes.conversationFile(conversationId, fileId));
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
      {mine ? null : <Avatar name={m.sender.name} size={32} />}
      <View style={{ gap: 4, flexShrink: 1, alignItems: mine ? 'flex-end' : 'flex-start' }}>
        <Text variant="caption" tint={color.text2}>
          <Text variant="captionStrong">{mine ? t('You') : m.sender.name}</Text>
          {'  '}
          {relativeStamp(m.createdAt)}
        </Text>
        {m.body ? (
          <View style={{ backgroundColor: mine ? color.primary : color.subtle, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm }}>
            <Text variant="small" tint={mine ? color.onPrimary : color.ink}>
              {m.body}
            </Text>
          </View>
        ) : null}
        {m.attachments.map((a) => (
          <SignedImage key={a.fileId} linkRoute={linkRoute(a.fileId)} contentType={a.contentType} label={a.fileName} style={{ width: 180, height: 130 }} />
        ))}
        {mine && m.state ? (
          <Text variant="caption" tint={color.text3}>
            {stateWord(m.state)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Composer({ onSend, sending }: { onSend: (body: string, files: PickedMedia[]) => Promise<boolean>; sending: boolean }) {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<PickedMedia[]>([]);
  const toast = useToast();
  const attach = async () => {
    const picked = await pickMedia({ prefix: 'message' }).catch(() => null);
    if (isDenied(picked)) return toast(t('Camera access is off for NeWay. Turn it on in Settings.'), 'warning');
    if (picked) setFiles((f) => [...f, picked]);
  };
  const canSend = (body.trim().length > 0 || files.length > 0) && !sending;
  return (
    <View style={{ gap: space.sm }}>
      {files.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {files.map((f, i) => (
            <View key={f.uri} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.subtle, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4 }}>
              <Icon name={f.kind === 'image' ? 'image-outline' : 'file-outline'} size={16} tint={color.text2} />
              <Text variant="caption">{f.kind === 'image' ? t('Photo {n}', { n: i + 1 }) : f.name}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Remove attachment')} onPress={() => setFiles((x) => x.filter((_, j) => j !== i))} hitSlop={8}>
                <Icon name="close" size={16} tint={color.text2} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Attach a photo')} onPress={attach} hitSlop={8} style={{ padding: space.xs }}>
          <Icon name="paperclip" size={22} tint={color.text2} />
        </Pressable>
        <TextInput
          accessibilityLabel={t('Message')}
          value={body}
          onChangeText={(v) => setBody(v.slice(0, 4000))}
          placeholder={t('Type a message…')}
          placeholderTextColor={color.text3}
          multiline
          style={[
            { flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, backgroundColor: color.subtle, paddingHorizontal: space.lg, paddingVertical: space.sm, fontSize: 15, color: color.ink, ...fontFor('500') },
            { outlineStyle: 'none' } as object,
          ]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('Send')}
          disabled={!canSend}
          onPress={async () => {
            const ok = await onSend(body.trim(), files);
            if (ok) {
              setBody('');
              setFiles([]);
            }
          }}
          hitSlop={8}
          style={{ padding: space.xs, opacity: canSend ? 1 : 0.35 }}
        >
          <Icon name="send" size={24} tint={color.primary} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Sheet 16 thread (both shells). Opening it marks it read. The driver's messages go through the
 * offline queue (Idempotency-Key, photos to POST /driver/files first) and show as "Waiting to
 * upload" until the TMS has them; the office posts directly (POST /files/raw for a photo).
 */
export function ConversationScreen({ id, shell }: { id: string; shell: ShellName }) {
  const path = shell === 'driver' ? routes.driverConversationMessages(id) : routes.conversationMessages(id);
  const thread = useResource<ConversationThread>(path);
  const queue = useQueue();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const pending = shell === 'driver' ? queue.items.filter((i) => i.kind === 'message' && refOf(i).conversationId === id && i.status !== 'received') : [];
  const deliveredCount = shell === 'driver' ? queue.items.filter((i) => i.kind === 'message' && refOf(i).conversationId === id && i.status === 'received').length : 0;

  // Read state: the other side sees "Read" once this thread is open.
  const ready = thread.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    void api.post(shell === 'driver' ? routes.driverConversationRead(id) : routes.conversationRead(id)).catch(() => undefined);
  }, [ready, id, shell]);
  // A queued message that just reached the TMS: show the stored one.
  useEffect(() => {
    if (deliveredCount) thread.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveredCount]);

  const send = async (body: string, files: PickedMedia[]): Promise<boolean> => {
    setSending(true);
    try {
      if (shell === 'driver') {
        await queue.enqueue(
          driverPostItem({
            kind: 'message',
            title: thread.status === 'ready' ? t('Message · {to}', { to: thread.data.conversation.departmentLabel ? t(thread.data.conversation.departmentLabel) : thread.data.conversation.title }) : t('Message'),
            subtitle: body ? body.slice(0, 80) : tn(files.length, '{count} photo', '{count} photos'),
            route: routes.driverConversationMessages(id),
            body: { body, attachmentFileIds: [] },
            files,
            fileField: 'attachmentFileIds',
            ref: { conversationId: id },
          }),
        );
        return true;
      }
      const attachmentFileIds: string[] = [];
      for (const f of files) {
        const stored = await uploadRaw<{ id: string }>(routes.filesRaw, { fileUri: f.uri, fileName: f.name, contentType: f.type, idempotencyKey: uuid() });
        attachmentFileIds.push(stored.id);
      }
      await api.post(routes.conversationMessages(id), { body, attachmentFileIds }, { idempotencyKey: uuid() });
      thread.reload();
      return true;
    } catch (error) {
      toast((error as Error).message || t('The message was not sent.'), 'danger');
      return false;
    } finally {
      setSending(false);
    }
  };

  const c = thread.status === 'ready' ? thread.data.conversation : null;
  const loadId = c?.subject?.type === 'load' ? c.subject.id : null;
  return (
    <Screen
      back={t('Inbox')}
      onRefresh={thread.reload}
      footer={thread.status === 'ready' ? <Composer onSend={send} sending={sending} /> : undefined}
    >
      <ResourceView resource={thread} what={t('This conversation')}>
        {({ conversation, messages }) => (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Text variant="heading">{shell === 'driver' ? (conversation.departmentLabel ? t(conversation.departmentLabel) : conversation.title) : (conversation.subject?.label ?? conversation.title)}</Text>
                <Text variant="small" tint={color.text2}>
                  {shell === 'driver'
                    ? (conversation.subject?.label ?? conversation.title)
                    : [conversation.departmentLabel ? t(conversation.departmentLabel) : null, conversation.drivers.map((d) => d.name).join(', ')].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {loadId ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(`/${shell}/load/${loadId}`)}
                  style={{ borderWidth: 1, borderColor: color.primary, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm }}
                >
                  <Text variant="smallStrong" tint={color.primary}>
                    {t('View load')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <View style={{ gap: space.lg, marginTop: space.lg }}>
              {messages.length === 0 && pending.length === 0 ? <EmptyState compact icon="message-outline" title={t('No messages yet')} body={t('Write the first one below.')} /> : null}
              {messages.map((m) => (
                <Bubble key={m.id} m={m} shell={shell} conversationId={id} />
              ))}
              {pending.map((item) => (
                <View key={item.id} style={{ alignSelf: 'flex-end', alignItems: 'flex-end', gap: 4, maxWidth: '88%' }}>
                  <View style={{ backgroundColor: color.subtle, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderStyle: 'dashed', borderColor: color.borderStrong }}>
                    <Text variant="small">{item.subtitle}</Text>
                  </View>
                  <StatusPill tone={item.status === 'failed' ? 'danger' : 'neutral'} label={STATUS_LABEL[item.status]} />
                </View>
              ))}
            </View>
            {conversation.subject && conversation.subject.type !== 'load' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.lg, backgroundColor: color.subtle, borderRadius: radius.md, padding: space.md }}>
                <Text variant="small" tint={color.text2}>
                  {t('Related')}
                </Text>
                <Text variant="smallStrong" tint={color.link} style={{ flex: 1 }}>
                  {conversation.subject.label}
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ResourceView>
    </Screen>
  );
}
