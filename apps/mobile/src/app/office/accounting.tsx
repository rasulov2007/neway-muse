import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type AccountingReimbursement, type AccountingSettlement, type BillingQueue, type BillingQueueRow, type OfficeToday } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { loadStatus } from '@/features/loads';
import { errorText, Field, isConflict } from '@/features/office/common';
import { PAYMENT_SOURCE_LABEL, REIMBURSEMENT_CATEGORY_LABEL, type PaymentSource, type ReimbursementCategory } from '@neway/shared/accounting/reimbursements';
import { inEastern } from '@/lib/clock';
import { dayLabel, moneyCents } from '@/lib/format';
import { Button, SegmentedTabs } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { StatusPill, Text } from '@/ui/primitives';
import { Pager, ReasonSheet, StatTile } from '@/ui/sheets';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, space, type StatusTone } from '@/ui/tokens';

type Tab = 'pod' | 'reimbursements' | 'settlements';
const TABS: Tab[] = ['pod', 'reimbursements', 'settlements'];

const DOC_LABEL: Record<string, string> = { pod: 'Proof of delivery', bol: 'Bill of lading', lumper_receipt: 'Lumper receipt', tonu: 'TONU', layover: 'Layover', detention: 'Detention', other: 'Document' };

/** One reason sheet for the whole screen: what it sends back, and to which route. */
interface Pending {
  title: string;
  body: string;
  confirm: string;
  run: (reason: string) => Promise<unknown>;
}

function useDecision(onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, call: () => Promise<unknown>, done: string, inSheet = false) => {
    setBusy(key);
    setError(null);
    try {
      await call();
      toast(done, 'success');
      setPending(null);
      onDone();
    } catch (e) {
      const text = isConflict(e) ? t('Someone changed this first — reloaded.') : errorText(e);
      if (inSheet) setError(text);
      else toast(text, 'danger');
      onDone();
    } finally {
      setBusy(null);
    }
  };
  return { busy, pending, setPending, error, run };
}

function PodCard({ row, decision }: { row: BillingQueueRow; decision: ReturnType<typeof useDecision> }) {
  const l = row.load;
  const docs = l.documents.filter((d) => d.source === 'driver_app' && (d.review ?? 'received') === 'received' && !d.supersededBy);
  const pickup = l.stops.find((s) => s.kind === 'pickup');
  const drop = [...l.stops].reverse().find((s) => s.kind === 'delivery');
  const status = loadStatus(l.status);
  return (
    <Panel style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="subheading" style={{ flex: 1 }}>
          {t('Load {number}', { number: l.loadNumber })}
        </Text>
        <StatusPill tone={status.tone} label={t(status.label)} />
      </View>
      <Text variant="caption" tint={color.text2}>
        {[l.brokerReference ? t('Ref {ref}', { ref: l.brokerReference }) : null, l.customerName ?? l.brokerName, l.driverName].filter(Boolean).join(' · ')}
      </Text>
      {pickup && drop ? (
        <Text variant="small">
          {pickup.city}, {pickup.state} → {drop.city}, {drop.state}
        </Text>
      ) : null}
      {l.deliveredAt ? (
        <Text variant="caption" tint={color.text2}>
          {t('Delivered {when}', { when: inEastern(l.deliveredAt, true) })}
        </Text>
      ) : null}
      {row.verdict.conditions.map((c) => (
        <Text key={c.code} variant="caption" tint={color.warning}>
          {c.message}
        </Text>
      ))}
      {docs.length === 0 ? (
        <Text variant="small" tint={color.text2}>
          {t('No driver-app paper waits for review on this load.')}
        </Text>
      ) : (
        docs.map((d) => (
          <View key={d.id} style={{ gap: space.sm, marginTop: space.sm }}>
            <Text variant="smallStrong">
              {DOC_LABEL[d.type] ? t(DOC_LABEL[d.type]!) : d.title} · {d.fileName}
            </Text>
            {d.fileId ? <SignedImage linkRoute={routes.fileLink(d.fileId)} contentType={d.mimeType} label={d.fileName} style={{ width: '100%', height: 180 }} /> : null}
            <Text variant="caption" tint={color.text3}>
              {d.uploadedBy} · {inEastern(d.uploadedAt, true)}
            </Text>
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Button
                compact
                style={{ flex: 1 }}
                variant="outline"
                label={t('Request correction')}
                onPress={() =>
                  decision.setPending({
                    title: t('Request correction'),
                    body: t('The driver reads this reason and sends a corrected copy.'),
                    confirm: t('Send to driver'),
                    run: (reason) => api.post(routes.billingDocumentReview(l.id, d.id), { review: 'rejected', reason, expectedUpdatedAt: l.updatedAt }),
                  })
                }
              />
              <Button
                compact
                style={{ flex: 1 }}
                label={t('Mark reviewed')}
                loading={decision.busy === d.id}
                onPress={() => void decision.run(d.id, () => api.post(routes.billingDocumentReview(l.id, d.id), { review: 'reviewed', expectedUpdatedAt: l.updatedAt }), t('Marked reviewed.'))}
              />
            </View>
          </View>
        ))
      )}
    </Panel>
  );
}

function ReimbursementCard({ e, decision }: { e: AccountingReimbursement; decision: ReturnType<typeof useDecision> }) {
  const r = e.reimbursement;
  return (
    <Panel style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text variant="subheading" style={{ flex: 1 }}>
          {e.description || t('Reimbursement')}
        </Text>
        {e.source === 'driver_app' ? <StatusPill tone="info" label={t('Driver app')} /> : null}
      </View>
      <Text variant="caption" tint={color.text2}>
        {[e.expenseNumber, r?.payerDriverName ?? e.driverName, e.loadNumber ? t('Load {number}', { number: e.loadNumber }) : null, e.unitNumber ? t('Unit {number}', { number: e.unitNumber }) : null].filter(Boolean).join(' · ')}
      </Text>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        {e.receiptFileId ? (
          <SignedImage linkRoute={routes.fileLink(e.receiptFileId)} label={t('Receipt')} style={{ width: 130, height: 110 }} />
        ) : (
          <View style={{ width: 130, height: 110, borderRadius: 8, backgroundColor: color.subtle, alignItems: 'center', justifyContent: 'center', padding: space.sm }}>
            <Text variant="caption" tint={color.text2} style={{ textAlign: 'center' }}>
              {t('No receipt attached')}
            </Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Field label={t('Amount')}>
            <Text variant="bodyStrong">{moneyCents(r?.driverFundedCents ?? Math.round(e.amount * 100))}</Text>
          </Field>
          <Field label={t('Paid by')}>{r ? t(PAYMENT_SOURCE_LABEL[r.paymentSource as PaymentSource] ?? r.paymentSource) : '—'}</Field>
          <Field label={t('Category')}>{r ? t(REIMBURSEMENT_CATEGORY_LABEL[r.category as ReimbursementCategory] ?? r.category) : '—'}</Field>
          <Field label={t('Reimbursable')}>
            <StatusPill tone={r && r.driverFundedCents > 0 ? 'success' : 'neutral'} label={r && r.driverFundedCents > 0 ? t('Yes') : t('No')} />
          </Field>
          <Field label={t('Date')}>{dayLabel(e.onDate)}</Field>
        </View>
      </View>
      {r?.note ? (
        <Text variant="caption" tint={color.text2}>
          {r.note}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xs }}>
        <Button
          compact
          style={{ flex: 1 }}
          variant="outline"
          label={t('Reject')}
          onPress={() =>
            decision.setPending({
              title: t('Reject reimbursement'),
              body: t('The driver reads this reason.'),
              confirm: t('Reject'),
              run: (reason) => api.post(routes.reimbursementReview(e.id), { decision: 'reject', reason }),
            })
          }
        />
        <Button
          compact
          style={{ flex: 1 }}
          label={t('Approve')}
          loading={decision.busy === e.id}
          onPress={() => void decision.run(e.id, () => api.post(routes.reimbursementReview(e.id), { decision: 'approve', reason: null }), t('Approved for the next statement.'))}
        />
      </View>
    </Panel>
  );
}

const SETTLEMENT_TONE: Record<string, StatusTone> = { review: 'warning', approved: 'info', paid: 'success', draft: 'neutral' };

/**
 * Sheet 21 — the billing queue's driver-app papers (Mark reviewed / Request correction through the
 * existing billing review route), pending reimbursements (existing review route) and statements
 * ready, all read from the existing Accounting routes.
 */
export default function AccountingWorkspace() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'pod');
  useEffect(() => {
    if (TABS.includes(params.tab as Tab)) setTab(params.tab as Tab);
  }, [params.tab]);
  const [index, setIndex] = useState(0);
  const today = useResource<OfficeToday>(routes.officeToday('accounting'));
  const queue = useResource<BillingQueue>(tab === 'pod' ? routes.billingQueue : null);
  const pending = useResource<AccountingReimbursement[]>(tab === 'reimbursements' ? routes.reimbursements('pending') : null);
  const statements = useResource<AccountingSettlement[]>(tab === 'settlements' ? routes.settlements : null);
  const reload = () => {
    today.reload();
    if (tab === 'pod') queue.reload();
    if (tab === 'reimbursements') pending.reload();
    if (tab === 'settlements') statements.reload();
  };
  const decision = useDecision(reload);
  const counter = (key: string) => (today.status === 'ready' ? (today.data.sections.flatMap((s) => s.counters).find((c) => c.key === key)?.value ?? null) : null);

  const podRows = useMemo(() => (queue.status === 'ready' ? queue.data.rows.filter((r) => r.verdict.queue === 'needs_review') : []), [queue]);
  const at = Math.min(index, Math.max(0, podRows.length - 1));

  return (
    <Screen back title={t('Accounting')} subtitle={t('Process documents, reimbursements and settlements.')} onRefresh={reload}>
      <SegmentedTabs
        variant="underline"
        options={[
          { key: 'pod', label: t('POD review') },
          { key: 'reimbursements', label: t('Reimbursements') },
          { key: 'settlements', label: t('Settlements') },
        ]}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setIndex(0);
        }}
      />
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
        <StatTile value={counter('billing_needs_review')} label={t('PODs in queue')} tone="neutral" selected={tab === 'pod'} onPress={() => setTab('pod')} />
        <StatTile value={counter('reimbursements_pending')} label={t('Reimbursements')} tone="neutral" selected={tab === 'reimbursements'} onPress={() => setTab('reimbursements')} />
        <StatTile value={counter('settlements_ready')} label={t('Settlements ready')} tone="neutral" selected={tab === 'settlements'} onPress={() => setTab('settlements')} />
      </View>

      {tab === 'pod' ? (
        <Section>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.sm }}>
            <Text variant="subheading" style={{ flex: 1 }}>
              {t('POD review queue')}
            </Text>
            {podRows.length ? <Pager index={at} total={podRows.length} onChange={setIndex} /> : null}
          </View>
          <ResourceView resource={queue} what={t('The billing queue')}>
            {() => (podRows.length ? <PodCard key={podRows[at]!.load.id} row={podRows[at]!} decision={decision} /> : <EmptyState compact icon="file-check-outline" title={t('No papers waiting for review')} />)}
          </ResourceView>
        </Section>
      ) : null}

      {tab === 'reimbursements' ? (
        <Section title={t('Reimbursements to review')}>
          <ResourceView resource={pending} what={t('Reimbursements')}>
            {(rows) =>
              rows.length ? (
                <View style={{ gap: space.md }}>
                  {rows.map((e) => (
                    <ReimbursementCard key={e.id} e={e} decision={decision} />
                  ))}
                </View>
              ) : (
                <EmptyState compact icon="receipt" title={t('No reimbursements waiting')} />
              )
            }
          </ResourceView>
        </Section>
      ) : null}

      {tab === 'settlements' ? (
        <Section title={t('Settlements ready')}>
          <ResourceView resource={statements} what={t('Settlements')}>
            {(rows) => {
              const ready = [...rows.filter((s) => s.status === 'review'), ...rows.filter((s) => s.status === 'approved' && !s.paidAt)];
              return ready.length ? (
                <View>
                  {ready.map((s, i) => (
                    <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, borderBottomWidth: i < ready.length - 1 ? StyleSheet.hairlineWidth : 0, borderColor: color.divider }}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="rowTitle">{s.partyName}</Text>
                        <Text variant="caption" tint={color.text2}>
                          {s.settlementNumber} · {dayLabel(s.periodStart)} – {dayLabel(s.periodEnd)}
                        </Text>
                        <Text variant="caption" tint={color.text3}>
                          {t('Pay date {date}', { date: dayLabel(s.payDate) })}
                          {s.unitNumber ? ` · ${t('Unit {number}', { number: s.unitNumber })}` : ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Text variant="bodyStrong">{moneyCents(s.netCents)}</Text>
                        <StatusPill tone={SETTLEMENT_TONE[s.status] ?? 'neutral'} label={s.status === 'review' ? t('Ready for review') : s.status === 'approved' ? t('Approved · not paid') : t(s.status)} />
                      </View>
                    </View>
                  ))}
                  <Text variant="caption" tint={color.text3} style={{ marginTop: space.sm }}>
                    {t('Approve and pay statements in the TMS (Accounting → Settlements).')}
                  </Text>
                </View>
              ) : (
                <EmptyState compact icon="file-document-outline" title={t('No statements ready')} />
              );
            }}
          </ResourceView>
        </Section>
      ) : null}

      <ReasonSheet
        visible={Boolean(decision.pending)}
        title={decision.pending?.title ?? ''}
        body={decision.pending?.body}
        confirmLabel={decision.pending?.confirm ?? t('Send')}
        busy={decision.busy === 'reason'}
        error={decision.error}
        onClose={() => decision.setPending(null)}
        onConfirm={(reason) => {
          const p = decision.pending;
          if (p) void decision.run('reason', () => p.run(reason), t('Sent back with your reason.'), true);
        }}
      />
    </Screen>
  );
}
