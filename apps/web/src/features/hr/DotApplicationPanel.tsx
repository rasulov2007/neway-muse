import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ExternalLink, FileText, Plus, Trash2 } from 'lucide-react';
import {
  CERTIFICATION_STATEMENT,
  CONSENT_PURPOSE_LABELS,
  checkDotApplication,
  type AccidentEntry,
  type AddressEntry,
  type ApplicantRecord,
  type ConvictionEntry,
  type DotApplication,
  type DotApplicationFormInput,
  type EmploymentEntry,
  type HiringCase,
  type LicenseEntry,
  type SaveDotApplicationInput,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DatePicker,
  EmptyState,
  IconButton,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@/design-system';
import { listConsentRequests } from '@/features/safety/compliance-api';
import { DocumentViewer } from '@/features/documents';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { FactRow, HrPanel } from './components/HrKit';
import { Field } from './RecruitingPage';
import { hiringApi, useDotApplication, useHiringMutation } from './useHiring';

/**
 * The DOT application (49 CFR 391.21) on a driver candidate's record.
 *
 * Before submission it is a form the recruiter fills in with the applicant. Submitting renders
 * the PDF and files it in the qualification file — after which this panel shows what was filed,
 * links to the file and to the verification case, and lists the employer verifications the
 * application produced. It never holds a copy of any of those; it reads them.
 */
export function DotApplicationPanel({
  hiringCase,
  candidate,
}: {
  hiringCase: HiringCase;
  candidate: ApplicantRecord;
}) {
  const application = useDotApplication(hiringCase.id);
  if (application.isPending) return <Skeleton className="h-64 w-full" />;
  if (application.error) {
    return <Alert tone="danger" title="The application could not be loaded" />;
  }
  if (application.data?.status === 'submitted') {
    return <SubmittedApplication application={application.data} hiringCase={hiringCase} />;
  }
  return (
    <ApplicationForm
      key={application.data?.updatedAt ?? 'new'}
      hiringCase={hiringCase}
      candidate={candidate}
      existing={application.data}
    />
  );
}

// ----------------------------------------------------------------------------- after submission

export function SubmittedApplication({
  application,
  hiringCase,
}: {
  application: DotApplication;
  hiringCase: HiringCase;
}) {
  const form = application.form;
  const [viewingPdf, setViewingPdf] = useState(false);
  const consents = useQuery({
    queryKey: ['verification', 'consents', 'driver', application.driverId],
    queryFn: () => listConsentRequests({ driverId: application.driverId ?? undefined }),
    enabled: application.driverId !== null,
  });
  const employerConsents = (consents.data ?? []).filter((c) =>
    application.consentIds.includes(c.id),
  );

  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone="success"
        title={`Submitted ${application.submittedAt ? formatDateTime(application.submittedAt) : ''} by ${application.submittedBy ?? ''}`}
        description={`Filed in the qualification file as the DOT employment application under driver id ${application.driverId ?? '—'}. The PDF is what the applicant signed; the answers below are read from it, not editable.`}
        actions={
          <>
            {application.documentId ? (
              // Through the viewer, not an anchor: a browser navigation carries no session, so
              // the API answered 401 and the link did nothing at all.
              <button
                type="button"
                onClick={() => setViewingPdf(true)}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary-text hover:underline"
              >
                <FileText aria-hidden className="size-3.5" /> Open the PDF
              </button>
            ) : null}
            {hiringCase.verificationCaseId ? (
              <Link
                to="/safety/compliance"
                search={{ tab: 'verification', case: hiringCase.verificationCaseId }}
                className="inline-flex items-center gap-1 text-sm font-medium text-primary-text hover:underline"
              >
                <ExternalLink aria-hidden className="size-3.5" /> Open in Safety → Verification
              </Link>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <HrPanel title="Applicant">
          <FactRow
            label="Legal name"
            value={[form.legalFirstName, form.legalMiddleName, form.legalLastName]
              .filter(Boolean)
              .join(' ')}
          />
          <FactRow label="Date of birth" value={formatIsoDate(form.dateOfBirth)} />
          <FactRow
            label="Social security number"
            value={
              application.ssnLast4
                ? `··· ${application.ssnLast4} (on the PDF only)`
                : 'Not provided'
            }
          />
          <FactRow
            label="Licence denied or revoked"
            value={
              form.licenseDeniedOrRevoked
                ? `Yes — ${form.licenseDeniedOrRevokedDetail ?? ''}`
                : 'No'
            }
          />
          <FactRow
            label="Certified"
            value={`${form.certifiedName ?? ''} · ${form.certifiedOn ? formatIsoDate(form.certifiedOn) : ''}`}
          />
        </HrPanel>

        <HrPanel title={`Employer verifications (${employerConsents.length})`}>
          {consents.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : employerConsents.length === 0 ? (
            <p className="text-sm text-muted">
              No DOT-regulated employer in the last three years was listed, so no verification
              consent was drafted.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {employerConsents.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0">
                    <span className="block text-ink">
                      {c.subject ?? CONSENT_PURPOSE_LABELS[c.purpose]}
                    </span>
                    <span className="block text-xs text-muted">
                      {CONSENT_PURPOSE_LABELS[c.purpose]} · managed in Safety → Consents
                    </span>
                  </span>
                  <Badge
                    tone={
                      c.status === 'signed'
                        ? 'success'
                        : c.status === 'declined'
                          ? 'danger'
                          : 'neutral'
                    }
                    size="sm"
                  >
                    {c.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </HrPanel>

        <HrPanel title={`Residences (${form.addresses.length})`}>
          <ul className="divide-y divide-line-soft text-sm">
            {form.addresses.map((a, i) => (
              <li key={i} className="py-1.5">
                <span className="block text-ink">
                  {a.street}, {a.city}, {a.state} {a.zip}
                </span>
                <span className="block text-xs text-muted">{span(a.from, a.to)}</span>
              </li>
            ))}
          </ul>
        </HrPanel>

        <HrPanel title={`Licences (${form.licenses.length})`}>
          <ul className="divide-y divide-line-soft text-sm">
            {form.licenses.map((l, i) => (
              <li key={i} className="py-1.5">
                <span className="block text-ink">
                  {l.state} {l.number} · class {l.licenseClass}
                  {l.endorsements.length ? ` · ${l.endorsements.join(' ')}` : ''}
                </span>
                <span className="block text-xs text-muted">
                  expires {formatIsoDate(l.expiresOn)}
                </span>
              </li>
            ))}
          </ul>
        </HrPanel>

        <div className="lg:col-span-2">
          <HrPanel title={`Employment (${form.employment.length})`}>
            <ul className="divide-y divide-line-soft text-sm">
              {[...form.employment]
                .sort((x, y) => y.from.localeCompare(x.from))
                .map((e, i) => (
                  <li key={i} className="py-1.5">
                    {e.kind === 'gap' ? (
                      <>
                        <span className="block text-ink">Not employed — {e.explanation}</span>
                        <span className="block text-xs text-muted">{span(e.from, e.to)}</span>
                      </>
                    ) : (
                      <>
                        <span className="block text-ink">
                          {e.employer} · {e.position}
                        </span>
                        <span className="block text-xs text-muted">
                          {span(e.from, e.to)}
                          {e.droveCmv ? ' · drove a CMV' : ''}
                          {e.dotRegulated ? ' · DOT-regulated' : ''}
                          {e.reasonForLeaving ? ` · left: ${e.reasonForLeaving}` : ''}
                        </span>
                      </>
                    )}
                  </li>
                ))}
            </ul>
          </HrPanel>
        </div>

        <HrPanel title={`Accidents, 3 years (${form.accidents.length})`}>
          {form.accidents.length === 0 ? (
            <p className="text-sm text-muted">None reported.</p>
          ) : (
            <ul className="divide-y divide-line-soft text-sm">
              {form.accidents.map((a, i) => (
                <li key={i} className="py-1.5">
                  <span className="block text-ink">
                    {formatIsoDate(a.date)} · {a.location}
                  </span>
                  <span className="block text-xs text-muted">
                    {a.nature} · {a.fatalities} fatalities · {a.injuries} injuries
                    {a.hazmatSpill ? ' · hazmat spill' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </HrPanel>

        <HrPanel title={`Convictions, 3 years (${form.convictions.length})`}>
          {form.convictions.length === 0 ? (
            <p className="text-sm text-muted">None reported.</p>
          ) : (
            <ul className="divide-y divide-line-soft text-sm">
              {form.convictions.map((c, i) => (
                <li key={i} className="py-1.5">
                  <span className="block text-ink">
                    {formatIsoDate(c.date)} · {c.offense}
                  </span>
                  <span className="block text-xs text-muted">
                    {c.location}
                    {c.penalty ? ` · ${c.penalty}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </HrPanel>
      </div>
      {viewingPdf && application.documentId ? (
        <DocumentViewer
          source={{ kind: 'compliance', id: application.documentId }}
          title="DOT employment application"
          subtitle={
            application.submittedAt
              ? `Signed ${formatDateTime(application.submittedAt)}`
              : undefined
          }
          contentType="application/pdf"
          fileName={`dot-application-${application.driverId ?? 'applicant'}.pdf`}
          onClose={() => setViewingPdf(false)}
        />
      ) : null}
    </div>
  );
}

function span(from: string, to: string | null): string {
  return `${formatIsoDate(from)} – ${to ? formatIsoDate(to) : 'present'}`;
}

// ----------------------------------------------------------------------------------- the form

type Draft = DotApplicationFormInput & { ssn: string };

const EMPTY_ADDRESS: AddressEntry = {
  street: '',
  city: '',
  state: '',
  zip: '',
  from: '',
  to: null,
};
const EMPTY_LICENSE: LicenseEntry = {
  state: '',
  number: '',
  licenseClass: 'A',
  endorsements: [],
  expiresOn: '',
};
const EMPTY_EMPLOYER: EmploymentEntry = {
  kind: 'employer',
  employer: '',
  address: null,
  phone: null,
  contactName: null,
  position: '',
  from: '',
  to: null,
  reasonForLeaving: null,
  droveCmv: true,
  dotRegulated: true,
  subjectToDrugTesting: true,
};
const EMPTY_GAP: EmploymentEntry = { kind: 'gap', from: '', to: null, explanation: '' };
const EMPTY_ACCIDENT: AccidentEntry = {
  date: '',
  location: '',
  nature: '',
  fatalities: 0,
  injuries: 0,
  hazmatSpill: false,
};
const EMPTY_CONVICTION: ConvictionEntry = { date: '', location: '', offense: '', penalty: null };

function initialDraft(candidate: ApplicantRecord, existing: DotApplication | null): Draft {
  if (existing) return { ...existing.form, ssn: '' };
  return {
    legalFirstName: candidate.firstName,
    legalMiddleName: null,
    legalLastName: candidate.lastName,
    dateOfBirth: '',
    ssn: '',
    addresses: [
      { ...EMPTY_ADDRESS, state: candidate.location?.length === 2 ? candidate.location : '' },
    ],
    licenses: [{ ...EMPTY_LICENSE }],
    employment: [{ ...EMPTY_EMPLOYER }],
    accidents: [],
    convictions: [],
    licenseDeniedOrRevoked: false,
    licenseDeniedOrRevokedDetail: null,
    certifiedName: null,
    certifiedOn: null,
  };
}

/** Strips the empty strings a form produces into the nulls the contract wants. */
function toPayload(draft: Draft, existing: DotApplication | null): SaveDotApplicationInput {
  const { ssn, ...form } = draft;
  const nul = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    ...form,
    legalMiddleName: nul(form.legalMiddleName),
    addresses: (form.addresses ?? []).map((a) => ({ ...a, to: nul(a.to) })),
    licenses: (form.licenses ?? []).map((l) => ({ ...l, endorsements: l.endorsements ?? [] })),
    employment: (form.employment ?? []).map((e) =>
      e.kind === 'gap'
        ? { ...e, to: nul(e.to) }
        : {
            ...e,
            address: nul(e.address),
            phone: nul(e.phone),
            contactName: nul(e.contactName),
            reasonForLeaving: nul(e.reasonForLeaving),
            to: nul(e.to),
          },
    ),
    convictions: (form.convictions ?? []).map((c) => ({ ...c, penalty: nul(c.penalty) })),
    licenseDeniedOrRevokedDetail: nul(form.licenseDeniedOrRevokedDetail),
    certifiedName: nul(form.certifiedName),
    certifiedOn: nul(form.certifiedOn),
    // The number travels only when typed; an existing sealed one is kept by leaving it out.
    ssn: ssn.trim() ? ssn.trim() : existing?.ssnLast4 ? undefined : null,
  };
}

function ApplicationForm({
  hiringCase,
  candidate,
  existing,
}: {
  hiringCase: HiringCase;
  candidate: ApplicantRecord;
  existing: DotApplication | null;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(candidate, existing));
  const save = useHiringMutation((body: SaveDotApplicationInput) =>
    hiringApi.saveDotApplication(hiringCase.id, body),
  );
  const submit = useHiringMutation(async (body: SaveDotApplicationInput) => {
    await hiringApi.saveDotApplication(hiringCase.id, body);
    return hiringApi.submitDotApplication(hiringCase.id);
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const error = submit.error ?? save.error;
  const problem =
    error instanceof ApiError ? (error.problem as unknown as { issues?: unknown } | null) : null;
  const issues = Array.isArray(problem?.issues)
    ? (problem.issues as { section: string; detail: string }[])
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone="info"
        title="49 CFR 391.21 — recorded with the applicant, filed as a PDF"
        description="Three years of addresses, every employer of the last three years (ten for commercial driving), accidents and convictions in the last three years. Submitting renders the application, files it in the qualification file, opens the verification case and drafts a previous-employer verification for each DOT-regulated employer listed."
      />
      {error ? (
        <Alert
          tone="danger"
          title={issues ? 'Not submitted — the application is not complete' : 'Not saved'}
          description={
            issues ? (
              <ul className="mt-1 list-disc pl-5">
                {issues.map((i, n) => (
                  <li key={n}>{i.detail}</li>
                ))}
              </ul>
            ) : error instanceof ApiError ? (
              error.message
            ) : (
              'Something went wrong.'
            )
          }
        />
      ) : null}

      <Card className="p-4">
        <SectionTitle>Applicant</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Legal first name">
            <Input
              value={draft.legalFirstName}
              onChange={(e) => set('legalFirstName', e.target.value)}
            />
          </Field>
          <Field label="Middle name">
            <Input
              value={draft.legalMiddleName ?? ''}
              onChange={(e) => set('legalMiddleName', e.target.value)}
            />
          </Field>
          <Field label="Legal last name">
            <Input
              value={draft.legalLastName}
              onChange={(e) => set('legalLastName', e.target.value)}
            />
          </Field>
          <Field label="Date of birth">
            <DatePicker value={draft.dateOfBirth} onIsoChange={(e) => set('dateOfBirth', e)} />
          </Field>
          <Field
            label={
              existing?.ssnLast4
                ? `Social security number (on file: ··· ${existing.ssnLast4})`
                : 'Social security number'
            }
          >
            <Input
              inputMode="numeric"
              autoComplete="off"
              placeholder={existing?.ssnLast4 ? 'Leave blank to keep' : '###-##-####'}
              value={draft.ssn}
              onChange={(e) => set('ssn', e.target.value)}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          The number is sealed at rest and printed only on the PDF. It is never shown again here.
        </p>
      </Card>

      <Card className="p-4">
        <SectionTitle
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              onClick={() => set('addresses', [...(draft.addresses ?? []), { ...EMPTY_ADDRESS }])}
            >
              Add address
            </Button>
          }
        >
          Residences, last three years
        </SectionTitle>
        {(draft.addresses ?? []).map((a, i) => (
          <Row
            key={i}
            onRemove={() =>
              set(
                'addresses',
                (draft.addresses ?? []).filter((_, n) => n !== i),
              )
            }
          >
            <Field label="Street">
              <Input
                value={a.street}
                onChange={(e) =>
                  set('addresses', patch(draft.addresses, i, { street: e.target.value }))
                }
              />
            </Field>
            <Field label="City">
              <Input
                value={a.city}
                onChange={(e) =>
                  set('addresses', patch(draft.addresses, i, { city: e.target.value }))
                }
              />
            </Field>
            <Field label="State">
              <Input
                maxLength={2}
                value={a.state}
                onChange={(e) =>
                  set(
                    'addresses',
                    patch(draft.addresses, i, { state: e.target.value.toUpperCase() }),
                  )
                }
              />
            </Field>
            <Field label="ZIP">
              <Input
                value={a.zip}
                onChange={(e) =>
                  set('addresses', patch(draft.addresses, i, { zip: e.target.value }))
                }
              />
            </Field>
            <Field label="From">
              <DatePicker
                value={a.from}
                onIsoChange={(e) => set('addresses', patch(draft.addresses, i, { from: e }))}
              />
            </Field>
            <Field label="To (blank = current)">
              <DatePicker
                value={a.to ?? ''}
                onIsoChange={(e) => set('addresses', patch(draft.addresses, i, { to: e || null }))}
              />
            </Field>
          </Row>
        ))}
      </Card>

      <Card className="p-4">
        <SectionTitle
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus />}
              onClick={() => set('licenses', [...(draft.licenses ?? []), { ...EMPTY_LICENSE }])}
            >
              Add licence
            </Button>
          }
        >
          Driver licences
        </SectionTitle>
        {(draft.licenses ?? []).map((l, i) => (
          <Row
            key={i}
            onRemove={() =>
              set(
                'licenses',
                (draft.licenses ?? []).filter((_, n) => n !== i),
              )
            }
          >
            <Field label="State">
              <Input
                maxLength={2}
                value={l.state}
                onChange={(e) =>
                  set('licenses', patch(draft.licenses, i, { state: e.target.value.toUpperCase() }))
                }
              />
            </Field>
            <Field label="Number">
              <Input
                value={l.number}
                onChange={(e) =>
                  set('licenses', patch(draft.licenses, i, { number: e.target.value }))
                }
              />
            </Field>
            <Field label="Class">
              <Select
                value={l.licenseClass}
                onValueChange={(v) =>
                  set(
                    'licenses',
                    patch(draft.licenses, i, { licenseClass: v as LicenseEntry['licenseClass'] }),
                  )
                }
                options={['A', 'B', 'C'].map((c) => ({ value: c, label: `Class ${c}` }))}
              />
            </Field>
            <Field label="Endorsements (space-separated)">
              <Input
                value={(l.endorsements ?? []).join(' ')}
                onChange={(e) =>
                  set(
                    'licenses',
                    patch(draft.licenses, i, {
                      endorsements: e.target.value.toUpperCase().split(/\s+/).filter(Boolean),
                    }),
                  )
                }
              />
            </Field>
            <Field label="Expires">
              <DatePicker
                value={l.expiresOn}
                onIsoChange={(e) => set('licenses', patch(draft.licenses, i, { expiresOn: e }))}
              />
            </Field>
          </Row>
        ))}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Checkbox
            label="A licence was ever denied, revoked or suspended"
            checked={draft.licenseDeniedOrRevoked}
            onCheckedChange={(v) => set('licenseDeniedOrRevoked', v === true)}
          />
          {draft.licenseDeniedOrRevoked ? (
            <Field label="Which, when and why">
              <Textarea
                rows={2}
                value={draft.licenseDeniedOrRevokedDetail ?? ''}
                onChange={(e) => set('licenseDeniedOrRevokedDetail', e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </Card>

      <Card className="p-4">
        <SectionTitle
          action={
            <span className="flex gap-1">
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  set('employment', [...(draft.employment ?? []), { ...EMPTY_EMPLOYER }])
                }
              >
                Add employer
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus />}
                onClick={() => set('employment', [...(draft.employment ?? []), { ...EMPTY_GAP }])}
              >
                Explain a gap
              </Button>
            </span>
          }
        >
          Employment history
        </SectionTitle>
        <p className="mb-3 text-xs text-muted">
          Every employer in the last three years, and every employer for which the applicant drove a
          commercial motor vehicle in the last ten. Breaks of a month or more need an explanation.
        </p>
        {(draft.employment ?? []).map((e, i) => (
          <Row
            key={i}
            onRemove={() =>
              set(
                'employment',
                (draft.employment ?? []).filter((_, n) => n !== i),
              )
            }
          >
            {e.kind === 'gap' ? (
              <>
                <Field label="From">
                  <DatePicker
                    value={e.from}
                    onIsoChange={(ev) =>
                      set('employment', patch(draft.employment, i, { from: ev }))
                    }
                  />
                </Field>
                <Field label="To">
                  <DatePicker
                    value={e.to ?? ''}
                    onIsoChange={(ev) =>
                      set('employment', patch(draft.employment, i, { to: ev || null }))
                    }
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Not employed — explanation">
                    <Input
                      value={e.explanation}
                      onChange={(ev) =>
                        set(
                          'employment',
                          patch(draft.employment, i, { explanation: ev.target.value }),
                        )
                      }
                    />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field label="Employer">
                  <Input
                    value={e.employer}
                    onChange={(ev) =>
                      set('employment', patch(draft.employment, i, { employer: ev.target.value }))
                    }
                  />
                </Field>
                <Field label="Position">
                  <Input
                    value={e.position}
                    onChange={(ev) =>
                      set('employment', patch(draft.employment, i, { position: ev.target.value }))
                    }
                  />
                </Field>
                <Field label="From">
                  <DatePicker
                    value={e.from}
                    onIsoChange={(ev) =>
                      set('employment', patch(draft.employment, i, { from: ev }))
                    }
                  />
                </Field>
                <Field label="To (blank = current)">
                  <DatePicker
                    value={e.to ?? ''}
                    onIsoChange={(ev) =>
                      set('employment', patch(draft.employment, i, { to: ev || null }))
                    }
                  />
                </Field>
                <Field label="Address">
                  <Input
                    value={e.address ?? ''}
                    onChange={(ev) =>
                      set('employment', patch(draft.employment, i, { address: ev.target.value }))
                    }
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    value={e.phone ?? ''}
                    onChange={(ev) =>
                      set('employment', patch(draft.employment, i, { phone: ev.target.value }))
                    }
                  />
                </Field>
                <Field label="Contact">
                  <Input
                    value={e.contactName ?? ''}
                    onChange={(ev) =>
                      set(
                        'employment',
                        patch(draft.employment, i, { contactName: ev.target.value }),
                      )
                    }
                  />
                </Field>
                <Field label="Reason for leaving">
                  <Input
                    value={e.reasonForLeaving ?? ''}
                    onChange={(ev) =>
                      set(
                        'employment',
                        patch(draft.employment, i, { reasonForLeaving: ev.target.value }),
                      )
                    }
                  />
                </Field>
                <div className="flex flex-wrap gap-4 sm:col-span-2 lg:col-span-4">
                  <Checkbox
                    label="Drove a commercial motor vehicle"
                    checked={e.droveCmv}
                    onCheckedChange={(v) =>
                      set('employment', patch(draft.employment, i, { droveCmv: v === true }))
                    }
                  />
                  <Checkbox
                    label="Employer subject to the FMCSRs (DOT-regulated)"
                    checked={e.dotRegulated}
                    onCheckedChange={(v) =>
                      set('employment', patch(draft.employment, i, { dotRegulated: v === true }))
                    }
                  />
                  <Checkbox
                    label="Subject to Part 382 drug & alcohol testing"
                    checked={e.subjectToDrugTesting}
                    onCheckedChange={(v) =>
                      set(
                        'employment',
                        patch(draft.employment, i, { subjectToDrugTesting: v === true }),
                      )
                    }
                  />
                </div>
              </>
            )}
          </Row>
        ))}
        {(draft.employment ?? []).length === 0 ? (
          <EmptyState
            title="No employment listed"
            description="Add every employer of the last three years."
          />
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <SectionTitle
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  set('accidents', [...(draft.accidents ?? []), { ...EMPTY_ACCIDENT }])
                }
              >
                Add accident
              </Button>
            }
          >
            Accidents, last three years
          </SectionTitle>
          {(draft.accidents ?? []).length === 0 ? (
            <p className="text-sm text-muted">None reported.</p>
          ) : null}
          {(draft.accidents ?? []).map((a, i) => (
            <Row
              key={i}
              onRemove={() =>
                set(
                  'accidents',
                  (draft.accidents ?? []).filter((_, n) => n !== i),
                )
              }
              columns={2}
            >
              <Field label="Date">
                <DatePicker
                  value={a.date}
                  onIsoChange={(e) => set('accidents', patch(draft.accidents, i, { date: e }))}
                />
              </Field>
              <Field label="Location">
                <Input
                  value={a.location}
                  onChange={(e) =>
                    set('accidents', patch(draft.accidents, i, { location: e.target.value }))
                  }
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Nature of the accident">
                  <Input
                    value={a.nature}
                    onChange={(e) =>
                      set('accidents', patch(draft.accidents, i, { nature: e.target.value }))
                    }
                  />
                </Field>
              </div>
              <Field label="Fatalities">
                <Input
                  type="number"
                  min="0"
                  value={a.fatalities}
                  onChange={(e) =>
                    set(
                      'accidents',
                      patch(draft.accidents, i, { fatalities: Number(e.target.value) || 0 }),
                    )
                  }
                />
              </Field>
              <Field label="Injuries">
                <Input
                  type="number"
                  min="0"
                  value={a.injuries}
                  onChange={(e) =>
                    set(
                      'accidents',
                      patch(draft.accidents, i, { injuries: Number(e.target.value) || 0 }),
                    )
                  }
                />
              </Field>
              <div className="sm:col-span-2">
                <Checkbox
                  label="Hazardous material spill"
                  checked={a.hazmatSpill}
                  onCheckedChange={(v) =>
                    set('accidents', patch(draft.accidents, i, { hazmatSpill: v === true }))
                  }
                />
              </div>
            </Row>
          ))}
        </Card>

        <Card className="p-4">
          <SectionTitle
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus />}
                onClick={() =>
                  set('convictions', [...(draft.convictions ?? []), { ...EMPTY_CONVICTION }])
                }
              >
                Add conviction
              </Button>
            }
          >
            Traffic convictions, last three years
          </SectionTitle>
          {(draft.convictions ?? []).length === 0 ? (
            <p className="text-sm text-muted">None reported.</p>
          ) : null}
          {(draft.convictions ?? []).map((c, i) => (
            <Row
              key={i}
              onRemove={() =>
                set(
                  'convictions',
                  (draft.convictions ?? []).filter((_, n) => n !== i),
                )
              }
              columns={2}
            >
              <Field label="Date">
                <DatePicker
                  value={c.date}
                  onIsoChange={(e) => set('convictions', patch(draft.convictions, i, { date: e }))}
                />
              </Field>
              <Field label="Location">
                <Input
                  value={c.location}
                  onChange={(e) =>
                    set('convictions', patch(draft.convictions, i, { location: e.target.value }))
                  }
                />
              </Field>
              <Field label="Offense">
                <Input
                  value={c.offense}
                  onChange={(e) =>
                    set('convictions', patch(draft.convictions, i, { offense: e.target.value }))
                  }
                />
              </Field>
              <Field label="Penalty">
                <Input
                  value={c.penalty ?? ''}
                  onChange={(e) =>
                    set('convictions', patch(draft.convictions, i, { penalty: e.target.value }))
                  }
                />
              </Field>
            </Row>
          ))}
        </Card>
      </div>

      <Card className="p-4">
        <SectionTitle>Certification</SectionTitle>
        <p className="text-sm text-secondary">{CERTIFICATION_STATEMENT}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Applicant's typed name">
            <Input
              value={draft.certifiedName ?? ''}
              onChange={(e) => set('certifiedName', e.target.value)}
            />
          </Field>
          <Field label="Date">
            <DatePicker
              value={draft.certifiedOn ?? ''}
              onIsoChange={(e) => set('certifiedOn', e)}
            />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <ReadinessNote draft={draft} existing={existing} />
        <Button
          variant="secondary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(toPayload(draft, existing), {
              onSuccess: () => toast({ tone: 'success', title: 'Draft saved' }),
            })
          }
        >
          Save draft
        </Button>
        <Button
          variant="primary"
          loading={submit.isPending}
          onClick={() =>
            submit.mutate(toPayload(draft, existing), {
              onSuccess: (result) =>
                toast({
                  tone: 'success',
                  title: 'Application submitted and filed',
                  description: `Filed under ${result.driverId}; ${result.consentIds.length} employer verification${result.consentIds.length === 1 ? '' : 's'} drafted.`,
                }),
            })
          }
        >
          Submit and file in the DQF
        </Button>
      </div>
    </div>
  );
}

/** What the rule still needs, computed locally with the same function the server uses. */
/** How many things the rule still needs, or null while dates are blank and it cannot be judged. */
function outstanding(draft: Draft, existing: DotApplication | null): number | null {
  try {
    const { ssn: _ssn, ...form } = toPayload(draft, existing);
    void _ssn;
    // Blank dates fail the contract before the rule; count those as incomplete too.
    if (JSON.stringify(form).includes('"from":""') || form.dateOfBirth === '') return null;
    return checkDotApplication(form as Parameters<typeof checkDotApplication>[0], new Date())
      .length;
  } catch {
    return null;
  }
}

function ReadinessNote({ draft, existing }: { draft: Draft; existing: DotApplication | null }) {
  const count = outstanding(draft, existing);
  if (count === null)
    return <span className="text-xs text-muted">Fill in the dates to check completeness.</span>;
  if (count === 0) return <span className="text-xs text-success-text">Complete under 391.21.</span>;
  return (
    <span className="text-xs text-muted">
      {count} thing{count === 1 ? '' : 's'} still needed before submission.
    </span>
  );
}

function patch<T>(list: T[] | undefined, index: number, change: Partial<T>): T[] {
  return (list ?? []).map((item, n) => (n === index ? ({ ...item, ...change } as T) : item));
}

function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-md font-bold text-ink">{children}</h3>
      {action}
    </div>
  );
}

function Row({
  children,
  onRemove,
  columns = 4,
}: {
  children: React.ReactNode;
  onRemove: () => void;
  columns?: 2 | 4;
}) {
  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border border-line-soft bg-surface p-3">
      <div
        className={
          columns === 2
            ? 'grid flex-1 gap-3 sm:grid-cols-2'
            : 'grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-4'
        }
      >
        {children}
      </div>
      <IconButton label="Remove" variant="ghost" size="sm" onClick={onRemove}>
        <Trash2 />
      </IconButton>
    </div>
  );
}
