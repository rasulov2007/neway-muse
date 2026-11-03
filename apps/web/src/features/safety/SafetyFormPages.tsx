import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { INSPECTION_KINDS, VIOLATION_CATEGORIES } from '@neway/shared';
import {
  DatePicker,
  BackButton,
  Alert,
  Button,
  Card,
  Checkbox,
  FormField,
  FormSection,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import {
  createInspection,
  createViolation,
  demoData,
  reportAccident,
  type AccidentKind,
} from '@/demo';
import { ACCIDENT_KIND_LABEL, INSPECTION_KIND_LABEL, VIOLATION_CATEGORY_LABEL } from './safety-ui';
import { useInvalidateSafety } from './useSafety';

/**
 * The three "record something" forms.
 *
 * They share one rule: ask only for what a person actually knows at the moment of recording, and
 * never for something the system can work out. An accident's DOT recordability is derived from the
 * fatality, injury and tow answers rather than asked as a checkbox; a violation's FMCSA weight is
 * dropped when the source is an internal review, because an internal finding never went on a
 * roadside report.
 */

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <FormSection
        title={title}
        description={description}
        className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-8"
      >
        {children}
      </FormSection>
    </Card>
  );
}

function useFleetOptions() {
  return useMemo(() => {
    const trucks = demoData.trucks
      .filter((t) => t.status !== 'sold' && t.status !== 'archived')
      .map((t) => ({ value: t.id, label: `${t.unitNumber} — ${t.year} ${t.make} ${t.model}` }));
    const trailers = demoData.trailers.map((t) => ({
      value: t.id,
      label: `${t.unitNumber} — ${t.type.replace(/_/g, ' ')}`,
    }));
    const drivers = demoData.drivers
      .filter((d) => d.status !== 'terminated')
      .map((d) => ({ value: d.id, label: `${d.name} · ${d.driverNumber}` }));
    const loads = demoData.loads
      .slice(0, 60)
      .map((l) => ({ value: l.id, label: `${l.loadNumber} — ${l.customerName}` }));
    return { trucks, trailers, drivers, loads };
  }, []);
}

// ---------------------------------------------------------------------------------------------
// Create inspection
// ---------------------------------------------------------------------------------------------

export function InspectionFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const { trucks, trailers, drivers } = useFleetOptions();

  const [assetId, setAssetId] = useState('');
  const [kind, setKind] = useState<string>('annual_dot');
  const [at, setAt] = useState('');
  const [inspector, setInspector] = useState('');
  const [agency, setAgency] = useState('');
  const [driverId, setDriverId] = useState('');
  const [trailerId, setTrailerId] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [level, setLevel] = useState('');
  const [reportNumber, setReportNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const roadside = kind === 'roadside';

  const create = useMutation({
    mutationFn: () =>
      createInspection({
        assetId,
        kind: kind as 'annual_dot' | 'pre_trip' | 'post_trip' | 'roadside' | 'other',
        at: new Date(at).toISOString(),
        inspector,
        inspectorAgency: roadside && agency.trim() ? agency.trim() : null,
        driverId: driverId || null,
        trailerId: trailerId || null,
        location:
          city.trim() && state.trim()
            ? { city: city.trim(), state: state.trim().toUpperCase() }
            : null,
        level: roadside && level ? (Number(level) as 1 | 2 | 3 | 4 | 5 | 6) : null,
        reportNumber: roadside && reportNumber.trim() ? reportNumber.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (inspection) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${inspection.inspectionNumber} booked`,
        description: 'It has no result until someone performs it.',
      });
      void navigate({
        to: '/safety/inspections/$inspectionId',
        params: { inspectionId: inspection.id },
      });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The inspection could not be created.'),
  });

  const valid = assetId !== '' && at !== '' && inspector.trim() !== '';

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/inspections" />}
        title="Create inspection"
        description="What is being inspected, when, and by whom."
      />

      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <Alert
          tone="info"
          title="An inspection starts with no result"
          description="It is booked, then performed, then recorded. Its findings are added afterwards, and each one can raise a corrective action that is tracked to a repair."
        />

        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <SectionCard title="Subject" description="The unit being inspected.">
          <FormField label="Unit" required>
            <Select
              options={trucks}
              value={assetId}
              onValueChange={setAssetId}
              placeholder="Pick a unit"
            />
          </FormField>
          <FormField label="Trailer" description="Optional.">
            <Select
              options={[{ value: '', label: 'None' }, ...trailers]}
              value={trailerId}
              onValueChange={setTrailerId}
            />
          </FormField>
          <FormField label="Driver" description="Optional; a shop inspection has none.">
            <Select
              options={[{ value: '', label: 'None' }, ...drivers]}
              value={driverId}
              onValueChange={setDriverId}
            />
          </FormField>
        </SectionCard>

        <SectionCard title="Inspection" description="What kind, when and by whom.">
          <FormField label="Type" required>
            <Select
              options={INSPECTION_KINDS.map((value) => ({
                value,
                label: INSPECTION_KIND_LABEL[value],
              }))}
              value={kind}
              onValueChange={setKind}
            />
          </FormField>
          <FormField label="Date and time" required>
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </FormField>
          <FormField label="Inspector" required>
            <Input
              value={inspector}
              onChange={(e) => setInspector(e.target.value)}
              placeholder={roadside ? 'Officer Reyes' : 'M. Delgado'}
            />
          </FormField>
          {roadside ? (
            <>
              <FormField label="Agency">
                <Input
                  value={agency}
                  onChange={(e) => setAgency(e.target.value)}
                  placeholder="Illinois State Police"
                />
              </FormField>
              <FormField label="Level" description="Roadside inspections are levels I to VI.">
                <Select
                  options={[
                    { value: '', label: 'Not recorded' },
                    ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `Level ${n}` })),
                  ]}
                  value={level}
                  onValueChange={setLevel}
                />
              </FormField>
              <FormField label="Report #">
                <Input value={reportNumber} onChange={(e) => setReportNumber(e.target.value)} />
              </FormField>
            </>
          ) : null}
        </SectionCard>

        <SectionCard title="Location" description="Where it took place. Optional.">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
            <FormField label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </FormField>
            <FormField label="State">
              <Input
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                className="uppercase"
              />
            </FormField>
          </div>
          <FormField label="Notes" description="Optional.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </SectionCard>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => void navigate({ to: '/safety/inspections' })}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Create inspection
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Record violation
// ---------------------------------------------------------------------------------------------

export function ViolationFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const { trucks, drivers } = useFleetOptions();

  const [driverId, setDriverId] = useState('');
  const [truckId, setTruckId] = useState('');
  const [onDate, setOnDate] = useState('');
  const [category, setCategory] = useState<string>('hos');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [points, setPoints] = useState('');
  const [source, setSource] = useState('roadside');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [citation, setCitation] = useState('');
  const [agency, setAgency] = useState('');
  const [fine, setFine] = useState('');
  const [courtDate, setCourtDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const roadside = source === 'roadside';

  const create = useMutation({
    mutationFn: () =>
      createViolation({
        driverId: driverId || null,
        truckId: truckId || null,
        onDate,
        category: category as (typeof VIOLATION_CATEGORIES)[number],
        code,
        description,
        severity: severity as 'low' | 'medium' | 'high' | 'critical',
        points: roadside && points ? Number(points) : null,
        source: roadside ? 'roadside' : 'company',
        inspectionId: null,
        location:
          city.trim() && state.trim()
            ? { city: city.trim(), state: state.trim().toUpperCase() }
            : null,
        citationNumber: roadside && citation.trim() ? citation.trim() : null,
        issuingAgency: roadside && agency.trim() ? agency.trim() : null,
        fineAmount: roadside && fine ? Number(fine) : null,
        courtDate: roadside && courtDate ? courtDate : null,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (violation) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${violation.violationNumber} recorded`,
        description:
          violation.points === null
            ? 'Recorded as an internal finding, so it carries no FMCSA weight.'
            : `${VIOLATION_CATEGORY_LABEL[violation.category]} · weight ${violation.points}.`,
      });
      void navigate({
        to: '/safety/violations/$violationId',
        params: { violationId: violation.id },
      });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The violation could not be recorded.'),
  });

  const valid =
    onDate !== '' && code.trim() !== '' && description.trim() !== '' && (driverId || truckId);

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/violations" />}
        title="Record violation"
        description="What was found, against whom, and where it came from."
      />

      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <Alert
          tone="info"
          title="Categories are the seven FMCSA CSA BASICs"
          description="These are what a carrier's SMS percentile is computed from and what a DOT auditor asks about, so violations are filed against them rather than a friendlier set of labels."
        />

        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <SectionCard title="Against" description="A violation needs a driver, a unit, or both.">
          <FormField label="Driver">
            <Select
              options={[{ value: '', label: 'None' }, ...drivers]}
              value={driverId}
              onValueChange={setDriverId}
            />
          </FormField>
          <FormField label="Unit">
            <Select
              options={[{ value: '', label: 'None' }, ...trucks]}
              value={truckId}
              onValueChange={setTruckId}
            />
          </FormField>
        </SectionCard>

        <SectionCard title="Violation" description="The code, the BASIC it lands in, and how bad.">
          <FormField label="Date" required>
            <DatePicker value={onDate} onIsoChange={setOnDate} />
          </FormField>
          <FormField label="BASIC" required>
            <Select
              options={VIOLATION_CATEGORIES.map((value) => ({
                value,
                label: VIOLATION_CATEGORY_LABEL[value],
              }))}
              value={category}
              onValueChange={setCategory}
            />
          </FormField>
          <FormField label="FMCSA code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="395.8(a)" />
          </FormField>
          <FormField label="Description" required>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Driver's record of duty status not current"
            />
          </FormField>
          <FormField label="Severity" required>
            <Select
              options={[
                { value: 'critical', label: 'Critical' },
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' },
              ]}
              value={severity}
              onValueChange={setSeverity}
            />
          </FormField>
        </SectionCard>

        <SectionCard
          title="Source"
          description="Where it came from decides whether it carries weight."
        >
          <FormField label="Source" required>
            <Select
              options={[
                { value: 'roadside', label: 'Roadside inspection' },
                { value: 'company', label: 'Internal safety review' },
              ]}
              value={source}
              onValueChange={setSource}
            />
          </FormField>
          {roadside ? (
            <>
              <FormField
                label="FMCSA weight"
                description="The severity weight the code carries. Leave empty if you do not have it."
              >
                <Input
                  inputMode="numeric"
                  value={points}
                  onChange={(e) => setPoints(e.target.value)}
                />
              </FormField>
              <FormField label="Citation #" description="Optional.">
                <Input value={citation} onChange={(e) => setCitation(e.target.value)} />
              </FormField>
              <FormField label="Issuing agency" description="Optional.">
                <Input value={agency} onChange={(e) => setAgency(e.target.value)} />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Fine">
                  <Input
                    inputMode="decimal"
                    value={fine}
                    onChange={(e) => setFine(e.target.value)}
                    prefix="$"
                  />
                </FormField>
                <FormField label="Court date">
                  <DatePicker value={courtDate} onIsoChange={setCourtDate} />
                </FormField>
              </div>
            </>
          ) : (
            <Alert
              tone="info"
              title="An internal finding carries no FMCSA weight"
              description="It never went on a roadside report, so recording points against it would overstate the carrier's exposure. It is still tracked, and it still earns a corrective action."
            />
          )}
        </SectionCard>

        <SectionCard title="Location" description="Where it happened. Optional.">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
            <FormField label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </FormField>
            <FormField label="State">
              <Input
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                className="uppercase"
              />
            </FormField>
          </div>
          <FormField label="Notes" description="Optional.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </SectionCard>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => void navigate({ to: '/safety/violations' })}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Record violation
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Report accident
// ---------------------------------------------------------------------------------------------

export function AccidentFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateSafety();
  const { trucks, trailers, drivers, loads } = useFleetOptions();

  const [at, setAt] = useState('');
  const [driverId, setDriverId] = useState('');
  const [truckId, setTruckId] = useState('');
  const [trailerId, setTrailerId] = useState('');
  const [loadId, setLoadId] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [highway, setHighway] = useState('');
  const [kind, setKind] = useState<string>('collision');
  const [severity, setSeverity] = useState('minor');
  const [description, setDescription] = useState('');
  const [weather, setWeather] = useState('');
  const [road, setRoad] = useState('');
  const [traffic, setTraffic] = useState('');
  const [fatalities, setFatalities] = useState('0');
  const [injuries, setInjuries] = useState('0');
  const [towed, setTowed] = useState(false);
  const [policeReport, setPoliceReport] = useState('');
  const [policeAgency, setPoliceAgency] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The federal test, applied live to what has been entered so far.
  const recordable = Number(fatalities) > 0 || Number(injuries) > 0 || towed;

  const create = useMutation({
    mutationFn: () =>
      reportAccident({
        at: new Date(at).toISOString(),
        driverId,
        truckId,
        trailerId: trailerId || null,
        loadId: loadId || null,
        location: {
          city: city.trim(),
          state: state.trim().toUpperCase(),
          highway: highway.trim() ? highway.trim() : null,
        },
        kind: kind as AccidentKind,
        severity: severity as 'minor' | 'moderate' | 'serious' | 'critical',
        description,
        weather: weather.trim() ? weather.trim() : null,
        roadConditions: road.trim() ? road.trim() : null,
        trafficConditions: traffic.trim() ? traffic.trim() : null,
        fatalities: Number(fatalities),
        injuriesTreatedAway: Number(injuries),
        towedFromScene: towed,
        policeReportNumber: policeReport.trim() ? policeReport.trim() : null,
        policeAgency: policeAgency.trim() ? policeAgency.trim() : null,
      }),
    onSuccess: async (accident) => {
      await invalidate();
      toast({
        tone: accident.dotRecordable ? 'warning' : 'success',
        title: `${accident.accidentNumber} reported`,
        description: accident.dotRecordable
          ? 'DOT recordable. The file needs a police report, a driver statement and photographs before it can be closed.'
          : 'Assign an investigator and decide preventability next.',
      });
      void navigate({
        to: '/safety/accidents/$accidentId',
        params: { accidentId: accident.id },
      });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The accident could not be reported.'),
  });

  const valid =
    at !== '' &&
    driverId !== '' &&
    truckId !== '' &&
    city.trim() !== '' &&
    /^[A-Za-z]{2}$/.test(state.trim()) &&
    description.trim() !== '';

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        back={<BackButton fallback="/safety/accidents" />}
        title="Report accident"
        description="What happened, who was involved, and what the scene looked like."
      />

      <div className="flex w-full max-w-220 flex-col gap-(--section-gap)">
        <Alert
          tone="info"
          title="Preventability is decided later, by a person"
          description="A new file opens as undetermined and unassigned. Nothing here guesses whether the accident was preventable — that decision goes on a driver's record, so it is made deliberately and attributed."
        />

        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <SectionCard title="When and who" description="The driver and equipment involved.">
          <FormField label="Date and time" required>
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </FormField>
          <FormField label="Driver" required>
            <Select
              options={drivers}
              value={driverId}
              onValueChange={setDriverId}
              placeholder="Pick a driver"
            />
          </FormField>
          <FormField label="Unit" required>
            <Select
              options={trucks}
              value={truckId}
              onValueChange={setTruckId}
              placeholder="Pick a unit"
            />
          </FormField>
          <FormField label="Trailer" description="Optional.">
            <Select
              options={[{ value: '', label: 'None' }, ...trailers]}
              value={trailerId}
              onValueChange={setTrailerId}
            />
          </FormField>
          <FormField
            label="Load"
            description="Optional; carries the customer and broker onto a claim."
          >
            <Select
              options={[{ value: '', label: 'Not on a load' }, ...loads]}
              value={loadId}
              onValueChange={setLoadId}
            />
          </FormField>
        </SectionCard>

        <SectionCard title="Where" description="The scene.">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
            <FormField label="City" required>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </FormField>
            <FormField label="State" required>
              <Input
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                className="uppercase"
              />
            </FormField>
          </div>
          <FormField label="Highway" description="Optional.">
            <Input
              value={highway}
              onChange={(e) => setHighway(e.target.value)}
              placeholder="I-70"
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Weather">
              <Input
                value={weather}
                onChange={(e) => setWeather(e.target.value)}
                placeholder="Rain"
              />
            </FormField>
            <FormField label="Road">
              <Input value={road} onChange={(e) => setRoad(e.target.value)} placeholder="Wet" />
            </FormField>
            <FormField label="Traffic">
              <Input
                value={traffic}
                onChange={(e) => setTraffic(e.target.value)}
                placeholder="Heavy"
              />
            </FormField>
          </div>
        </SectionCard>

        <SectionCard title="What happened" description="The type and a first description.">
          <FormField label="Type" required>
            <Select
              options={Object.entries(ACCIDENT_KIND_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
              value={kind}
              onValueChange={setKind}
            />
          </FormField>
          <FormField label="Severity" required>
            <Select
              options={[
                { value: 'critical', label: 'Critical' },
                { value: 'serious', label: 'Serious' },
                { value: 'moderate', label: 'Moderate' },
                { value: 'minor', label: 'Minor' },
              ]}
              value={severity}
              onValueChange={setSeverity}
            />
          </FormField>
          <FormField label="Description" required>
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Rear-ended a passenger vehicle in slowing traffic."
            />
          </FormField>
        </SectionCard>

        <SectionCard
          title="Injuries and tow"
          description="These three answers decide whether the crash is DOT recordable, under 49 CFR 390.5."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Fatalities" required>
              <Input
                inputMode="numeric"
                value={fatalities}
                onChange={(e) => setFatalities(e.target.value)}
              />
            </FormField>
            <FormField
              label="Injuries treated away from the scene"
              required
              description="Not everyone who was hurt — only those who needed immediate treatment elsewhere."
            >
              <Input
                inputMode="numeric"
                value={injuries}
                onChange={(e) => setInjuries(e.target.value)}
              />
            </FormField>
          </div>
          <Checkbox
            checked={towed}
            onCheckedChange={(checked) => setTowed(checked === true)}
            label="A vehicle was towed from the scene"
            description="Because of disabling damage, not as a convenience."
          />
          <Alert
            tone={recordable ? 'warning' : 'info'}
            title={recordable ? 'This will be DOT recordable' : 'This will not be DOT recordable'}
            description={
              recordable
                ? 'It goes into the crash BASIC, and the file will need a police report, a driver statement and photographs before it can be closed.'
                : 'No fatality, no injury treated away from the scene, and no tow for disabling damage. Change any of the three and this changes with it.'
            }
          />
        </SectionCard>

        <SectionCard title="Police" description="If an officer attended. Optional.">
          <FormField label="Report #">
            <Input value={policeReport} onChange={(e) => setPoliceReport(e.target.value)} />
          </FormField>
          <FormField label="Agency">
            <Input value={policeAgency} onChange={(e) => setPoliceAgency(e.target.value)} />
          </FormField>
        </SectionCard>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => void navigate({ to: '/safety/accidents' })}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            Report accident
          </Button>
        </div>
      </div>
    </div>
  );
}
