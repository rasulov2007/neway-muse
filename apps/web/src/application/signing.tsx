import { useEffect, useRef, useState } from 'react';
import { useForm } from './context';
import { fmtDT } from './format';
import { trimmedPng } from './signature';

/** One signature box (prototype SIG): Sign, or the signature on file with Re-sign. */
export function Sig({ k, label = 'Signature', note }: { k: string; label?: string; note?: string }) {
  const f = useForm();
  const s = f.sigs.get(k);
  const img = f.sigImages.get(k);
  const invalid = f.errors.has(`sig.${k}`);
  const editable = ['sent', 'opened', 'in_progress', 'changes_requested'].includes(f.state.status);
  if (s)
    return (
      <div className="sig-box signed" data-key={`sig.${k}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', minWidth: 0 }}>
          {img ? <img src={img} alt={`Signature of ${s.typedName}`} /> : <span className="sig-typed" aria-label={`Signed by ${s.typedName}`}>{s.typedName}</span>}
          <div className="sig-meta">
            <b style={{ color: 'var(--text)' }}>{s.typedName}</b>
            <br />
            Signed {fmtDT(s.signedAt)} · {s.docVersion}
            <br />
            Evidence ID {s.evidenceId}
          </div>
        </div>
        {editable ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => f.openSign(k)}>
            Re-sign
          </button>
        ) : null}
      </div>
    );
  return (
    <div className={`sig-box${invalid ? ' invalid' : ''}`} data-key={`sig.${k}`}>
      <div>
        <b style={{ fontSize: 13 }}>
          {label}
          <span className="req" aria-hidden="true">
            *
          </span>
        </b>
        <div className="sig-meta">{note || 'Draw with your finger or mouse. Each document is signed separately.'}</div>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => f.openSign(k)} disabled={!editable}>
        Sign
      </button>
      <div className="err-msg" style={{ width: '100%', display: invalid ? 'block' : 'none' }} role={invalid ? 'alert' : undefined}>
        This document must be signed.
      </div>
    </div>
  );
}

export interface SheetProps {
  title: string;
  version: string;
  signer: string;
  onCancel: () => void;
  /** Resolves with an error message to show, or null when signed. */
  onSign: (typedName: string, image: string) => Promise<string | null>;
}

/**
 * The signing sheet (prototype sheetHTML / initPad / adoptSig). While it is open the page cannot
 * scroll (body fixed in place) and the canvas takes every touch (touch-action: none).
 */
export function SignSheet({ title, version, signer, onCancel, onSign }: SheetProps) {
  const cv = useRef<HTMLCanvasElement>(null);
  const pts = useRef(0);
  const [name, setName] = useState(signer);
  const [consent, setConsent] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Lock the page behind the sheet (iOS ignores overflow:hidden alone).
  useEffect(() => {
    const y = window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, width: b.width, overflow: b.overflow };
    b.position = 'fixed';
    b.top = `-${y}px`;
    b.width = '100%';
    b.overflow = 'hidden';
    document.body.classList.add('sheet-open');
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', esc);
    return () => {
      Object.assign(b, prev);
      document.body.classList.remove('sheet-open');
      window.scrollTo(0, y);
      window.removeEventListener('keydown', esc);
    };
  }, [onCancel]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const setup = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#14231d';
      return ctx;
    };
    let ctx = setup();
    let down = false;
    let last: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const b = c.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      down = true;
      last = pos(e);
      ctx?.beginPath();
      ctx?.moveTo(...last);
    };
    const onMove = (e: PointerEvent) => {
      if (!down || !ctx) return;
      e.preventDefault();
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const p = pos(ev);
        ctx.lineTo(...p);
        last = p;
        pts.current++;
      }
      ctx.stroke();
    };
    const onUp = () => {
      down = false;
      last = null;
    };
    // Belt and braces for older iOS: a touch on the pad never scrolls or zooms the page.
    const stopTouch = (e: TouchEvent) => e.preventDefault();
    const onResize = () => {
      if (pts.current === 0) ctx = setup();
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onUp);
    c.addEventListener('touchstart', stopTouch, { passive: false });
    c.addEventListener('touchmove', stopTouch, { passive: false });
    window.addEventListener('resize', onResize);
    void last;
    return () => {
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointercancel', onUp);
      c.removeEventListener('pointerleave', onUp);
      c.removeEventListener('touchstart', stopTouch);
      c.removeEventListener('touchmove', stopTouch);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const clear = () => {
    const c = cv.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    pts.current = 0;
  };

  const adopt = async () => {
    const p: string[] = [];
    if (pts.current < 8) p.push('Draw your signature in the box.');
    if (name.trim().length < 2) p.push('Enter your full name.');
    if (!consent) p.push('Agree to use an electronic signature.');
    const image = cv.current && pts.current >= 8 ? trimmedPng(cv.current) : null;
    if (pts.current >= 8 && !image) p.push('Draw your signature in the box.');
    setProblems(p);
    if (p.length || !image) return;
    setBusy(true);
    const err = await onSign(name.trim(), image);
    setBusy(false);
    if (err) setProblems([err]);
  };

  return (
    <div className="sheet-bg" role="dialog" aria-modal="true" aria-labelledby="sgh" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="sheet">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <h3 id="sgh">Sign: {title}</h3>
            <div className="hint">
              Document version {version} · signer {signer || '—'}
            </div>
          </div>
          <button type="button" className="x" aria-label="Close" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </div>
        <div className="pad-wrap">
          <canvas ref={cv} id="pad" aria-label="Signature area. Draw your signature." />
          <span className="pad-x" aria-hidden="true">
            ✕
          </span>
          <div className="pad-line" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span className="hint">Sign above the line</span>
          <button type="button" className="link-btn" onClick={clear}>
            Clear
          </button>
        </div>
        <div className="f" style={{ marginBottom: 12 }}>
          <label htmlFor="sig_name">
            Full name<span className="req">*</span>
          </label>
          <input className="inp" id="sig_name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </div>
        <label className={`chk${consent ? ' checked' : ''}`} style={{ marginBottom: 16 }}>
          <input type="checkbox" id="sig_consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I agree to use an electronic signature to sign this document. An electronic signature is as legally binding as an ink signature.</span>
        </label>
        {problems.length ? (
          <div id="sig_err" className="note err" role="alert">
            <div>
              {problems.map((x) => (
                <div key={x}>{x}</div>
              ))}
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => void adopt()} disabled={busy}>
            {busy ? 'Signing…' : 'Sign document'}
          </button>
        </div>
      </div>
    </div>
  );
}
