import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View, StyleSheet } from 'react-native';

import { api } from '@/api/client';
import { routes, type AccountingReimbursement, type OfficeApprovalItem, type OfficeApprovalKind, type OfficeApprovals } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { errorText, Field, OmittedNotes } from '@/features/office/common';
import { REIMBURSEMENT_CATEGORY_LABEL, type ReimbursementCategory } from '@neway/shared/accounting/reimbursements';
import { OFFICE_APPROVAL_KINDS } from '@neway/shared/mobile/office';
import { inEastern } from '@/lib/clock';
import { moneyCents, moneyDollars } from '@/lib/format';
import { Button, SegmentedTabs } from '@/ui/controls';
import { Panel, Screen, useToast } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { Icon, StatusPill, Text, type IconName } from '@/ui/primitives';
import { ReasonSheet } from '@/ui/sheets';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, radius, space } from '@/ui/tokens';

const KIND_ICON: Record<OfficeApprovalKind, IconName> = {
  expenses: 'receipt-text-outline',
  pto: 'calendar-account-outline',
  repairs: 'wrench-outline',
  vacations: 'calendar-blank-outline',
};

/** The body each existing decision route takes (named by the server in item.approve / item.reject). */
function decisionBody(item: OfficeApprovalItem, approve: boolean, reason: string | null): Record<string, unknown> {
  switch (item.kind) {
    case 'expenses':
      return { decision: approve ? 'approve' : 'reject', reason: reason || null };
    case 'pto':
      return approve ? { status: 'approved', ...(reason ? { note: reason } : {}) } : { status: 'rejected', note: reason };
    case 'vacations':
      return { version: item.version ?? undefined, decision: approve ? 'approve' : 'reject', reason: reason || null };
    default:
      return {};
  }
}

function money(item: OfficeApprovalItem): string | null {
  return item.amount === null ? null : moneyDollars(item.amount);
}

function Row({ item, selected, onPress }: { item: OfficeApprovalItem; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.md,
        paddingHorizontal: space.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: color.divider,
        backgroundColor: selected ? color.warningBg : pressed ? color.subtle : 'transparent',
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: color.subtle, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={KIND_ICON[item.kind]} size={22} tint={color.ink} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="rowTitle" numberOfLines={1}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text variant="caption" tint={color.text2} numberOfLines={2}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {money(item) ? <Text variant="bodyStrong">{money(item)}</Text> : null}
        <StatusPill tone="warning" label={t('Pending')} />
      </View>
      <Icon name="chevron-right" size={20} tint={color.text3} />
    </Pressable>
  );
}

/**
 * Sheet 17 — what waits for this person's decision (GET /office/approvals). Approve / Request
 * changes call the existing decision route the server names; a reason is required to send it back.
 */
export default function Approvals() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const initial = (OFFICE_APPROVAL_KINDS as readonly string[]).includes(params.kind ?? '') ? (params.kind as OfficeApprovalKind) : null;
  const [kind, setKind] = useState<OfficeApprovalKind | null>(initial);
  useEffect(() => {
    if (initial) setKind(initial);
  }, [initial]);
  const list = useResource<OfficeApprovals>(routes.officeApprovals(kind));
  const receipts = useResource<AccountingReimbursement[]>(kind === 'expenses' || (kind === null && list.status === 'ready' && list.data.kind === 'expenses') ? routes.reimbursements('pending') : null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<OfficeApprovalItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const decide = async (item: OfficeApprovalItem, approve: boolean, reason: string | null) => {
    const action = approve ? item.approve : item.reject;
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(action.path, decisionBody(item, approve, reason));
      toast(approve ? t('Approved.') : t('Sent back with your reason.'), 'success');
      setReasonFor(null);
      setSelected(null);
      list.reload();
    } catch (e) {
      const text = errorText(e);
      if (reasonFor) setError(text);
      else toast(text, 'danger');
      list.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('Approvals')} onRefresh={list.reload}>
      <ResourceView resource={list} what={t('Approvals')}>
        {(a) => {
          const active = a.kind;
          const item = a.items.find((i) => i.id === selected) ?? null;
          const receipt = item && receipts.status === 'ready' ? receipts.data.find((r) => r.id === item.id) : undefined;
          return (
            <>
              {a.tabs.length ? (
                <SegmentedTabs
                  variant="underline"
                  options={a.tabs.map((tab) => ({ key: tab.kind, label: `${t(tab.label)} (${tab.count})` }))}
                  value={active ?? a.tabs[0]!.kind}
                  onChange={(k) => {
                    setSelected(null);
                    setKind(k);
                  }}
                />
              ) : null}
              <View style={{ marginTop: space.sm }}>
                {a.items.length ? (
                  a.items.map((i) => <Row key={i.id} item={i} selected={i.id === selected} onPress={() => setSelected(i.id === selected ? null : i.id)} />)
                ) : (
                  <EmptyState icon="check-circle-outline" title={t('Nothing waiting for you')} />
                )}
              </View>

              {item ? (
                <Panel style={{ marginTop: space.lg, gap: space.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text variant="smallStrong" style={{ flex: 1 }}>
                      {t('Request detail')}
                    </Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Close detail')} onPress={() => setSelected(null)} hitSlop={8}>
                      <Icon name="close" size={20} tint={color.text2} />
                    </Pressable>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                    <Text variant="subheading" style={{ flex: 1 }}>
                      {item.title}
                    </Text>
                    {money(item) ? <Text variant="subheading">{money(item)}</Text> : null}
                  </View>
                  {item.subtitle ? (
                    <Text variant="small" tint={color.text2}>
                      {item.subtitle}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: space.md }}>
                    {receipt?.receiptFileId ? (
                      <SignedImage linkRoute={routes.fileLink(receipt.receiptFileId)} label={t('Receipt')} style={{ width: 120, height: 90 }} />
                    ) : null}
                    <View style={{ flex: 1 }}>
                      {receipt?.reimbursement ? (
                        <>
                          <Field label={t('Category')}>{t(REIMBURSEMENT_CATEGORY_LABEL[receipt.reimbursement.category as ReimbursementCategory] ?? receipt.reimbursement.category)}</Field>
                          <Field label={t('Paid by')}>{receipt.reimbursement.payerDriverName ?? receipt.driverName ?? '—'}</Field>
                          <Field label={t('Receipt')}>{moneyCents(receipt.reimbursement.receiptCents)}</Field>
                          <Field label={t('Date')}>{receipt.onDate}</Field>
                          {receipt.reimbursement.note ? <Field label={t('Notes')}>{receipt.reimbursement.note}</Field> : null}
                        </>
                      ) : null}
                      {item.submittedAt ? <Field label={t('Submitted')}>{inEastern(item.submittedAt, true) ?? ''}</Field> : null}
                    </View>
                  </View>
                  {item.approve || item.reject ? (
                    <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.sm }}>
                      {item.reject ? (
                        <Button
                          compact
                          style={{ flex: 1 }}
                          variant="outline"
                          label={t('Request changes')}
                          disabled={busy}
                          onPress={() => {
                            setError(null);
                            setReasonFor(item);
                          }}
                        />
                      ) : null}
                      {item.approve ? <Button compact style={{ flex: 1 }} label={t('Approve')} loading={busy && !reasonFor} onPress={() => void decide(item, true, null)} /> : null}
                    </View>
                  ) : null}
                  {item.note || (!item.approve && item.kind === 'repairs') ? (
                    <Text variant="caption" tint={color.text2}>
                      {item.kind === 'repairs' ? `${t('Approve in the TMS (choose the estimate).')} ` : ''}
                      {item.note ?? ''}
                    </Text>
                  ) : null}
                </Panel>
              ) : null}
              <OmittedNotes omitted={a.omitted} />
              <ReasonSheet
                visible={Boolean(reasonFor)}
                title={t('Request changes')}
                body={t('The person who sent it reads this reason.')}
                confirmLabel={t('Send back')}
                busy={busy}
                error={error}
                onClose={() => setReasonFor(null)}
                onConfirm={(reason) => reasonFor && void decide(reasonFor, false, reason)}
              />
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
