import { useState } from 'react';
import { View } from 'react-native';

import { routes, type DriverReferralList } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { requestTone } from '@/features/driver/common';
import { driverPostItem } from '@/features/submit';
import { t } from '@/i18n';
import { relativeStamp } from '@/lib/clock';
import { moneyCents } from '@/lib/format';
import { useQueue } from '@/offline/queue';
import { Button, ListRow, TextField } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { Icon, StatusPill, Text } from '@/ui/primitives';
import { EmptyState, ResourceView } from '@/ui/states';
import { color, space } from '@/ui/tokens';

/**
 * Refer a driver (POST /driver/referrals): Recruiting gets a lead with this driver as the
 * referrer. Progress is a stage word only; the bonus is shown only when the company set one.
 */
export default function Referral() {
  const list = useResource<DriverReferralList>(routes.driverReferrals);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();
  const queued = queue.items.filter((i) => i.kind === 'referral' && i.status !== 'received');
  const bonus = list.status === 'ready' ? list.data.bonusAmountCents : null;
  const ok = name.trim().length >= 2 && phone.replace(/\D/g, '').length >= 7;

  const save = async () => {
    setBusy(true);
    try {
      await queue.enqueue(
        driverPostItem({
          kind: 'referral',
          title: t('Referral · {name}', { name: name.trim() }),
          subtitle: phone.trim(),
          route: routes.driverReferrals,
          body: { name: name.trim(), phone: phone.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      );
      toast(t('Saved. Recruiting receives it as soon as the phone is online.'), 'success');
      setName('');
      setPhone('');
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('Driver Referral')} subtitle={t('Know a good driver? Send their name and phone to Recruiting.')} onRefresh={list.reload}>
      {bonus ? (
        <Panel tinted style={{ marginBottom: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Icon name="gift-outline" size={22} tint={color.success} />
            <Text variant="smallStrong" style={{ flex: 1 }}>
              {t('Referral bonus')}
            </Text>
            <StatusPill tone="success" label={moneyCents(bonus).replace(/\.00$/, '')} />
          </View>
        </Panel>
      ) : null}
      <View style={{ gap: space.md }}>
        <TextField label={t('Their name')} value={name} onChangeText={(v) => setName(v.slice(0, 120))} autoCapitalize="words" />
        <TextField label={t('Their phone')} value={phone} onChangeText={(v) => setPhone(v.slice(0, 40))} keyboardType="phone-pad" />
        <TextField label={t('Note (optional)')} value={note} onChangeText={(v) => setNote(v.slice(0, 1000))} multiline placeholder={t('Experience, where they are, best time to call')} />
      </View>
      <Button style={{ marginTop: space.lg }} label={t('Send to Recruiting')} disabled={!ok} loading={busy} onPress={save} />

      <Section title={t('My referrals')}>
        {queued.map((i) => (
          <ListRow key={i.id} title={i.title.replace('Referral · ', '').replace(t('Referral · {name}', { name: '' }), '')} subtitle={i.subtitle ?? undefined} right={<StatusPill tone="neutral" label={i.status === 'failed' ? t('Upload failed') : t('Waiting to upload')} />} chevron={false} />
        ))}
        <ResourceView resource={list} what={t('Your referrals')} compact>
          {({ referrals }) =>
            referrals.length ? (
              referrals.map((r, i) => (
                <ListRow
                  key={r.id}
                  title={r.name}
                  subtitle={t('{number} · sent {when}', { number: r.number, when: relativeStamp(r.submittedAt) })}
                  right={<StatusPill tone={requestTone('referral', r.stage)} label={t(r.stageLabel)} />}
                  chevron={false}
                  divider={i < referrals.length - 1}
                />
              ))
            ) : queued.length ? null : (
              <EmptyState compact icon="account-plus-outline" title={t('No referrals yet')} />
            )
          }
        </ResourceView>
      </Section>
    </Screen>
  );
}
