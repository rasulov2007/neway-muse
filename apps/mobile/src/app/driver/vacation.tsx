import { useState } from 'react';
import { View, StyleSheet } from 'react-native';

import { routes, type DriverVacationRequestList, type DriverVacationRequestView } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { CheckRow, requestTone } from '@/features/driver/common';
import { QueueItemRow } from '@/features/components';
import { driverPostItem, refOf } from '@/features/submit';
import { t, tn } from '@/i18n';
import { easternDay, inEastern } from '@/lib/clock';
import { dayLabel, daysBetween, weekdayOf } from '@/lib/format';
import type { PickedMedia } from '@/lib/media';
import { useQueue } from '@/offline/queue';
import { Button, DateField, ListRow, Sheet, TextField } from '@/ui/controls';
import { Panel, Screen, Section, Timeline, useToast } from '@/ui/layout';
import { MediaStrip } from '@/ui/media';
import { Icon, StatusPill, StatusSymbol, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, radius, space } from '@/ui/tokens';

function DayCard({ label, day }: { label: string; day: string }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text variant="caption" tint={color.text2}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
        <Icon name="calendar-blank-outline" size={22} tint={color.text2} />
        <View>
          <Text variant="bodyStrong">{dayLabel(day)}</Text>
          <Text variant="caption" tint={color.text2}>
            {weekdayOf(day)}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** The request as on sheet 11: dates, days and status, then the server's steps. */
function VacationCard({ v, onCancel, onParked, pending }: { v: DriverVacationRequestView; onCancel: () => void; onParked: () => void; pending: boolean }) {
  const steps = v.steps.filter((s) => s.step !== 'requested' && s.step !== 'decided');
  return (
    <View style={{ gap: space.md }}>
      <View style={{ borderRadius: radius.lg, backgroundColor: color.subtle, padding: space.md, gap: space.md }}>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <DayCard label={t('From')} day={v.from} />
          <DayCard label={t('Until')} day={v.to} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.divider, paddingTop: space.md }}>
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            {tn(daysBetween(v.from, v.to), '{count} day', '{count} days')}
          </Text>
          <StatusPill tone={requestTone('vacation', v.status)} label={t(v.statusLabel)} />
        </View>
      </View>
      {v.decidedReason ? (
        <Panel style={{ borderColor: v.status === 'rejected' ? color.danger : color.border, backgroundColor: v.status === 'rejected' ? color.dangerBg : color.background }}>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <StatusSymbol tone={v.status === 'rejected' ? 'danger' : 'info'} size={18} />
            <Text variant="small" tint={v.status === 'rejected' ? color.danger : color.ink} style={{ flex: 1 }}>
              {v.decidedReason}
            </Text>
          </View>
        </Panel>
      ) : null}
      {v.status !== 'rejected' && v.status !== 'cancelled' ? (
        <Timeline
          steps={[
            ...v.steps
              .filter((s) => s.step === 'requested' || s.step === 'decided')
              .map((s) => ({ key: s.step, title: s.step === 'decided' && !s.at ? t('Waiting for dispatch') : t(s.label), state: (s.at ? 'done' : 'current') as 'done' | 'current', subtitle: s.at ? inEastern(s.at, true) : null, detail: s.by })),
            ...steps.map((s) => ({
              key: s.step,
              title: t(s.label),
              state: (s.at ? 'done' : 'pending') as 'done' | 'pending',
              subtitle: s.at ? inEastern(s.at, true) : s.step === 'return_review' ? t('To be completed after return') : null,
              detail: [s.by, s.note].filter(Boolean).join(' · ') || null,
              right:
                s.step === 'return_review' ? (
                  <StatusPill tone={v.returnReview ? 'info' : 'warning'} label={v.returnReview?.label ? t(v.returnReview.label) : t('Pending')} />
                ) : null,
            })),
          ]}
        />
      ) : null}
      <Panel tinted>
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Icon name="calendar-check-outline" size={22} tint={color.text2} />
          <View>
            <Text variant="caption" tint={color.text2}>
              {t('Last day of vacation')}
            </Text>
            <Text variant="bodyStrong">
              {dayLabel(v.to)} <Text variant="small" tint={color.text2}>{weekdayOf(v.to)}</Text>
            </Text>
          </View>
        </View>
      </Panel>
      {v.note ? (
        <Text variant="small" tint={color.text2}>
          {t('Your note: {note}', { note: v.note })}
        </Text>
      ) : null}
      {pending ? (
        <Text variant="small" tint={color.text2}>
          {t('Your last change is saved on the phone and waiting to upload.')}
        </Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {v.canConfirmParked ? <Button icon="truck-check-outline" label={t('Confirm truck parked')} onPress={onParked} /> : null}
          {v.canCancel ? <Button variant="outline" label={t('Cancel request')} onPress={onCancel} /> : null}
        </View>
      )}
    </View>
  );
}

/**
 * Sheet 11. A request (POST /driver/vacations) is only a request: Dispatch approves or rejects it;
 * the vacation itself starts on Dispatch's side. The driver confirms the truck parked (optional
 * photo, keys handed over) after approval. Safety's return review shows its own state word.
 */
export default function Vacation() {
  const list = useResource<DriverVacationRequestList>(routes.driverVacations);
  const queue = useQueue();
  const toast = useToast();
  const today = easternDay();
  const [newOpen, setNewOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [parkedFor, setParkedFor] = useState<DriverVacationRequestView | null>(null);
  const [parkedNote, setParkedNote] = useState('');
  const [photo, setPhoto] = useState<PickedMedia[]>([]);
  const [keys, setKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const queued = queue.items.filter((i) => (i.kind === 'vacation' || i.kind === 'vacation-parked' || i.kind === 'vacation-cancel') && i.status !== 'received');

  const request = async () => {
    if (!from || !to) return;
    setBusy(true);
    try {
      await queue.enqueue(
        driverPostItem({
          kind: 'vacation',
          title: t('Vacation request'),
          subtitle: `${dayLabel(from)} – ${dayLabel(to)}`,
          route: routes.driverVacations,
          body: { from, to, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      );
      toast(t('Saved. Dispatch receives it as soon as the phone is online.'), 'success');
      setNewOpen(false);
      setFrom(null);
      setTo(null);
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (v: DriverVacationRequestView) => {
    await queue.enqueue(
      driverPostItem({ kind: 'vacation-cancel', title: t('Cancel vacation request'), subtitle: `${dayLabel(v.from)} – ${dayLabel(v.to)}`, route: routes.driverVacationCancel(v.id), body: {}, ref: { vacationId: v.id } }),
    );
    toast(t('Cancel saved. Dispatch sees it as soon as the phone is online.'), 'success');
  };

  const confirmParked = async () => {
    if (!parkedFor) return;
    setBusy(true);
    try {
      await queue.enqueue(
        driverPostItem({
          kind: 'vacation-parked',
          title: t('Truck parked'),
          subtitle: keys ? t('Keys handed over') : (parkedNote.trim() || null),
          route: routes.driverVacationParked(parkedFor.id),
          body: { keysHandedOver: keys, ...(parkedNote.trim() ? { note: parkedNote.trim() } : {}) },
          files: photo,
          fileField: 'photoFileId',
          fileMode: 'single',
          ref: { vacationId: parkedFor.id },
        }),
      );
      toast(t('Saved. Dispatch sees it as soon as the phone is online.'), 'success');
      setParkedFor(null);
      setParkedNote('');
      setPhoto([]);
      setKeys(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('Vacation request')} onRefresh={list.reload} titleRight={<Button compact icon="plus" label={t('New request')} onPress={() => setNewOpen(true)} />}>
      {queued.length ? (
        <Section title={t('On this phone')} style={{ marginTop: 0 }}>
          {queued.map((item, i) => (
            <QueueItemRow key={item.id} item={item} divider={i < queued.length - 1} onRetry={() => void queue.retry(item.id)} onDiscard={() => void queue.discard(item.id)} />
          ))}
        </Section>
      ) : null}
      <ResourceView resource={list} what={t('Your vacation requests')}>
        {({ vacations }) => {
          if (!vacations.length) return <EmptyState icon="calendar-blank-outline" title={t('No vacation requests')} body={t('Ask for time off with New request. Dispatch approves or rejects it.')} />;
          const sorted = [...vacations].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          const [current, ...older] = sorted;
          const pendingFor = (id: string) => queued.some((q) => refOf(q).vacationId === id);
          return (
            <>
              <VacationCard v={current!} pending={pendingFor(current!.id)} onCancel={() => void cancel(current!)} onParked={() => setParkedFor(current!)} />
              {older.length ? (
                <Section title={t('Earlier requests')}>
                  {older.map((v, i) => (
                    <ListRow
                      key={v.id}
                      title={`${dayLabel(v.from)} – ${dayLabel(v.to)}`}
                      subtitle={`${tn(daysBetween(v.from, v.to), '{count} day', '{count} days')}${v.decidedReason ? ` · ${v.decidedReason}` : ''}`}
                      right={<StatusPill tone={requestTone('vacation', v.status)} label={t(v.statusLabel)} />}
                      chevron={false}
                      divider={i < older.length - 1}
                    />
                  ))}
                </Section>
              ) : null}
            </>
          );
        }}
      </ResourceView>

      <Sheet visible={newOpen} title={t('New vacation request')} onClose={() => setNewOpen(false)}>
        <View style={{ gap: space.md, paddingVertical: space.md }}>
          <DateField label={t('First day')} value={from} onChange={setFrom} today={today} error={from && from < today ? t('Pick today or later.') : null} />
          <DateField label={t('Last day')} value={to} onChange={setTo} today={today} error={from && to && to < from ? t('The last day cannot be before the first.') : null} />
          {from && to && to >= from ? (
            <Text variant="small" tint={color.text2}>
              {tn(daysBetween(from, to), '{count} day', '{count} days')}
            </Text>
          ) : null}
          <TextField label={t('Note (optional)')} value={note} onChangeText={(x) => setNote(x.slice(0, 1000))} multiline />
          <Button label={t('Send request')} disabled={!from || !to || to < from || from < today} loading={busy} onPress={request} />
        </View>
      </Sheet>

      <Sheet visible={Boolean(parkedFor)} title={t('Confirm truck parked')} onClose={() => setParkedFor(null)}>
        <View style={{ gap: space.md, paddingVertical: space.md }}>
          <TextField label={t('Where is it parked? (optional)')} value={parkedNote} onChangeText={(x) => setParkedNote(x.slice(0, 1000))} multiline placeholder={t('Yard, spot, anything dispatch should know')} />
          <Text variant="smallStrong" tint={color.text2}>
            {t('Photo (optional)')}
          </Text>
          <MediaStrip items={photo} onChange={setPhoto} max={1} prefix="parked" />
          <CheckRow label={t('Keys handed over')} value={keys} onChange={setKeys} />
          <Button label={t('Confirm')} loading={busy} onPress={confirmParked} />
        </View>
      </Sheet>
    </Screen>
  );
}
