import { Eye } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DOT_APP_STEP_TITLES, type DotAppAnswers, type DotAppStepId } from '@neway/shared';
import { Button, useToast } from '@/design-system';
import { errorText } from '@/features/hr/recruit/journey/journey-utils';

/**
 * A read-only summary of everything the driver answered, section by section, built from the
 * answers themselves (so a field the form adds later still shows). The SSN is never in the answers:
 * it is shown masked, and "Show" asks the server (restricted permission, audited).
 */

const GROUPS: { step: DotAppStepId; keys: (keyof DotAppAnswers)[] }[] = [
  { step: 'personal', keys: ['personal'] },
  { step: 'company', keys: ['company'] },
  { step: 'license', keys: ['exp', 'licenses'] },
  { step: 'employment', keys: ['employers', 'unemployment', 'schools'] },
  { step: 'history', keys: ['fmcsr', 'accidents', 'violations', 'criminal'] },
  { step: 'emergency', keys: ['emergency'] },
  { step: 'certs', keys: ['cov', 'prevda', 'onduty', 'otherwork'] },
  { step: 'disclosures', keys: ['ack', 'chs', 'sph', 'copy'] },
  { step: 'policies', keys: ['dar', 'ica', 'hb', 'vid'] },
  { step: 'contractor', keys: ['ach', 'w9', 'oa'] },
];

const BLOCK_TITLE: Partial<Record<keyof DotAppAnswers, string>> = {
  exp: 'Driving experience',
  licenses: 'Licenses',
  employers: 'Employers',
  unemployment: 'Unemployment periods',
  schools: 'Trucking schools',
  fmcsr: 'FMCSR questions',
  accidents: 'Accidents',
  violations: 'Violations',
  criminal: 'Criminal record',
  cov: 'Certification of Violations',
  prevda: 'Previous Employment A&D Statement',
  onduty: 'On-duty hours',
  otherwork: 'Other compensated work',
  ack: 'Acknowledgements',
  sph: 'Safety Performance History — where to send',
  chs: 'Clearinghouse single limited query — period',
  ach: 'ACH debit authorization',
  copy: 'User requested copy',
  dar: 'Alcohol & Drug Certified Receipt',
  ica: 'Independent Contractor’s Acknowledgement',
  hb: 'Handbook acknowledgement',
  vid: 'Video consent',
  w9: 'Form W-9',
  oa: 'Occupational Accident',
};

const LABEL: Record<string, string> = {
  dob: 'Date of birth',
  res3: 'At this address 3 years',
  smsOptIn: 'Text-message opt-in',
  emailOptIn: 'Email opt-in',
  isOwner: 'Owns equipment',
  cls: 'Class',
  exp: 'Expires',
  med: 'Medical card expires',
  cdl: 'CDL',
  endorse: 'Endorsements',
  cmv: 'CMV',
  fmcsr: 'Subject to FMCSRs',
  dotTesting: 'DOT drug & alcohol tested',
  preEmpPositive: 'Pre-employment positive / refusal',
  q1: 'Question 1',
  q2: 'Question 2',
  csz: 'City, state, ZIP',
  alt: 'Alternate phone',
  doe: 'Date of employment',
  tinType: 'TIN type',
  ein: 'EIN',
  fein: 'FEIN',
  feinNone: 'FEIN: None',
  street2: 'Address 2',
  canadaPermit: 'Minister’s permit (Canada)',
  accountType: 'Checking / Saving account',
  bank: 'Depository bank name',
  from: 'From',
  to: 'To',
  vin: 'VIN',
  twic: 'TWIC card',
  twicExp: 'TWIC expires',
};

export function humanize(key: string): string {
  if (LABEL[key]) return LABEL[key]!;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function empty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(empty);
  return false;
}

function Value({ value }: { value: unknown }): ReactNode {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x !== 'object' || x === null)) return value.join(', ');
    return (
      <ol className="flex flex-col gap-2">
        {value.map((item, i) => (
          <li key={i} className="rounded-lg border border-nw-border p-3">
            <p className="mb-1 text-xs font-semibold text-nw-text-3">#{i + 1}</p>
            <Fields value={item as Record<string, unknown>} />
          </li>
        ))}
      </ol>
    );
  }
  if (value && typeof value === 'object') return <Fields value={value as Record<string, unknown>} />;
  return '—';
}

function Fields({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value ?? {}).filter(([k, v]) => k !== 'id' && !empty(v));
  if (entries.length === 0) return <p className="text-sm text-nw-text-3">Nothing entered.</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[minmax(140px,220px)_minmax(0,1fr)]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-nw-text-3">{humanize(k)}</dt>
          <dd className="min-w-0 break-words text-nw-text">
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SsnRow({ last4, canReveal, reveal }: { last4: string | null; canReveal: boolean; reveal: () => Promise<{ ssn: string }> }) {
  const { toast } = useToast();
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="ssn-row">
      <span className="min-w-[140px] text-nw-text-3">SSN</span>
      <span className="font-mono text-nw-text tabular-nums" data-testid="ssn-value">
        {shown ?? (last4 ? `•••-••-${last4}` : 'Not on file')}
      </span>
      {last4 && canReveal && !shown ? (
        <Button
          variant="outline"
          size="sm"
          icon={<Eye />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setShown((await reveal()).ssn);
            } catch (e) {
              toast({ tone: 'danger', title: 'Not shown', description: errorText(e) });
            } finally {
              setBusy(false);
            }
          }}
          data-testid="ssn-show"
        >
          Show
        </Button>
      ) : null}
      {shown ? <span className="text-xs text-nw-text-3">Viewing the full SSN is recorded in the audit log.</span> : null}
    </div>
  );
}

/** ACH bank numbers: masked; "Show" only with the restricted code (the server records every view). */
export function BankRow({ last4, canReveal, reveal }: { last4: string | null; canReveal: boolean; reveal: () => Promise<{ routing: string; account: string }> }) {
  const { toast } = useToast();
  const [shown, setShown] = useState<{ routing: string; account: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="bank-row">
      <span className="min-w-[140px] text-nw-text-3">Routing / account number</span>
      <span className="font-mono text-nw-text tabular-nums" data-testid="bank-value">
        {shown ? `${shown.routing} / ${shown.account}` : last4 ? `••••••••• / •••• ${last4}` : 'Not on file'}
      </span>
      {last4 && canReveal && !shown ? (
        <Button
          variant="outline"
          size="sm"
          icon={<Eye />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setShown(await reveal());
            } catch (e) {
              toast({ tone: 'danger', title: 'Not shown', description: errorText(e) });
            } finally {
              setBusy(false);
            }
          }}
          data-testid="bank-show"
        >
          Show
        </Button>
      ) : null}
      {shown ? <span className="text-xs text-nw-text-3">Viewing bank numbers is recorded in the audit log.</span> : null}
    </div>
  );
}

export function AnswersSummary({ answers, visibleSteps, ssn, bank }: { answers: DotAppAnswers; visibleSteps: DotAppStepId[]; ssn: ReactNode; bank?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4" data-testid="answers-summary">
      {GROUPS.filter((g) => visibleSteps.includes(g.step)).map((g) => (
        <section key={g.step} className="rounded-[10px] border border-nw-border bg-nw-panel p-5">
          <h3 className="mb-3 text-md font-bold text-nw-text">{DOT_APP_STEP_TITLES[g.step]}</h3>
          <div className="flex flex-col gap-4">
            {g.step === 'personal' ? ssn : null}
            {g.step === 'contractor' ? bank : null}
            {g.keys.map((k) => {
              const v = answers[k];
              const showTitle = g.keys.length > 1 || BLOCK_TITLE[k];
              return (
                <div key={k} className="flex flex-col gap-2">
                  {showTitle && g.step !== 'personal' && g.step !== 'company' && g.step !== 'emergency' ? <h4 className="text-sm font-semibold text-nw-text-2">{BLOCK_TITLE[k] ?? humanize(k)}</h4> : null}
                  {empty(v) ? <p className="text-sm text-nw-text-3">Nothing entered.</p> : <Value value={v} />}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
