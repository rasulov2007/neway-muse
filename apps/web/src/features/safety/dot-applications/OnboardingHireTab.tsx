import { Link } from '@tanstack/react-router';
import { ArrowRight, RotateCcw, Save, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { DRIVER_LANGUAGES, DRIVER_TYPES, PAY_PLAN_KINDS, type DotAppHireInput, type DotAppSafetyDetail } from '@neway/shared';
import { Alert, Button, Checkbox, DatePicker, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { dotAppSafetyApi, useSafetyMutation } from '@/features/dot-application/api';
import { FamilyBadge, driverNumber } from '@/features/dot-application/status';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';
import { longDateTime } from '@/features/hr/recruit/recruit-format';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { ApiError } from '@/lib/api-client';
import { today } from '@/lib/clock';
import { CarrierSignature, Checklist, LegalText, Panel, templateOf } from './kit';

const DRIVER_TYPE_LABELS: Record<(typeof DRIVER_TYPES)[number], string> = { company: 'Company driver', owner_operator: 'Owner-operator', lease_operator: 'Lease operator' };
const PAY_PLAN_LABELS: Record<(typeof PAY_PLAN_KINDS)[number], string> = {
  per_mile: 'Per mile',
  percent_of_linehaul: 'Percent of linehaul',
  lease_owner: 'Lease owner',
  lease_to_own: 'Lease to own',
  owner_truck: 'Owner truck',
};
const LANGUAGE_LABELS: Record<(typeof DRIVER_LANGUAGES)[number], string> = { en: 'English', es: 'Spanish', ru: 'Russian', uz: 'Uzbek', uk: 'Ukrainian' };

interface Onboarding {
  trainingDate: string;
  instructor: string;
  ch: boolean;
  mvrpsp: boolean;
  dot: boolean;
}

function readOnboarding(o: Record<string, unknown>): Onboarding {
  return {
    trainingDate: typeof o.trainingDate === 'string' ? o.trainingDate : '',
    instructor: typeof o.instructor === 'string' ? o.instructor : '',
    ch: o.ch === true,
    mvrpsp: o.mvrpsp === true,
    dot: o.dot === true,
  };
}

/** Safety → Onboarding & hire: opens after approval; Hire is one server transaction into Fleet → Drivers. */
export function OnboardingHireTab({ detail, onReload }: { detail: DotAppSafetyDetail; onReload: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Onboarding>(readOnboarding(detail.onboarding ?? {}));
  const [base, setBase] = useState(detail.version);
  const [stale, setStale] = useState(false);
  const [hiring, setHiring] = useState(false);
  const save = useSafetyMutation(detail.id, (o: Onboarding) => dotAppSafetyApi.onboarding(detail.id, base, { ...o }));
  const ready = detail.status === 'approved';
  const hired = detail.status === 'hired';
  const open = ready || hired;
  const training = templateOf(detail, 'safety_training');
  const dirty = JSON.stringify(draft) !== JSON.stringify(readOnboarding(detail.onboarding ?? {}));
  const allDone = detail.onboardingChecklist.every((x) => x.done);
  const set = <K extends keyof Onboarding>(k: K, value: Onboarding[K]) => setDraft((d) => ({ ...d, [k]: value }));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" data-testid="onboarding-hire">
      <div className="flex min-w-0 flex-col gap-4">
        {!open ? <Alert tone="info" description="Onboarding opens after Safety approves the application." /> : null}
        {stale ? (
          <Alert
            tone="danger"
            title="Someone else saved this application meanwhile"
            description="Reload to see their changes, then make yours again."
            actions={
              <Button size="sm" variant="secondary" icon={<RotateCcw />} onClick={onReload}>
                Reload
              </Button>
            }
          />
        ) : null}
        {training ? (
          <Panel title={training.title} description={`${training.source ?? ''} · version ${training.version} · driver and instructor sign in person`} actions={<FamilyBadge family="info">In person</FamilyBadge>}>
            <div className="flex flex-col gap-4">
              <LegalText html={(training.content as { html?: string }).html} />
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Date">
                  <DatePicker aria-label="Training date" value={draft.trainingDate || undefined} onIsoChange={(iso) => set('trainingDate', iso)} disabled={!ready} />
                </FormField>
                <FormField label="Instructor">
                  <Input value={draft.instructor} onChange={(e) => set('instructor', e.target.value)} disabled={!ready} />
                </FormField>
              </div>
              <CarrierSignature
                detail={detail}
                sigKey="emp_training_driver"
                label="Driver Signature (the driver signs here, in person)"
                defaultName={[detail.answers.personal?.firstName, detail.answers.personal?.middleName, detail.answers.personal?.lastName].filter(Boolean).join(' ') || detail.candidateName}
                disabled={!ready}
              />
              <CarrierSignature detail={detail} sigKey="emp_training" label="Instructor’s signature" disabled={!ready} />
            </div>
          </Panel>
        ) : null}
        <Panel title="Onboarding checklist" description={`${detail.onboardingChecklist.filter((x) => x.done).length} of ${detail.onboardingChecklist.length} done`}>
          <div className="flex flex-col gap-3">
            <Checklist items={detail.onboardingChecklist} testId="onboarding-checklist" />
            <div className="flex flex-col gap-2 border-t border-nw-border pt-3">
              <Checkbox checked={draft.ch} onCheckedChange={(x) => set('ch', x === true)} disabled={!ready} label="Clearinghouse query result recorded" />
              <Checkbox checked={draft.mvrpsp} onCheckedChange={(x) => set('mvrpsp', x === true)} disabled={!ready} label="MVR and PSP reviewed" />
              <Checkbox checked={draft.dot} onCheckedChange={(x) => set('dot', x === true)} disabled={!ready} label="For Department of Transportation verification purpose only — initial" />
            </div>
            {ready ? (
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  icon={<Save />}
                  disabled={!dirty}
                  loading={save.isPending}
                  data-testid="onboarding-save"
                  onClick={() =>
                    save.mutate(draft, {
                      onSuccess: (next) => {
                        setBase(next.version);
                        setDraft(readOnboarding(next.onboarding ?? {}));
                        setStale(false);
                        toast({ tone: 'success', title: 'Onboarding saved' });
                      },
                      onError: (e) => {
                        if (e instanceof ApiError && e.status === 409) setStale(true);
                        else toast({ tone: 'danger', title: 'Not saved', description: errorText(e) });
                      },
                    })
                  }
                >
                  Save onboarding
                </Button>
              </div>
            ) : null}
          </div>
        </Panel>
      </div>
      <Panel title="Hire" testId="hire-panel" className="h-fit">
        {hired ? (
          <div className="flex flex-col gap-3">
            <Alert tone="success" title={`Hired as ${driverNumber(detail.rosterDriverId ?? detail.driverId)} — open Fleet → Drivers`} description={`Hired ${longDateTime(detail.hiredAt)}. The CDL, medical card and signed application are in the driver's qualification file.`} />
            {detail.rosterDriverId ? (
              <Link to="/drivers/$driverId" params={{ driverId: detail.rosterDriverId }} className="inline-flex items-center gap-1.5 text-sm font-semibold text-nw-accent-ink hover:underline" data-testid="open-driver">
                Open Fleet → Drivers <ArrowRight aria-hidden className="size-4" />
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-nw-text-2">
              Creates the Fleet driver profile under the reserved ID <span className="font-mono font-semibold">{driverNumber(detail.driverId)}</span> and files the CDL, medical card and signed application. Not created as an HR employee.
            </p>
            <Button variant="primary" icon={<UserPlus />} disabled={!ready || !allDone || !detail.permissions.canHire} onClick={() => setHiring(true)} data-testid="hire-open">
              Hire driver
            </Button>
            <p className="text-xs text-nw-text-3">
              Needs: Safety approval{ready ? ' ✓' : ''} · every onboarding item{allDone ? ' ✓' : ''}
            </p>
          </div>
        )}
      </Panel>
      {hiring ? <HireModal detail={detail} onClose={() => setHiring(false)} /> : null}
    </div>
  );
}

function HireModal({ detail, onClose }: { detail: DotAppSafetyDetail; onClose: () => void }) {
  const { toast } = useToast();
  const hire = useSafetyMutation(detail.id, (body: DotAppHireInput) => dotAppSafetyApi.hire(detail.id, body));
  const [form, setForm] = useState<DotAppHireInput>({ hireDate: today(), dispatcherId: '', driverType: 'company', payPlanKind: 'per_mile', payPlanRate: 0, preferredLanguage: 'en' });
  const set = <K extends keyof DotAppHireInput>(k: K, value: DotAppHireInput[K]) => setForm((f) => ({ ...f, [k]: value }));
  const checks = [
    { label: 'Safety approval on file', ok: detail.status === 'approved' },
    { label: `Reserved ID ${driverNumber(detail.driverId)}`, ok: Boolean(detail.driverId) },
    { label: `Company: ${detail.company.name}`, ok: true },
  ];
  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !hire.isPending ? onClose() : undefined)}
      title={`Hire ${detail.candidateName}?`}
      description="One transaction: create or activate the Fleet driver, file the CDL, medical card and signed application, mark the candidate hired. If any step fails nothing is saved."
      dismissible={!hire.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={hire.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={hire.isPending}
            disabled={!form.hireDate}
            data-testid="hire-confirm"
            onClick={() =>
              hire.mutate(form, {
                onSuccess: (r) => {
                  toast({ tone: 'success', title: `Hired as ${driverNumber(r.rosterDriverId ?? r.driverId)}` });
                  onClose();
                },
              })
            }
          >
            Confirm hire
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="hire-modal">
        {hire.error ? <Alert tone="danger" title="Not hired" description={errorText(hire.error)} /> : null}
        <ul className="flex flex-col gap-1.5">
          {checks.map((x) => (
            <li key={x.label} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-nw-text">{x.label}</span>
              <FamilyBadge family={x.ok ? 'done' : 'urgent'}>{x.ok ? 'OK' : 'Missing'}</FamilyBadge>
            </li>
          ))}
        </ul>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Hire date" required>
            <DatePicker aria-label="Hire date" value={form.hireDate} onIsoChange={(iso) => set('hireDate', iso)} />
          </FormField>
          <FormField label="Dispatcher" description="Optional">
            <DispatcherSelect value={form.dispatcherId || null} onValueChange={(id) => set('dispatcherId', id ?? '')} allowCreate={false} />
          </FormField>
          <FormField label="Driver type">
            <Select aria-label="Driver type" value={form.driverType} onValueChange={(x) => set('driverType', x as DotAppHireInput['driverType'])} options={DRIVER_TYPES.map((t) => ({ value: t, label: DRIVER_TYPE_LABELS[t] }))} />
          </FormField>
          <FormField label="Preferred language">
            <Select aria-label="Preferred language" value={form.preferredLanguage} onValueChange={(x) => set('preferredLanguage', x as DotAppHireInput['preferredLanguage'])} options={DRIVER_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))} />
          </FormField>
          <FormField label="Pay plan">
            <Select aria-label="Pay plan" value={form.payPlanKind} onValueChange={(x) => set('payPlanKind', x as DotAppHireInput['payPlanKind'])} options={PAY_PLAN_KINDS.map((k) => ({ value: k, label: PAY_PLAN_LABELS[k] }))} />
          </FormField>
          <FormField label={form.payPlanKind === 'percent_of_linehaul' ? 'Rate (%)' : 'Rate'}>
            <Input type="number" min={0} max={100} step="0.01" value={String(form.payPlanRate)} onChange={(e) => set('payPlanRate', Number(e.target.value) || 0)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
