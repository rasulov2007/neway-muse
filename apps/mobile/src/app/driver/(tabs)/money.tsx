import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { api } from '@/api/client';
import { routes, type DriverSettlementDetail, type DriverSettlementList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { addDays, easternDay, weekLabel, weekStart } from '@/lib/clock';
import { dayLabel, moneyCents } from '@/lib/format';
import { openAuthorizedPdf } from '@/lib/open-file';
import { Button, WeekPicker } from '@/ui/controls';
import { KeyValue, Panel, Screen, Section, useToast } from '@/ui/layout';
import { Divider, Icon, StatusPill, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, space } from '@/ui/tokens';
import { t } from '@/i18n';

function Amount({ cents, label }: { cents: number; label: string }) {
  return (
    <View style={{ gap: 2, flex: 1 }}>
      <Text variant="bodyStrong">{moneyCents(cents)}</Text>
      <Text variant="caption" tint={color.text2}>
        {label}
      </Text>
    </View>
  );
}

/** "Line haul … $1,900.00" (sheet 05): the label takes the row, the amount sits right. */
function Line({ label, cents, last }: { label: string; cents: number; last?: boolean }) {
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.sm }}>
        <Text variant="small" style={{ flex: 1 }}>
          {label}
        </Text>
        <Text variant="small">{moneyCents(cents)}</Text>
      </View>
      {last ? null : <Divider />}
    </>
  );
}

/** The statement itself (GET /driver/settlements/:id), as Accounting stored it — never recomputed. */
function Statement({ id }: { id: string }) {
  const detail = useResource<DriverSettlementDetail>(routes.driverSettlement(id));
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  return (
    <ResourceView resource={detail} what={t('Your pay statement')}>
      {(s) => {
        const paid = s.state === 'paid';
        const lines: Array<{ label: string; cents: number }> = [
          ...s.earnings.map((e) => ({ label: [e.description, e.loadNumber ? `#${e.loadNumber}` : null].filter(Boolean).join(' · '), cents: e.amountCents })),
          ...s.reimbursements.map((r) => ({ label: [r.description, r.loadNumber ? `#${r.loadNumber}` : null].filter(Boolean).join(' · '), cents: r.amountCents })),
          ...s.deductions.map((d) => ({ label: d.description, cents: -Math.abs(d.amountCents) })),
          ...(s.carryCents ? [{ label: t('Carried balance'), cents: s.carryCents }] : []),
          ...(s.escrowCents ? [{ label: t('Escrow'), cents: -Math.abs(s.escrowCents) }] : []),
        ];
        return (
          <>
            <Panel tinted>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="small" tint={color.text2}>
                    {paid ? t('Net pay · after deductions') : t('Finalized net pay · after deductions')}
                  </Text>
                  <Text variant="money" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {moneyCents(s.netCents)}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: space.xs }}>
                  <StatusPill tone={paid ? 'success' : 'moving'} label={t(s.stateLabel || (paid ? 'Paid' : 'Finalized'))} />
                  <Text variant="caption" tint={color.text2}>
                    {paid ? t('Paid {date}', { date: s.paidAt ? dayLabel(s.paidAt.slice(0, 10)) : '' }) : t('Not paid yet')}
                  </Text>
                </View>
              </View>
              <Divider style={{ marginVertical: space.md }} />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Amount cents={s.grossCents} label={t('Gross earnings')} />
                <Amount cents={s.reimbursementsCents} label={t('Reimbursements')} />
                <Amount cents={-Math.abs(s.deductionsCents)} label={t('Deductions')} />
              </View>
            </Panel>
            <Section title={t('Statement details')}>
              {lines.length ? lines.map((l, i) => <Line key={`${l.label}${i}`} label={l.label} cents={l.cents} last={i === lines.length - 1} />) : <Text variant="small" tint={color.text2}>{t('No lines on this statement.')}</Text>}
            </Section>
            <Section>
              <KeyValue label={t('Statement')} value={s.number} />
              <KeyValue label={t('Period')} value={`${dayLabel(s.periodStart)} – ${dayLabel(s.periodEnd)}`} />
              <KeyValue label={t('Pay date')} value={dayLabel(s.payDate)} />
              <KeyValue label={t('Loads · miles')} value={t('{loads} · {miles} mi', { loads: s.loadCount, miles: s.totalMiles.toLocaleString('en-US') })} last={!s.notes.length} />
              {s.notes.length ? <KeyValue label={t('Notes')} value={s.notes.join('\n')} last /> : null}
            </Section>
            <Button
              style={{ marginTop: space.lg }}
              variant="outline"
              icon="download"
              label={t('Download PDF')}
              loading={downloading}
              onPress={async () => {
                setDownloading(true);
                try {
                  await openAuthorizedPdf(routes.driverSettlementPdf(s.id), `${s.number}.pdf`);
                } catch {
                  toast(t('The PDF could not be opened. Try again when you have signal.'), 'warning');
                } finally {
                  setDownloading(false);
                }
              }}
            />
          </>
        );
      }}
    </ResourceView>
  );
}

/**
 * Sheet 05. The pay week runs on the Eastern clock; only statements Accounting finalized or paid
 * reach the app (GET /driver/settlements?week=), with their state as stored.
 */
export default function Money() {
  const { statement } = useLocalSearchParams<{ statement?: string }>();
  const current = weekStart(easternDay());
  const [week, setWeek] = useState(current);
  const [picked, setPicked] = useState<string | null>(statement ?? null);
  const list = useResource<DriverSettlementList>(routes.driverSettlements(week));

  // A deep link names a statement: open its week.
  useEffect(() => {
    if (!statement) return;
    setPicked(statement);
    api
      .get<DriverSettlementDetail>(routes.driverSettlement(statement))
      .then((s) => setWeek(weekStart(s.periodStart)))
      .catch(() => undefined);
  }, [statement]);

  const move = (days: number) => {
    setPicked(null);
    setWeek(addDays(week, days));
  };

  return (
    <Screen title={t('Earnings')} onRefresh={list.reload}>
      <WeekPicker label={weekLabel(week)} onPrev={() => move(-7)} onNext={() => move(7)} nextDisabled={week >= current} />
      <View style={{ marginTop: space.lg }}>
        <ResourceView resource={list} what={t('Your pay statements')}>
          {({ settlements }) => {
            if (!settlements.length) {
              return (
                <EmptyState
                  icon="file-document-outline"
                  title={t('No statement for this week')}
                  body={t('A statement shows here once Accounting finalizes it. Drafts still being worked are not shown.')}
                />
              );
            }
            const chosen = settlements.find((s) => s.id === picked) ?? settlements[0]!;
            return (
              <>
                {settlements.length > 1 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md }}>
                    {settlements.map((s) => (
                      <Button key={s.id} compact variant={s.id === chosen.id ? 'primary' : 'outline'} label={s.number} onPress={() => setPicked(s.id)} />
                    ))}
                  </View>
                ) : null}
                <Statement key={chosen.id} id={chosen.id} />
              </>
            );
          }}
        </ResourceView>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.lg }}>
        <Icon name="information-outline" size={16} tint={color.text3} />
        <Text variant="caption" tint={color.text3} style={{ flex: 1 }}>
          {t('Paid is shown only when Accounting marks the statement paid.')}
        </Text>
      </View>
    </Screen>
  );
}
