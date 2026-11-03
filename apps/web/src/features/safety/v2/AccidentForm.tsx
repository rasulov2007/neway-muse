import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { assessPostAccidentTesting, dotRecordable, type SafetyAccident } from '@neway/shared';
import { Button, Checkbox, Combobox, FormField, Input, Modal, Textarea } from '@/design-system';
import { safetyApi, useSafetyPickers, useSafetyWrite } from './api';
import { easternNowInput, fromEasternInput, toEasternInput } from './time';

interface FormState {
  occurredAt: string;
  location: string;
  city: string;
  state: string;
  driverId: string | null;
  truckId: string | null;
  trailerId: string | null;
  loadId: string | null;
  description: string;
  fatalities: string;
  injuries: string;
  injuriesTreatedAway: string;
  disablingTow: boolean;
  citationIssued: boolean;
  citationAt: string;
  policeReportNumber: string;
}

function fromAccident(a: SafetyAccident | null): FormState {
  return {
    occurredAt: a ? toEasternInput(a.occurredAt) : easternNowInput(),
    location: a?.location ?? '',
    city: a?.city ?? '',
    state: a?.state ?? '',
    driverId: a?.driverId ?? null,
    truckId: a?.truckId ?? null,
    trailerId: a?.trailerId ?? null,
    loadId: a?.loadId ?? null,
    description: a?.description ?? '',
    fatalities: String(a?.fatalities ?? 0),
    injuries: String(a?.injuries ?? 0),
    injuriesTreatedAway: String(a?.injuriesTreatedAway ?? 0),
    disablingTow: a?.disablingTow ?? false,
    citationIssued: a?.citationIssued ?? false,
    citationAt: a?.citationAt ? toEasternInput(a.citationAt) : '',
    policeReportNumber: a?.policeReportNumber ?? '',
  };
}

const n = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * Record an accident, or correct its facts. The DOT recordability and the post-accident testing
 * decision are shown live from the same shared rules the server applies on save.
 */
export function AccidentForm({ open, onOpenChange, accident }: { open: boolean; onOpenChange: (open: boolean) => void; accident?: SafetyAccident | null }) {
  const navigate = useNavigate();
  const pickers = useSafetyPickers();
  const [form, setForm] = useState<FormState>(() => fromAccident(accident ?? null));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const occurredIso = fromEasternInput(form.occurredAt);
  const citationIso = form.citationIssued && form.citationAt ? fromEasternInput(form.citationAt) : null;
  const preview = useMemo(() => {
    if (!occurredIso) return null;
    return {
      recordable: dotRecordable({ fatalities: n(form.fatalities), injuriesTreatedAway: n(form.injuriesTreatedAway), towedFromScene: form.disablingTow }),
      testing: assessPostAccidentTesting({
        occurredAt: occurredIso,
        fatalities: n(form.fatalities),
        injuriesTreatedAway: n(form.injuriesTreatedAway),
        disablingTow: form.disablingTow,
        citationIssued: form.citationIssued,
        citationAt: citationIso,
      }),
    };
  }, [occurredIso, citationIso, form.fatalities, form.injuriesTreatedAway, form.disablingTow, form.citationIssued]);

  const body = () => ({
    occurredAt: occurredIso,
    location: form.location.trim(),
    city: form.city.trim() || null,
    state: form.state.trim() || null,
    driverId: form.driverId,
    truckId: form.truckId,
    trailerId: form.trailerId,
    loadId: form.loadId,
    description: form.description.trim(),
    fatalities: n(form.fatalities),
    injuries: n(form.injuries),
    injuriesTreatedAway: n(form.injuriesTreatedAway),
    disablingTow: form.disablingTow,
    citationIssued: form.citationIssued,
    citationAt: citationIso,
    policeReportNumber: form.policeReportNumber.trim() || null,
  });

  const save = useSafetyWrite(
    () =>
      accident
        ? safetyApi.patch<SafetyAccident>(`/accidents/${accident.id}`, { version: accident.version, ...body() })
        : safetyApi.post<SafetyAccident>('/accidents', body()),
    (a) => (accident ? `${a.number} saved` : `${a.number} recorded`),
  );

  const drivers = (pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }));
  const trucks = (pickers.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.number}` }));
  const trailers = (pickers.data?.trailers ?? []).map((t) => ({ value: t.id, label: `Trailer ${t.number}` }));
  const loads = (pickers.data?.loads ?? []).map((l) => ({ value: l.id, label: l.number }));
  const valid = Boolean(occurredIso) && form.location.trim().length >= 2 && (!form.citationIssued || !form.citationAt || Boolean(citationIso));

  const testingWord = (r: 'yes' | 'no' | 'undetermined') => (r === 'yes' ? 'Required' : r === 'no' ? 'Not required' : 'Needs the citation time');

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={accident ? `Edit ${accident.number}` : 'Record accident'}
      description="Times are US Eastern."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (a) => {
                  onOpenChange(false);
                  if (!accident) void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: a.id } });
                },
              })
            }
          >
            {accident ? 'Save' : 'Record accident'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Date and time (Eastern)" required>
          <Input type="datetime-local" value={form.occurredAt} onChange={(e) => set('occurredAt', e.target.value)} />
        </FormField>
        <FormField label="Location" required>
          <Input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Road, mile marker or address" />
        </FormField>
        <FormField label="City">
          <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
        </FormField>
        <FormField label="State">
          <Input value={form.state} onChange={(e) => set('state', e.target.value)} maxLength={40} />
        </FormField>
        <FormField label="Driver">
          <Combobox
            options={drivers}
            value={form.driverId}
            loading={pickers.isLoading}
            placeholder={pickers.isLoading ? 'Loading…' : 'Choose the driver'}
            onValueChange={(v) => {
              set('driverId', v);
              const truck = pickers.data?.drivers.find((d) => d.id === v)?.truckId;
              if (truck && !form.truckId) set('truckId', truck);
            }}
          />
        </FormField>
        <FormField label="Truck">
          <Combobox options={trucks} value={form.truckId} loading={pickers.isLoading} placeholder={pickers.isLoading ? 'Loading…' : 'Choose the unit'} onValueChange={(v) => set('truckId', v)} />
        </FormField>
        <FormField label="Trailer">
          <Combobox options={trailers} value={form.trailerId} loading={pickers.isLoading} placeholder="None" onValueChange={(v) => set('trailerId', v)} />
        </FormField>
        <FormField label="Load">
          <Combobox options={loads} value={form.loadId} loading={pickers.isLoading} placeholder="None" onValueChange={(v) => set('loadId', v)} />
        </FormField>
        <FormField label="What happened" className="md:col-span-2">
          <Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>
        <FormField label="Fatalities">
          <Input type="number" min={0} value={form.fatalities} onChange={(e) => set('fatalities', e.target.value)} />
        </FormField>
        <FormField label="Injuries">
          <Input type="number" min={0} value={form.injuries} onChange={(e) => set('injuries', e.target.value)} />
        </FormField>
        <FormField label="Injuries treated away from the scene">
          <Input type="number" min={0} value={form.injuriesTreatedAway} onChange={(e) => set('injuriesTreatedAway', e.target.value)} />
        </FormField>
        <FormField label="Police report #">
          <Input value={form.policeReportNumber} onChange={(e) => set('policeReportNumber', e.target.value)} />
        </FormField>
        <div className="grid gap-2 md:col-span-2">
          <Checkbox checked={form.disablingTow} onCheckedChange={(v) => set('disablingTow', v === true)} label="A vehicle was towed away with disabling damage" />
          <Checkbox checked={form.citationIssued} onCheckedChange={(v) => set('citationIssued', v === true)} label="Our driver was cited for a moving violation" />
        </div>
        {form.citationIssued ? (
          <FormField label="Citation time (Eastern)" description="Decides whether testing is required: within 8 h for alcohol, 32 h for drugs.">
            <Input type="datetime-local" value={form.citationAt} onChange={(e) => set('citationAt', e.target.value)} />
          </FormField>
        ) : null}
      </div>
      {preview ? (
        <div className="mt-4 grid gap-1 rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-sm" aria-live="polite">
          <div>
            <span className="font-semibold">DOT recordable: </span>
            {preview.recordable.recordable ? 'Yes' : 'No'} <span className="text-nw-text-3">— {preview.recordable.reasons.join('; ')}</span>
          </div>
          <div>
            <span className="font-semibold">Alcohol test: </span>
            {testingWord(preview.testing.alcohol.required)} <span className="text-nw-text-3">— {preview.testing.alcohol.reasons[0]}</span>
          </div>
          <div>
            <span className="font-semibold">Drug test: </span>
            {testingWord(preview.testing.drug.required)} <span className="text-nw-text-3">— {preview.testing.drug.reasons[0]}</span>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
