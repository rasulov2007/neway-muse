import { router, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import {
  routes,
  type DriverBreakdown,
  type DriverCareRequest,
  type DriverReferralList,
  type DriverReimbursement,
  type DriverSafetyReport,
} from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { DRIVER_CARE_STATES, DRIVER_CARE_STATE_LABEL, DRIVER_REFERRAL_STAGES, DRIVER_REFERRAL_STAGE_LABEL } from '@neway/shared/mobile/index';
import { REIMBURSEMENT_CATEGORY_LABEL } from '@neway/shared/accounting/reimbursements';
import { requestTone } from '@/features/driver/common';
import { t } from '@/i18n';
import { inEastern } from '@/lib/clock';
import { moneyCents } from '@/lib/format';
import { Button } from '@/ui/controls';
import { Panel, Screen, Section, Timeline, type TimelineStep } from '@/ui/layout';
import { SignedImage } from '@/ui/media';
import { Divider, Icon, StatusPill, StatusSymbol, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, space } from '@/ui/tokens';

function Header({ title, subtitle, amount, status }: { title: string; subtitle?: string | null; amount?: string | null; status?: ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <Text variant="title" style={{ flex: 1 }}>
          {title}
        </Text>
        {amount ? <Text variant="heading">{amount}</Text> : null}
      </View>
      {subtitle ? (
        <Text variant="small" tint={color.text2}>
          {subtitle}
        </Text>
      ) : null}
      {status}
    </View>
  );
}

function PersonRow({ label, name, detail, icon = 'account-outline' }: { label: string; name: string; detail?: string | null; icon?: 'account-outline' | 'wrench-outline' | 'account-group-outline' | 'map-marker-outline' }) {
  return (
    <View style={{ paddingVertical: space.sm, gap: space.xs }}>
      <Text variant="caption" tint={color.text2}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Icon name={icon} size={22} tint={color.text2} />
        <View style={{ flex: 1 }}>
          <Text variant="smallStrong">{name}</Text>
          {detail ? (
            <Text variant="caption" tint={color.text2}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function LastUpdate({ at }: { at: string }) {
  return (
    <View style={{ paddingVertical: space.sm, gap: space.xs }}>
      <Text variant="caption" tint={color.text2}>
        {t('Last update')}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Icon name="clock-outline" size={22} tint={color.text2} />
        <Text variant="bodyStrong">{inEastern(at, true)}</Text>
      </View>
    </View>
  );
}

function Reason({ text }: { text: string }) {
  return (
    <Panel style={{ marginTop: space.md, borderColor: color.danger, backgroundColor: color.dangerBg }}>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <StatusSymbol tone="danger" size={18} />
        <Text variant="small" tint={color.danger} style={{ flex: 1 }}>
          {text}
        </Text>
      </View>
    </Panel>
  );
}

function stepState(reached: boolean, current: boolean): TimelineStep['state'] {
  return current ? 'current' : reached ? 'done' : 'pending';
}

// ------------------------------------------------------------------------------- reimbursement

function ReimbursementDetail({ id }: { id: string }) {
  const r = useResource<DriverReimbursement>(routes.driverReimbursement(id));
  return (
    <Screen back onRefresh={r.reload}>
      <ResourceView resource={r} what={t('This receipt')}>
        {(x) => {
          const paid = x.state === 'paid';
          return (
            <>
              <Header title={t('Reimbursement #{number}', { number: x.number })} subtitle={t(REIMBURSEMENT_CATEGORY_LABEL[x.category] ?? x.category)} amount={moneyCents(x.amountCents)} />
              <Section>
                <Timeline
                  steps={x.steps.map((s) => ({
                    key: s.state,
                    title: t(s.label),
                    state: s.reachedAt && !s.current ? 'done' : s.current ? (s.state === 'paid' || s.state === 'rejected' || s.state === 'company_expense' ? 'done' : 'current') : 'pending',
                    subtitle: s.reachedAt ? inEastern(s.reachedAt, true) : null,
                    right: s.state === 'paid' && !paid ? <StatusPill tone="warning" label={t('Pending')} /> : null,
                  }))}
                />
                {x.settlement ? (
                  <Text variant="caption" tint={color.text2} style={{ marginTop: space.sm }}>
                    {t('On statement {number}', { number: x.settlement.number })}
                    {paid && x.settlement.paidAt ? ` · ${t('paid {when}', { when: inEastern(x.settlement.paidAt, true) })}` : ` · ${t('will be paid with that settlement')}`}
                  </Text>
                ) : null}
                {x.rejectedReason ? <Reason text={x.rejectedReason} /> : null}
              </Section>
              <Section>
                <Divider />
                {x.reviewer ? <PersonRow label={t('Assigned reviewer')} name={x.reviewer.name} detail={t('Accounting Department')} /> : <PersonRow label={t('Assigned reviewer')} name={t('Accounting')} detail={t('Not picked up yet')} icon="account-group-outline" />}
                <LastUpdate at={x.lastUpdate} />
              </Section>
              {x.receiptFileId ? (
                <Section title={t('Receipt')}>
                  <SignedImage linkRoute={routes.driverFileLink(x.receiptFileId)} label={t('Receipt')} style={{ width: 160, height: 120 }} />
                </Section>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}

// ------------------------------------------------------------------------------- breakdown

function BreakdownDetail({ id }: { id: string }) {
  const b = useResource<DriverBreakdown>(routes.driverBreakdown(id));
  return (
    <Screen back onRefresh={b.reload}>
      <ResourceView resource={b} what={t('This breakdown')}>
        {(x) => (
          <>
            <Header
              title={t('Breakdown {number}', { number: x.number })}
              subtitle={[t(x.categoryLabel), x.truck ? t('Truck {unit}', { unit: x.truck.unitNumber }) : null, x.trailer ? t('Trailer {unit}', { unit: x.trailer.unitNumber }) : null, x.load ? t('Load {number}', { number: x.load.loadNumber }) : null].filter(Boolean).join(' · ')}
              status={<StatusPill tone={requestTone('breakdown', x.status)} label={t(x.statusLabel)} />}
            />
            <Section>
              <Timeline
                steps={x.steps.map((s) => ({
                  key: s.status,
                  title: t(s.label),
                  state: stepState(Boolean(s.reachedAt), s.current && s.status !== 'closed' && s.status !== 'ready'),
                  subtitle: s.reachedAt ? inEastern(s.reachedAt, true) : null,
                }))}
              />
            </Section>
            {x.latestUpdate ? (
              <Panel tinted style={{ marginTop: space.md }}>
                <Text variant="caption" tint={color.text2}>
                  {t('Latest from Fleet')} · {inEastern(x.latestUpdate.at, true)}
                </Text>
                <Text variant="small">{x.latestUpdate.text}</Text>
              </Panel>
            ) : null}
            <Section>
              <Divider />
              <PersonRow label={t('Working on it')} name={x.responsible?.name ?? t('Fleet')} detail={x.responsible ? t('Fleet') : t('Not assigned yet')} />
              {x.shopName ? <PersonRow label={t('Shop')} name={x.shopName} icon="wrench-outline" /> : null}
              {x.location?.text ? <PersonRow label={t('Location you sent')} name={x.location.text} detail={x.location.source === 'gps' ? 'GPS' : t('Typed')} icon="map-marker-outline" /> : null}
              <LastUpdate at={x.latestUpdate?.at ?? x.updatedAt} />
            </Section>
            <Section title={t('What you reported')}>
              <Text variant="small">{x.description}</Text>
            </Section>
            <Button
              style={{ marginTop: space.lg }}
              variant="outline"
              icon="message-outline"
              label={t('Message Fleet')}
              onPress={() => router.push({ pathname: '/driver/new-message', params: { department: 'fleet', loadId: x.load?.id ?? '' } })}
            />
          </>
        )}
      </ResourceView>
    </Screen>
  );
}

// ------------------------------------------------------------------------------- Driver Care

function CareDetail({ id }: { id: string }) {
  const c = useResource<DriverCareRequest>(routes.driverCareRequest(id));
  return (
    <Screen back onRefresh={c.reload}>
      <ResourceView resource={c} what={t('This request')}>
        {(x) => {
          const at = DRIVER_CARE_STATES.indexOf(x.state);
          return (
            <>
              <Header title={x.number} subtitle={`${t(x.topicLabel)}${x.confidential ? ` · ${t('Confidential')}` : ''}`} status={<StatusPill tone={requestTone('care', x.state)} label={t(x.stateLabel)} />} />
              <Section>
                <Timeline
                  steps={DRIVER_CARE_STATES.map((s, i) => ({
                    key: s,
                    title: t(DRIVER_CARE_STATE_LABEL[s]),
                    state: i < at || (i === at && s === 'resolved') ? 'done' : i === at ? 'current' : 'pending',
                    subtitle: s === 'received' ? inEastern(x.acknowledgedAt, true) : i === at ? inEastern(x.lastUpdate, true) : null,
                  }))}
                />
              </Section>
              <Section>
                <Divider />
                <PersonRow label={t('Answered by')} name={t(x.teamLabel)} icon="account-group-outline" />
                <LastUpdate at={x.lastUpdate} />
              </Section>
              <Section title={t('Your message')}>
                <Text variant="small">{x.message}</Text>
              </Section>
              <Section title={t('Replies ({count})', { count: x.responses.length })}>
                {x.responses.length ? (
                  x.responses.map((r, i) => (
                    <View key={`${r.at}${i}`} style={{ paddingVertical: space.sm, gap: 2 }}>
                      <Text variant="caption" tint={color.text2}>
                        {r.byName} · {inEastern(r.at, true)}
                      </Text>
                      <Text variant="small">{r.text}</Text>
                      {i < x.responses.length - 1 ? <Divider style={{ marginTop: space.sm }} /> : null}
                    </View>
                  ))
                ) : (
                  <Text variant="small" tint={color.text2}>
                    {t('No reply yet.')}
                  </Text>
                )}
              </Section>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}

// ------------------------------------------------------------------------------- safety report

function SafetyReportDetail({ id }: { id: string }) {
  const s = useResource<DriverSafetyReport>(routes.driverSafetyReport(id));
  return (
    <Screen back onRefresh={s.reload}>
      <ResourceView resource={s} what={t('This report')}>
        {(x) => (
          <>
            <Header title={`${t(x.kindLabel)} ${x.reference}`} subtitle={t('Happened {when}', { when: inEastern(x.occurredAt, true) })} status={<StatusPill tone="info" label={t(x.statusLabel)} />} />
            <Section>
              <Timeline
                steps={[
                  { key: 'received', title: t('Received by Safety'), state: 'done', subtitle: inEastern(x.createdAt, true) },
                  { key: 'stage', title: t(x.statusLabel), state: 'current', subtitle: t('Safety works the case; its stage shows here.') },
                ]}
              />
            </Section>
            <Section>
              <Divider />
              <PersonRow label={t('Handled by')} name={t('Safety')} icon="account-group-outline" />
            </Section>
            <Section title={t('What you reported')}>
              <Text variant="small">{x.description}</Text>
            </Section>
          </>
        )}
      </ResourceView>
    </Screen>
  );
}

// ------------------------------------------------------------------------------- referral

function ReferralDetail({ id }: { id: string }) {
  const list = useResource<DriverReferralList>(routes.driverReferrals);
  return (
    <Screen back onRefresh={list.reload}>
      <ResourceView resource={list} what={t('Your referral')}>
        {({ referrals }) => {
          const r = referrals.find((x) => x.id === id);
          if (!r) return <EmptyState icon="file-question-outline" title={t('Not found')} body={t('This referral is not among yours.')} />;
          const at = DRIVER_REFERRAL_STAGES.indexOf(r.stage);
          const stages = DRIVER_REFERRAL_STAGES.filter((s) => s !== 'closed' || r.stage === 'closed');
          return (
            <>
              <Header title={t('Referral · {name}', { name: r.name })} subtitle={r.number} status={<StatusPill tone={requestTone('referral', r.stage)} label={t(r.stageLabel)} />} />
              <Section>
                <Timeline
                  steps={stages.map((s) => {
                    const i = DRIVER_REFERRAL_STAGES.indexOf(s);
                    return {
                      key: s,
                      title: t(DRIVER_REFERRAL_STAGE_LABEL[s]),
                      state: i < at || (i === at && (s === 'hired' || s === 'closed')) ? 'done' : i === at ? 'current' : 'pending',
                      subtitle: s === 'received' ? inEastern(r.submittedAt, true) : null,
                    };
                  })}
                />
              </Section>
              <Section>
                <Divider />
                <PersonRow label={t('Handled by')} name={t('Recruiting')} icon="account-group-outline" />
              </Section>
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}

/** Sheet 09 — one request with its server timeline, who has it, and the last update. */
export default function RequestTracking() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  switch (kind) {
    case 'reimbursement':
      return <ReimbursementDetail id={id} />;
    case 'breakdown':
      return <BreakdownDetail id={id} />;
    case 'care':
      return <CareDetail id={id} />;
    case 'safety_report':
      return <SafetyReportDetail id={id} />;
    case 'referral':
      return <ReferralDetail id={id} />;
    default:
      return (
        <Screen back>
          <EmptyState icon="file-question-outline" title={t('Not found')} />
        </Screen>
      );
  }
}
