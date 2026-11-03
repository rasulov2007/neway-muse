import { router, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { routes, type DriverLoadDetail, type DriverLoadsResponse, type DriverMe, type DriverPtiCurrent, type DriverSettlementList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { useAccount } from '@/auth/session';
import { AskRow, dueLabel, HomeRow, HomeSection, LoadStack, LoadStackPlaceholder, QuickActions } from '@/features/driver/home';
import { headerDate } from '@/lib/clock';
import { dayLabel, moneyCents } from '@/lib/format';
import { useQueue } from '@/offline/queue';
import { useUnreadCount } from '@/ui/header';
import { Screen } from '@/ui/layout';
import { Avatar, Icon, Text } from '@/ui/primitives';
import { ErrorFor, LoadingState } from '@/ui/states';
import { color, space } from '@/ui/tokens';
import { t, tn } from '@/i18n';

interface Task {
  key: string;
  title: string;
  done: boolean;
  href: Href;
}

const short = (day: string) => dayLabel(day).replace(/, \d{4}$/, '');

/**
 * Driver Home (mobile M6, the owner's fintech reference mapped to trucking): "Hello <name>", bell
 * and avatar; the current load in front of a stack with the next loads peeking behind; round quick
 * actions; Ask NeWay; then this week's pay and today's tasks as clean rows. Everything comes from
 * the TMS (GET /driver/me, /driver/loads, /driver/pti/current, /driver/settlements); while a part
 * loads it says "Loading…", never a zero.
 */
export default function DriverToday() {
  const account = useAccount();
  const me = useResource<DriverMe>(routes.driverMe);
  const active = useResource<DriverLoadsResponse>(routes.driverLoads('active'));
  const upcoming = useResource<DriverLoadsResponse>(routes.driverLoads('upcoming'));
  const pti = useResource<DriverPtiCurrent>(routes.driverPtiCurrent);
  const pay = useResource<DriverSettlementList>(routes.driverSettlements());
  const unread = useUnreadCount(true);
  const firstLoad = active.status === 'ready' ? active.data.loads[0] : undefined;
  const detail = useResource<DriverLoadDetail>(firstLoad ? routes.driverLoad(firstLoad.id) : null);
  const { items } = useQueue();
  const waiting = items.filter((i) => i.status === 'waiting' || i.status === 'uploading' || i.status === 'failed');
  const firstName = (me.status === 'ready' ? me.data.driver.firstName : null) || account.name.split(/\s+/)[0];

  const tasks: Task[] = [];
  if (pti.status === 'ready' && pti.data.truck) {
    const p = pti.data;
    const done = p.state === 'received' || p.state === 'in_review' || p.state === 'reviewed';
    tasks.push({ key: 'pti', title: p.state === 'correction_requested' ? t('Fix PTI — correction requested') : done ? t('PTI — {state}', { state: t(p.stateLabel) }) : t('Complete PTI'), done, href: '/driver/pti' });
  }
  if (firstLoad && !firstLoad.acknowledgedAt) {
    tasks.push({ key: 'ack', title: t('Acknowledge load #{number}', { number: firstLoad.loadNumber }), done: false, href: `/driver/load/${firstLoad.id}` });
  }
  if (detail.status === 'ready') {
    for (const due of detail.data.documentsDue) {
      tasks.push({ key: `doc-${due.type}-${due.stopId ?? ''}`, title: dueLabel(due.label), done: false, href: { pathname: '/driver/scan', params: { loadId: detail.data.id, type: due.type, stopId: due.stopId ?? '' } } });
    }
  }
  const tasksLoading = pti.status === 'loading' || active.status === 'loading' || (firstLoad && detail.status === 'loading');

  const next = firstLoad?.nextStop;
  const docType = next?.kind === 'pickup' ? 'bol' : 'pod';
  const latest = pay.status === 'ready' ? pay.data.settlements[0] : undefined;
  const truck = me.status === 'ready' ? me.data.truck : null;

  return (
    <Screen
      header={false}
      background={color.canvas}
      onRefresh={() => {
        me.reload();
        active.reload();
        upcoming.reload();
        pti.reload();
        pay.reload();
      }}
    >
      {/* Hello, bell, avatar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.lg }}>
        <View style={{ flex: 1 }}>
          <Text variant="title" accessibilityRole="header" numberOfLines={1}>
            {t('Hello {name}', { name: firstName })}
          </Text>
          <Text variant="small" tint={color.text2} numberOfLines={1}>
            {headerDate()}
            {truck ? ` · ${t('Unit {unit}', { unit: truck.unitNumber })}` : ''}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={unread ? t('Notifications, {count} unread', { count: unread }) : t('Notifications')}
          onPress={() => router.push('/driver/notifications')}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.panel, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="bell-outline" size={22} tint={color.ink} />
          {unread ? <View style={{ position: 'absolute', top: 10, right: 11, width: 9, height: 9, borderRadius: 5, backgroundColor: color.dangerIcon, borderWidth: 1.5, borderColor: color.panel }} /> : null}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Settings')} onPress={() => router.push('/settings')}>
          <Avatar name={account.name} size={44} tone="info" />
        </Pressable>
      </View>

      {/* The load stack */}
      {active.status === 'loading' || upcoming.status === 'loading' ? (
        <LoadStackPlaceholder title={t('Loading…')} />
      ) : active.status === 'error' ? (
        <ErrorFor error={active.error} what={t('Your loads')} onRetry={active.reload} compact />
      ) : (
        (() => {
          const loads = [...active.data.loads, ...(upcoming.status === 'ready' ? upcoming.data.loads : [])];
          return loads.length ? <LoadStack loads={loads} activeCount={active.data.loads.length} /> : <LoadStackPlaceholder title={t('No active load')} body={t('When dispatch assigns you a load, it shows up here.')} />;
        })()
      )}

      <QuickActions
        actions={[
          {
            key: 'upload',
            label: firstLoad ? t('Upload {doc}', { doc: docType.toUpperCase() }) : t('Documents'),
            icon: firstLoad ? 'file-upload-outline' : 'card-account-details-outline',
            onPress: () =>
              firstLoad ? router.push({ pathname: '/driver/scan', params: { loadId: firstLoad.id, type: docType, stopId: next?.stopId ?? '' } }) : router.push('/driver/documents'),
          },
          { key: 'inbox', label: t('Messages'), icon: 'message-text-outline', onPress: () => router.push('/driver/inbox') },
          { key: 'pay', label: t('Pay'), icon: 'wallet-outline', onPress: () => router.push('/driver/money') },
          { key: 'more', label: t('More'), icon: 'dots-grid', onPress: () => router.push('/driver/more') },
        ]}
      />

      <View style={{ marginTop: space.md }}>
        <AskRow />
      </View>

      <HomeSection title={t('This week')} action={t('All pay')} onAction={() => router.push('/driver/money')}>
        {pay.status === 'loading' ? (
          <LoadingState compact />
        ) : pay.status === 'error' ? (
          <ErrorFor error={pay.error} what={t('Your pay')} onRetry={pay.reload} compact />
        ) : latest ? (
          <HomeRow
            icon="wallet-outline"
            tone={latest.state === 'paid' ? 'success' : 'accent'}
            title={t('Net pay')}
            subtitle={`${short(latest.periodStart)} – ${short(latest.periodEnd)} · ${latest.state === 'paid' ? (latest.paidAt ? t('Paid {date}', { date: short(latest.paidAt.slice(0, 10)) }) : t('Paid')) : t('{state} · pay date {date}', { state: t(latest.stateLabel), date: short(latest.payDate) })}`}
            value={
              // Net is after charges and deductions; the amount sits right, centred on the row, one line.
              <View style={{ alignItems: 'flex-end', justifyContent: 'center', flexShrink: 0, maxWidth: '45%' }}>
                <Text variant="heading" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={{ textAlign: 'right' }}>
                  {moneyCents(latest.netCents)}
                </Text>
                <Text variant="caption" tint={color.text3} numberOfLines={1} style={{ textAlign: 'right' }}>
                  {t('after deductions')}
                </Text>
              </View>
            }
            href={{ pathname: '/driver/money', params: { statement: latest.id } }}
            last={!truck && !waiting.length}
          />
        ) : (
          <HomeRow icon="wallet-outline" tone="neutral" title={t('No finalized statement yet')} subtitle={t('It shows up when Accounting finalizes your week.')} last={!truck && !waiting.length} />
        )}
        {truck ? (
          <HomeRow
            icon="truck-outline"
            tone="info"
            title={`${t('Unit {unit}', { unit: truck.unitNumber })}${me.status === 'ready' && me.data.trailer ? ` · ${t('Trailer {unit}', { unit: me.data.trailer.unitNumber })}` : ''}`}
            subtitle={me.status === 'ready' && me.data.telematics?.freshness === 'fresh' ? me.data.telematics.location?.text : [truck.make, truck.model].filter(Boolean).join(' ') || null}
            href="/driver/documents"
            last={!waiting.length}
          />
        ) : null}
        {waiting.length ? (
          <HomeRow icon="cloud-upload-outline" tone="warning" title={t('On this phone')} subtitle={tn(waiting.length, '{count} item is waiting to reach the TMS', '{count} items are waiting to reach the TMS')} href="/driver/uploads" last />
        ) : null}
      </HomeSection>

      <HomeSection title={t("Today's tasks")}>
        {tasksLoading ? (
          <LoadingState compact />
        ) : tasks.length ? (
          tasks.map((task, i) => (
            <HomeRow
              key={task.key}
              icon={task.done ? 'check-circle' : task.key === 'pti' ? 'clipboard-check-outline' : task.key === 'ack' ? 'handshake-outline' : 'file-document-outline'}
              tone={task.done ? 'success' : task.key === 'pti' ? 'warning' : 'accent'}
              title={task.title}
              subtitle={task.done ? t('Done') : t('To do')}
              done={task.done}
              href={task.href}
              last={i === tasks.length - 1}
            />
          ))
        ) : (
          <HomeRow icon="check-circle-outline" tone="success" title={t('Nothing due today')} last />
        )}
      </HomeSection>
    </Screen>
  );
}
