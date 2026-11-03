import { ArrowLeft, ArrowRight, CircleCheck, FileUp, OctagonAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DOT_SECTIONS,
  DOT_SECTION_LABELS,
  dotApplicationProblems,
  dotSectionStates,
  type DotFieldProblem,
  type DotSection,
  type PublicDotApplication,
} from '@neway/shared';
import { Alert, Button, Card, DatePicker, FormField, cn } from '@/design-system';
import { formatTime } from '@/lib/format';
import {
  Addresses,
  Employment,
  Identity,
  Incidents,
  Licenses,
  Review,
  SectionRules,
} from '@/features/hr/DotApplicationSections';
import { initialDraft, toForm, type Draft } from '@/features/hr/dot-application-form';
import { DotLinkError, dotApi, readAsBase64, uploadDocument } from './api';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The driver's own DOT application page (/dot/<token>), opened from the link a recruiter sent.
 *
 * Mobile first. The six sections are the recruiter's own form components; Next saves, Save saves,
 * and nothing is called saved until the server has answered. Review & certify submits; the issues
 * the server finds are shown per section. After submitting, the driver uploads the CDL (front
 * required, back optional), and a thank-you closes it. Nothing is stored in the browser.
 */
export function DotPage({ token }: { token: string }) {
  const [data, setData] = useState<PublicDotApplication | null>(null);
  const [failure, setFailure] = useState<'gone' | 'error' | null>(token ? null : 'gone');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    dotApi.load(token).then(
      (d) => !cancelled && setData(d),
      (e: unknown) => !cancelled && setFailure(e instanceof DotLinkError && e.gone ? 'gone' : 'error'),
    );
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  return (
    <div className="min-h-dvh bg-app text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-2xl flex-col px-4 py-3">
          <strong className="text-base font-bold text-ink" data-testid="dot-company">{data?.companyName ?? ' '}</strong>
          <span className="text-xs font-semibold text-muted">Driver employment application</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-4">
        {failure === 'gone' ? (
          <Gone />
        ) : failure === 'error' ? (
          <Alert
            tone="danger"
            title="The application could not be loaded"
            actions={
              <Button variant="outline" size="sm" onClick={() => {
                  setFailure(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            }
          >
            Check your connection and try again.
          </Alert>
        ) : !data ? (
          <p className="py-10 text-center text-sm text-muted" role="status">
            Loading…
          </p>
        ) : data.status === 'draft' ? (
          <ApplicationSteps token={token} data={data} onChange={setData} onGone={() => setFailure('gone')} />
        ) : !data.cdlUploaded ? (
          <CdlStep token={token} data={data} onChange={setData} onGone={() => setFailure('gone')} />
        ) : (
          <ThankYou />
        )}
      </main>
    </div>
  );
}

function Gone() {
  return (
    <Card className="mt-6 flex flex-col items-center gap-3 p-6 text-center" data-testid="dot-gone">
      <OctagonAlert aria-hidden className="size-8 text-danger-text" />
      <h1 className="text-lg font-bold text-ink">This link is not active</h1>
      <p className="text-sm text-secondary">This link has expired or was turned off. Contact your recruiter for a new one.</p>
    </Card>
  );
}

function ThankYou() {
  return (
    <Card className="mt-6 flex flex-col items-center gap-3 p-6 text-center" data-testid="dot-thanks">
      <CircleCheck aria-hidden className="size-9 text-success-text" />
      <h1 className="text-lg font-bold text-ink">Thank you — your application is with our recruiting team.</h1>
      <p className="text-sm text-secondary">Your recruiter will contact you about the next steps. You can close this page.</p>
    </Card>
  );
}

function ApplicationSteps({
  token,
  data,
  onChange,
  onGone,
}: {
  token: string;
  data: PublicDotApplication;
  onChange: (d: PublicDotApplication) => void;
  onGone: () => void;
}) {
  const name = { firstName: data.firstName, lastName: data.lastName };
  const [draft, setDraft] = useState<Draft>(() => initialDraft(name, data.form));
  const [section, setSection] = useState<DotSection>('identity');
  const [savedJson, setSavedJson] = useState(() => (data.form ? JSON.stringify(toForm(initialDraft(name, data.form))) : ''));
  const [savedAt, setSavedAt] = useState<string | null>(data.updatedAt);
  const [ssnLast4, setSsnLast4] = useState<string | null>(data.ssnLast4);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<DotSection>>(() => new Set());
  const [serverIssues, setServerIssues] = useState<DotFieldProblem[] | null>(null);

  const form = useMemo(() => toForm(draft), [draft]);
  const dirty = JSON.stringify(form) !== savedJson || draft.ssn.trim().length > 0;
  const now = useMemo(() => new Date(), []);
  const states = useMemo(() => dotSectionStates(form, now), [form, now]);
  const problems = useMemo(() => dotApplicationProblems(form, now), [form, now]);
  const err = (sectionOf: DotSection) => (path: string) =>
    shown.has(sectionOf) ? problems.find((p) => p.path === path)?.detail : undefined;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const index = DOT_SECTIONS.indexOf(section);

  // Leaving with unsaved answers asks first; nothing is kept in the browser.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const go = (next: DotSection) => {
    setSection(next);
    window.scrollTo({ top: 0 });
  };

  const save = async (): Promise<boolean> => {
    setError(null);
    setBusy('save');
    try {
      const ssn = draft.ssn.trim();
      const result = await dotApi.save(token, { ...form, ssn: ssn ? ssn : ssnLast4 ? undefined : null });
      setSavedJson(JSON.stringify(form));
      setSavedAt(result.updatedAt);
      setSsnLast4(result.ssnLast4);
      setDraft((d) => ({ ...d, ssn: '' }));
      return true;
    } catch (e) {
      if (e instanceof DotLinkError && e.gone) onGone();
      else if (e instanceof DotLinkError && e.status === 409) {
        // Submitted meanwhile (by the recruiter): show what is on file now.
        onChange(await dotApi.load(token));
      } else setError(e instanceof Error ? e.message : 'Not saved. Please try again.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const next = async () => {
    setShown((s) => new Set(s).add(section));
    if (!(await save())) return;
    const following = DOT_SECTIONS[index + 1];
    if (following) go(following);
  };

  const submit = async () => {
    setShown(new Set(DOT_SECTIONS));
    setServerIssues(null);
    if (!(await save())) return;
    setBusy('submit');
    try {
      onChange(await dotApi.submit(token));
    } catch (e) {
      if (e instanceof DotLinkError && e.gone) onGone();
      else if (e instanceof DotLinkError && e.issues.length > 0) setServerIssues(e.issues);
      else setError(e instanceof Error ? e.message : 'Not submitted. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="dot-steps">
      <div>
        <h1 className="text-lg font-bold text-ink">
          {data.firstName} {data.lastName}
        </h1>
        <p className="text-sm text-muted">Fill in each step. Your answers are saved when you press Next or Save.</p>
      </div>
      {data.returnNote ? (
        <Alert tone="warning" title="Your recruiter returned your application" data-testid="dot-return-note">
          <span className="block">“{data.returnNote}”</span>
          <span className="mt-1 block">Correct it, then sign and submit it again on the last step.</span>
        </Alert>
      ) : null}

      <nav aria-label="Application steps" className="flex flex-col gap-2">
        <div className="flex gap-1" aria-hidden>
          {DOT_SECTIONS.map((s, i) => (
            <span
              key={s}
              className={cn('h-1.5 flex-1 rounded-full', i < index || states[s] === 'complete' ? 'bg-success' : i === index ? 'bg-primary' : 'bg-line')}
            />
          ))}
        </div>
        <p className="text-xs font-semibold text-muted" data-testid="dot-step-label">
          Step {index + 1} of {DOT_SECTIONS.length} · {DOT_SECTION_LABELS[section]}
        </p>
      </nav>

      <Card padding="none">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-base font-bold text-ink">{DOT_SECTION_LABELS[section]}</h2>
        </header>
        <div className="flex flex-col gap-4 px-4 py-4">
          {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
          {section === 'identity' ? (
            <Identity
              draft={draft}
              set={set}
              contact={data.contact}
              contactNote="From your file with our recruiting team. If something here is wrong, tell your recruiter."
              ssnLast4={ssnLast4}
              err={err('identity')}
            />
          ) : null}
          {section === 'addresses' ? <Addresses draft={draft} set={set} err={err('addresses')} /> : null}
          {section === 'licenses' ? <Licenses draft={draft} set={set} err={err('licenses')} /> : null}
          {section === 'employment' ? <Employment draft={draft} set={set} err={err('employment')} /> : null}
          {section === 'incidents' ? <Incidents draft={draft} set={set} err={err('incidents')} /> : null}
          {section === 'certification' ? (
            <Review
              audience="driver"
              draft={draft}
              set={set}
              states={states}
              problems={serverIssues ?? problems}
              onGo={(s) => {
                setShown((x) => new Set(x).add(s));
                go(s);
              }}
              err={err('certification')}
            />
          ) : null}
          {shown.has(section) && section !== 'certification' ? (
            <SectionRules problems={problems.filter((p) => p.section === section && p.path === null)} />
          ) : null}
        </div>
        <footer className="sticky bottom-0 flex flex-col gap-2 rounded-b-[10px] border-t border-line bg-surface px-4 py-3">
          <span className="text-xs text-muted" data-testid="dot-save-state" aria-live="polite">
            {busy === 'save' ? 'Saving…' : busy === 'submit' ? 'Submitting…' : dirty ? 'Not saved yet' : savedAt ? `Saved ${formatTime(savedAt)}` : 'Not saved yet'}
          </span>
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <Button variant="secondary" icon={<ArrowLeft />} onClick={() => go(DOT_SECTIONS[index - 1]!)} disabled={busy !== null}>
                Back
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void save()} disabled={busy !== null || !dirty} loading={busy === 'save'}>
              Save
            </Button>
            {section === 'certification' ? (
              <Button variant="primary" className="ml-auto" onClick={() => void submit()} loading={busy === 'submit'} disabled={busy !== null}>
                Submit application
              </Button>
            ) : (
              <Button variant="primary" className="ml-auto" iconRight={<ArrowRight />} onClick={() => void next()} disabled={busy !== null}>
                Next
              </Button>
            )}
          </div>
        </footer>
      </Card>
    </div>
  );
}

function CdlStep({
  token,
  data,
  onChange,
  onGone,
}: {
  token: string;
  data: PublicDotApplication;
  onChange: (d: PublicDotApplication) => void;
  onGone: () => void;
}) {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [expiresOn, setExpiresOn] = useState('');
  const [progress, setProgress] = useState<{ label: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsExpiry = !data.cdlExpiresOn;

  const pick = (file: File | null, setter: (f: File | null) => void) => {
    setError(null);
    if (file && file.size > MAX_FILE_BYTES) {
      setError('A file can be up to 20 MB. Take the photo again or send a smaller file.');
      return;
    }
    setter(file);
  };

  const send = async () => {
    if (!front) {
      setError('Add a photo of the front of your CDL.');
      return;
    }
    if (needsExpiry && !expiresOn) {
      setError('Enter the expiry date printed on your CDL.');
      return;
    }
    setError(null);
    try {
      let latest = data;
      const files: { code: 'cdl' | 'cdl_back'; file: File; label: string }[] = [{ code: 'cdl', file: front, label: 'front' }];
      if (back && !data.cdlBackUploaded) files.push({ code: 'cdl_back', file: back, label: 'back' });
      // The back first: once the front is on file the page moves on.
      for (const item of files.reverse()) {
        setProgress({ label: `Uploading the ${item.label}…`, fraction: 0 });
        const content = await readAsBase64(item.file);
        const result = await uploadDocument(
          token,
          { code: item.code, fileName: item.file.name || `cdl-${item.label}`, content, expiresOn: needsExpiry ? expiresOn : null },
          (fraction) => setProgress({ label: `Uploading the ${item.label}…`, fraction }),
        );
        latest = result.application;
      }
      onChange(latest);
    } catch (e) {
      if (e instanceof DotLinkError && e.gone) onGone();
      else setError(e instanceof Error ? e.message : 'The file was not uploaded. Please try again.');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="dot-cdl">
      <Alert tone="success" title="Your application was submitted">
        Your recruiter will review it. One more step: a photo of your CDL.
      </Alert>
      <Card className="flex flex-col gap-4 p-4">
        <h1 className="text-base font-bold text-ink">Upload your CDL</h1>
        <p className="text-sm text-muted">A clear photo or a PDF. Make sure every corner of the card and all the text can be read.</p>
        {error ? <Alert tone="danger" title="Not uploaded">{error}</Alert> : null}
        <FilePick label="Front of your CDL" required file={front} onPick={(f) => pick(f, setFront)} testId="cdl-front" />
        {data.cdlBackUploaded ? (
          <p className="text-sm text-muted">The back of your CDL is already on file.</p>
        ) : (
          <FilePick label="Back of your CDL (optional)" file={back} onPick={(f) => pick(f, setBack)} testId="cdl-back" />
        )}
        {needsExpiry ? (
          <FormField label="CDL expiry date" required description="As printed on the card.">
            <DatePicker value={expiresOn} onIsoChange={setExpiresOn} />
          </FormField>
        ) : null}
        {progress ? (
          <div className="flex flex-col gap-1" role="status">
            <span className="text-xs text-muted">{progress.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          </div>
        ) : null}
        <Button variant="primary" icon={<FileUp />} onClick={() => void send()} loading={progress !== null} disabled={progress !== null} fullWidth>
          Upload
        </Button>
      </Card>
    </div>
  );
}

function FilePick({
  label,
  required,
  file,
  onPick,
  testId,
}: {
  label: string;
  required?: boolean;
  file: File | null;
  onPick: (file: File | null) => void;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-3">
      <span className="text-sm font-semibold text-ink">
        {label}
        {required ? <span className="text-danger-text"> *</span> : null}
      </span>
      <span className="text-xs text-muted">{file ? file.name : 'Take a photo or choose a file (photo or PDF).'}</span>
      <input
        type="file"
        accept="image/*,application/pdf"
        className="text-sm text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-primary-text"
        onChange={(e) => onPick(e.currentTarget.files?.[0] ?? null)}
        data-testid={testId}
      />
    </label>
  );
}
