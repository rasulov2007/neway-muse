import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  abaRoutingValid,
  DOT_APP_EDITABLE,
  DOT_APP_STEP_TITLES,
  dotAppSignaturesFor,
  signatureDocKey,
  signatureLabel,
  type DotAppAnswers,
  type DotAppCompanyBrand,
  type DotAppDriverState,
  type DotAppMissingItem,
  type DotAppPublicGate,
  type DotAppSignatureView,
  type DotAppStepId,
  type DotAppUploadSlot,
  type DotAppUploadView,
} from '@neway/shared';
import { ApiError, DotAppClient, legacyTokenValid, loadSession, saveSession, uploadProblem } from './api';
import { saveLabel, useAutosave } from './autosave';
import { Documents, Review, type PendingUpload } from './docs-review';
import { FormProvider, type FormApi } from './context';
import { Note } from './form';
import { fmtDT, fmtTime } from './format';
import { getP, setP } from './paths';
import { allMissing, withDefaults, attentionToast, continueFrom, initialPosition, reindex, ruleContext, stepComplete, stepErrors, visibleSteps } from './rules';
import { SignSheet } from './signing';
import { fullName, STEP_META } from './meta';
import { Certs, Company, Contractor, Disclosures, Emergency, Employment, History, License, Personal, Policies } from './steps';

const STEP_BODY: Partial<Record<DotAppStepId, () => ReactNode>> = { personal: Personal, company: Company, license: License, employment: Employment, history: History, emergency: Emergency, certs: Certs, disclosures: Disclosures, policies: Policies, contractor: Contractor };

// ================================================================================== shell pieces

function BrandHead({ name, right }: { name: string; right?: ReactNode }) {
  return (
    <header className="brand-head">
      <div className="in">
        <div className="brand">
          <div className="n">{name}</div>
          <div className="s">Driver application</div>
        </div>
        {right}
      </div>
    </header>
  );
}
function CenterCard({ children }: { children: ReactNode }) {
  return (
    <main className="center-wrap">
      <div className="card">{children}</div>
    </main>
  );
}

interface ToastState {
  msg: string;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}
function Toast({ t, onDone }: { t: ToastState | null; onDone: () => void }) {
  useEffect(() => {
    if (!t || t.sticky) return;
    const id = setTimeout(onDone, 2600);
    return () => clearTimeout(id);
  }, [t, onDone]);
  if (!t) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{t.msg}</span>
      {t.action ? (
        <button type="button" className="btn" onClick={t.action.run}>
          {t.action.label}
        </button>
      ) : null}
    </div>
  );
}

// ================================================================================== root: link → code → application

type Phase =
  | { k: 'loading'; company?: DotAppCompanyBrand }
  | { k: 'gone' }
  | { k: 'paused'; company: DotAppCompanyBrand }
  | { k: 'code'; gate: DotAppPublicGate }
  | { k: 'ready'; state: DotAppDriverState }
  | { k: 'error'; msg: string; company?: DotAppCompanyBrand };

type SetPhase = (p: Phase) => void;

/** After the code (or with a live session): the application itself. */
async function loadApplication(client: DotAppClient, token: string, setPhase: SetPhase, company?: DotAppCompanyBrand): Promise<void> {
  setPhase({ k: 'loading', ...(company ? { company } : {}) });
  try {
    setPhase({ k: 'ready', state: await client.state() });
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 401) {
      client.setSession(null);
      await saveSession(token, null);
      await openLink(client, token, setPhase);
    } else if (err.status === 404) setPhase({ k: 'gone' });
    else if (err.status === 423 && company) setPhase({ k: 'paused', company });
    else setPhase({ k: 'error', msg: err.message, ...(company ? { company } : {}) });
  }
}

/** The link: gone, paused, needs the code, or straight in with the stored session. */
async function openLink(client: DotAppClient, token: string, setPhase: SetPhase): Promise<void> {
  if (!token) return setPhase({ k: 'gone' });
  client.setSession(await loadSession(token));
  let gate: DotAppPublicGate;
  try {
    gate = await client.gate();
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 404) {
      // An old link of the previous application page still works there.
      if (await legacyTokenValid(token)) {
        window.location.replace(`/application-legacy/#token=${encodeURIComponent(token)}`);
        return;
      }
      return setPhase({ k: 'gone' });
    }
    return setPhase({ k: 'error', msg: err.network ? 'You appear to be offline. Check your connection and reload this page.' : err.message });
  }
  if (gate.state === 'paused') return setPhase({ k: 'paused', company: gate.company });
  if (gate.state === 'verified') return loadApplication(client, token, setPhase, gate.company);
  setPhase({ k: 'code', gate });
}

export function Root({ token }: { token: string }) {
  const client = useMemo(() => new DotAppClient(token), [token]);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const restart = useCallback(() => void openLink(client, token, setPhase), [client, token]);

  useEffect(() => {
    restart();
  }, [restart]);

  const company = 'company' in phase ? phase.company : phase.k === 'code' ? phase.gate.company : phase.k === 'ready' ? phase.state.company : undefined;
  const brand = company?.name ?? 'NeWay';

  if (phase.k === 'ready')
    return (
      <ApplicationView
        key={phase.state.applicationId + phase.state.version}
        client={client}
        initial={phase.state}
        onAuthLost={() => {
          client.setSession(null);
          void saveSession(token, null).then(restart);
        }}
        onReplace={(s) => setPhase({ k: 'ready', state: s })}
      />
    );
  return (
    <>
      <BrandHead name={brand} />
      {phase.k === 'loading' ? (
        <CenterCard>
          <p className="sec-sub" role="status" style={{ margin: 0 }}>
            Loading…
          </p>
        </CenterCard>
      ) : phase.k === 'gone' ? (
        <CenterCard>
          <h1 className="sec">This link is no longer active</h1>
          <p className="sec-sub">For your security, application links expire. Please contact recruiting to get a new link.</p>
        </CenterCard>
      ) : phase.k === 'paused' ? (
        <CenterCard>
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            Verify it’s you
          </div>
          <h1 className="sec">Confirm your identity</h1>
          <Note kind="err">Too many attempts. For your security this link is paused. Please contact {phase.company.name} recruiting.</Note>
        </CenterCard>
      ) : phase.k === 'error' ? (
        <CenterCard>
          <h1 className="sec">Something went wrong</h1>
          <Note kind="err">{phase.msg}</Note>
          <button type="button" className="btn btn-primary" onClick={restart}>
            Try again
          </button>
        </CenterCard>
      ) : (
        <CodeScreen
          client={client}
          gate={phase.gate}
          onVerified={async (session) => {
            client.setSession(session);
            await saveSession(token, session);
            await loadApplication(client, token, setPhase, phase.gate.company);
          }}
          onPaused={() => setPhase({ k: 'paused', company: phase.gate.company })}
          onGone={() => setPhase({ k: 'gone' })}
        />
      )}
    </>
  );
}

// ================================================================================== the 6-digit code

function CodeScreen({ client, gate, onVerified, onPaused, onGone }: { client: DotAppClient; gate: DotAppPublicGate; onVerified: (s: string) => Promise<void>; onPaused: () => void; onGone: () => void }) {
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(gate.resendInSeconds);
  const [fresh] = useState(() => Boolean(gate.codeSentAt && Date.now() - Date.parse(gate.codeSentAt) < 10 * 60_000));
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok' | 'info'; text: string } | null>(() => (fresh ? { kind: 'info', text: `We emailed a 6-digit code to ${gate.maskedEmail}.` } : null));
  const [busy, setBusy] = useState(false);
  const [masked, setMasked] = useState(gate.maskedEmail);
  const sentOnce = useRef(false);

  const send = useCallback(
    async (auto: boolean) => {
      try {
        const r = await client.sendCode();
        setMasked(r.maskedEmail);
        setWait(r.resendInSeconds);
        setMsg({ kind: 'ok', text: auto ? `We emailed a 6-digit code to ${r.maskedEmail}.` : `A new code was sent to ${r.maskedEmail}.` });
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 429) setWait(Number(err.ext.retryAfter) || 60);
        else if (err.status === 423) onPaused();
        else if (err.status === 404) onGone();
        if (!(auto && err.status === 429)) setMsg({ kind: 'err', text: err.message });
      }
    },
    [client, onPaused, onGone],
  );

  // Send the code by itself when none was sent in the last 10 minutes.
  useEffect(() => {
    if (sentOnce.current) return;
    sentOnce.current = true;
    if (!fresh) void Promise.resolve().then(() => send(true));
  }, [fresh, send]);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const verify = async () => {
    const c = code.replace(/\D/g, '');
    if (c.length !== 6) return setMsg({ kind: 'err', text: 'Enter the 6-digit code.' });
    setBusy(true);
    try {
      const r = await client.verify(c);
      await onVerified(r.session);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 423) onPaused();
      else if (err.status === 404) onGone();
      else setMsg({ kind: 'err', text: err.message });
      setBusy(false);
    }
  };

  return (
    <CenterCard>
      <div className="eyebrow" style={{ marginBottom: 14 }}>
        Verify it’s you
      </div>
      <h1 className="sec">Confirm your identity</h1>
      <p className="sec-sub">
        To keep your application private, enter the 6-digit code we emailed to <b>{masked}</b>. The code works for 10 minutes.
      </p>
      {msg ? (
        <div className={`note ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
          <div>{msg.text}</div>
        </div>
      ) : null}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <div className="grid">
          <div className="f full">
            <label htmlFor="v_code">
              6-digit code<span className="req">*</span>
            </label>
            <input
              className="inp code-inp"
              id="v_code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 22, flexWrap: 'wrap' }}>
          <button type="button" className="link-btn" disabled={wait > 0} aria-disabled={wait > 0} onClick={() => void send(false)} style={wait > 0 ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}>
            {wait > 0 ? `Resend code in ${wait} s` : 'Resend code'}
          </button>
          <button type="submit" className="btn btn-primary" style={{ flex: 1, maxWidth: 260 }} disabled={busy}>
            {busy ? 'Checking…' : 'Continue →'}
          </button>
        </div>
      </form>
    </CenterCard>
  );
}

// ================================================================================== the application

const AUTO_ROWS: Record<string, { when: string; list: string; make: () => Record<string, unknown> }> = {
  'personal.res3': { when: 'No', list: 'personal.prevAddresses', make: () => ({ country: 'United States' }) },
  'company.isOwner': { when: 'Yes', list: 'company.equipment', make: () => ({}) },
  'accidents.any': { when: 'Yes', list: 'accidents.list', make: () => ({}) },
  'violations.any': { when: 'Yes', list: 'violations.list', make: () => ({}) },
};

/** Scroll a field (by its answer path / missing key) into view and focus its control. */
function scrollToKey(form: HTMLFormElement | null, key: string): void {
  if (!form) return;
  const el = [...form.querySelectorAll<HTMLElement>('[data-key]')].find((x) => x.dataset.key === key);
  if (!el) return window.scrollTo({ top: 0, behavior: 'smooth' });
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => (el.matches('input,select,textarea,button') ? el : el.querySelector<HTMLElement>('input,select,textarea,button'))?.focus({ preventScroll: true }), 300);
}
/** The first of these keys in page order. */
function firstErrorKey(form: HTMLFormElement | null, keys: Set<string>): string | null {
  const el = form ? [...form.querySelectorAll<HTMLElement>('[data-key]')].find((x) => keys.has(x.dataset.key ?? '')) : undefined;
  return el?.dataset.key ?? [...keys][0] ?? null;
}

const ssnValid = (v: string) => v.replace(/\D/g, '').length === 9;
const bankValid = (b: { routing: string; account: string }) => abaRoutingValid(b.routing) && /^\d{4,17}$/.test(b.account);

function ApplicationView({ client, initial, onAuthLost, onReplace }: { client: DotAppClient; initial: DotAppDriverState; onAuthLost: () => void; onReplace: (s: DotAppDriverState) => void }) {
  const st = initial;
  const editable = DOT_APP_EDITABLE.includes(st.status);
  const first = useMemo(() => withDefaults(st.answers, st.today), [st.answers, st.today]);
  const [answers, setAnswers] = useState<DotAppAnswers>(first.answers);
  const answersRef = useRef(answers);
  useLayoutEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  const [sigs, setSigs] = useState(() => new Map(st.signatures.map((s) => [s.key, s] as [string, DotAppSignatureView])));
  const [sigImages, setSigImages] = useState(() => new Map<string, string>());
  // Signatures already on file: their images come back from the server (session only).
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    for (const s of st.signatures) {
      client
        .signatureUrl(s.key)
        .then((url) => {
          urls.push(url);
          if (live) setSigImages((m) => (m.has(s.key) ? m : new Map(m).set(s.key, url)));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [client, st.signatures]);
  const [bank, setBank] = useState({ onFile: st.bankOnFile, last4: st.bankLast4, editing: false, routing: '', account: '' });
  const bankRef = useRef(bank);
  useLayoutEffect(() => {
    bankRef.current = bank;
  }, [bank]);
  const [uploads, setUploads] = useState<DotAppUploadView[]>(st.uploads);
  const [pending, setPending] = useState<Partial<Record<DotAppUploadSlot, PendingUpload>>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busySlots, setBusySlots] = useState<Set<string>>(new Set());
  const [ssn, setSsn] = useState({ onFile: st.ssnOnFile, last4: st.ssnLast4, editing: false, draft: '' });
  const ssnRef = useRef(ssn);
  useLayoutEffect(() => {
    ssnRef.current = ssn;
  }, [ssn]);
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [serverMissing, setServerMissing] = useState<DotAppMissingItem[] | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const focusKey = useRef<string | null>(null);

  const reload = useCallback(() => window.location.reload(), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const conflictToast = useCallback(
    () => setToast({ msg: 'A newer version was saved from another device. Reload to continue.', action: { label: 'Reload', run: reload }, sticky: true }),
    [reload],
  );

  const save = useAutosave({
    client,
    version: st.version,
    lastSavedAt: st.lastSavedAt,
    answers: () => answersRef.current,
    ssn: () => {
      const s = ssnRef.current;
      return (s.editing || !s.onFile) && ssnValid(s.draft) ? s.draft : undefined;
    },
    bank: () => {
      const b = bankRef.current;
      return (b.editing || !b.onFile) && bankValid(b) ? { routing: b.routing, account: b.account } : undefined;
    },
    onSaved: (r) => {
      if (r.sentBank) {
        const sent = r.sentBank;
        setBank((b) =>
          b.routing === sent.routing && b.account === sent.account
            ? { onFile: r.bankOnFile, last4: r.bankLast4, editing: false, routing: '', account: '' }
            : { ...b, onFile: r.bankOnFile, last4: r.bankLast4 },
        );
      }
      if (r.sentSsn) {
        setSsn((s) => (s.draft === r.sentSsn ? { onFile: r.ssnOnFile, last4: r.ssnLast4, editing: false, draft: '' } : { ...s, onFile: r.ssnOnFile, last4: r.ssnLast4 }));
      }
    },
    onConflict: conflictToast,
    onAuthLost,
    onFrozen: reload,
  });
  const { touch } = save;

  useEffect(() => {
    if (first.changed && editable) touch();
  }, [first.changed, editable, touch]);

  // ------------------------------------------------------------------ derived rules
  const awaiting = useMemo(() => new Set(st.awaitingDocs), [st.awaitingDocs]);
  const tplMap = useMemo(() => new Map(st.templates.map((t) => [t.key, t])), [st.templates]);
  const approved = useMemo(() => st.templates.map((t) => t.key).filter((k) => !awaiting.has(k)), [st.templates, awaiting]);
  const ctx = useMemo(
    () =>
      ruleContext({
        today: st.today,
        signatures: sigs.keys(),
        uploads: uploads.map((u) => u.slot),
        approvedDocs: approved,
        consentLinks: st.consentLinks.map((l) => l.link),
        ssnOnFile: ssn.onFile || ssnValid(ssn.draft),
        bankOnFile: (bank.onFile && !bank.editing) || bankValid(bank),
        templateContent: (k) => tplMap.get(k)?.content as Record<string, unknown> | undefined,
      }),
    [st.today, sigs, uploads, approved, st.consentLinks, ssn.onFile, ssn.draft, tplMap, bank],
  );
  const missing = useMemo(() => {
    const m = allMissing(answers, ctx);
    if (ssn.editing && ssn.draft && !ssnValid(ssn.draft) && !m.some((x) => x.key === 'personal.ssn'))
      m.unshift({ step: 'personal', key: 'personal.ssn', label: 'SSN/SIN (9 digits)', kind: 'field' });
    if (bank.editing && (bank.routing || bank.account) && !bankValid(bank) && !m.some((x) => x.key === 'ach.numbers'))
      m.push({ step: 'contractor', key: 'ach.numbers', label: 'ACH authorization: Routing Number (9 digits) and Account Number', kind: 'field' });
    return m;
  }, [answers, ctx, ssn.editing, ssn.draft, bank]);
  const steps = useMemo(() => visibleSteps(answers), [answers]);
  const required = useMemo(() => {
    const out = new Set<string>();
    for (const s of steps) for (const k of dotAppSignaturesFor(s, answers, ctx)) out.add(k);
    return out;
  }, [steps, answers, ctx]);

  const [pos, setPos] = useState(() => initialPosition(steps, missing, awaiting, st.openChangeRequest?.sections ?? null));
  const prevSteps = useRef(steps);
  useEffect(() => {
    if (prevSteps.current.join() !== steps.join()) {
      const old = prevSteps.current;
      setPos((p) => ({ step: reindex(old, steps, p.step), maxStep: Math.min(Math.max(reindex(old, steps, p.maxStep), 0), steps.length - 1) }));
      prevSteps.current = steps;
    }
  }, [steps]);
  const stepId = steps[Math.min(pos.step, steps.length - 1)] ?? 'personal';
  const n = steps.length;
  const pct = Math.round(((pos.step + 1) / n) * 100);
  const corr = st.openChangeRequest;

  // On a step change: top of the page and focus on the section title (or the field a Fix link named).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const key = focusKey.current;
    focusKey.current = null;
    if (key) {
      requestAnimationFrame(() => scrollToKey(formRef.current, key));
      return;
    }
    window.scrollTo(0, 0);
    setTimeout(() => titleRef.current?.focus({ preventScroll: true }), 30);
  }, [pos.step]);

  // Phones: a focused field is kept above the sticky Continue bar (and above the keyboard).
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || window.innerWidth > 900 || !el.matches('input,select,textarea')) return;
      if (el.closest('.sheet')) return;
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const bottom = (vv ? vv.height + vv.offsetTop : window.innerHeight) - 96;
        if (r.bottom > bottom || r.top < 80) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 320);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  // ------------------------------------------------------------------ writes
  const set = useCallback(
    (path: string, value: unknown) => {
      if (!editable) return;
      setAnswers((prev) => {
        let next = setP(prev, path, value);
        const auto = AUTO_ROWS[path];
        if (auto && value === auto.when && !((getP(next, auto.list) as unknown[] | undefined) ?? []).length) next = setP(next, auto.list, [auto.make()]);
        return next;
      });
      setErrors((prev) => {
        if (!prev.size) return prev;
        const out = new Set([...prev].filter((k) => k !== path && !k.startsWith(`${path}.`) && !path.startsWith(`${k}.`)));
        return out.size === prev.size ? prev : out;
      });
      setServerMissing(null);
      touch();
    },
    [editable, touch],
  );

  const goto = useCallback(
    (id: DotAppStepId, key?: string) => {
      const i = steps.indexOf(id);
      if (i < 0) return;
      const errs = key ? new Set(stepErrors(id, missing, awaiting).map((m) => m.key)) : new Set<string>();
      setErrors(errs);
      if (key) focusKey.current = key;
      if (i === pos.step && key) requestAnimationFrame(() => scrollToKey(formRef.current, key));
      setPos((p) => ({ step: i, maxStep: Math.max(p.maxStep, i) }));
    },
    [steps, missing, awaiting, pos.step],
  );

  const next = () => {
    const errs = stepErrors(stepId, missing, awaiting);
    const r = continueFrom(pos.step, pos.maxStep, errs, n);
    if (r.blocked) {
      const keys = new Set(errs.map((m) => m.key));
      setErrors(keys);
      requestAnimationFrame(() => {
        const k = firstErrorKey(formRef.current, keys);
        if (k) scrollToKey(formRef.current, k);
      });
      setToast({ msg: attentionToast(errs.length) });
      return;
    }
    setErrors(new Set());
    setPos({ step: r.step, maxStep: r.maxStep });
  };
  const back = () => {
    setErrors(new Set());
    setPos((p) => ({ ...p, step: Math.max(0, p.step - 1) }));
  };
  const jump = (i: number) => {
    if (i < 0 || i > pos.maxStep) return;
    setErrors(new Set());
    setPos((p) => ({ ...p, step: i }));
  };

  // ------------------------------------------------------------------ signatures
  const sheetDoc = sheet ? tplMap.get(signatureDocKey(sheet)) : undefined;
  const sign = async (typedName: string, image: string): Promise<string | null> => {
    const key = sheet;
    if (!key || !sheetDoc) return 'This document cannot be signed yet.';
    if (!(await save.flush())) return navigator.onLine ? 'Your answers are not saved yet. Please try again in a moment.' : 'You are offline. Sign when you are back online.';
    try {
      const v = await client.sign({ key, docVersion: sheetDoc.version, typedName, image });
      setSigs((m) => new Map(m).set(key, v));
      setSigImages((m) => new Map(m).set(key, image));
      setErrors((e) => {
        const o = new Set(e);
        o.delete(`sig.${key}`);
        return o;
      });
      setServerMissing(null);
      setSheet(null);
      return null;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409 && err.code === 'template_changed') {
        setToast({ msg: 'This document was updated. Reload to sign the current version.', action: { label: 'Reload', run: reload }, sticky: true });
      } else if (err.status === 401) {
        onAuthLost();
      }
      return err.network ? 'You appear to be offline. Try again when the connection returns.' : err.message;
    }
  };

  // ------------------------------------------------------------------ uploads
  const loadThumb = useCallback(
    (u: DotAppUploadView) => {
      if (!/^image\/(jpeg|png)$/.test(u.contentType)) return;
      client
        .fileUrl(u.id)
        .then((url) => setThumbs((t) => ({ ...t, [u.id]: url })))
        .catch(() => undefined);
    },
    [client],
  );
  useEffect(() => {
    st.uploads.forEach(loadThumb);
  }, [st.uploads, loadThumb]);
  const thumbsRef = useRef(thumbs);
  useLayoutEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);
  useEffect(() => () => Object.values(thumbsRef.current).forEach((u) => URL.revokeObjectURL(u)), []);

  const startUpload = (slot: DotAppUploadSlot, file: File) => {
    setPending((p) => ({ ...p, [slot]: { name: file.name, size: file.size, progress: 0, status: 'uploading', file } }));
    const { done } = client.upload(slot, file, (pct) => setPending((p) => (p[slot] ? { ...p, [slot]: { ...p[slot], progress: pct } } : p)));
    done
      .then((view) => {
        setUploads((prev) => [...prev.filter((u) => u.slot !== slot), view]);
        setPending((p) => {
          const o = { ...p };
          delete o[slot];
          return o;
        });
        setErrors((e) => {
          const o = new Set(e);
          o.delete(`upload.${slot}`);
          return o;
        });
        setServerMissing(null);
        loadThumb(view);
      })
      .catch((e: ApiError) => {
        if (e.status === 401) return onAuthLost();
        setPending((p) => (p[slot] ? { ...p, [slot]: { ...p[slot], status: 'error', error: e.status ? e.message : 'Upload failed' } } : p));
        setToast({ msg: 'Upload failed. Tap Retry.' });
      });
  };
  const onPick = (slot: DotAppUploadSlot, file: File) => {
    const problem = uploadProblem(file);
    if (problem) return setToast({ msg: problem });
    startUpload(slot, file);
  };
  const onRetry = (slot: DotAppUploadSlot) => {
    const p = pending[slot];
    if (p) startUpload(slot, p.file);
  };
  const onRemove = (slot: DotAppUploadSlot) => {
    const view = uploads.find((u) => u.slot === slot);
    if (!view) return;
    setBusySlots((b) => new Set(b).add(slot));
    client
      .removeUpload(view.id)
      .then(() => setUploads((prev) => prev.filter((u) => u.id !== view.id)))
      .catch((e: ApiError) => (e.status === 401 ? onAuthLost() : setToast({ msg: e.message })))
      .finally(() =>
        setBusySlots((b) => {
          const o = new Set(b);
          o.delete(slot);
          return o;
        }),
      );
  };

  // ------------------------------------------------------------------ submit
  const shownMissing = serverMissing ?? missing;
  const submit = async () => {
    if (submitting) return;
    if (missing.length) {
      setToast({ msg: 'Please complete the items listed at the top.' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (!navigator.onLine) return setToast({ msg: 'You are offline. Submit when you are back online.' });
    setSubmitting(true);
    try {
      if (!(await save.flush())) {
        setToast({ msg: 'Your answers are not saved yet. Please try again in a moment.' });
        return;
      }
      onReplace(await client.submit(save.version()));
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 422 && Array.isArray(err.ext.missing)) {
        setServerMissing(err.ext.missing as DotAppMissingItem[]);
        setToast({ msg: 'Please complete the items listed at the top.' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (err.status === 409 && err.code === 'stale') conflictToast();
      else if (err.status === 401) onAuthLost();
      else setToast({ msg: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  // ------------------------------------------------------------------ form api
  const api: FormApi = {
    a: answers,
    set,
    errors,
    prefilled: new Set(st.prefilledPaths),
    today: st.today,
    company: st.company,
    state: st,
    tpl: (k) => (awaiting.has(k) ? undefined : tplMap.get(k)),
    awaiting,
    required,
    sigs,
    sigImages,
    openSign: (k) => editable && setSheet(k),
    goto: (s) => goto(s),
    ssn: {
      ...ssn,
      setDraft: (v) => {
        setSsn((s) => ({ ...s, draft: v }));
        setErrors((e) => {
          if (!e.has('personal.ssn')) return e;
          const o = new Set(e);
          o.delete('personal.ssn');
          return o;
        });
        touch();
      },
      startEdit: () => setSsn((s) => ({ ...s, editing: true, draft: '' })),
    },
    bank: {
      ...bank,
      set: (field, v) => {
        setBank((b) => ({ ...b, [field]: v.replace(/\D/g, '').slice(0, field === 'routing' ? 9 : 17) }));
        setErrors((e) => {
          if (!e.has('ach.numbers')) return e;
          const o = new Set(e);
          o.delete('ach.numbers');
          return o;
        });
        touch();
      },
      startEdit: () => setBank((b) => ({ ...b, editing: true, routing: '', account: '' })),
    },
  };

  const status = saveLabel(save.online, save.state, save.at, fmtTime);
  const firstName = answers.personal?.firstName ?? '';

  // ------------------------------------------------------------------ submitted: thank you
  if (!editable)
    return (
      <>
        <BrandHead name={st.company.name} />
        <CenterCard>
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            Application received
          </div>
          <h1 className="sec">Thank you, {firstName}.</h1>
          <p className="sec-sub">
            Your application was submitted on {fmtDT(st.submittedAt)}. {st.company.name} Safety will review it and contact you. You can close this page.
          </p>
          {st.reference ? (
            <Note kind="info">
              Reference: <b>{st.reference}</b>
            </Note>
          ) : null}
        </CenterCard>
      </>
    );

  const Body = STEP_BODY[stepId];
  return (
    <FormProvider value={api}>
      <BrandHead
        name={st.company.name}
        right={
          <div className={`save-status ${status.cls}`} role="status" aria-live="polite">
            <span className="dot" />
            {status.text}
          </div>
        }
      />
      <div className="mobile-steps">
        <div className="row">
          <span>Driver application</span>
          <span className="jump">
            Step {pos.step + 1} of {n} ▾
            <select aria-label="Go to section" value={pos.step} onChange={(e) => jump(Number(e.target.value))}>
              {steps.map((s, i) => (
                <option key={s} value={i} disabled={i > pos.maxStep}>
                  {i + 1}. {DOT_APP_STEP_TITLES[s]}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="cur">{DOT_APP_STEP_TITLES[stepId]}</div>
      </div>
      <div className="app-wrap">
        <aside className="side" aria-label="Application progress">
          <div className="eyebrow">Driver application</div>
          <ol className="steps">
            {steps.map((s, i) => {
              const complete = stepComplete(s, missing, awaiting);
              const done = i < pos.step || (i <= pos.maxStep && complete);
              const err = Boolean(corr?.sections.includes(s));
              return (
                <li key={s} className={[i === pos.step ? 'cur' : '', done ? 'done' : '', err ? 'err' : ''].filter(Boolean).join(' ')}>
                  <button type="button" disabled={i > pos.maxStep} aria-current={i === pos.step ? 'step' : undefined} onClick={() => jump(i)}>
                    <span className="c">{i < pos.step && complete ? '✓' : i + 1}</span>
                    {DOT_APP_STEP_TITLES[s]}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="side-notes">
            Your progress saves automatically.
            <br />
            Have your CDL and medical card ready.
            <br />
            Your SSN and any bank numbers are stored encrypted and shown only masked.
          </div>
        </aside>
        <main className="card" id="card" aria-labelledby="sec-title">
          <div className="card-top">
            <span>{STEP_META[stepId].eyebrow}</span>
            <span>
              {String(pos.step + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}
            </span>
          </div>
          <div className="progress" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </div>
          {corr ? (
            <Note kind="err">
              <b>Safety requested changes</b> — {corr.message}
              <br />
              Sections: {corr.sections.map((s) => DOT_APP_STEP_TITLES[s] ?? s).join(', ')}
            </Note>
          ) : null}
          {!save.online ? <Note kind="warn">You are offline. Your answers stay on this screen and will save when the connection returns.</Note> : null}
          <h1 className="sec" id="sec-title" tabIndex={-1} ref={titleRef}>
            {DOT_APP_STEP_TITLES[stepId]}.
          </h1>
          <p className="sec-sub">{STEP_META[stepId].sub}</p>
          <form id="stepform" noValidate ref={formRef} onSubmit={(e) => e.preventDefault()}>
            {stepId === 'documents' ? (
              <Documents uploads={uploads} pending={pending} thumbs={thumbs} onPick={onPick} onRetry={onRetry} onRemove={onRemove} busy={busySlots} />
            ) : stepId === 'review' ? (
              <Review steps={steps} missing={shownMissing} onFix={(m) => goto(m.step, m.key)} />
            ) : Body ? (
              <Body />
            ) : null}
          </form>
          <div className="nav">
            {pos.step > 0 ? (
              <button type="button" className="btn btn-ghost" onClick={back}>
                ← Back
              </button>
            ) : (
              <span />
            )}
            {stepId === 'review' ? (
              <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={submitting} aria-busy={submitting}>
                {submitting ? 'Submitting…' : 'Submit application'}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={next}>
                Continue →
              </button>
            )}
          </div>
        </main>
      </div>
      <div className="foot">{st.company.legalName} · Driver recruiting · Secured by NeWay</div>
      <Toast t={toast} onDone={() => setToast(null)} />
      {sheet && sheetDoc ? (
        <SignSheet
          title={signatureDocKey(sheet) !== sheet ? signatureLabel(sheet, answers) : sheetDoc.title}
          version={sheetDoc.version}
          signer={fullName(answers)}
          onCancel={closeSheet}
          onSign={sign}
        />
      ) : null}
    </FormProvider>
  );
}
