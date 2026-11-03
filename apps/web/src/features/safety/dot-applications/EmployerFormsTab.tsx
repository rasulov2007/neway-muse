import { RotateCcw, Save } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { dotAppSphEmployers, isDotAppContractor, type DotAppSafetyDetail } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Input, RadioGroup, Select, Textarea, useToast } from '@/design-system';
import { dotAppSafetyApi, useSafetyMutation } from '@/features/dot-application/api';
import { FamilyBadge } from '@/features/dot-application/status';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';
import { ApiError } from '@/lib/api-client';
import { today } from '@/lib/clock';
import { CarrierSignature, Checklist, LegalText, Panel, getPath, setPath, templateOf, type Forms } from './kit';

const SPH_METHODS = ['Faxed to previous employer', 'Mailed', 'Emailed', 'Other'];
const SPH_RECEIVED = ['Fax', 'Mail', 'Email', 'Telephone', 'Other'];

function Block({ title, source, children, testId }: { title: string; source: string; children: ReactNode; testId?: string }) {
  return (
    <Panel title={title} description={source} actions={<FamilyBadge family="info">Completed by motor carrier</FamilyBadge>} testId={testId}>
      <div className="flex flex-col gap-4">{children}</div>
    </Panel>
  );
}

/**
 * Safety → Employer forms (internal only): the motor carrier's sections of the company's own
 * approved documents. Never shown to the driver. Saved with the application's version; a stale
 * save is refused and the screen says to reload.
 */
export function EmployerFormsTab({ detail, onReload }: { detail: DotAppSafetyDetail; onReload: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Forms>(detail.employerForms ?? {});
  const [base, setBase] = useState(detail.version);
  const [stale, setStale] = useState(false);
  const save = useSafetyMutation(detail.id, (f: Forms) => dotAppSafetyApi.employerForms(detail.id, base, f));
  const editable = ['submitted', 'under_review', 'approved'].includes(detail.status);
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.employerForms ?? {});
  const v = (path: string) => {
    const x = getPath(draft, path);
    return typeof x === 'string' ? x : '';
  };
  const set = (path: string, value: string) => setDraft((d) => setPath(d, path, value));
  const text = (path: string, label: string, opts: { required?: boolean; wide?: boolean } = {}) => (
    <FormField label={label} required={opts.required} className={opts.wide ? 'sm:col-span-2' : undefined}>
      <Input value={v(path)} onChange={(e) => set(path, e.target.value)} disabled={!editable} />
    </FormField>
  );
  const date = (path: string, label: string) => (
    <FormField label={label}>
      <DatePicker aria-label={label} value={v(path) || undefined} onIsoChange={(iso) => set(path, iso ?? '')} disabled={!editable} />
    </FormField>
  );

  const cov = templateOf(detail, 'violations_cert');
  const covContent = (cov?.content ?? {}) as { employer?: string; employerOpts?: string[]; footer?: string };
  const hasDa = Boolean(templateOf(detail, 'da_receipt'));
  const hasOa = Boolean(templateOf(detail, 'occ_accident')) && isDotAppContractor(detail.answers);
  const sph = dotAppSphEmployers(detail.answers, today());
  const c = detail.company;
  const hasW9 = Boolean(templateOf(detail, 'w9')) && isDotAppContractor(detail.answers);
  /** A value prefilled from the company profile until Safety types its own. */
  const prefilled = (path: string, fallback: string) => {
    const x = getPath(draft, path);
    return typeof x === 'string' ? x : fallback;
  };
  const companyAddress = [c.legalName || c.name, c.address].filter(Boolean).join(', ');

  const doSave = () =>
    save.mutate(draft, {
      onSuccess: (next) => {
        setBase(next.version);
        setDraft(next.employerForms ?? {});
        setStale(false);
        toast({ tone: 'success', title: 'Employer forms saved' });
      },
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) setStale(true);
        else toast({ tone: 'danger', title: 'Not saved', description: errorText(e) });
      },
    });


  return (
    <div className="flex flex-col gap-4" data-testid="employer-forms">
      <Alert tone="info" description="These sections are completed by the motor carrier. They are never shown to the driver." />
      <Panel title="Employer checklist" description={`${detail.employerChecklist.filter((x) => x.done).length} of ${detail.employerChecklist.length} complete`}>
        <Checklist items={detail.employerChecklist} testId="employer-checklist" />
      </Panel>
      {!editable ? <Alert tone="neutral" description={`The application is ${detail.status.replace('_', ' ')}; the employer forms can no longer be changed.`} /> : null}
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
          data-testid="employer-stale"
        />
      ) : null}

      {cov ? (
        <Block title="Annual Review of Driving Record" source={`${cov.title} · ${cov.source ?? ''} · version ${cov.version}`} testId="emp-annual">
          <LegalText html={covContent.employer} />
          <FormField label="Finding" required>
            <RadioGroup value={v('annual.finding')} onValueChange={(x) => set('annual.finding', x)} disabled={!editable} options={(covContent.employerOpts ?? []).map((o) => ({ value: o, label: o }))} label="Finding" />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Action taken" className="sm:col-span-2">
              <Textarea rows={2} value={v('annual.action')} onChange={(e) => set('annual.action', e.target.value)} disabled={!editable} />
            </FormField>
            {text('annual.reviewedBy', 'Reviewed by', { required: true })}
            {date('annual.date', 'Date')}
            {text('annual.name', 'Name')}
            {text('annual.title', 'Title')}
            <FormField label="Motor carrier name">
              <Input value={c.legalName || c.name} readOnly />
            </FormField>
            <FormField label="Motor carrier address">
              <Input value={c.address ?? ''} readOnly />
            </FormField>
          </div>
          <CarrierSignature detail={detail} sigKey="emp_annual" label="Reviewer signature" disabled={!editable} />
          {covContent.footer ? <p className="text-xs text-nw-text-3">{covContent.footer}</p> : null}
        </Block>
      ) : (
        <Alert tone="warning" title="Certification of Violations" description="No approved document on file for this company; the Annual Review cannot be completed." />
      )}

      <Block title="Certification of Violations — carrier header" source="Date of employment and home terminal">
        <div className="grid gap-3 sm:grid-cols-2">
          {date('cov.doe', 'Date of employment')}
          {text('cov.home', 'Home terminal (city and state)')}
        </div>
      </Block>

      {hasDa ? (
        <Block title="Alcohol and Drug Employee’s Certified Receipt" source="Authorized employer representative">
          <CarrierSignature detail={detail} sigKey="emp_da" label="Authorized Employer Representative" disabled={!editable} />
        </Block>
      ) : null}

      <Block title="Previous Employment – Employee Alcohol & Drug Test Statement" source="Company representative">
        <div className="grid gap-3 sm:grid-cols-2">{text('prevda.name', 'Company representative’s name', { wide: true })}</div>
        <CarrierSignature detail={detail} sigKey="emp_prevda" label="Company Representative’s Signature" disabled={!editable} />
      </Block>

      <Block title="Driver Certification for Other Compensated Work" source="Company representative">
        <CarrierSignature detail={detail} sigKey="emp_onduty" label="Company Representative’s Signature" disabled={!editable} />
      </Block>

      <Block title="Safety Performance History Records Request — Sections 5a / 5b" source="One per DOT-tested employer in the last 3 years" testId="emp-sph">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Prospective employer’s confidential fax number" description="The company’s own number, printed on every driver’s SPH request (saved for the company).">
            <Input value={prefilled('sphConfFax', c.sphConfidentialFax ?? '')} onChange={(e) => set('sphConfFax', e.target.value)} disabled={!editable} data-testid="confidential-fax" />
          </FormField>
        </div>
        {sph.length === 0 ? <p className="text-sm text-nw-text-3">No DOT-tested previous employers in the last 3 years.</p> : null}
        {sph.map((e) => {
          const p = `sph.${e.id}`;
          const to = detail.answers.sph?.[e.id];
          return (
            <div key={e.id} className="flex flex-col gap-3 rounded-lg border border-nw-border p-4" data-testid={`sph-${e.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-nw-text">{e.company}</span>
                {v(`${p}.method`) ? <FamilyBadge family="done">Sent</FamilyBadge> : <FamilyBadge family="warning">Not sent</FamilyBadge>}
              </div>
              <p className="text-xs text-nw-text-3">
                Sections 2–4 are completed by the previous employer.{to?.email || to?.fax ? ` Send to: ${[to.email, to.fax && `fax ${to.fax}`].filter(Boolean).join(' · ')}.` : ''}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Section 5a: this form was">
                  <Select aria-label="Section 5a: this form was" value={v(`${p}.method`)} onValueChange={(x) => set(`${p}.method`, x)} options={SPH_METHODS.map((m) => ({ value: m, label: m }))} placeholder="Choose" disabled={!editable} />
                </FormField>
                {v(`${p}.method`) === 'Other' ? text(`${p}.methodOther`, 'Other (specify)') : null}
                {text(`${p}.by`, 'By')}
                {date(`${p}.date`, 'Date')}
                <FormField label="Subsequent attempts to contact previous employer (§391.23(c)(1))" className="sm:col-span-2">
                  <Textarea rows={2} value={v(`${p}.attempts`)} onChange={(ev) => set(`${p}.attempts`, ev.target.value)} disabled={!editable} />
                </FormField>
                {text(`${p}.from`, 'Section 5b: information received from')}
                {text(`${p}.recordedBy`, 'Recorded by')}
                <FormField label="Method">
                  <Select aria-label="Method" value={v(`${p}.rmethod`)} onValueChange={(x) => set(`${p}.rmethod`, x)} options={SPH_RECEIVED.map((m) => ({ value: m, label: m }))} placeholder="Choose" disabled={!editable} />
                </FormField>
                {v(`${p}.rmethod`) === 'Other' ? text(`${p}.rmethodOther`, 'Other (specify)') : null}
                {date(`${p}.rdate`, 'Date received')}
              </div>
            </div>
          );
        })}
      </Block>

      {hasOa ? (
        <Block title="Occupational Accident — Motor Carrier Information" source="Contractors only">
          <div className="grid gap-3 sm:grid-cols-2">
            {date('oa.effective', 'Effective date of the contract')}
            <FormField label="Phone/Fax Number" description="Motor carrier representative (prefilled from the company profile)">
              <Input value={prefilled('oa.phoneFax', c.phone ?? '')} onChange={(e) => set('oa.phoneFax', e.target.value)} disabled={!editable} data-testid="oa-phone-fax" />
            </FormField>
          </div>
          <CarrierSignature detail={detail} sigKey="emp_oa" label="Motor Carrier Representative" disabled={!editable} />
        </Block>
      ) : null}

      {hasW9 ? (
        <Block title="Form W-9 — Requester’s name and address (optional)" source="Completed by the requester (the motor carrier)" testId="emp-w9">
          <FormField label="Requester’s name and address (optional)" description="Prefilled with the company’s legal name and address">
            <Textarea rows={2} value={prefilled('w9.requester', companyAddress)} onChange={(e) => set('w9.requester', e.target.value)} disabled={!editable} data-testid="w9-requester" />
          </FormField>
        </Block>
      ) : null}

      {editable ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
          <span className="mr-auto text-xs text-nw-text-3">{dirty ? 'Unsaved changes' : 'Saved'} · signatures are saved when signed</span>
          <Button variant="primary" icon={<Save />} disabled={!dirty} loading={save.isPending} onClick={doSave} data-testid="employer-save">
            Save employer forms
          </Button>
        </div>
      ) : null}
    </div>
  );
}
