import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { routes, type DriverLoadsResponse, type DriverMe } from '@/api/contract';
import { useResource } from '@/api/use-resource';
import { BREAKDOWN_CATEGORIES, BREAKDOWN_CATEGORY_LABEL, type BreakdownCategory, type DriverLocation } from '@neway/shared/mobile/breakdowns';
import { DRIVER_SAFETY_REPORT_KIND_LABEL, type DriverSafetyReportKind } from '@neway/shared/mobile/safety-reports';
import { ChoiceRow, ReadOnlyBox, CheckRow, LocationField } from '@/features/driver/common';
import { driverPostItem } from '@/features/submit';
import { t } from '@/i18n';
import { now } from '@/lib/clock';
import type { PickedMedia } from '@/lib/media';
import { useQueue } from '@/offline/queue';
import { Button, Select, TextField } from '@/ui/controls';
import { Screen, Section, useToast } from '@/ui/layout';
import { MediaStrip } from '@/ui/media';
import { Text } from '@/ui/primitives';
import { color, space } from '@/ui/tokens';

type Kind = 'breakdown' | DriverSafetyReportKind;
type YesNo = 'yes' | 'no' | 'unknown';
const MAX = 500;

/**
 * Sheet 08. A breakdown goes to Fleet (POST /driver/breakdowns: a BD case, and a Breakdown flag on
 * the load). An accident, roadside inspection or ticket goes to Safety (POST
 * /driver/safety-reports). The unit is the server's assignment; location is GPS with its capture
 * time or typed. Everything is saved on the phone first and sent through the queue.
 */
export default function ReportProblem() {
  const params = useLocalSearchParams<{ loadId?: string; kind?: string }>();
  const me = useResource<DriverMe>(routes.driverMe);
  const active = useResource<DriverLoadsResponse>(routes.driverLoads('active'));
  const [kind, setKind] = useState<Kind>((['accident', 'roadside_inspection', 'violation'] as string[]).includes(params.kind ?? '') ? (params.kind as Kind) : 'breakdown');
  const [category, setCategory] = useState<BreakdownCategory | null>(null);
  const [location, setLocation] = useState<DriverLocation | null>(null);
  const [files, setFiles] = useState<PickedMedia[]>([]);
  const [description, setDescription] = useState('');
  const [level, setLevel] = useState<string | null>(null);
  const [agency, setAgency] = useState('');
  const [reportNumber, setReportNumber] = useState('');
  const [injuries, setInjuries] = useState<YesNo>('unknown');
  const [towAway, setTowAway] = useState<YesNo>('unknown');
  const [police, setPolice] = useState<YesNo>('unknown');
  const [outOfService, setOutOfService] = useState(false);
  const [busy, setBusy] = useState(false);
  const queue = useQueue();
  const toast = useToast();

  const truck = me.status === 'ready' ? me.data.truck : null;
  const trailer = me.status === 'ready' ? me.data.trailer : null;
  const loads = active.status === 'ready' ? active.data.loads : [];
  const load = loads.find((l) => l.id === params.loadId) ?? loads[0] ?? null;
  const ok = description.trim().length >= 3 && Boolean(location?.text) && (kind !== 'breakdown' || category !== null);

  const save = async () => {
    setBusy(true);
    try {
      const units: Record<string, unknown> = {};
      if (truck) units.truckId = truck.id;
      if (trailer) units.trailerId = trailer.id;
      if (load) units.loadId = load.id;
      if (kind === 'breakdown') {
        await queue.enqueue(
          driverPostItem({
            kind: 'breakdown',
            title: t('Breakdown · {category}', { category: t(BREAKDOWN_CATEGORY_LABEL[category!]) }),
            subtitle: [truck ? t('Truck {unit}', { unit: truck.unitNumber }) : null, location?.text].filter(Boolean).join(' · '),
            route: routes.driverBreakdowns,
            body: { category, description: description.trim(), location, ...units },
            files,
            fileField: 'fileIds',
          }),
        );
        toast(t('Saved. Fleet receives it as soon as the phone is online.'), 'success');
      } else {
        const body: Record<string, unknown> = { kind, occurredAt: now().toISOString(), location, description: description.trim(), ...units };
        if (kind === 'roadside_inspection') {
          if (level) body.inspectionLevel = Number(level);
          if (agency.trim()) body.agency = agency.trim();
        }
        if (kind !== 'accident') {
          if (reportNumber.trim()) body.reportNumber = reportNumber.trim();
          body.outOfService = outOfService;
        } else {
          body.injuries = injuries;
          body.towAway = towAway;
          body.police = police;
        }
        await queue.enqueue(
          driverPostItem({
            kind: 'safety-report',
            title: t('{kind} report', { kind: t(DRIVER_SAFETY_REPORT_KIND_LABEL[kind]) }),
            subtitle: location?.text ?? null,
            route: routes.driverSafetyReports,
            body,
            files,
            fileField: 'fileIds',
          }),
        );
        toast(t('Saved. Safety receives it as soon as the phone is online.'), 'success');
      }
      router.replace('/driver/requests');
    } finally {
      setBusy(false);
    }
  };

  const yesNo = (label: string, value: YesNo, onChange: (v: YesNo) => void) => (
    <ChoiceRow<YesNo>
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { key: 'yes', label: t('Yes') },
        { key: 'no', label: t('No') },
        { key: 'unknown', label: t('Not sure') },
      ]}
    />
  );

  return (
    <Screen back title={t('Report a problem')} subtitle={t("Tell us what happened. We'll take care of it.")}>
      <View style={{ gap: space.md }}>
        <ChoiceRow<Kind>
          value={kind}
          onChange={setKind}
          options={[
            { key: 'breakdown', label: t('Breakdown') },
            { key: 'accident', label: t('Accident') },
            { key: 'roadside_inspection', label: t('Inspection') },
            { key: 'violation', label: t('Ticket') },
          ]}
        />
        {kind === 'breakdown' ? (
          <Select<BreakdownCategory> label={t('Issue type')} value={category} onChange={setCategory} options={BREAKDOWN_CATEGORIES.map((c) => ({ value: c, label: t(BREAKDOWN_CATEGORY_LABEL[c]) }))} />
        ) : null}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <ReadOnlyBox label={t('Unit (Truck)')} icon="truck-outline" value={me.status === 'loading' ? t('Loading…') : (truck?.unitNumber ?? null)} />
          <ReadOnlyBox label={t('Trailer')} icon="truck-trailer" value={me.status === 'loading' ? t('Loading…') : (trailer?.unitNumber ?? null)} />
        </View>
        <ReadOnlyBox label={t('Load number')} icon="file-document-outline" value={active.status === 'loading' ? t('Loading…') : load ? load.loadNumber : null} />
        <LocationField value={location} onChange={setLocation} />
        {kind === 'roadside_inspection' ? (
          <>
            <Select<string> label={t('Inspection level (optional)')} value={level} onChange={setLevel} options={['1', '2', '3', '4', '5', '6'].map((l) => ({ value: l, label: t('Level {n}', { n: l }) }))} />
            <TextField label={t('Agency (optional)')} value={agency} onChangeText={(v) => setAgency(v.slice(0, 200))} placeholder={t('e.g. Indiana State Police')} />
          </>
        ) : null}
        {kind === 'roadside_inspection' || kind === 'violation' ? (
          <>
            <TextField label={t('Report / ticket number (optional)')} value={reportNumber} onChangeText={(v) => setReportNumber(v.slice(0, 80))} autoCapitalize="characters" />
            <CheckRow label={t('The vehicle was put out of service')} value={outOfService} onChange={setOutOfService} />
          </>
        ) : null}
        {kind === 'accident' ? (
          <>
            {yesNo(t('Anyone hurt?'), injuries, setInjuries)}
            {yesNo(t('Vehicle towed?'), towAway, setTowAway)}
            {yesNo(t('Police on scene?'), police, setPolice)}
          </>
        ) : null}
      </View>
      <Section title={kind === 'breakdown' ? t('Add photo (optional)') : t('Photos (optional)')}>
        <MediaStrip items={files} onChange={setFiles} max={10} video prefix={kind === 'breakdown' ? 'breakdown' : 'report'} />
      </Section>
      <View style={{ marginTop: space.lg }}>
        <TextField label={t('Description')} value={description} onChangeText={(v) => setDescription(v.slice(0, MAX))} multiline placeholder={t('What happened, and what you need')} hint={`${description.length}/${MAX}`} />
      </View>
      <Button style={{ marginTop: space.lg }} label={kind === 'breakdown' ? t('Send to Fleet') : t('Send to Safety')} disabled={!ok} loading={busy} onPress={save} />
      {!ok ? (
        <Text variant="caption" tint={color.text3} style={{ textAlign: 'center', marginTop: space.sm }}>
          {kind === 'breakdown' ? t('Choose the issue type, add where you are and a few words.') : t('Add where you are and a few words.')}
        </Text>
      ) : null}
    </Screen>
  );
}
