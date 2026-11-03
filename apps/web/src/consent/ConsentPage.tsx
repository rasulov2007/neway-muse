import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, FileText, Info, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SAFETY_SCREENING_QUESTIONS, type ConsentFormContext, type SafetyScreeningKey } from '@neway/shared';
import { Button, cn } from '@/design-system';
import { SignaturePad } from './SignaturePad';

const BASE = '/api/v1/public/consent';
const MAX_FILE = 8 * 1024 * 1024;

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; form: ConsentFormContext };

/** A safe sentence from any answer: the server's `{ error }`, or a plain fallback — never raw JSON. */
async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}

const easternDate = () => new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'America/New_York' }).format(new Date());

/**
 * The driver's consent (owner brief and design, 2026-10-11): two steps — Driver details (name,
 * phone, email and the CDL front, which is required), then Authorize & send (a review of what was
 * entered, each disclosure in its own section, one confirmation, a typed or drawn signature).
 * The texts are the company's exactly as published; the PSP disclosure stays its own document.
 * Nothing says "saved" until the TMS has committed it, and a failed send keeps everything entered.
 * Phone first: one column under 1024 px, the steps beside the card above it.
 */
export function ConsentPage({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>(() =>
    token ? { state: 'loading' } : { state: 'error', message: 'This link is incomplete. Open the full link from your message, or ask your recruiter to send it again.' },
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  /** The safety questions (owner, 2026-10-13): Yes / No each; unanswered until chosen. */
  const [answers, setAnswers] = useState<Partial<Record<SafetyScreeningKey, boolean>>>({});
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cdl, setCdl] = useState<File | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [showAnswerErrors, setShowAnswerErrors] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [method, setMethod] = useState<'typed' | 'drawn'>('typed');
  const [typed, setTyped] = useState('');
  const [drawing, setDrawing] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // One key per page load: a retry after a dropped answer is the same submission, never a second.
  const submissionKey = useRef(crypto.randomUUID());
  const cardTop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    fetch(`${BASE}/form`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-neway-device': deviceKey(), ...staffAuthorization() }, body: JSON.stringify({ token }), credentials: 'omit' })
      .then(async (res) => {
        if (!live) return;
        if (!res.ok) return setLoad({ state: 'error', message: await messageOf(res, 'This consent link could not be opened.') });
        const form = (await res.json()) as ConsentFormContext;
        setFirst(form.firstName);
        setLast(form.lastName);
        setPhone(form.phone);
        setEmail(form.email);
        setLoad({ state: 'ready', form });
      })
      .catch(() => live && setLoad({ state: 'error', message: 'The page could not reach the server. Check your connection and reload.' }));
    return () => {
      live = false;
    };
  }, [token]);

  if (load.state === 'loading') {
    return (
      <Frame>
        <Card eyebrow="Driver consent">
          <p className="text-nw-text-3">Loading…</p>
        </Card>
      </Frame>
    );
  }
  if (load.state === 'error') {
    return (
      <Frame>
        <Card eyebrow="Driver consent">
          <Notice title="This link can't be used">{load.message}</Notice>
        </Card>
      </Frame>
    );
  }
  const form = load.form;
  if (done || form.alreadySubmitted) {
    return (
      <Frame company={form.companyName}>
        <Card eyebrow="Driver consent">
          <div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="consent-done">
            <CheckCircle2 aria-hidden className="size-12 text-nw-done-icon" />
            <h2 className="text-2xl font-bold text-nw-text">Thank you — your consent is saved.</h2>
            {done ? (
              <p className="text-nw-text-2">
                Reference <span className="font-semibold text-nw-text" data-testid="consent-reference">{done}</span>. Recruiting will contact you about the next step.
              </p>
            ) : (
              <p className="text-nw-text-2">This consent was already received. Recruiting will contact you about the next step.</p>
            )}
          </div>
        </Card>
      </Frame>
    );
  }

  const missing = {
    first: !first.trim(),
    last: !last.trim(),
    phone: phone.replace(/\D/g, '').length < 7,
    email: !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()),
    cdl: !cdl,
  };
  const detailsOk = !Object.values(missing).some(Boolean);
  const signatureReady = method === 'typed' ? typed.trim().length >= 2 : Boolean(drawing);
  const answered = SAFETY_SCREENING_QUESTIONS.every((q) => typeof answers[q.key] === 'boolean');
  const ready = detailsOk && answered && confirmed && signatureReady && !form.preview;

  const go = (next: 1 | 2 | 3) => {
    setStep(next);
    cardTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const next = () => {
    if (!detailsOk) return setShowErrors(true);
    go(2);
  };
  const nextFromQuestions = () => {
    if (!answered) return setShowAnswerErrors(true);
    go(3);
  };

  const submit = async () => {
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    const data = new FormData();
    data.set('token', token);
    data.set('submissionKey', submissionKey.current);
    data.set('firstName', first.trim());
    data.set('lastName', last.trim());
    data.set('phone', phone.trim());
    data.set('email', email.trim());
    data.set('confirmed', 'true');
    data.set('signatureMethod', method);
    if (method === 'typed') data.set('signatureText', typed.trim());
    else if (drawing) data.set('signatureDrawing', drawing);
    data.set('clientSignedAt', new Date().toISOString());
    data.set('documents', JSON.stringify(form.disclosures.map((d) => ({ type: d.type, version: d.version, sha256: d.sha256 }))));
    data.set('safetyAnswers', JSON.stringify(answers));
    if (cdl) data.set('cdlFront', cdl, cdl.name);
    try {
      const res = await fetch(`${BASE}/submit`, { method: 'POST', body: data, credentials: 'omit', headers: { accept: 'application/json', 'x-neway-device': deviceKey() } });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { saved?: boolean; reference?: string } | null;
        if (body?.saved && body.reference) return setDone(body.reference);
        return setError('We could not confirm your consent was saved. Please try again.');
      }
      setError(await messageOf(res, 'We could not save your consent. Nothing was submitted; please try again.'));
    } catch {
      setError('The page could not reach the server. Nothing was submitted; check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  const err = (k: keyof typeof missing, text: string) => (showErrors && missing[k] ? text : null);

  return (
    <Frame company={form.companyName} step={step}>
      <div ref={cardTop} className="scroll-mt-4">
        <Card eyebrow={step === 2 ? 'Safety questions' : 'Let’s get to know you'} counter={`0${step} / 03`} progress={Math.round((step / 3) * 100)}>
          {step === 1 ? (
            <div className="flex flex-col gap-5" data-testid="consent-step-1">
              <div>
                <h2 className="text-[26px] leading-tight font-bold tracking-tight text-nw-text sm:text-[28px]">Driver details.</h2>
                <p className="mt-2 text-[15px] text-nw-text-2">Identify the driver whose records are being requested.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" value={first} onChange={setFirst} autoComplete="given-name" testId="first-name" error={err('first', 'Enter your first name.')} />
                <Field label="Last name" value={last} onChange={setLast} autoComplete="family-name" testId="last-name" error={err('last', 'Enter your last name.')} />
                <Field label="Phone number" value={phone} onChange={setPhone} type="tel" autoComplete="tel" testId="phone" error={err('phone', 'Enter your phone number.')} />
                <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" testId="email" error={err('email', 'Enter a valid email.')} />
              </div>
              {/* Only the front of the licence (owner, 2026-10-13). */}
              <CdlUpload
                label="CDL — front"
                hint="Upload a clear photo of the front of your CDL."
                missingText="Upload a photo of the front of your CDL — it is required."
                file={cdl}
                onFile={setCdl}
                showError={showErrors && missing.cdl}
                testId="cdl"
              />
              <div className="flex justify-end pt-2">
                <Button variant="primary" size="lg" iconRight={<ArrowRight />} className="h-12 w-full px-6 text-base sm:w-auto" onClick={next} data-testid="consent-continue">
                  Continue
                </Button>
              </div>
            </div>
          ) : step === 2 ? (
            <div className="flex flex-col gap-5" data-testid="consent-step-questions">
              <div>
                <h2 className="text-[26px] leading-tight font-bold tracking-tight text-nw-text sm:text-[28px]">Safety questions.</h2>
                <p className="mt-2 text-[15px] text-nw-text-2">In the last 3 years, has your record included any of the following?</p>
              </div>
              <div className="flex items-start gap-3 rounded-[12px] border border-nw-moving-border bg-nw-moving-bg px-4 py-3">
                <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-nw-moving-icon" />
                <div>
                  <p className="text-sm font-bold text-nw-text">Company hiring policy</p>
                  <p className="text-sm text-nw-text-2">Any Yes answer below results in automatic disqualification under our 3-year policy.</p>
                </div>
              </div>
              <ol className="flex flex-col divide-y divide-nw-border">
                {SAFETY_SCREENING_QUESTIONS.map((q, i) => {
                  const value = answers[q.key];
                  const missingHere = showAnswerErrors && typeof value !== 'boolean';
                  return (
                    <li key={q.key} className="flex items-center gap-3 py-3" data-testid={`question-${q.key}`}>
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-nw-subtle text-xs font-bold text-nw-text-2">{i + 1}</span>
                      <span className={cn('min-w-0 flex-1 text-[15px] text-nw-text', missingHere && 'text-nw-urgent-text')}>{q.label}</span>
                      <div role="radiogroup" aria-label={q.label} className="flex shrink-0 gap-2">
                        {([true, false] as const).map((yes) => (
                          <button
                            key={String(yes)}
                            type="button"
                            role="radio"
                            aria-checked={value === yes}
                            onClick={() => setAnswers((a) => ({ ...a, [q.key]: yes }))}
                            className={cn(
                              'h-11 w-16 rounded-[10px] border text-sm font-semibold transition-colors',
                              value === yes ? 'border-nw-accent bg-nw-accent text-nw-on-accent' : 'border-nw-border-strong bg-nw-panel text-nw-text hover:bg-nw-hover',
                            )}
                            data-testid={`question-${q.key}-${yes ? 'yes' : 'no'}`}
                          >
                            {yes ? 'Yes' : 'No'}
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {showAnswerErrors && !answered ? <p className="text-sm font-semibold text-nw-urgent-text">Answer every question with Yes or No.</p> : null}
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="secondary" size="lg" icon={<ArrowLeft />} className="h-12 w-full sm:w-auto" onClick={() => go(1)} data-testid="questions-back">
                  Back
                </Button>
                <Button variant="primary" size="lg" iconRight={<ArrowRight />} className="h-12 w-full px-6 text-base sm:w-auto" onClick={nextFromQuestions} data-testid="questions-continue">
                  Continue
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5" data-testid="consent-step-2">
              <div>
                <h2 className="text-[26px] leading-tight font-bold tracking-tight text-nw-text sm:text-[28px]">Your authorizations.</h2>
                <p className="mt-2 text-[15px] text-nw-text-2">Review your information before sending.</p>
              </div>
              <dl className="grid gap-x-6 gap-y-2 rounded-[12px] bg-nw-subtle px-4 py-4 text-sm sm:grid-cols-[auto_1fr]" data-testid="consent-review">
                <Review label="Name">{`${first.trim()} ${last.trim()}`}</Review>
                <Review label="Phone">{phone.trim()}</Review>
                <Review label="Email">{email.trim()}</Review>
                <Review label="CDL front">{cdl?.name ?? '—'}</Review>
                <div className="sm:col-span-2">
                  <button type="button" onClick={() => go(1)} className="text-sm font-semibold text-nw-accent-ink hover:underline" data-testid="consent-edit">
                    Edit details
                  </button>
                </div>
              </dl>

              <ul className="flex flex-col gap-3">
                {form.disclosures.map((d) => (
                  <li key={d.type} className="rounded-[12px] border border-nw-border bg-nw-subtle" data-testid={`disclosure-${d.type}`}>
                    <button
                      type="button"
                      onClick={() => setOpen((o) => ({ ...o, [d.type]: !o[d.type] }))}
                      aria-expanded={Boolean(open[d.type])}
                      className="flex w-full items-center gap-3 px-4 py-4 text-left sm:px-5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold text-nw-text">{d.title}</span>
                        <span className="block text-xs text-nw-text-3">{d.label}</span>
                      </span>
                      <ChevronDown aria-hidden className={cn('size-5 shrink-0 text-nw-text-2 transition-transform', open[d.type] && 'rotate-180')} />
                    </button>
                    {open[d.type] ? (
                      <div className="max-h-[420px] overflow-y-auto border-t border-nw-border bg-nw-panel px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-nw-text sm:px-5" data-testid={`disclosure-text-${d.type}`}>
                        {d.driverNamePlaceholder ? d.text.split(d.driverNamePlaceholder).join(`${first} ${last}`.trim() || '(your full name)') : d.text}
                        {d.scope ? <span className="mt-2 block text-xs text-nw-text-3">Scope set by the company: {d.scope}.</span> : null}
                      </div>
                    ) : null}
                  </li>
                ))}
                {form.pending.map((p) => (
                  <li key={p.type} className="rounded-[12px] border border-dashed border-nw-border px-4 py-3 text-sm text-nw-text-3" data-testid={`disclosure-pending-${p.type}`}>
                    {p.label} — not part of this form yet; recruiting will send it separately.
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-1 text-sm text-nw-text-3">
                <p>Open each disclosure to read it in full.</p>
                <p>A full Clearinghouse query needs your separate consent inside the FMCSA Clearinghouse.</p>
              </div>

              <label className="flex items-start gap-3 text-sm text-nw-text">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-(--nw-accent)" data-testid="confirm" />
                <span>{form.confirmationStatement}</span>
              </label>

              <fieldset disabled={!confirmed} className={cn('flex flex-col gap-3', !confirmed && 'opacity-50')}>
                <legend className="mb-2 text-[15px] font-semibold text-nw-text">Signature</legend>
                <div className="flex gap-2" role="tablist">
                  {(['drawn', 'typed'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={method === m}
                      onClick={() => setMethod(m)}
                      className={cn('h-10 rounded-[10px] px-4 text-sm font-semibold', method === m ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-subtle text-nw-text-2 hover:text-nw-text')}
                      data-testid={`sign-${m}`}
                    >
                      {m === 'typed' ? 'Type' : 'Draw'}
                    </button>
                  ))}
                </div>
                {method === 'typed' ? (
                  <>
                    <Field label="Type your signature" value={typed} onChange={setTyped} autoComplete="name" testId="typed-signature" />
                    <div className="flex min-h-[110px] items-center justify-center rounded-[12px] border border-nw-border bg-nw-panel px-4" aria-hidden>
                      <span className="font-['Great_Vibes',cursive] text-[44px] leading-tight text-nw-text">{typed.trim()}</span>
                    </div>
                  </>
                ) : (
                  <SignaturePad onChange={setDrawing} disabled={!confirmed} />
                )}
                <p className="text-sm text-nw-text-3">
                  Signed date: <span className="font-semibold text-nw-text-2">{easternDate()}</span> (US Eastern)
                </p>
              </fieldset>

              {error ? <Notice title="Not sent">{error}</Notice> : null}
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="secondary" size="lg" icon={<ArrowLeft />} className="h-12 w-full sm:w-auto" onClick={() => go(2)} data-testid="consent-back">
                  Back
                </Button>
                <Button variant="primary" size="lg" iconRight={<ArrowRight />} className="h-12 w-full px-6 text-base sm:w-auto" disabled={!ready} loading={sending} onClick={() => void submit()} data-testid="consent-submit">
                  Send consent
                </Button>
              </div>
              {!ready ? <p className="text-center text-xs text-nw-text-3 sm:text-right">Tick the confirmation and sign to send.</p> : null}
            </div>
          )}
        </Card>
      </div>
    </Frame>
  );
}

const STEP_LABELS = ['Driver details', 'Safety questions', 'Authorize & send'] as const;

/** The page: brand bar, the headline and the two steps beside the card (above it on a phone), footer. */
function Frame({ company, step, children }: { company?: string; step?: 1 | 2 | 3; children: ReactNode }) {
  const name = (company ?? 'Driver recruiting').toUpperCase();
  return (
    <div className="flex min-h-screen flex-col bg-nw-bg">
      <header className="border-b border-nw-border bg-nw-panel">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <div>
            <p className="text-base font-extrabold tracking-[0.12em] text-nw-text">{name}</p>
            <p className="mt-0.5 text-[10px] font-bold tracking-[0.35em] text-nw-text-3">DRIVER RECRUITING</p>
          </div>
          <p className="hidden text-sm text-nw-text-3 sm:block">Your driving record starts here.</p>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-16 lg:py-14">
        <div className="flex flex-col gap-6 px-1 lg:pt-2">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-nw-accent-ink">DRIVER CONSENT</p>
            <h1 className="mt-3 text-[36px] leading-[1.05] font-extrabold tracking-tight text-nw-text sm:text-[48px]">
              A better road.
              <br />A fresh start.
            </h1>
          </div>
          {step ? (
            <ol className="hidden flex-col gap-5 lg:flex" aria-label="Steps">
              {STEP_LABELS.map((label, i) => {
                const n = (i + 1) as 1 | 2 | 3;
                const isDone = n < step;
                const here = n === step;
                return (
                  <li key={label} className="flex items-center gap-3" aria-current={here ? 'step' : undefined}>
                    <span
                      className={cn(
                        'flex size-7 items-center justify-center rounded-full text-xs font-bold',
                        here ? 'bg-nw-accent text-nw-on-accent' : isDone ? 'bg-nw-done-bg text-nw-done-icon' : 'border border-nw-border-strong text-nw-text-3',
                      )}
                    >
                      {isDone ? <Check aria-hidden className="size-3.5" /> : n}
                    </span>
                    <span className={cn('text-[15px]', here ? 'font-bold text-nw-text' : 'text-nw-text-3')}>{label}</span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
        <div className="min-w-0">{children}</div>
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-nw-text-3">{company ? `${company} · Driver recruiting` : 'Driver recruiting'}</footer>
    </div>
  );
}

function Card({ eyebrow, counter, progress, children }: { eyebrow: string; counter?: string; progress?: number; children: ReactNode }) {
  return (
    <section className="rounded-[18px] border border-nw-border bg-nw-panel px-5 py-6 sm:px-9 sm:py-9">
      <div className="flex items-center justify-between text-[11px] font-semibold tracking-[0.14em] text-nw-text-3 uppercase">
        <span>{eyebrow}</span>
        {counter ? <span className="tabular-nums">{counter}</span> : null}
      </div>
      {progress !== undefined ? (
        <div className="mt-3 h-1 w-full rounded-full bg-nw-subtle" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1 rounded-full bg-nw-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      <div className="mt-7">{children}</div>
    </section>
  );
}

function Review({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-nw-text-3">{label}</dt>
      <dd className="min-w-0 font-medium break-words text-nw-text">{children}</dd>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  testId,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  testId?: string;
  error?: string | null;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-semibold text-nw-text">
        {label} <span aria-hidden>*</span>
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        maxLength={160}
        aria-invalid={error ? true : undefined}
        className={cn(
          'h-12 rounded-[10px] border bg-nw-field px-3.5 text-[15px] text-nw-text focus:border-nw-accent focus:outline-none',
          error ? 'border-nw-urgent-border' : 'border-nw-border-strong',
        )}
        data-testid={testId}
      />
      {error ? <span className="text-xs text-nw-urgent-text">{error}</span> : null}
    </label>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[12px] border border-nw-urgent-border bg-nw-urgent-bg px-4 py-3 text-nw-urgent-text" role="alert">
      <p className="font-semibold">{title}</p>
      <p className="text-sm">{children}</p>
    </div>
  );
}

/** One side of the licence: choose, see what was chosen, remove it. */
function CdlUpload({ label, hint, missingText, file, onFile, showError, testId }: { label: string; hint: string; missingText: string; file: File | null; onFile: (f: File | null) => void; showError: boolean; testId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const pick = (f: File | null) => {
    setFileError(null);
    if (!f) return onFile(null);
    if (f.size > MAX_FILE) return setFileError('The file must be 8 MB or smaller.');
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(f.type)) return setFileError('Use a JPG, PNG or PDF file.');
    onFile(f);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-nw-text">
        {label} <span aria-hidden>*</span>
      </span>
      {file ? (
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-3 rounded-[12px] border border-nw-border bg-nw-subtle px-4 py-3 text-sm text-nw-text" data-testid={`${testId}-chosen`}>
            <FileText aria-hidden className="size-5 shrink-0 text-nw-accent-ink" />
            <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
            <span className="shrink-0 text-xs text-nw-text-3">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onFile(null);
              if (input.current) input.current.value = '';
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-semibold text-nw-urgent-text hover:bg-nw-urgent-bg"
            data-testid={`${testId}-remove`}
          >
            <Trash2 aria-hidden className="size-4" />
            Remove file
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={cn(
            'flex w-full items-center gap-4 rounded-[14px] border border-dashed bg-nw-subtle px-4 py-6 text-left transition-colors hover:border-nw-accent sm:px-5',
            showError ? 'border-nw-urgent-border' : 'border-nw-border-strong',
          )}
          data-testid={`${testId}-choose`}
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-nw-border bg-nw-panel text-nw-text-2">
            <Upload aria-hidden className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-nw-text">Choose a file to upload</span>
            <span className="block text-xs text-nw-text-3">JPG, PNG or PDF · Up to 8 MB</span>
          </span>
          <span className="hidden shrink-0 rounded-[8px] border border-nw-border bg-nw-panel px-3 py-2 text-sm font-semibold text-nw-text sm:inline">Upload file</span>
        </button>
      )}
      <input ref={input} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} data-testid={`${testId}-input`} />
      {fileError ? <p className="text-sm text-nw-urgent-text">{fileError}</p> : showError ? <p className="text-sm text-nw-urgent-text">{missingText}</p> : null}
      <p className="text-sm text-nw-text-3">{hint}</p>
    </div>
  );
}

/**
 * This browser's own random key (owner, 2026-10-12): the link opens on the first device only, so
 * a link forwarded to someone else does not open for them. Kept for the visit when storage is off.
 */
let sessionDevice: string | null = null;

/**
 * A recruiter signed in to the TMS on this browser (same site, same storage): the page asks as
 * them, so the server shows a preview and leaves the link for the driver (owner, 2026-10-14).
 */
function staffAuthorization(): Record<string, string> {
  try {
    const token = window.localStorage.getItem('neway.session.token');
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
function deviceKey(): string {
  try {
    const kept = window.localStorage.getItem('nw.device');
    if (kept) return kept;
    const made = crypto.randomUUID();
    window.localStorage.setItem('nw.device', made);
    return made;
  } catch {
    sessionDevice ??= crypto.randomUUID();
    return sessionDevice;
  }
}
