import { Lock, Plus, Trash2 } from 'lucide-react';
import {
  CERTIFICATION_STATEMENT,
  DOT_SECTIONS,
  DOT_SECTION_LABELS,
  type DotFieldProblem,
  type DotSection,
  type DotSectionState,
  type LicenseEntry,
} from '@neway/shared';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  FormField,
  IconButton,
  Input,
  Select,
  Textarea,
  cn,
} from '@/design-system';
import {
  EMPTY_ACCIDENT,
  EMPTY_ADDRESS,
  EMPTY_CONVICTION,
  EMPTY_EMPLOYER,
  EMPTY_GAP,
  EMPTY_LICENSE,
  STATE_LABEL,
  type Draft,
} from './dot-application-form';

export type { Draft } from './dot-application-form';

/**
 * The six sections of the DOT application (49 CFR 391.21), shared by the recruiter's wizard and
 * the driver's own page (/dot/<token>). Pure: a draft in, changes out. Nothing here knows about
 * the router, the session or the API, so the public page can draw the same form.
 */

export type SetFn = <K extends keyof Draft>(key: K, value: Draft[K]) => void;
export type ErrFn = (path: string) => string | undefined;

function patch<T>(list: T[], index: number, change: Partial<T>): T[] {
  return list.map((item, n) => (n === index ? ({ ...item, ...change } as T) : item));
}

function Entry({ title, onRemove, children }: { title: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">{title}</span>
        <IconButton label={`Remove ${title.toLowerCase()}`} size="sm" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

export interface ContactDetails {
  email: string | null;
  phone: string | null;
  location: string | null;
}

export function Identity({
  draft,
  set,
  contact,
  contactNote = 'From the candidate record; change them on the candidate, not on the application.',
  ssnLast4,
  err,
}: {
  draft: Draft;
  set: SetFn;
  contact: ContactDetails;
  contactNote?: string;
  ssnLast4: string | null;
  err: ErrFn;
}) {
  return (
    <>
      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-bold text-ink">Legal name</h4>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="First name" required error={err('legalFirstName')}>
            <Input value={draft.legalFirstName} onChange={(e) => set('legalFirstName', e.target.value)} />
          </FormField>
          <FormField label="Middle name (optional)">
            <Input value={draft.legalMiddleName ?? ''} onChange={(e) => set('legalMiddleName', e.target.value)} />
          </FormField>
          <FormField label="Last name" required error={err('legalLastName')}>
            <Input value={draft.legalLastName} onChange={(e) => set('legalLastName', e.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Date of birth" required error={err('dateOfBirth')}>
            <DatePicker value={draft.dateOfBirth} onIsoChange={(v) => set('dateOfBirth', v)} />
          </FormField>
          <FormField
            label="Social Security number"
            description={ssnLast4 ? `SSN on file ••••${ssnLast4}. Leave blank to keep it.` : 'Stored securely. Printed only on the PDF and hidden after saving.'}
          >
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Social Security number"
              placeholder={ssnLast4 ? '•••-••-' + ssnLast4 : '###-##-####'}
              value={draft.ssn}
              onChange={(e) => set('ssn', e.target.value)}
              suffix={<Lock aria-hidden className="size-4 text-faint" />}
            />
          </FormField>
        </div>
      </section>
      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h4 className="text-sm font-bold text-ink">Contact details</h4>
        <p className="text-xs text-muted">{contactNote}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="min-w-0"><dt className="text-muted">Email</dt><dd className="break-all text-ink">{contact.email ?? 'Not on file'}</dd></div>
          <div className="min-w-0"><dt className="text-muted">Phone</dt><dd className="text-ink">{contact.phone || 'Not on file'}</dd></div>
          <div className="min-w-0"><dt className="text-muted">Location</dt><dd className="text-ink">{contact.location ?? 'Not on file'}</dd></div>
        </dl>
      </section>
    </>
  );
}

export function Addresses({ draft, set, err }: { draft: Draft; set: SetFn; err: ErrFn }) {
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted">Every address of the last three years, current first. Leave “To” blank for the current one.</p>
      {draft.addresses.map((a, i) => (
        <Entry key={i} title={`Address ${i + 1}`} onRemove={() => set('addresses', draft.addresses.filter((_, n) => n !== i))}>
          <FormField label="Street" required error={err(`addresses.${i}.street`)}>
            <Input value={a.street} onChange={(e) => set('addresses', patch(draft.addresses, i, { street: e.target.value }))} />
          </FormField>
          <FormField label="City" required error={err(`addresses.${i}.city`)}>
            <Input value={a.city} onChange={(e) => set('addresses', patch(draft.addresses, i, { city: e.target.value }))} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="State" required error={err(`addresses.${i}.state`)}>
              <Input maxLength={2} value={a.state} onChange={(e) => set('addresses', patch(draft.addresses, i, { state: e.target.value.toUpperCase() }))} />
            </FormField>
            <FormField label="ZIP" required error={err(`addresses.${i}.zip`)}>
              <Input value={a.zip} onChange={(e) => set('addresses', patch(draft.addresses, i, { zip: e.target.value }))} />
            </FormField>
          </div>
          <FormField label="From" required error={err(`addresses.${i}.from`)}>
            <DatePicker value={a.from} onIsoChange={(v) => set('addresses', patch(draft.addresses, i, { from: v }))} />
          </FormField>
          <FormField label="To (blank = current)">
            <DatePicker value={a.to ?? ''} onIsoChange={(v) => set('addresses', patch(draft.addresses, i, { to: v || null }))} />
          </FormField>
        </Entry>
      ))}
      <Button variant="outline" size="sm" icon={<Plus />} className="self-start" onClick={() => set('addresses', [...draft.addresses, { ...EMPTY_ADDRESS }])}>
        Add address
      </Button>
    </section>
  );
}

export function Licenses({ draft, set, err }: { draft: Draft; set: SetFn; err: ErrFn }) {
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted">Every driver licence held in the last three years.</p>
      {draft.licenses.map((l, i) => (
        <Entry key={i} title={`Licence ${i + 1}`} onRemove={() => set('licenses', draft.licenses.filter((_, n) => n !== i))}>
          <FormField label="State" required error={err(`licenses.${i}.state`)}>
            <Input maxLength={2} value={l.state} onChange={(e) => set('licenses', patch(draft.licenses, i, { state: e.target.value.toUpperCase() }))} />
          </FormField>
          <FormField label="Licence number" required error={err(`licenses.${i}.number`)}>
            <Input value={l.number} onChange={(e) => set('licenses', patch(draft.licenses, i, { number: e.target.value }))} />
          </FormField>
          <FormField label="Class" required>
            <Select aria-label={`Licence ${i + 1} class`} value={l.licenseClass} onValueChange={(v) => set('licenses', patch(draft.licenses, i, { licenseClass: v as LicenseEntry['licenseClass'] }))} options={['A', 'B', 'C'].map((c) => ({ value: c, label: `Class ${c}` }))} />
          </FormField>
          <FormField label="Endorsements (space-separated)">
            <Input value={l.endorsements.join(' ')} onChange={(e) => set('licenses', patch(draft.licenses, i, { endorsements: e.target.value.toUpperCase().split(/\s+/).filter(Boolean) }))} />
          </FormField>
          <FormField label="Expires" required error={err(`licenses.${i}.expiresOn`)}>
            <DatePicker value={l.expiresOn} onIsoChange={(v) => set('licenses', patch(draft.licenses, i, { expiresOn: v }))} />
          </FormField>
        </Entry>
      ))}
      <Button variant="outline" size="sm" icon={<Plus />} className="self-start" onClick={() => set('licenses', [...draft.licenses, { ...EMPTY_LICENSE }])}>
        Add licence
      </Button>
    </section>
  );
}

export function Employment({ draft, set, err }: { draft: Draft; set: SetFn; err: ErrFn }) {
  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted">Every employer of the last three years, and every employer where the applicant drove a commercial motor vehicle in the last ten. A break of a month or more needs an explanation.</p>
      {draft.employment.map((e, i) =>
        e.kind === 'gap' ? (
          <Entry key={i} title={`Gap ${i + 1}`} onRemove={() => set('employment', draft.employment.filter((_, n) => n !== i))}>
            <FormField label="From" required error={err(`employment.${i}.from`)}>
              <DatePicker value={e.from} onIsoChange={(v) => set('employment', patch(draft.employment, i, { from: v }))} />
            </FormField>
            <FormField label="To">
              <DatePicker value={e.to ?? ''} onIsoChange={(v) => set('employment', patch(draft.employment, i, { to: v || null }))} />
            </FormField>
            <FormField label="Not employed — explanation" required error={err(`employment.${i}.explanation`)}>
              <Input value={e.explanation} onChange={(ev) => set('employment', patch(draft.employment, i, { explanation: ev.target.value }))} />
            </FormField>
          </Entry>
        ) : (
          <Entry key={i} title={`Employer ${i + 1}`} onRemove={() => set('employment', draft.employment.filter((_, n) => n !== i))}>
            <FormField label="Employer" required error={err(`employment.${i}.employer`)}>
              <Input value={e.employer} onChange={(ev) => set('employment', patch(draft.employment, i, { employer: ev.target.value }))} />
            </FormField>
            <FormField label="Position" required error={err(`employment.${i}.position`)}>
              <Input value={e.position} onChange={(ev) => set('employment', patch(draft.employment, i, { position: ev.target.value }))} />
            </FormField>
            <FormField label="From" required error={err(`employment.${i}.from`)}>
              <DatePicker value={e.from} onIsoChange={(v) => set('employment', patch(draft.employment, i, { from: v }))} />
            </FormField>
            <FormField label="To (blank = current)">
              <DatePicker value={e.to ?? ''} onIsoChange={(v) => set('employment', patch(draft.employment, i, { to: v || null }))} />
            </FormField>
            <FormField label="Address">
              <Input value={e.address ?? ''} onChange={(ev) => set('employment', patch(draft.employment, i, { address: ev.target.value }))} />
            </FormField>
            <FormField label="Phone">
              <Input value={e.phone ?? ''} onChange={(ev) => set('employment', patch(draft.employment, i, { phone: ev.target.value }))} />
            </FormField>
            <FormField label="Contact">
              <Input value={e.contactName ?? ''} onChange={(ev) => set('employment', patch(draft.employment, i, { contactName: ev.target.value }))} />
            </FormField>
            <FormField label="Reason for leaving">
              <Input value={e.reasonForLeaving ?? ''} onChange={(ev) => set('employment', patch(draft.employment, i, { reasonForLeaving: ev.target.value }))} />
            </FormField>
            <div className="flex flex-col gap-2 sm:col-span-2 xl:col-span-3">
              <Checkbox label="Drove a commercial motor vehicle" checked={e.droveCmv} onCheckedChange={(v) => set('employment', patch(draft.employment, i, { droveCmv: v === true }))} />
              <Checkbox label="Employer subject to the FMCSRs (DOT-regulated)" checked={e.dotRegulated} onCheckedChange={(v) => set('employment', patch(draft.employment, i, { dotRegulated: v === true }))} />
              <Checkbox label="Subject to Part 382 drug & alcohol testing" checked={e.subjectToDrugTesting} onCheckedChange={(v) => set('employment', patch(draft.employment, i, { subjectToDrugTesting: v === true }))} />
            </div>
          </Entry>
        ),
      )}
      <span className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" icon={<Plus />} onClick={() => set('employment', [...draft.employment, { ...EMPTY_EMPLOYER }])}>
          Add employer
        </Button>
        <Button variant="ghost" size="sm" icon={<Plus />} onClick={() => set('employment', [...draft.employment, { ...EMPTY_GAP }])}>
          Explain a gap
        </Button>
      </span>
    </section>
  );
}

export function Incidents({ draft, set, err }: { draft: Draft; set: SetFn; err: ErrFn }) {
  return (
    <>
      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-bold text-ink">Accidents, last three years</h4>
        {draft.accidents.length === 0 ? <p className="text-sm text-muted">None reported.</p> : null}
        {draft.accidents.map((a, i) => (
          <Entry key={i} title={`Accident ${i + 1}`} onRemove={() => set('accidents', draft.accidents.filter((_, n) => n !== i))}>
            <FormField label="Date" required error={err(`accidents.${i}.date`)}>
              <DatePicker value={a.date} onIsoChange={(v) => set('accidents', patch(draft.accidents, i, { date: v }))} />
            </FormField>
            <FormField label="Location" required error={err(`accidents.${i}.location`)}>
              <Input value={a.location} onChange={(e) => set('accidents', patch(draft.accidents, i, { location: e.target.value }))} />
            </FormField>
            <FormField label="Nature of the accident" required error={err(`accidents.${i}.nature`)}>
              <Input value={a.nature} onChange={(e) => set('accidents', patch(draft.accidents, i, { nature: e.target.value }))} />
            </FormField>
            <FormField label="Fatalities">
              <Input type="number" min="0" value={a.fatalities} onChange={(e) => set('accidents', patch(draft.accidents, i, { fatalities: Number(e.target.value) || 0 }))} />
            </FormField>
            <FormField label="Injuries">
              <Input type="number" min="0" value={a.injuries} onChange={(e) => set('accidents', patch(draft.accidents, i, { injuries: Number(e.target.value) || 0 }))} />
            </FormField>
            <div className="flex items-end">
              <Checkbox label="Hazardous material spill" checked={a.hazmatSpill} onCheckedChange={(v) => set('accidents', patch(draft.accidents, i, { hazmatSpill: v === true }))} />
            </div>
          </Entry>
        ))}
        <Button variant="outline" size="sm" icon={<Plus />} className="self-start" onClick={() => set('accidents', [...draft.accidents, { ...EMPTY_ACCIDENT }])}>
          Add accident
        </Button>
      </section>
      <section className="flex flex-col gap-3 border-t border-line pt-4">
        <h4 className="text-sm font-bold text-ink">Traffic convictions, last three years</h4>
        {draft.convictions.length === 0 ? <p className="text-sm text-muted">None reported.</p> : null}
        {draft.convictions.map((c, i) => (
          <Entry key={i} title={`Conviction ${i + 1}`} onRemove={() => set('convictions', draft.convictions.filter((_, n) => n !== i))}>
            <FormField label="Date" required error={err(`convictions.${i}.date`)}>
              <DatePicker value={c.date} onIsoChange={(v) => set('convictions', patch(draft.convictions, i, { date: v }))} />
            </FormField>
            <FormField label="Location" required error={err(`convictions.${i}.location`)}>
              <Input value={c.location} onChange={(e) => set('convictions', patch(draft.convictions, i, { location: e.target.value }))} />
            </FormField>
            <FormField label="Offense" required error={err(`convictions.${i}.offense`)}>
              <Input value={c.offense} onChange={(e) => set('convictions', patch(draft.convictions, i, { offense: e.target.value }))} />
            </FormField>
            <FormField label="Penalty">
              <Input value={c.penalty ?? ''} onChange={(e) => set('convictions', patch(draft.convictions, i, { penalty: e.target.value }))} />
            </FormField>
          </Entry>
        ))}
        <Button variant="outline" size="sm" icon={<Plus />} className="self-start" onClick={() => set('convictions', [...draft.convictions, { ...EMPTY_CONVICTION }])}>
          Add conviction
        </Button>
      </section>
      <section className="flex flex-col gap-3 border-t border-line pt-4">
        <Checkbox label="A licence was ever denied, revoked or suspended" checked={draft.licenseDeniedOrRevoked} onCheckedChange={(v) => set('licenseDeniedOrRevoked', v === true)} />
        {draft.licenseDeniedOrRevoked ? (
          <FormField label="Which, when and why" required>
            <Textarea rows={2} value={draft.licenseDeniedOrRevokedDetail ?? ''} onChange={(e) => set('licenseDeniedOrRevokedDetail', e.target.value)} />
          </FormField>
        ) : null}
      </section>
    </>
  );
}

export function SectionRules({ problems }: { problems: DotFieldProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <Alert tone="warning" title="Still needed in this section">
      <ul className="mt-1 list-disc pl-5">
        {problems.map((p, i) => (
          <li key={i}>{p.detail}</li>
        ))}
      </ul>
    </Alert>
  );
}

export function Review({
  draft,
  set,
  states,
  problems,
  onGo,
  err,
  audience = 'staff',
}: {
  draft: Draft;
  set: SetFn;
  states: Record<DotSection, DotSectionState>;
  problems: DotFieldProblem[];
  onGo: (s: DotSection) => void;
  err: ErrFn;
  /** The recruiter's wizard, or the driver filling it in through the link. */
  audience?: 'staff' | 'driver';
}) {
  const driver = audience === 'driver';
  const bySection = DOT_SECTIONS.map((s) => ({ s, items: problems.filter((p) => p.section === s) }));
  const outstanding = problems.length;
  return (
    <>
      <section className="flex flex-col gap-2" data-testid="review-summary">
        <h4 className="text-sm font-bold text-ink">Review</h4>
        {outstanding === 0 ? (
          <Alert tone="success" title={driver ? 'Everything is filled in' : 'Complete under 49 CFR 391.21'}>Every section is filled in. Certify below, then submit.</Alert>
        ) : (
          <Alert tone="warning" title={`${outstanding} thing${outstanding === 1 ? '' : 's'} still needed before submission`}>
            <ul className="mt-1 flex flex-col gap-1.5">
              {bySection
                .filter((x) => x.items.length > 0)
                .map((x) => (
                  <li key={x.s}>
                    <button type="button" className="font-semibold text-primary-text underline" onClick={() => onGo(x.s)}>
                      {DOT_SECTION_LABELS[x.s]}
                    </button>
                    <ul className="list-disc pl-5">
                      {x.items.slice(0, 6).map((p, i) => (
                        <li key={i}>{p.detail}</li>
                      ))}
                      {x.items.length > 6 ? <li>and {x.items.length - 6} more</li> : null}
                    </ul>
                  </li>
                ))}
            </ul>
          </Alert>
        )}
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {DOT_SECTIONS.filter((s) => s !== 'certification').map((s) => (
            <li key={s} className="flex items-center justify-between rounded-md border border-line px-3 py-1.5">
              <button type="button" className="text-ink hover:underline" onClick={() => onGo(s)}>{DOT_SECTION_LABELS[s]}</button>
              <span className={cn('text-xs font-semibold', states[s] === 'complete' ? 'text-success-text' : 'text-muted')}>{STATE_LABEL[states[s]]}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          {draft.addresses.length} address{draft.addresses.length === 1 ? '' : 'es'} · {draft.licenses.length} licence{draft.licenses.length === 1 ? '' : 's'} · {draft.employment.length} employment entr{draft.employment.length === 1 ? 'y' : 'ies'} · {draft.accidents.length} accident{draft.accidents.length === 1 ? '' : 's'} · {draft.convictions.length} conviction{draft.convictions.length === 1 ? '' : 's'}
        </p>
      </section>
      <section className="flex flex-col gap-3 border-t border-line pt-4">
        <h4 className="text-sm font-bold text-ink">Certification</h4>
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-secondary">{CERTIFICATION_STATEMENT}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={driver ? 'Your full name' : "Applicant's typed name"}
            required
            description={driver ? 'Typing your name here is your signature.' : 'Typed by the applicant, as their signature.'}
          >
            <Input value={draft.certifiedName ?? ''} onChange={(e) => set('certifiedName', e.target.value)} />
          </FormField>
          <FormField label="Date signed" required error={err('certifiedOn')}>
            <DatePicker value={draft.certifiedOn ?? ''} onIsoChange={(v) => set('certifiedOn', v || null)} />
          </FormField>
        </div>
        <p className="text-xs text-muted">
          {driver
            ? 'Submitting sends your application to the recruiting team. It cannot be changed after that; call your recruiter if something needs fixing.'
            : "Submitting files the PDF in the driver's qualification file, opens Safety's verification case and drafts a previous-employer verification for each DOT-regulated employer listed."}
        </p>
      </section>
    </>
  );
}
