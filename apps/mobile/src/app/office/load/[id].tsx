import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type ConversationThread, type LoadStatusCode, type OfficeLoad } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { useSession } from '@/auth/session';
import { appointment, loadStatus, nextStop, placeOf, sortedStops } from '@/features/loads';
import { can, errorText } from '@/features/office/common';
import { NEXT_STATUSES, missingPaperwork } from '@neway/shared/loads/progress';
import { inEastern } from '@/lib/clock';
import { humanize } from '@/lib/format';
import { openSignedLink } from '@/lib/open-file';
import { Button, ListRow, Sheet } from '@/ui/controls';
import { Screen, Section, Timeline, useToast } from '@/ui/layout';
import { Avatar, Divider, Icon, StatusPill, StatusSymbol, Text } from '@/ui/primitives';
import { ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space, type StatusTone } from '@/ui/tokens';

const DOC_SHORT: Record<string, string> = {
  rate_confirmation: 'RC',
  bol: 'BOL',
  pod: 'POD',
  lumper_receipt: 'Lumper',
  tonu: 'TONU',
  layover: 'Layover',
  detention: 'Detention',
  invoice: 'Invoice',
  other: 'Other',
};

function reviewWord(review: string | undefined, status: string): { label: string; tone: StatusTone } {
  switch (review ?? status) {
    case 'reviewed':
      return { label: t('Reviewed'), tone: 'success' };
    case 'verified':
      return { label: t('Verified'), tone: 'success' };
    case 'rejected':
      return { label: t('Correction requested'), tone: 'danger' };
    default:
      return { label: t('Received'), tone: 'success' };
  }
}

/**
 * Sheet 15 — the existing GET /loads/:id (loads.view). Message driver opens (or finds) the load's
 * dispatch conversation; Update status uses the existing POST /loads/:id/status and is offered
 * only with loads.edit. Money is never shown on the phone.
 */
export default function OfficeLoadDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useResource<OfficeLoad>(routes.load(id));
  const { account } = useSession();
  const toast = useToast();
  const [statusOpen, setStatusOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const messageDriver = async (l: OfficeLoad) => {
    setBusy('message');
    try {
      const thread = await api.post<ConversationThread>(routes.startConversation, { department: 'dispatch', subjectType: 'load', subjectId: l.id });
      router.push(`/office/conversation/${thread.conversation.id}`);
    } catch (error) {
      toast(errorText(error, t('Could not open the conversation.')), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (l: OfficeLoad, status: LoadStatusCode) => {
    setBusy(status);
    try {
      await api.post(routes.loadStatus(l.id), { status, expectedUpdatedAt: l.updatedAt });
      setStatusOpen(false);
      toast(t('Load {number} is now {status}.', { number: l.loadNumber, status: t(loadStatus(status).label) }), 'success');
      load.reload();
    } catch (error) {
      // Close the sheet so the server's reason (shown in the toast) is not hidden behind it.
      setStatusOpen(false);
      toast(errorText(error), 'danger');
      load.reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen back={t('Loads')} onRefresh={load.reload}>
      <ResourceView resource={load} what={t('This load')}>
        {(l) => {
          const stops = sortedStops(l.stops);
          const next = nextStop(stops);
          const rawStatus = loadStatus(l.status);
          const status = { ...rawStatus, label: t(rawStatus.label) };
          const docs = l.documents.filter((d) => !d.supersededBy);
          const missing = missingPaperwork(l).filter((m) => m !== 'rate_confirmation');
          const facts = [humanize(l.equipmentType), l.weightLbs ? `${l.weightLbs.toLocaleString('en-US')} lb` : null, l.commodity].filter(Boolean);
          const nextStatuses = NEXT_STATUSES[l.status] ?? [];
          const mayEdit = can(account, 'loads.edit');
          return (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Text variant="title" style={{ flex: 1 }}>
                  {t('Load {number}', { number: l.loadNumber })}
                </Text>
                <StatusPill tone={status.tone} label={status.label} />
              </View>
              <Text variant="small" tint={color.text2}>
                {(facts.length ? facts : [l.customerName, l.brokerReference ? t('Ref {ref}', { ref: l.brokerReference }) : null].filter(Boolean)).join('  •  ')}
              </Text>

              <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.lg }}>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Avatar name={l.driverName ?? '?'} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text variant="smallStrong" numberOfLines={1}>
                      {l.driverName ?? t('No driver')}
                    </Text>
                    <Text variant="caption" tint={color.text2} numberOfLines={1}>
                      {l.dispatcherName ? t('Dispatcher {name}', { name: l.dispatcherName }) : ''}
                    </Text>
                  </View>
                </View>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Icon name="truck" size={28} tint={color.ink} />
                  <View style={{ flex: 1 }}>
                    <Text variant="smallStrong" numberOfLines={1}>
                      {l.truckUnit ? t('Unit {number}', { number: l.truckUnit }) : t('No truck')}
                    </Text>
                    {l.trailerUnit ? (
                      <Text variant="caption" tint={color.text2} numberOfLines={1}>
                        {t('Trailer {number}', { number: l.trailerUnit })}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>

              <Section>
                <Timeline
                  steps={stops.map((s, i) => {
                    const when = appointment(s);
                    const done = Boolean(s.departedAt) || s.status === 'completed';
                    return {
                      key: s.id,
                      state: done ? 'done' : s.id === next?.id ? 'current' : 'pending',
                      title: `${i + 1}. ${placeOf(s)}`,
                      subtitle: [s.kind === 'pickup' ? t('Pickup') : t('Delivery'), when.local].filter(Boolean).join(' • '),
                      detail: [when.eastern, s.arrivedAt && !done ? t('Arrived {when}', { when: inEastern(s.arrivedAt, true) }) : null].filter(Boolean).join(' · ') || null,
                      right: (
                        <Text variant="caption" tint={done ? color.text2 : color.info}>
                          {done ? t('Completed') : s.id === next?.id ? t('ETA') : ''}
                        </Text>
                      ),
                    };
                  })}
                />
              </Section>

              <Section title={t('Documents')}>
                {docs.map((d) => {
                  const r = reviewWord(d.review, d.status);
                  const fileId = d.fileId;
                  return (
                    <Pressable
                      key={d.id}
                      accessibilityRole="button"
                      disabled={!fileId}
                      onPress={() => fileId && void openSignedLink(routes.fileLink(fileId)).catch(() => toast(t('Could not open the file.'), 'warning'))}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.divider }}
                    >
                      <Text variant="smallStrong" style={{ width: 56 }}>
                        {DOC_SHORT[d.type] ? t(DOC_SHORT[d.type]!) : d.title}
                      </Text>
                      <StatusSymbol tone={r.tone} size={18} />
                      <Text variant="small" style={{ width: 92 }} tint={r.tone === 'danger' ? color.danger : color.ink}>
                        {r.label}
                      </Text>
                      <Text variant="caption" tint={color.text2} style={{ flex: 1 }}>
                        {inEastern(d.uploadedAt, true)}
                      </Text>
                      {fileId ? <Icon name="file-document-outline" size={20} tint={color.text2} /> : null}
                    </Pressable>
                  );
                })}
                {missing.map((m) => (
                  <View key={m} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.divider }}>
                    <Text variant="smallStrong" style={{ width: 56 }}>
                      {DOC_SHORT[m] ? t(DOC_SHORT[m]!) : m}
                    </Text>
                    <StatusSymbol tone="danger" size={18} />
                    <Text variant="small" tint={color.danger} style={{ width: 92 }}>
                      {t('Missing')}
                    </Text>
                    <Text variant="caption" tint={color.text2} style={{ flex: 1 }}>
                      —
                    </Text>
                  </View>
                ))}
                {!docs.length && !missing.length ? (
                  <Text variant="small" tint={color.text2}>
                    {t('No documents yet.')}
                  </Text>
                ) : null}
              </Section>

              <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.lg }}>
                <Button style={{ flex: 1 }} variant="outline" label={t('Message driver')} loading={busy === 'message'} disabled={!l.driverId} onPress={() => void messageDriver(l)} />
                {mayEdit ? (
                  <Button style={{ flex: 1 }} label={t('Update status')} icon="chevron-down" disabled={!nextStatuses.length} onPress={() => setStatusOpen(true)} />
                ) : null}
              </View>
              {!l.driverId ? (
                <Text variant="caption" tint={color.text3} style={{ marginTop: space.xs }}>
                  {t('No driver on this load to message.')}
                </Text>
              ) : null}

              <Sheet visible={statusOpen} title={t('Move load {number} to', { number: l.loadNumber })} onClose={() => setStatusOpen(false)}>
                {nextStatuses.map((s, i) => {
                  const w = loadStatus(s);
                  return (
                    <ListRow
                      key={s}
                      left={<StatusSymbol tone={w.tone} size={20} />}
                      title={t(w.label)}
                      chevron={false}
                      divider={i < nextStatuses.length - 1}
                      right={busy === s ? <Text variant="caption">{t('Saving…')}</Text> : null}
                      onPress={() => void changeStatus(l, s)}
                    />
                  );
                })}
                <Divider />
                <Text variant="caption" tint={color.text3} style={{ paddingVertical: space.md }}>
                  {t('The TMS checks the stops and paperwork; a move it refuses says why.')}
                </Text>
              </Sheet>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
