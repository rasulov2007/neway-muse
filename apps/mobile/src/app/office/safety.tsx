import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { api } from '@/api/client';
import { routes, type OfficeToday, type PtiBoard, type PtiBoardRow } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { AttentionList } from '@/features/office/attention';
import { errorText, isConflict, OmittedNotes } from '@/features/office/common';
import { inEastern } from '@/lib/clock';
import { humanize } from '@/lib/format';
import { Button } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { StatusPill, Text } from '@/ui/primitives';
import { Pager, ReasonSheet, StatTile } from '@/ui/sheets';
import { EmptyState, ResourceView } from '@/ui/states';
import { t, tn } from '@/i18n';
import { color, space } from '@/ui/tokens';

type Focus = 'pti' | 'documents' | 'incidents';

function awaitingReview(row: PtiBoardRow): boolean {
  const i = row.inspection;
  return (i.receiptStatus === 'received' || i.receiptStatus === 'late') && i.reviewState !== 'reviewed';
}

function PtiCard({ row, onDone }: { row: PtiBoardRow; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const i = row.inspection;
  const sub = i.driverSubmission ?? null;
  const flagged = sub ? sub.checklist.filter((c) => c.result !== 'good') : [];
  const componentName = (key: string) => row.openDefects.find((d) => d.component === key)?.componentName ?? humanize(key);
  const flaggedPhotos = new Set(flagged.flatMap((c) => c.photoFileIds));
  const otherPhotos = (sub?.photos ?? []).filter((p) => !flaggedPhotos.has(p));

  const markReviewed = async () => {
    setBusy(true);
    try {
      await api.post(routes.ptiReview(i.id), {
        version: i.version,
        result: 'no_issues',
        receivedAt: null,
        source: null,
        dispositions: row.openDefects.map((d) => ({ defectId: d.id, seen: 'still_present' })),
        defects: [],
      });
      toast(t('PTI for unit {number} marked reviewed.', { number: i.unitNumber }), 'success');
      onDone();
    } catch (e) {
      toast(isConflict(e) ? t('Someone changed this inspection — reloaded.') : errorText(e), 'danger');
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const requestCorrection = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(routes.ptiRequestCorrection(i.id), { version: i.version, reason });
      setAsking(false);
      toast(t('Sent back to the driver with your reason.'), 'success');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subheading">{i.driverName ?? t('No driver on file')}</Text>
          <Text variant="caption" tint={color.text2}>
            {t('Unit {number}', { number: i.unitNumber })}
            {sub?.trailerUnit ? ` · ${t('Trailer {number}', { number: sub.trailerUnit })}` : ''}
          </Text>
          {i.receivedAt ? (
            <Text variant="caption" tint={color.text2}>
              {t('Submitted {when}', { when: inEastern(i.receivedAt, true) })}
              {sub && sub.submissionNumber > 1 ? ` · ${t('resubmission {n}', { n: sub.submissionNumber })}` : ''}
            </Text>
          ) : null}
        </View>
        <StatusPill tone="warning" label={i.reviewState === 'in_review' ? t('In review') : t('Awaiting review')} />
      </View>

      {!sub ? (
        <Text variant="small" tint={color.text2}>
          {t('This walk-around arrived outside the app (video). Watch it in the TMS PTI board before marking it reviewed.')}
        </Text>
      ) : flagged.length === 0 ? (
        <Text variant="small" tint={color.text2}>
          {t('The driver marked every item Good.')}
        </Text>
      ) : (
        flagged.map((c) => (
          <View key={c.key} style={{ gap: space.xs, marginTop: space.xs }}>
            <Text variant="smallStrong">
              {componentName(c.key)} ({c.result === 'defect' ? t('defect') : t('needs attention')})
            </Text>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              {c.photoFileIds[0] ? <SignedImage linkRoute={routes.fileLink(c.photoFileIds[0])} label={t('{name} photo', { name: componentName(c.key) })} style={{ width: 150, height: 110 }} /> : null}
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="caption" tint={color.text2}>
                  {t('Driver comment')}
                </Text>
                <Text variant="small">{c.note ?? '—'}</Text>
              </View>
            </View>
            {c.photoFileIds.length > 1 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {c.photoFileIds.slice(1).map((f) => (
                  <SignedImage key={f} linkRoute={routes.fileLink(f)} style={{ width: 72, height: 54 }} />
                ))}
              </View>
            ) : null}
          </View>
        ))
      )}
      {sub?.notes ? (
        <View style={{ gap: 2 }}>
          <Text variant="caption" tint={color.text2}>
            {t('Notes')}
          </Text>
          <Text variant="small">{sub.notes}</Text>
        </View>
      ) : null}
      {otherPhotos.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {otherPhotos.map((f) => (
            <SignedImage key={f} linkRoute={routes.fileLink(f)} style={{ width: 72, height: 54 }} />
          ))}
        </View>
      ) : null}
      {row.openDefects.length ? (
        <Text variant="caption" tint={color.text2}>
          {tn(row.openDefects.length, '{count} open defect on this unit stays open; Mark reviewed records it as still present.', '{count} open defects on this unit stay open; Mark reviewed records them as still present.')}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.sm }}>
        {sub ? <Button compact style={{ flex: 1 }} variant="outline" label={t('Request correction')} disabled={busy} onPress={() => setAsking(true)} /> : null}
        <Button compact style={{ flex: 1 }} label={t('Mark reviewed')} loading={busy && !asking} onPress={() => void markReviewed()} />
      </View>
      <ReasonSheet
        visible={asking}
        title={t('Request correction')}
        body={t('The driver reads this reason and redoes the walk-around.')}
        placeholder={t('Say what the driver should redo')}
        confirmLabel={t('Send to driver')}
        busy={busy}
        error={error}
        onClose={() => setAsking(false)}
        onConfirm={(r) => void requestCorrection(r)}
      />
    </Panel>
  );
}

/**
 * Sheet 19 — PTI awaiting review (the Fleet PTI board, GET /fleet/pti/board), expiring documents
 * and incidents (GET /office/today?role=safety). Mark reviewed / Request correction are the
 * existing PTI review routes.
 */
export default function SafetyWorkspace() {
  const params = useLocalSearchParams<{ inspection?: string }>();
  const today = useResource<OfficeToday>(routes.officeToday('safety'));
  const board = useResource<PtiBoard>(routes.ptiBoard);
  const [focus, setFocus] = useState<Focus>('pti');
  const [index, setIndex] = useState(0);

  const queue = useMemo(() => (board.status === 'ready' ? board.data.rows.filter(awaitingReview) : []), [board]);
  useEffect(() => {
    if (!params.inspection || !queue.length) return;
    const at = queue.findIndex((r) => r.inspection.id === params.inspection);
    if (at >= 0) {
      setFocus('pti');
      setIndex(at);
    }
  }, [params.inspection, queue]);
  const at = Math.min(index, Math.max(0, queue.length - 1));

  const counter = (key: string) => (today.status === 'ready' ? (today.data.sections.flatMap((s) => s.counters).find((c) => c.key === key)?.value ?? null) : null);
  const items = today.status === 'ready' ? today.data.attention : [];
  const docs = items.filter((a) => a.kind === 'document_expiring');
  const incidents = items.filter((a) => a.kind === 'accident_urgent');

  return (
    <Screen
      back
      title={t('Safety')}
      subtitle={t('Keep drivers, equipment and compliance on track.')}
      onRefresh={() => {
        today.reload();
        board.reload();
      }}
    >
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <StatTile value={counter('pti_awaiting_review')} label={t('Awaiting PTI review')} tone="danger" selected={focus === 'pti'} onPress={() => setFocus('pti')} />
        <StatTile value={counter('expiring_documents')} label={t('Expiring documents')} tone="warning" selected={focus === 'documents'} onPress={() => setFocus('documents')} />
        <StatTile value={counter('open_incidents')} label={t('Open incidents')} tone="danger" selected={focus === 'incidents'} onPress={() => setFocus('incidents')} />
      </View>

      {focus === 'pti' ? (
        <Section>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
            <Text variant="subheading" accessibilityRole="header" style={{ flex: 1 }}>
              {t('Pending PTI review')}
            </Text>
            {queue.length ? <Pager index={at} total={queue.length} onChange={setIndex} /> : null}
          </View>
          <ResourceView resource={board} what={t('The PTI board')}>
            {() =>
              queue.length ? (
                <>
                  <PtiCard key={queue[at]!.inspection.id} row={queue[at]!} onDone={board.reload} />
                </>
              ) : (
                <EmptyState compact icon="clipboard-check-outline" title={t('No PTI waiting for review')} />
              )
            }
          </ResourceView>
        </Section>
      ) : (
        <Section title={focus === 'documents' ? t('Expiring documents') : t('Open incidents')}>
          <ResourceView resource={today} what={t('Safety')}>
            {(d) => (
              <>
                {focus === 'documents' ? (
                  docs.length ? <AttentionList items={docs} /> : <EmptyState compact icon="file-check-outline" title={t('No documents expiring')} />
                ) : incidents.length ? (
                  <AttentionList items={incidents} />
                ) : (
                  <Text variant="small" tint={color.text2}>
                    {counter('open_incidents') ? t('The case list lives in Safety → Accidents in the TMS; none is marked urgent.') : t('No open incidents.')}
                  </Text>
                )}
                <OmittedNotes omitted={d.omitted} />
              </>
            )}
          </ResourceView>
        </Section>
      )}
    </Screen>
  );
}
