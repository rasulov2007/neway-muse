import { router } from 'expo-router';
import { View } from 'react-native';

import {
  routes,
  type DriverBreakdownList,
  type DriverCareList,
  type DriverReferralList,
  type DriverReimbursementList,
  type DriverSafetyReportList,
  type DriverVacationRequestList,
} from '@/api/contract';
import { useResource, type ResourceWithReload } from '@/api/use-resource';
import { requestTone } from '@/features/driver/common';
import { t } from '@/i18n';
import {
  REQUEST_KIND_LABEL,
  fromBreakdown,
  fromCare,
  fromReferral,
  fromReimbursement,
  fromSafetyReport,
  fromVacation,
  type RequestEntry,
  type RequestKind,
} from '@/features/driver/requests';
import { QueueItemRow } from '@/features/components';
import { relativeStamp } from '@/lib/clock';
import { useQueue } from '@/offline/queue';
import { ListRow } from '@/ui/controls';
import { Screen, Section } from '@/ui/layout';
import { StatusPill, Text } from '@/ui/primitives';
import { EmptyState, ErrorFor, LoadingState } from '@/ui/states';
import { color } from '@/ui/tokens';

const QUEUED_KINDS = new Set(['breakdown', 'reimbursement', 'care', 'referral', 'vacation', 'vacation-parked', 'vacation-cancel', 'safety-report', 'driver-document']);

/**
 * Sheet 09 list: every request this driver sent — breakdowns, receipts, Driver Care, vacations,
 * safety reports and referrals — each with the server's own status words, who has it and when it
 * last moved. Items still on the phone come first with their upload status.
 */
export default function Requests() {
  const sources: Array<{ kind: RequestKind; res: ResourceWithReload<unknown>; map: (data: unknown) => RequestEntry[] }> = [
    { kind: 'breakdown', res: useResource<DriverBreakdownList>(routes.driverBreakdowns), map: (d) => (d as DriverBreakdownList).breakdowns.map(fromBreakdown) },
    { kind: 'reimbursement', res: useResource<DriverReimbursementList>(routes.driverReimbursements), map: (d) => (d as DriverReimbursementList).reimbursements.map(fromReimbursement) },
    { kind: 'care', res: useResource<DriverCareList>(routes.driverCare), // A referral is also a DR request (topic referral); it is listed once, from /driver/referrals, with its stage word.
    map: (d) => (d as DriverCareList).requests.filter((c) => c.topic !== 'referral').map(fromCare) },
    { kind: 'vacation', res: useResource<DriverVacationRequestList>(routes.driverVacations), map: (d) => (d as DriverVacationRequestList).vacations.map(fromVacation) },
    { kind: 'safety_report', res: useResource<DriverSafetyReportList>(routes.driverSafetyReports), map: (d) => (d as DriverSafetyReportList).reports.map(fromSafetyReport) },
    { kind: 'referral', res: useResource<DriverReferralList>(routes.driverReferrals), map: (d) => (d as DriverReferralList).referrals.map(fromReferral) },
  ];
  const queue = useQueue();
  const onPhone = queue.items.filter((i) => QUEUED_KINDS.has(i.kind) && i.status !== 'received');
  const loading = sources.some((s) => s.res.status === 'loading');
  const failed = sources.filter((s) => s.res.status === 'error');
  const entries = sources
    .flatMap((s) => (s.res.status === 'ready' ? s.map(s.res.data) : []))
    .sort((a, b) => Date.parse(b.lastUpdate) - Date.parse(a.lastUpdate));

  return (
    <Screen back title={t('My requests')} subtitle={t('Everything you sent, and where it is now.')} onRefresh={() => sources.forEach((s) => s.res.reload())}>
      {onPhone.length ? (
        <Section title={t('On this phone ({count})', { count: onPhone.length })} style={{ marginTop: 0 }}>
          {onPhone.map((item, i) => (
            <QueueItemRow key={item.id} item={item} divider={i < onPhone.length - 1} onRetry={() => void queue.retry(item.id)} onDiscard={() => void queue.discard(item.id)} />
          ))}
        </Section>
      ) : null}
      {failed.map((s) =>
        s.res.status === 'error' ? (
          <View key={s.kind}>
            <Text variant="smallStrong" tint={color.text2}>
              {t(REQUEST_KIND_LABEL[s.kind])}
            </Text>
            <ErrorFor compact error={s.res.error} what={t('Your requests: {kind}', { kind: t(REQUEST_KIND_LABEL[s.kind]) })} onRetry={s.res.reload} />
          </View>
        ) : null,
      )}
      <Section title={onPhone.length ? t('Received by TMS') : undefined} style={onPhone.length ? undefined : { marginTop: 0 }}>
        {entries.map((e, i) => (
          <ListRow
            key={`${e.kind}:${e.id}`}
            title={e.title}
            subtitle={e.subtitle ?? undefined}
            meta={[e.responsible, t('Updated {when}', { when: relativeStamp(e.lastUpdate) })].filter(Boolean).join(' · ')}
            right={<StatusPill tone={requestTone(e.kind === 'safety_report' ? 'safety' : e.kind, e.status)} label={t(e.statusLabel)} />}
            divider={i < entries.length - 1}
            onPress={() => router.push(e.href)}
          />
        ))}
        {loading ? <LoadingState compact /> : null}
        {!loading && !entries.length && !onPhone.length && !failed.length ? (
          <EmptyState icon="timeline-check-outline" title={t('No requests yet')} body={t('Breakdowns, receipts, Driver Care messages, vacations and reports you send show up here.')} />
        ) : null}
      </Section>
    </Screen>
  );
}
