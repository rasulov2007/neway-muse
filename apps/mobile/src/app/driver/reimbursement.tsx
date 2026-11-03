import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type DriverLoadsResponse, type DriverMe } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { REIMBURSEMENT_CATEGORIES, REIMBURSEMENT_CATEGORY_LABEL, type ReimbursementCategory } from '@neway/shared/accounting/reimbursements';
import type { DriverLocation } from '@neway/shared/mobile/breakdowns';
import { DRIVER_REIMBURSEMENT_STATE_LABEL, type DriverReceiptPayer } from '@neway/shared/mobile/money';
import { ChoiceRow, LocationField, dollarsToCents } from '@/features/driver/common';
import { driverPostItem } from '@/features/submit';
import { t } from '@/i18n';
import { easternDay } from '@/lib/clock';
import { moneyCents } from '@/lib/format';
import type { PickedMedia } from '@/lib/media';
import { useQueue } from '@/offline/queue';
import { Button, DateField, Select, TextField } from '@/ui/controls';
import { Panel, Screen, Section, useToast } from '@/ui/layout';
import { MediaStrip } from '@/ui/media';
import { Text } from '@/ui/primitives';
import { color, space } from '@/ui/tokens';

const NONE = '_none';

/**
 * File a receipt (POST /driver/reimbursements). Paid by the driver → Accounting reviews it as a
 * reimbursement; paid with the company card → a company expense, nothing owed back. Filing never
 * approves anything. The receipt photo goes to POST /driver/files first (through the queue).
 */
export default function ReimbursementForm() {
  const me = useResource<DriverMe>(routes.driverMe);
  const active = useResource<DriverLoadsResponse>(routes.driverLoads('active'));
  const recent = useResource<DriverLoadsResponse>(routes.driverLoads('completed'));
  const [receipt, setReceipt] = useState<PickedMedia[]>([]);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ReimbursementCategory | null>(null);
  const [date, setDate] = useState<string>(easternDay());
  const [location, setLocation] = useState<DriverLocation | null>(null);
  const [loadId, setLoadId] = useState<string>(NONE);
  const [paidBy, setPaidBy] = useState<DriverReceiptPayer>('driver');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();
  const today = easternDay();
  const cents = dollarsToCents(amount);
  const truck = me.status === 'ready' ? me.data.truck : null;
  const trailer = me.status === 'ready' ? me.data.trailer : null;
  const loads = [...(active.status === 'ready' ? active.data.loads : []), ...(recent.status === 'ready' ? recent.data.loads.slice(0, 10) : [])];
  const defaultLoad = active.status === 'ready' ? active.data.loads[0]?.id : undefined;
  const chosenLoad = loadId === NONE ? (defaultLoad ?? NONE) : loadId;
  const ok = receipt.length === 1 && cents !== null && category !== null && date <= today;

  const save = async () => {
    if (!ok || cents === null || !category) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { amountCents: cents, currency: 'USD', category, date, paidBy };
      if (location?.text) body.location = location;
      if (truck) body.truckId = truck.id;
      if (trailer) body.trailerId = trailer.id;
      if (chosenLoad !== NONE && chosenLoad !== 'none') body.loadId = chosenLoad;
      if (note.trim()) body.note = note.trim();
      await queue.enqueue(
        driverPostItem({
          kind: 'reimbursement',
          title: t('Receipt · {category} {amount}', { category: t(REIMBURSEMENT_CATEGORY_LABEL[category]), amount: moneyCents(cents) }),
          subtitle: paidBy === 'driver' ? t('I paid') : t('Company card'),
          route: routes.driverReimbursements,
          body,
          files: receipt,
          fileField: 'receiptFileId',
          fileMode: 'single',
        }),
      );
      toast(paidBy === 'driver' ? t('Saved. Accounting reviews it once the phone is online.') : t('Saved as a company expense.'), 'success');
      router.replace('/driver/requests');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('Reimbursement')} subtitle={t('Send a receipt for something you paid on the road.')}>
      <Section title={t('Receipt photo')} style={{ marginTop: 0 }}>
        <MediaStrip items={receipt} onChange={setReceipt} max={1} addLabel={t('Add receipt')} prefix="receipt" size={120} />
      </Section>
      <View style={{ gap: space.md, marginTop: space.lg }}>
        <TextField label={t('Amount')} icon="currency-usd" value={amount} onChangeText={(v) => setAmount(v.slice(0, 12))} keyboardType="decimal-pad" placeholder="0.00" error={amount && cents === null ? t('Enter an amount above $0') : null} />
        <Select<ReimbursementCategory> label={t('Category')} value={category} onChange={setCategory} options={REIMBURSEMENT_CATEGORIES.map((c) => ({ value: c, label: t(REIMBURSEMENT_CATEGORY_LABEL[c]) }))} />
        <DateField label={t('Date on the receipt')} value={date} onChange={setDate} today={today} error={date > today ? t('The date cannot be in the future.') : null} />
        <LocationField value={location} onChange={setLocation} optional />
        <Select<string>
          label={t('Load (optional)')}
          value={chosenLoad}
          onChange={setLoadId}
          options={[{ value: 'none', label: t('Not for a load') }, ...loads.map((l) => ({ value: l.id, label: `#${l.loadNumber}`, description: t(l.statusLabel) }))]}
        />
        <Text variant="caption" tint={color.text3}>
          {truck ? (trailer ? t('Truck {truck} · Trailer {trailer} (your assignment)', { truck: truck.unitNumber, trailer: trailer.unitNumber }) : t('Truck {truck} (your assignment)', { truck: truck.unitNumber })) : t('No truck is assigned to you right now.')}
        </Text>
        <ChoiceRow<DriverReceiptPayer>
          label={t('Who paid')}
          value={paidBy}
          onChange={setPaidBy}
          options={[
            { key: 'driver', label: t('I paid') },
            { key: 'company_card', label: t('Company card') },
          ]}
        />
        {paidBy === 'company_card' ? (
          <Panel tinted>
            <Text variant="small" tint={color.text2}>
              {t(DRIVER_REIMBURSEMENT_STATE_LABEL.company_expense)}. {t('Fleet records it as a company expense.')}
            </Text>
          </Panel>
        ) : null}
        <TextField label={t('Note (optional)')} value={note} onChangeText={(v) => setNote(v.slice(0, 1000))} multiline />
      </View>
      <Button style={{ marginTop: space.xl }} label={t('Send receipt')} disabled={!ok} loading={busy} onPress={save} />
      {!ok ? (
        <Text variant="caption" tint={color.text3} style={{ textAlign: 'center', marginTop: space.sm }}>
          {t('A receipt photo, an amount and a category are needed.')}
        </Text>
      ) : null}
    </Screen>
  );
}
