import { useState, type ReactNode } from 'react';
import { DOT_APP_OPTIONS } from '@neway/shared';
import { useForm } from './context';
import { idOf } from './format';
import { getP } from './paths';
import { sanitizeLegalHtml } from './sanitize';

const ReqMark = ({ on }: { on?: boolean | undefined }) =>
  on ? (
    <span className="req" aria-hidden="true">
      *
    </span>
  ) : null;

/** Template wording (sanitised) as HTML. */
export function Html({ html, as: Tag = 'span', className }: { html: unknown; as?: 'span' | 'div' | 'p'; className?: string }) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: sanitizeLegalHtml(html) }} />;
}

export function Note({ kind, children }: { kind: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode }) {
  return (
    <div className={`note ${kind}`} role={kind === 'err' ? 'alert' : 'note'}>
      <div>{children}</div>
    </div>
  );
}
export const Pill = ({ k, children }: { k: 'ok' | 'warn' | 'err' | 'info' | 'mute' | 'dark'; children: ReactNode }) => <span className={`pill ${k}`}>{children}</span>;

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0);

export interface FieldProps {
  path: string;
  label: ReactNode;
  req?: boolean | undefined;
  type?: 'text' | 'date' | 'email' | 'tel' | 'number' | 'time' | 'textarea' | undefined;
  opts?: readonly string[] | undefined;
  ph?: string | undefined;
  im?: 'numeric' | 'tel' | 'decimal' | 'email' | undefined;
  ac?: string | undefined;
  max?: string | undefined;
  min?: string | undefined;
  hint?: ReactNode;
  err?: string | undefined;
  full?: boolean | undefined;
  upper?: boolean | undefined;
  maxLength?: number | undefined;
}

export function Field(p: FieldProps) {
  const f = useForm();
  const id = idOf(p.path);
  const raw = getP(f.a, p.path);
  const val = raw == null ? '' : String(raw);
  const invalid = f.errors.has(p.path);
  const pre = f.prefilled.has(p.path);
  const describedBy = `${id}_e${p.hint ? ` ${id}_h` : ''}`;
  const common = {
    id,
    'aria-required': p.req ? true : undefined,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': describedBy,
  } as const;
  const onValue = (v: string) => f.set(p.path, p.upper ? v.toUpperCase() : v);
  let ctl: ReactNode;
  if (p.opts) {
    ctl = (
      <select className="inp" {...common} value={val} onChange={(e) => onValue(e.target.value)}>
        <option value="">{p.ph ?? 'Select'}</option>
        {p.opts.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
        {val && !p.opts.includes(val) ? <option value={val}>{val}</option> : null}
      </select>
    );
  } else if (p.type === 'textarea') {
    ctl = <textarea className="inp" {...common} placeholder={p.ph ?? ''} value={val} onChange={(e) => onValue(e.target.value)} />;
  } else {
    ctl = (
      <input
        className="inp"
        {...common}
        type={p.type ?? 'text'}
        value={val}
        placeholder={p.ph ?? ''}
        inputMode={p.im}
        autoComplete={p.ac}
        max={p.max}
        min={p.min}
        maxLength={p.maxLength}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  }
  return (
    <div className={`f${p.full ? ' full' : ''}${invalid ? ' invalid' : ''}`} data-key={p.path}>
      <label htmlFor={id}>
        {p.label}
        <ReqMark on={p.req} />
        {pre ? <span className="prefill">From Consent Form</span> : null}
      </label>
      {ctl}
      {p.hint ? (
        <div className="hint" id={`${id}_h`}>
          {p.hint}
        </div>
      ) : null}
      <div className="err-msg" id={`${id}_e`} role={invalid ? 'alert' : undefined}>
        {invalid && filled(raw) && p.err ? p.err : p.err && !p.req ? p.err : 'This field is required.'}
      </div>
    </div>
  );
}

/** A read-only display box (license number on the certification, today's date …). */
export function ReadOnly({ label, value, full }: { label: ReactNode; value: string; full?: boolean }) {
  const [id] = useState(() => `ro_${Math.random().toString(36).slice(2, 9)}`);
  return (
    <div className={`f${full ? ' full' : ''}`}>
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <input className="inp" id={id} readOnly value={value} />
    </div>
  );
}

export function YN({ path, q, opts = ['Yes', 'No'], req = true, cite, full = true }: { path: string; q: ReactNode; opts?: readonly string[]; req?: boolean; cite?: string; full?: boolean }) {
  const f = useForm();
  const val = getP(f.a, path);
  const id = idOf(path);
  const invalid = f.errors.has(path);
  return (
    <div className={`q${full ? ' full' : ''}${invalid ? ' invalid' : ''}`} role="radiogroup" aria-labelledby={`${id}_q`} aria-required={req || undefined} data-key={path}>
      <div className="qt" id={`${id}_q`}>
        {q}
        <ReqMark on={req} />
        {cite ? <span className="cite"> {cite}</span> : null}
      </div>
      <div className="yn">
        {opts.map((x) => (
          <label key={x}>
            <input type="radio" name={id} value={x} checked={val === x} onChange={() => f.set(path, x)} />
            <span>{x}</span>
          </label>
        ))}
      </div>
      <div className="err-msg" role={invalid ? 'alert' : undefined}>
        Please choose an answer.
      </div>
    </div>
  );
}

export function Chk({ path, html, children, req }: { path: string; html?: unknown; children?: ReactNode; req?: boolean }) {
  const f = useForm();
  const on = Boolean(getP(f.a, path));
  const id = idOf(path);
  const invalid = f.errors.has(path);
  return (
    <label className={`chk${on ? ' checked' : ''}${invalid ? ' invalid' : ''}`} htmlFor={id} data-key={path}>
      <input type="checkbox" id={id} checked={on} aria-required={req || undefined} aria-invalid={invalid || undefined} onChange={(e) => f.set(path, e.target.checked)} />
      {html !== undefined ? <Html html={html} /> : <span>{children}</span>}
    </label>
  );
}

export function Multi({ path, label, opts, req }: { path: string; label: ReactNode; opts: readonly string[]; req?: boolean }) {
  const f = useForm();
  const cur = (getP(f.a, path) as string[] | undefined) ?? [];
  const invalid = f.errors.has(path);
  return (
    <div className={`f full${invalid ? ' invalid' : ''}`} data-key={path} role="group" aria-label={typeof label === 'string' ? label : undefined}>
      <span className="lbl">
        {label}
        <ReqMark on={req} />
      </span>
      <div className="chk-list">
        {opts.map((x) => {
          const on = cur.includes(x);
          return (
            <label key={x} className={`chk${on ? ' checked' : ''}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  const next = new Set(cur);
                  if (e.target.checked) next.add(x);
                  else next.delete(x);
                  f.set(path, opts.filter((o) => next.has(o)));
                }}
              />
              <span>{x}</span>
            </label>
          );
        })}
      </div>
      <div className="err-msg">Select at least one.</div>
    </div>
  );
}

export function Rep({
  path,
  title,
  item,
  min = 0,
  add,
  make = () => ({}),
}: {
  path: string;
  title: string;
  item: (p: string, i: number) => ReactNode;
  min?: number;
  add?: string;
  make?: () => Record<string, unknown>;
}) {
  const f = useForm();
  const arr = (getP(f.a, path) as unknown[] | undefined) ?? [];
  const invalid = f.errors.has(path);
  return (
    <>
      {arr.map((row, i) => (
        <div className="rep" key={(row as { id?: string })?.id ?? i}>
          <div className="rep-h">
            <b>
              {title} {i + 1}
            </b>
            {arr.length > min ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Remove ${title} ${i + 1}`}
                onClick={() =>
                  f.set(
                    path,
                    arr.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </button>
            ) : null}
          </div>
          <div className="grid">{item(`${path}.${i}`, i)}</div>
        </div>
      ))}
      <button type="button" className={`add${invalid ? ' invalid' : ''}`} data-key={path} onClick={() => f.set(path, [...arr, make()])}>
        + {add ?? `Add ${title.toLowerCase()}`}
      </button>
    </>
  );
}

export function Addr({ base, req = true, country }: { base: string; req?: boolean; country?: boolean }) {
  return (
    <>
      <Field path={`${base}.street`} label="Street address" req={req} full ac="street-address" />
      <Field path={`${base}.city`} label="City" req={req} ac="address-level2" />
      <div className="grid" style={{ gap: '0 12px', gridTemplateColumns: '1fr 1fr' }}>
        <Field path={`${base}.state`} label="State/Province" req={req} opts={DOT_APP_OPTIONS.states} ph="Select" />
        <Field path={`${base}.zip`} label="Zip/Postal" req={req} im="numeric" ac="postal-code" />
      </div>
      {country ? <Field path={`${base}.country`} label="Country" req={req} opts={DOT_APP_OPTIONS.country} /> : null}
    </>
  );
}


/**
 * The company's letterhead, where the source document prints one (the template marks it with
 * `letterhead: true`). Name, address and phone come from the company's own profile, never from code.
 */
export function Letterhead() {
  const f = useForm();
  const c = f.company;
  return (
    <div className="letterhead" data-testid="letterhead">
      <b>{c.legalName.toUpperCase()}</b>
      {c.address ? <span>{c.address}</span> : null}
      {c.phone ? <span>{c.phone}</span> : null}
    </div>
  );
}

/** One legal document card: title header, optional pill, optional company letterhead. */
export function DocCard({ title, pill, letterhead, children }: { title: ReactNode; pill?: ReactNode; letterhead?: boolean; children: ReactNode }) {
  return (
    <div className="doc">
      <div className="doc-h">
        <div>
          <div className="t">{title}</div>
        </div>
        {pill}
      </div>
      <div className="doc-b">
        {letterhead ? <Letterhead /> : null}
        {children}
      </div>
    </div>
  );
}

/** The scrolling document text with Expand / Print. */
export function LegalBox({ html, id }: { html: unknown; id: string }) {
  const [open, setOpen] = useState(false);
  const clean = sanitizeLegalHtml(html);
  const print = () => {
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) return;
    w.document.title = 'Copy';
    w.document.body.style.cssText = 'font:14px/1.6 system-ui;max-width:760px;margin:30px auto';
    w.document.body.innerHTML = clean;
    w.print();
  };
  return (
    <>
      <div className={`legal${open ? ' open' : ''}`} id={`lg_${id}`} tabIndex={0} aria-label="Document text" dangerouslySetInnerHTML={{ __html: clean }} />
      <div className="legal-tools">
        <button type="button" className="link-btn" aria-expanded={open} aria-controls={`lg_${id}`} onClick={() => setOpen(!open)}>
          {open ? 'Collapse text' : 'Expand full text'}
        </button>
        <button type="button" className="link-btn" onClick={print}>
          Print / save copy
        </button>
      </div>
    </>
  );
}

/** "Awaiting <company> approved document(s)": the document cannot be read or signed yet. */
export function PendingLegal({ names }: { names: string[] }) {
  const f = useForm();
  return (
    <Note kind="warn">
      <b>
        Awaiting {f.company.name} approved document{names.length > 1 ? 's' : ''}.
      </b>
      <br />
      {names.join(' · ')}
      <br />
      This section unlocks when Safety uploads the approved version.
    </Note>
  );
}
