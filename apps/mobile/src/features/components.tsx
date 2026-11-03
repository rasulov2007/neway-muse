import { router } from 'expo-router';
import { Pressable, View, StyleSheet } from 'react-native';

import type { DriverLoadSummary } from '@/api/contract';
import { useSession, type Shell } from '@/auth/session';
import { STATUS_LABEL, type QueueItem } from '@/offline/queue-core';
import { Button, ListRow } from '@/ui/controls';
import { Avatar, Divider, Icon, StatusPill, Text } from '@/ui/primitives';
import { color, space, type StatusTone } from '@/ui/tokens';

import { t } from '@/i18n/core';

import { appointment, loadStatus, placeOf } from './loads';

// ------------------------------------------------------------------------------------ TripCard

/** A trip on the Trips list (sheet 02): number, status, pickup → delivery, units. */
export function TripCard({ load, onPress }: { load: DriverLoadSummary; onPress?: () => void }) {
  const status = loadStatus(load.status);
  const facts = [
    load.truckUnit ? t('Truck {unit}', { unit: load.truckUnit }) : null,
    load.trailerUnit ? t('Trailer {unit}', { unit: load.trailerUnit }) : null,
    t('{count} stops', { count: load.stopCount }),
    load.loadedMiles ? t('Loaded {miles} mi', { miles: load.loadedMiles.toLocaleString('en-US') }) : null,
    load.deadheadMiles ? t('DH {miles} mi', { miles: load.deadheadMiles.toLocaleString('en-US') }) : null,
    load.reference ? t('Ref {ref}', { ref: load.reference }) : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Load {number}, {status}', { number: load.loadNumber, status: load.statusLabel ? t(load.statusLabel) : status.label })}
      onPress={onPress}
      style={({ pressed }) => ({
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: color.border,
        borderRadius: 10,
        padding: space.md,
        backgroundColor: pressed ? color.subtle : color.background,
        gap: space.md,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Text variant="heading" style={{ flexShrink: 1 }}>
          #{load.loadNumber}
        </Text>
        <StatusPill tone={status.tone} label={load.statusLabel ? t(load.statusLabel) : status.label} />
        {load.correctionsRequested ? <StatusPill tone="danger" label={t('{count} to fix', { count: load.correctionsRequested })} /> : null}
        <View style={{ flex: 1, minWidth: 0 }} />
        <Icon name="chevron-right" size={22} tint={color.text3} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        {[load.firstPickup, load.lastDelivery].map((stop, i) => {
          const when = stop ? appointment(stop) : null;
          return (
            <View key={i} style={{ flex: 1, flexDirection: 'row', gap: space.sm }}>
              <View style={{ alignItems: 'center', paddingTop: 4 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: i === 0 ? color.success : color.borderStrong }} />
                <View style={{ width: 2, flex: 1, backgroundColor: i === 0 ? color.success : color.divider, marginTop: 2 }} />
              </View>
              <View style={{ flex: 1, gap: 1 }}>
                <Text variant="caption" tint={color.text2}>
                  {i === 0 ? t('Pickup') : t('Delivery')}
                </Text>
                <Text variant="smallStrong">{stop ? placeOf(stop) : '—'}</Text>
                {when?.local ? (
                  <Text variant="caption" tint={color.text2}>
                    {when.local}
                  </Text>
                ) : null}
                {when?.eastern ? (
                  <Text variant="caption" tint={color.text3}>
                    {when.eastern}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
      <Divider />
      <Text variant="caption" tint={color.text2}>
        {facts.join('  •  ')}
      </Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------------------- Queue status

export function queueTone(item: QueueItem): StatusTone {
  switch (item.status) {
    case 'saved':
      return 'neutral';
    case 'waiting':
      return item.pausedForSignIn ? 'warning' : 'info';
    case 'uploading':
      return 'moving';
    case 'received':
      return 'success';
    case 'failed':
      return 'danger';
  }
}

/** One item on the phone: its status word, progress while uploading, and Retry when it failed. */
export function QueueItemRow({ item, onRetry, onDiscard, divider = true }: { item: QueueItem; onRetry?: () => void; onDiscard?: () => void; divider?: boolean }) {
  // What the server answered: a filed document (with its review words) or a PTI state.
  const result = item.result as { document?: { title?: string; stateLabel?: string }; stateLabel?: string } | null;
  const receipt =
    item.status === 'received' ? t(result?.document?.stateLabel ?? result?.stateLabel ?? 'Received by TMS') : null;
  return (
    <View>
      <View style={{ paddingVertical: space.md, gap: space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text variant="rowTitle" style={{ flex: 1 }}>
            {item.title}
          </Text>
          <StatusPill tone={queueTone(item)} label={STATUS_LABEL[item.status]} />
        </View>
        {item.subtitle ? (
          <Text variant="small" tint={color.text2}>
            {item.subtitle}
          </Text>
        ) : null}
        {item.status === 'uploading' ? (
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }} style={{ height: 4, borderRadius: 2, backgroundColor: color.subtle, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round(item.progress * 100)}%`, height: 4, backgroundColor: color.primary }} />
          </View>
        ) : null}
        {receipt ? (
          <Text variant="caption" tint={color.success}>
            {t('TMS: {receipt}', { receipt })}
          </Text>
        ) : null}
        {item.review ? (
          <Text variant="caption" tint={color.text2}>
            {t('Review: {label}', { label: t(item.review.label) })}
            {item.review.reason ? ` — ${item.review.reason}` : ''}
          </Text>
        ) : null}
        {item.lastError && item.status !== 'received' ? (
          <Text variant="caption" tint={item.status === 'failed' ? color.danger : color.text2}>
            {item.lastError}
          </Text>
        ) : null}
        {item.status === 'failed' || (item.status === 'waiting' && !item.pausedForSignIn) || item.status === 'received' || item.status === 'saved' ? (
          <View style={{ flexDirection: 'row', gap: space.lg }}>
            {(item.status === 'failed' || item.status === 'waiting') && onRetry ? <Button variant="link" icon="refresh" label={t('Retry now')} onPress={onRetry} /> : null}
            {(item.status === 'received' || item.status === 'saved' || item.status === 'failed') && onDiscard ? (
              <Button variant="link" icon="delete-outline" label={item.status === 'received' ? t('Clear') : t('Delete from phone')} onPress={onDiscard} />
            ) : null}
          </View>
        ) : null}
      </View>
      {divider ? <Divider /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------- Account block

/** Profile line, company switch, shell switch and sign-out — shared by both More screens. */
export function AccountSection({ shell }: { shell: Shell }) {
  const { account, canDrive, canOffice, setShell } = useSession();
  if (!account) return null;
  const other: Shell = shell === 'driver' ? 'office' : 'driver';
  const canSwitch = shell === 'driver' ? canOffice : canDrive;
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
        <Avatar name={account.name} size={56} tone="info" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">{account.name}</Text>
          {account.companyName ? (
            <Text variant="small" tint={color.text2}>
              {account.companyName}
            </Text>
          ) : null}
          <Text variant="caption" tint={color.text3}>
            {account.email}
          </Text>
        </View>
      </View>
      <Divider />
      <ListRow
        left={<Icon name="cog-outline" tint={color.primary} />}
        title={t('Settings')}
        subtitle={t('Appearance, Face ID, notifications')}
        onPress={() => router.push('/settings')}
      />
      {canSwitch ? (
        <ListRow
          left={<Icon name="swap-horizontal" tint={color.primary} />}
          title={other === 'driver' ? t('Switch to Driver') : t('Switch to Office')}
          subtitle={other === 'driver' ? t('Your loads, documents and pay') : t('Dispatch, approvals and team work')}
          onPress={async () => {
            await setShell(other);
            router.replace(other === 'driver' ? '/driver/today' : '/office/today');
          }}
        />
      ) : null}
    </>
  );
}

/** Sign out: last row of More. Clears this membership's drafts and queue from the phone. */
export function SignOutRow() {
  const { logout } = useSession();
  return (
    <>
      <ListRow
        left={<Icon name="logout" tint={color.danger} />}
        title={<Text variant="bodyStrong" tint={color.danger}>{t('Sign out')}</Text>}
        subtitle={t('Removes your drafts and waiting uploads from this phone')}
        chevron={false}
        divider={false}
        onPress={async () => {
          await logout();
          router.replace('/login');
        }}
      />
    </>
  );
}
