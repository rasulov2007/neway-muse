import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type OfficeMoney, type OfficeToday } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { useSession } from '@/auth/session';
import { AttentionList } from '@/features/office/attention';
import { OmittedNotes } from '@/features/office/common';
import { DASHBOARD_PERIOD_PRESETS } from '@neway/shared/dashboard/period';
import { dayLabel, moneyDollars } from '@/lib/format';
import { Select } from '@/ui/controls';
import { Screen, Section, useToast } from '@/ui/layout';
import { Icon, Text, type IconName } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { t } from '@/i18n';
import { color, radius, space, type StatusTone } from '@/ui/tokens';

type Preset = Exclude<(typeof DASHBOARD_PERIOD_PRESETS)[number], 'custom'>;
const PERIODS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
];

function basisWords(m: OfficeMoney): string {
  return m.basis === 'posted' ? t('Posted only') : t('Includes estimates');
}

function MoneyTile({ label, money, tone, hidden }: { label: string; money: OfficeMoney; tone: StatusTone; hidden?: string | null }) {
  const bg = tone === 'success' ? color.successBg : tone === 'danger' ? color.dangerBg : color.infoBg;
  const fg = tone === 'success' ? color.success : tone === 'danger' ? color.danger : color.info;
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.lg, padding: space.md, gap: 2, minHeight: 84 }}>
      <Text variant="heading" tint={fg} numberOfLines={1} adjustsFontSizeToFit>
        {hidden ? t('Hidden') : money.amount === null ? '—' : moneyDollars(money.amount, 0)}
      </Text>
      <Text variant="captionStrong">{label}</Text>
      <Text variant="caption" tint={color.text2}>
        {hidden ?? basisWords(money)}
      </Text>
    </View>
  );
}

function FleetTile({ icon, value, label }: { icon: IconName; value: number; label: string }) {
  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: color.subtle, borderRadius: radius.lg, paddingHorizontal: space.sm, paddingVertical: space.md }}>
      <Icon name={icon} size={22} tint={color.ink} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="heading">{value}</Text>
        <Text variant="caption" tint={color.text2}>
          {label}
        </Text>
      </View>
    </View>
  );
}

/**
 * Sheet 23 — GET /office/today?role=owner&period=: revenue / expenses / net exactly as the
 * analytics service reports them, labelled posted or including estimates; fleet status counts;
 * the critical lines of the departments this person may see.
 */
export default function OwnerOverview() {
  const { account, switchCompany } = useSession();
  const toast = useToast();
  const [period, setPeriod] = useState<Preset>('this_week');
  const [all, setAll] = useState(false);
  const view = useResource<OfficeToday>(routes.officeToday('owner', period));
  const companies = account?.companies ?? [];

  return (
    <Screen back title={t('Owner overview')} subtitle={t('A real-time view of your business.')} onRefresh={view.reload}>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          {companies.length > 1 ? (
            <Select
              label={t('Company')}
              value={account?.companyId ?? null}
              options={companies.map((c) => ({ value: c.companyId, label: c.companyName }))}
              onChange={(id) => {
                if (id === account?.companyId) return;
                switchCompany(id).then(
                  () => view.reload(),
                  () => toast(t('Could not switch company.'), 'danger'),
                );
              }}
            />
          ) : (
            <View style={{ gap: space.xs }}>
              <Text variant="smallStrong" tint={color.text2}>
                {t('Company')}
              </Text>
              <View style={{ minHeight: 48, borderWidth: 1, borderColor: color.border, borderRadius: radius.md, justifyContent: 'center', paddingHorizontal: space.md, backgroundColor: color.subtle }}>
                <Text numberOfLines={1}>{account?.companyName ?? ''}</Text>
              </View>
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Select label={t('Period')} value={period} options={PERIODS.map((p) => ({ ...p, label: t(p.label) }))} onChange={setPeriod} icon="calendar-blank-outline" />
        </View>
      </View>

      <ResourceView resource={view} what={t('The owner overview')}>
        {(d) => {
          const o = d.owner;
          const critical = all ? d.attention : d.attention.slice(0, 3);
          return (
            <>
              {o ? (
                <>
                  <Text variant="caption" tint={color.text2} style={{ marginTop: space.xs, textAlign: 'right' }}>
                    {o.period.label || `${dayLabel(o.period.from)} – ${dayLabel(o.period.to)}`}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                    <MoneyTile label={t('Revenue')} money={o.revenue} tone="success" />
                    <MoneyTile label={t('Expenses')} money={o.expenses} tone="danger" />
                    <MoneyTile label={t('Net')} money={o.net} tone="info" hidden={o.net.hiddenReason} />
                  </View>
                  {o.notes.map((n) => (
                    <Text key={n} variant="caption" tint={color.text3} style={{ marginTop: space.xs }}>
                      {n}
                    </Text>
                  ))}
                  {o.source === 'demo' ? (
                    <Text variant="caption" tint={color.warning} style={{ marginTop: space.xs }}>
                      {t('Demo data.')}
                    </Text>
                  ) : null}
                  <Section title={t('Fleet status')}>
                    {o.fleet ? (
                      <View style={{ flexDirection: 'row', gap: space.sm }}>
                        <FleetTile icon="truck" value={o.fleet.active} label={t('Active trucks')} />
                        <FleetTile icon="wrench" value={o.fleet.inShop} label={t('In shop')} />
                        <FleetTile icon="clock-outline" value={o.fleet.outOfService} label={t('Out of service')} />
                      </View>
                    ) : (
                      <Text variant="small" tint={color.text2}>
                        {t('Fleet counts need a unit permission.')}
                      </Text>
                    )}
                  </Section>
                </>
              ) : (
                <EmptyState compact icon="chart-box-outline" title={t('No figures for your role')} body={t('Revenue and expenses need analytics access.')} />
              )}
              <Section title={t('Critical tasks ({count})', { count: d.attention.length })} action={d.attention.length > 3 ? (all ? t('Show less') : t('View all')) : undefined} onAction={() => setAll((a) => !a)}>
                {critical.length ? <AttentionList items={critical} /> : <Text variant="small" tint={color.text2}>{t('Nothing critical right now.')}</Text>}
              </Section>
              <OmittedNotes omitted={d.omitted} />
              {d.availableRoles.length > 1 ? (
                <Text variant="caption" tint={color.link} style={{ marginTop: space.md }} onPress={() => router.push('/office/today')}>
                  {t('Department views are on Today.')}
                </Text>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Screen>
  );
}
