import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { routes, type DriverLoadDetail, type DriverStop, type DriverStopEventRequest } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { QueueItemRow } from '@/features/components';
import { dueLabel } from '@/features/driver/home';
import { appointment, driverDocumentTone, loadStatus, nextStop, placeOf, sortedStops } from '@/features/loads';
import { inEastern, inStopZone, now } from '@/lib/clock';
import { openSignedLink } from '@/lib/open-file';
import { uuid } from '@/lib/uuid';
import { useQueue } from '@/offline/queue';
import { Button } from '@/ui/controls';
import { KeyValue, Screen, Section, Timeline, useToast } from '@/ui/layout';
import { Divider, Icon, StatusPill, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, space } from '@/ui/tokens';
import { t, tn } from '@/i18n';

/** What the driver confirms next at a stop: arrival, then departure (pickup) or completion (delivery). */
function stopAction(stop: DriverStop | undefined): { kind: DriverStopEventRequest['kind']; label: string; done: string } | null {
  if (!stop) return null;
  if (!stop.arrivedAt) return { kind: 'arrived', label: t('Confirm arrival'), done: t('Arrived') };
  return stop.kind === 'pickup' ? { kind: 'departed', label: t('Confirm departure'), done: t('Departed') } : { kind: 'completed', label: t('Confirm delivery'), done: t('Delivered') };
}

/**
 * Sheet 03 — GET /driver/loads/:id. Stop times in each stop's own zone, Eastern beside them when it
 * differs. Arrival / departure / acknowledgement go through the queue with the actual time, so a
 * driver without signal still records when it happened.
 */
export default function LoadDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useResource<DriverLoadDetail>(routes.driverLoad(id));
  const queue = useQueue();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const mine = queue.items.filter((i) => (i.payload as { loadId?: string }).loadId === id && i.status !== 'received');

  const openFile = async (fileId: string) => {
    try {
      await openSignedLink(routes.driverFileLink(fileId));
    } catch {
      toast(t('Could not open the file.'), 'warning');
    }
  };

  return (
    <Screen back onRefresh={load.reload}>
      <ResourceView resource={load} what={t('This load')}>
        {(l) => {
          const stops = sortedStops(l.stops);
          const next = nextStop(stops);
          const action = stopAction(next);
          const status = loadStatus(l.status);
          const pendingEvent = mine.some((i) => i.kind === 'stop-event' && (i.payload as { stopId?: string }).stopId === next?.id);
          const pendingAck = mine.some((i) => i.kind === 'load-ack');

          const record = async (kind: 'stop-event' | 'load-ack') => {
            setBusy(kind);
            try {
              if (kind === 'load-ack') {
                await queue.enqueue({ id: uuid(), idempotencyKey: uuid(), kind, title: t('Acknowledged · Load #{number}', { number: l.loadNumber }), payload: { loadId: l.id }, files: [] });
                toast(t('Acknowledgement saved. Dispatch sees it as soon as the phone is online.'), 'success');
              } else if (next && action) {
                await queue.enqueue({
                  id: uuid(),
                  idempotencyKey: uuid(),
                  kind,
                  title: `${action.done} · ${placeOf(next)}`,
                  subtitle: `${t('Load #{number}', { number: l.loadNumber })} · ${inStopZone(now().toISOString(), next.timezone)}`,
                  payload: { loadId: l.id, stopId: next.id, kind: action.kind, at: now().toISOString() },
                  files: [],
                });
                toast(t('Saved with the time it happened. It reaches dispatch as soon as the phone is online.'), 'success');
              }
            } finally {
              setBusy(null);
            }
          };

          return (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                <Text variant="title">{t('Load #{number}', { number: l.loadNumber })}</Text>
                <StatusPill tone={status.tone} label={t(l.statusLabel || status.label)} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs }}>
                <Text variant="small">{placeOf(l.firstPickup)}</Text>
                <Icon name="arrow-right" size={16} tint={color.text2} />
                <Text variant="small">{placeOf(l.lastDelivery)}</Text>
              </View>
              <Text variant="caption" tint={color.text2} style={{ marginTop: 2 }}>
                {[l.truckUnit ? t('Truck {unit}', { unit: l.truckUnit }) : null, l.trailerUnit ? t('Trailer {unit}', { unit: l.trailerUnit }) : null, tn(l.stopCount, '{count} stop', '{count} stops'), l.loadedMiles ? t('Loaded {miles} mi', { miles: l.loadedMiles.toLocaleString('en-US') }) : null, l.deadheadMiles ? t('DH {miles} mi', { miles: l.deadheadMiles.toLocaleString('en-US') }) : null,].filter(Boolean).join('  •  ')}
              </Text>

              {!l.acknowledgedAt ? (
                <Button
                  style={{ marginTop: space.md }}
                  variant="outline"
                  icon="check"
                  label={pendingAck ? t('Acknowledgement saved') : t('Acknowledge load')}
                  disabled={pendingAck}
                  loading={busy === 'load-ack'}
                  onPress={() => void record('load-ack')}
                />
              ) : null}

              <Section>
                <Timeline
                  steps={stops.map((s, i) => {
                    const when = appointment(s);
                    const state = s.status === 'completed' || s.departedAt ? 'done' : s.id === next?.id ? 'current' : 'pending';
                    const actual = s.departedAt ? t('Departed {time}', { time: inStopZone(s.departedAt, s.timezone) }) : s.arrivedAt ? t('Arrived {time}', { time: inStopZone(s.arrivedAt, s.timezone) }) : null;
                    return {
                      key: s.id,
                      state,
                      title: `${i + 1}. ${s.kind === 'pickup' ? t('Pickup') : t('Delivery')}${state === 'done' ? ` ${t('(completed)')}` : state === 'current' ? ` ${t('(next)')}` : ''}`,
                      subtitle: [s.facilityName, s.address, `${placeOf(s)}${s.zip ? ` ${s.zip}` : ''}`].filter(Boolean).join('\n'),
                      detail: [actual, s.reference ? t('Ref {ref}', { ref: s.reference }) : null, s.notes].filter(Boolean).join('\n') || null,
                      right: (
                        <View style={{ alignItems: 'flex-end', maxWidth: 140 }}>
                          {when.local ? (
                            <Text variant="smallStrong" style={{ textAlign: 'right' }}>
                              {when.local}
                            </Text>
                          ) : null}
                          {when.eastern ? (
                            <Text variant="caption" tint={color.text3} style={{ textAlign: 'right' }}>
                              {when.eastern}
                            </Text>
                          ) : null}
                        </View>
                      ),
                    };
                  })}
                />
              </Section>

              <Section>
                <Divider />
                {l.reference ? <KeyValue label={t('Reference number')} value={l.reference} /> : null}
                {l.dispatch ? (
                  <KeyValue
                    label={t('Dispatch contact')}
                    last
                    value={
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <View style={{ flex: 1 }}>
                          <Text variant="small">{l.dispatch.name}</Text>
                          {l.dispatch.phone ? (
                            <Text variant="small" tint={color.link}>
                              {l.dispatch.phone}
                            </Text>
                          ) : null}
                        </View>
                        {l.dispatch.phone ? (
                          <Pressable accessibilityRole="button" accessibilityLabel={t('Call {name}', { name: l.dispatch.name })} hitSlop={10} onPress={() => void Linking.openURL(`tel:${l.dispatch!.phone}`)}>
                            <Icon name="phone-outline" size={22} tint={color.link} />
                          </Pressable>
                        ) : null}
                      </View>
                    }
                  />
                ) : null}
              </Section>

              <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.lg }}>
                <Button
                  style={{ flex: 1 }}
                  label={pendingEvent ? t('Saved on phone') : (action?.label ?? t('All stops done'))}
                  disabled={!action || pendingEvent}
                  loading={busy === 'stop-event'}
                  onPress={() => void record('stop-event')}
                />
                <Button style={{ flex: 1 }} variant="outline" label={t('Report issue')} onPress={() => router.push({ pathname: '/driver/report-problem', params: { loadId: l.id } })} />
              </View>

              {l.driverNotes.length ? (
                <Section title={t('Notes from dispatch')}>
                  {l.driverNotes.map((n) => (
                    <View key={n.id} style={{ paddingVertical: space.sm }}>
                      <Text variant="small">{n.body}</Text>
                      <Text variant="caption" tint={color.text3}>
                        {n.authorName} · {inEastern(n.at, true)}
                      </Text>
                    </View>
                  ))}
                </Section>
              ) : null}

              <Section
                title={t('Documents')}
                action={t('Scan')}
                onAction={() => router.push({ pathname: '/driver/scan', params: { loadId: l.id, type: l.documentsDue[0]?.type ?? (next?.kind === 'pickup' ? 'bol' : 'pod'), stopId: l.documentsDue[0]?.stopId ?? next?.id ?? '' } })}
              >
                {l.documentsDue.map((due) => (
                  <View key={`${due.type}${due.stopId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm }}>
                    <StatusPill tone="warning" label={t('Due')} />
                    <Text variant="small" style={{ flex: 1 }}>
                      {dueLabel(due.label)}
                    </Text>
                  </View>
                ))}
                {l.documents.length === 0 && mine.length === 0 && l.documentsDue.length === 0 ? <EmptyState compact icon="file-document-outline" title={t('No documents yet')} /> : null}
                {l.documents.map((d, i) => (
                  <View key={d.id}>
                    <Divider />
                    <Pressable accessibilityRole="button" disabled={!d.fileId} onPress={() => d.fileId && void openFile(d.fileId)} style={{ paddingVertical: space.md, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <Text variant="bodyStrong" style={{ flex: 1 }}>
                          {d.title}
                        </Text>
                        <StatusPill tone={driverDocumentTone(d.state)} label={t(d.stateLabel)} />
                      </View>
                      <Text variant="caption" tint={color.text2}>
                        {[d.fileName, d.pageCount ? tn(d.pageCount, '{count} page', '{count} pages') : null, inEastern(d.uploadedAt, true)].filter(Boolean).join(' · ')}
                      </Text>
                      {d.correctionReason ? (
                        <Text variant="small" tint={color.danger}>
                          {d.correctionReason}
                        </Text>
                      ) : null}
                    </Pressable>
                    {d.state === 'correction_requested' && d.mine ? (
                      <Button
                        variant="link"
                        icon="camera-retake-outline"
                        label={t('Send a corrected copy')}
                        onPress={() => router.push({ pathname: '/driver/scan', params: { loadId: l.id, type: d.type, stopId: d.stopId ?? '', replacesId: d.id } })}
                      />
                    ) : null}
                    {i === l.documents.length - 1 && mine.length ? <Divider /> : null}
                  </View>
                ))}
                {mine.map((item, i) => (
                  <QueueItemRow key={item.id} item={item} divider={i < mine.length - 1} onRetry={() => void queue.retry(item.id)} />
                ))}
              </Section>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
