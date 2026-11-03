import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { routes, type DriverPtiCurrent, type DriverPtiSubmitRequest } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { t, tn } from '@/i18n';
import { inEastern } from '@/lib/clock';
import { dayLabel, weekdayOf } from '@/lib/format';
import { asQueueFile, type PickedMedia } from '@/lib/media';
import { uuid } from '@/lib/uuid';
import { useQueue } from '@/offline/queue';
import { Button, ListRow, TextField } from '@/ui/controls';
import { KeyValue, Panel, Screen, Section, useToast } from '@/ui/layout';
import { MediaStrip } from '@/ui/media';
import { Divider, StatusPill, StatusSymbol, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, radius, space, type StatusTone } from '@/ui/tokens';

type Result = 'good' | 'attention' | 'defect';

const RESULTS: Array<{ value: Result; label: string; tone: StatusTone }> = [
  { value: 'good', label: 'Good', tone: 'success' },
  { value: 'attention', label: 'Attention', tone: 'warning' },
  { value: 'defect', label: 'Defect', tone: 'danger' },
];

const STATE_TONE: Record<string, StatusTone> = {
  not_submitted: 'neutral',
  received: 'info',
  in_review: 'info',
  reviewed: 'success',
  correction_requested: 'danger',
};

const MAX_NOTES = 2000;
/** The server raises a defect only with a description of at least this many characters. */
const DEFECT_NOTE_MIN = 8;

const toneColor = (x: StatusTone) => (x === 'success' ? color.success : x === 'warning' ? color.warning : color.danger);
const toneBg = (x: StatusTone) => (x === 'success' ? color.successBg : x === 'warning' ? color.warningBg : color.dangerBg);

/**
 * Sheet 10 — the weekly walk-around (GET /driver/pti/current, POST /driver/pti). The checklist comes
 * from the server; every item starts unanswered (nothing is pre-marked Good). An item marked
 * Attention or Defect takes a note and photos (each photo is filed on that item). It is saved on the
 * phone first and sent through the queue, then shows as Received — Needs review for Safety; a
 * correction Safety asks for comes back here with its reason, and the driver sends it again.
 */
export default function PreTrip() {
  const current = useResource<DriverPtiCurrent>(routes.driverPtiCurrent);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [itemPhotos, setItemPhotos] = useState<Record<string, PickedMedia[]>>({});
  const [photos, setPhotos] = useState<PickedMedia[]>([]);
  const [notes, setNotes] = useState('');
  const [odometer, setOdometer] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();
  const queued = queue.items.find((i) => i.kind === 'pti' && i.status !== 'received');

  return (
    <Screen
      back
      title={t('Pre-trip inspection')}
      titleRight={
        current.status === 'ready' ? (
          <Text variant="small" tint={color.text2} style={{ marginTop: 6 }}>
            {dayLabel(current.data.today)}
          </Text>
        ) : null
      }
      onRefresh={current.reload}
    >
      <ResourceView resource={current} what={t('Your inspection')}>
        {(p) => {
          if (!p.truck) return <EmptyState icon="truck-outline" title={t('No truck assigned')} body={t('There is nothing to inspect until dispatch assigns you a truck.')} />;
          const answered = p.checklist.every((c) => results[c.key]);
          const shortDefects = p.checklist.filter((c) => results[c.key] === 'defect' && (itemNotes[c.key]?.trim().length ?? 0) < DEFECT_NOTE_MIN);
          const odometerValue = odometer.trim() ? Number(odometer.replace(/[^\d]/g, '')) : null;
          const last = p.submission;

          const save = async () => {
            setBusy(true);
            try {
              const key = uuid();
              const tagged = p.checklist.flatMap((c) => (results[c.key] && results[c.key] !== 'good' ? (itemPhotos[c.key] ?? []).map((m) => ({ ...m, tag: c.key })) : []));
              const body: DriverPtiSubmitRequest = {
                checklist: p.checklist.map((c) => ({ key: c.key, result: results[c.key]!, note: itemNotes[c.key]?.trim() || null, photoFileIds: [] })),
                notes: notes.trim() || null,
                odometer: odometerValue,
                ...(p.inspection ? { version: p.inspection.version } : {}),
              };
              const flagged = body.checklist.filter((c) => c.result !== 'good').length;
              await queue.enqueue({
                id: uuid(),
                idempotencyKey: key,
                kind: 'pti',
                title: p.trailer ? t('Pre-trip · Truck {truck} / Trailer {trailer}', { truck: p.truck!.unitNumber, trailer: p.trailer.unitNumber }) : t('Pre-trip · Truck {truck}', { truck: p.truck!.unitNumber }),
                subtitle: flagged ? tn(flagged, '{count} item reported', '{count} items reported') : t('All items good'),
                payload: body as unknown as Record<string, unknown>,
                files: [...tagged, ...photos].map(asQueueFile),
              });
              toast(t('Inspection saved. Safety receives it as soon as the phone is online.'), 'success');
              router.replace('/driver/uploads');
            } finally {
              setBusy(false);
            }
          };

          return (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                <Text variant="small" tint={color.text2}>
                  {t('Truck {unit}', { unit: p.truck.unitNumber })}
                  {p.trailer ? ` · ${t('Trailer {unit}', { unit: p.trailer.unitNumber })}` : ''} · {t('due')} {/^\d{4}-\d{2}-\d{2}$/.test(p.dueAt) ? `${weekdayOf(p.dueAt).slice(0, 3)}, ${dayLabel(p.dueAt)}` : inEastern(p.dueAt, true)}
                </Text>
                <StatusPill tone={STATE_TONE[p.state] ?? 'neutral'} label={t(p.stateLabel)} />
              </View>

              {p.correction && !p.correction.answeredAt ? (
                <Panel style={{ marginTop: space.md, borderColor: color.danger, backgroundColor: color.dangerBg }}>
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <StatusSymbol tone="danger" size={18} />
                    <View style={{ flex: 1 }}>
                      <Text variant="smallStrong" tint={color.danger}>
                        {t('Safety asked for a correction')}
                      </Text>
                      <Text variant="small" tint={color.danger}>
                        {p.correction.reason}
                      </Text>
                      <Text variant="caption" tint={color.danger}>
                        {inEastern(p.correction.requestedAt, true)} · {t('fix it below and send it again')}
                      </Text>
                    </View>
                  </View>
                </Panel>
              ) : null}

              {last ? (
                <Section title={t('Last sent')}>
                  <Divider />
                  <KeyValue label={t('Submission')} value={`#${last.submissionNumber} · ${inEastern(last.submittedAt, true)}`} />
                  <KeyValue label={t('Items reported')} value={t('{count} of {total}', { count: last.checklist.filter((c) => c.result !== 'good').length, total: last.checklist.length })} />
                  <KeyValue
                    label={t('Review')}
                    last={!p.inspection?.reviewerName && p.history.length < 2}
                    value={p.inspection?.reviewerName ? `${t(p.stateLabel)} · ${p.inspection.reviewerName}` : t(p.stateLabel)}
                  />
                  {p.history.length > 1 ? <KeyValue label={t('Earlier this week')} value={tn(p.history.length - 1, '{count} earlier submission kept', '{count} earlier submissions kept')} last /> : null}
                </Section>
              ) : null}

              {p.defects.length ? (
                <Section title={t('Open defects')}>
                  {p.defects.map((d, i) => (
                    <ListRow
                      key={d.id}
                      title={`${d.componentName} · ${d.defectNumber}`}
                      subtitle={d.description}
                      meta={d.workOrderNumber ? t('Work order {number}', { number: d.workOrderNumber }) : undefined}
                      right={<StatusPill tone="warning" label={t(d.stateLabel)} />}
                      chevron={false}
                      divider={i < p.defects.length - 1}
                    />
                  ))}
                </Section>
              ) : null}

              {queued ? (
                <Section>
                  <Text variant="small" tint={color.text2}>
                    {t('Your inspection is saved on this phone and waiting to upload.')}
                  </Text>
                </Section>
              ) : p.canSubmit ? (
                <>
                  <Section title={t('Checklist')}>
                    {p.checklist.map((item) => {
                      const value = results[item.key];
                      const noteShort = value === 'defect' && (itemNotes[item.key]?.trim().length ?? 0) < DEFECT_NOTE_MIN;
                      return (
                        <View key={item.key}>
                          <View style={{ paddingVertical: space.md, gap: space.sm }}>
                            <Text variant="bodyStrong">{t(item.label)}</Text>
                            <View style={{ flexDirection: 'row', gap: space.sm }}>
                              {RESULTS.map((r) => {
                                const on = value === r.value;
                                return (
                                  <Pressable
                                    key={r.value}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: on }}
                                    accessibilityLabel={`${t(item.label)}: ${t(r.label)}`}
                                    onPress={() => setResults((x) => ({ ...x, [item.key]: r.value }))}
                                    style={{
                                      flex: 1,
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: 4,
                                      minHeight: 44,
                                      borderRadius: radius.md,
                                      borderWidth: 1,
                                      borderColor: on ? toneColor(r.tone) : color.border,
                                      backgroundColor: on ? toneBg(r.tone) : color.background,
                                    }}
                                  >
                                    {on ? <StatusSymbol tone={r.tone} size={14} /> : null}
                                    <Text variant="smallStrong" tint={on ? toneColor(r.tone) : color.text2}>
                                      {t(r.label)}
                                    </Text>
                                  </Pressable>
                                );
                              })}
                            </View>
                            {value && value !== 'good' ? (
                              <>
                                <TextField
                                  placeholder={t('What did you find?')}
                                  value={itemNotes[item.key] ?? ''}
                                  onChangeText={(v) => setItemNotes((x) => ({ ...x, [item.key]: v.slice(0, 1000) }))}
                                  error={noteShort && (itemNotes[item.key]?.length ?? 0) > 0 ? t('Describe the defect (at least {min} characters).', { min: DEFECT_NOTE_MIN }) : null}
                                />
                                <MediaStrip
                                  items={itemPhotos[item.key] ?? []}
                                  onChange={(m) => setItemPhotos((x) => ({ ...x, [item.key]: m }))}
                                  max={5}
                                  prefix={`pti-${item.key}`}
                                  tag={item.key}
                                  size={84}
                                />
                              </>
                            ) : null}
                          </View>
                          <Divider />
                        </View>
                      );
                    })}
                  </Section>

                  <Section title={t('Photos of the walk-around (optional)')}>
                    <MediaStrip items={photos} onChange={setPhotos} max={10} prefix="pti" />
                  </Section>

                  <Section style={{ gap: space.md }}>
                    <TextField label={t('Odometer (optional)')} value={odometer} onChangeText={setOdometer} keyboardType="number-pad" placeholder={t('Miles')} />
                    <TextField
                      label={t('Notes')}
                      value={notes}
                      onChangeText={(v) => setNotes(v.slice(0, MAX_NOTES))}
                      multiline
                      placeholder={t('Anything Safety should know')}
                      hint={`${notes.length}/${MAX_NOTES}`}
                    />
                  </Section>
                  <Button
                    style={{ marginTop: space.lg }}
                    label={p.correction && !p.correction.answeredAt ? t('Send corrected inspection') : t('Save inspection')}
                    disabled={!answered || shortDefects.length > 0}
                    loading={busy}
                    onPress={save}
                  />
                  {!answered || shortDefects.length ? (
                    <Text variant="small" tint={color.text2} style={{ marginTop: space.sm, textAlign: 'center' }}>
                      {!answered ? t('Answer every item to save.') : t('Describe each defect in at least {min} characters.', { min: DEFECT_NOTE_MIN })}
                    </Text>
                  ) : null}
                </>
              ) : (
                <EmptyState compact icon="clipboard-check-outline" title={t('Nothing to send now')} body={t("This week's inspection is with Safety.")} />
              )}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
