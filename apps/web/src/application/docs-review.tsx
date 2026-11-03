import {
  DOT_APP_STEP_TITLES,
  DOT_APP_UPLOAD_LABELS,
  dotAppCoverage,
  dotAppSignaturesFor,
  signatureDocKey,
  dotAppUploadSlots,
  type DotAppMissingItem,
  type DotAppStepId,
  type DotAppUploadSlot,
  type DotAppUploadView,
} from '@neway/shared';
import { useForm } from './context';
import { DocCard, Html, Note, Pill, ReadOnly } from './form';
import { fmtDate, maskSsn } from './format';
import { Sig } from './signing';
import { currentLicense, fullName } from './meta';

export interface PendingUpload {
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'error';
  error?: string;
  file: File;
}

export interface UploadsProps {
  uploads: readonly DotAppUploadView[];
  pending: Readonly<Partial<Record<DotAppUploadSlot, PendingUpload>>>;
  thumbs: Readonly<Record<string, string>>;
  onPick: (slot: DotAppUploadSlot, file: File) => void;
  onRetry: (slot: DotAppUploadSlot) => void;
  onRemove: (slot: DotAppUploadSlot) => void;
  busy: ReadonlySet<string>;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

/** 11 Documents (prototype UPLOADS / uploadRow), with a separate "Take photo". */
export function Documents(p: UploadsProps) {
  const f = useForm();
  return (
    <>
      {dotAppUploadSlots(f.a).map(({ slot, required }) => {
        const view = p.uploads.find((u) => u.slot === slot);
        const pend = p.pending[slot];
        const invalid = f.errors.has(`upload.${slot}`);
        const label = DOT_APP_UPLOAD_LABELS[slot];
        const thumb = view ? p.thumbs[view.id] : undefined;
        const kind = view ? (view.contentType === 'application/pdf' ? 'PDF' : /heic|heif/.test(view.contentType) ? 'HEIC' : 'IMG') : 'NONE';
        const pick = (capture: boolean) => (
          <label className={`btn ${view || pend ? 'btn-ghost' : capture ? 'btn-primary' : 'btn-outline'} btn-sm`} style={{ position: 'relative' }}>
            {capture ? 'Take photo' : view || pend ? 'Replace' : 'Upload'}
            <input
              type="file"
              accept={capture ? 'image/*' : 'image/*,.pdf,.heic'}
              {...(capture ? { capture: 'environment' as const } : {})}
              aria-label={`${capture ? 'Take a photo of' : 'Upload'} ${label}`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) p.onPick(slot, file);
              }}
            />
          </label>
        );
        return (
          <div className={`up${invalid ? ' invalid' : ''}`} key={slot} id={`up_${slot}`} data-key={`upload.${slot}`}>
            <div className="th">{thumb ? <img src={thumb} alt="" /> : pend ? '…' : kind}</div>
            <div className="info">
              <b>
                {label}
                {required ? (
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </b>
              <span className="hint">
                {pend ? (
                  <>
                    {pend.name} · {mb(pend.size)}
                    {pend.status === 'error' ? (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--error)' }}>{pend.error || 'Upload failed'}</span>
                      </>
                    ) : (
                      ' · Uploading…'
                    )}
                  </>
                ) : view ? (
                  <>
                    {view.fileName} · {mb(view.sizeBytes)} · {view.source === 'consent' ? 'From Consent Form' : 'Uploaded securely'}
                  </>
                ) : (
                  'Not uploaded'
                )}
              </span>
              {pend && pend.status === 'uploading' ? (
                <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pend.progress} aria-label={`Uploading ${label}`}>
                  <i style={{ width: `${pend.progress}%` }} />
                </div>
              ) : null}
              <div className="err-msg" style={{ display: invalid ? 'block' : 'none' }}>
                This document is required.
              </div>
            </div>
            <div className="acts">
              {pend?.status === 'error' ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => p.onRetry(slot)}>
                  Retry
                </button>
              ) : null}
              {pick(true)}
              {pick(false)}
              {view && !pend ? (
                <button type="button" className="btn btn-ghost btn-sm" disabled={p.busy.has(slot)} onClick={() => p.onRemove(slot)}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

export interface ReviewProps {
  steps: readonly DotAppStepId[];
  missing: readonly DotAppMissingItem[];
  onFix: (m: DotAppMissingItem) => void;
}

/** 12 Review & submit (prototype renderReview). */
export function Review({ steps, missing, onFix }: ReviewProps) {
  const f = useForm();
  const a = f.a;
  const nm = fullName(a);
  const lic = (a.licenses ?? [])[0] ?? currentLicense(a);
  const p = a.personal ?? {};
  const c = a.company ?? {};
  const sum: Partial<Record<DotAppStepId, [string, unknown][]>> = {
    personal: [
      ['Name', nm],
      ['Address', [p.address?.street, p.address?.city, p.address?.state, p.address?.zip].filter(Boolean).join(', ')],
      ['SSN', maskSsn(f.ssn.last4)],
      ['Date of birth', fmtDate(p.dob)],
      ['Phone', p.phone],
      ['Email', p.email],
      ['3+ years at address', p.res3],
    ],
    company: [
      ['Position', c.position],
      ['Location', c.location],
      ['Eligible to work in US', c.eligible],
      ['Reads/writes/speaks English', c.english],
      ['TWIC', c.twic],
      ['Heard about us', c.heard],
    ],
    license: [
      ['License', [lic.number, lic.authority, lic.cls].filter(Boolean).join(' · ')],
      ['License expires', fmtDate(lic.exp)],
      ['Medical card expires', fmtDate(lic.med)],
      ['Tractor & semi-trailer', a.exp?.tractorSemi],
      ['Licenses listed', (a.licenses ?? []).length],
    ],
    employment: [
      ['Employers', (a.employers ?? []).map((e) => e.company).filter(Boolean).join(', ')],
      ['3-year coverage', `${dotAppCoverage(a, f.today).months} of 36 months`],
      ['Unemployment periods', (a.unemployment ?? []).length],
      ['Trucking schools', (a.schools ?? []).length],
    ],
    history: [
      ['Currently disqualified', a.fmcsr?.disqualified],
      ['Accidents (5 yrs)', a.accidents?.any === 'Yes' ? (a.accidents.list ?? []).length : a.accidents?.any],
      ['Violations (3 yrs)', a.violations?.any === 'Yes' ? (a.violations.list ?? []).length : a.violations?.any],
      ['Convicted of a crime', a.criminal?.convicted],
    ],
    emergency: [
      ['Contact #1', [a.emergency?.c1?.name, a.emergency?.c1?.relationship, a.emergency?.c1?.phone].filter(Boolean).join(' · ')],
      ['Contact #2', a.emergency?.c2?.name || '—'],
    ],
  };
  const ctx = { approvedDocs: new Set([...f.state.templates.map((t) => t.key)].filter((k) => !f.awaiting.has(k))), consentLinks: new Set(f.state.consentLinks.map((l) => l.link)), today: f.today };
  const sigApp = f.tpl('app_signature');
  return (
    <>
      {missing.length ? (
        <>
          <h2 className="blk" style={{ color: 'var(--error)' }}>
            Still needed ({missing.length})
          </h2>
          <ul className="missing">
            {missing.slice(0, 12).map((m) => (
              <li key={`${m.step}:${m.key}:${m.label}`}>
                <span>{m.label}</span>
                <button type="button" className="link-btn" onClick={() => onFix(m)}>
                  Fix
                </button>
              </li>
            ))}
            {missing.length > 12 ? <li>…and {missing.length - 12} more</li> : null}
          </ul>
        </>
      ) : (
        <Note kind="ok">All required sections are complete.</Note>
      )}
      {steps
        .filter((s) => s !== 'review')
        .map((s) => {
          const sigs = dotAppSignaturesFor(s, a, ctx).filter((k) => ctx.approvedDocs.has(signatureDocKey(k)));
          const signed = sigs.filter((k) => f.sigs.has(k)).length;
          const rows = sum[s];
          return (
            <div className="rv" key={s}>
              <div className="rv-h">
                <b>{DOT_APP_STEP_TITLES[s]}</b>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {sigs.length ? <Pill k={signed === sigs.length ? 'ok' : 'warn'}>{`${signed}/${sigs.length} signed`}</Pill> : null}
                  <button type="button" className="link-btn" onClick={() => f.goto(s)}>
                    Edit
                  </button>
                </span>
              </div>
              {rows ? (
                <dl>
                  {rows.map(([k, v]) => (
                    <div key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd>{v === undefined || v === null || v === '' ? '—' : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          );
        })}
      <div style={{ marginTop: 22 }}>
        <DocCard title={sigApp?.title ?? 'Application Signature'}>
          <div className="legal" style={{ maxHeight: 'none' }}>
            {sigApp && !f.awaiting.has('app_signature') ? (
              <Html as="div" html={(sigApp.content as { html?: string }).html} />
            ) : (
              <p>
                <i>Application signature wording pending {f.company.name} approval.</i>
              </p>
            )}
          </div>
          <div className="grid" style={{ marginTop: 14 }}>
            <ReadOnly label="Full Name" value={nm} />
            <ReadOnly label="IP Address" value="Recorded at signing" />
            <ReadOnly label="Signature Date/Time · Signed Date" value="Recorded at signing" />
          </div>
          {sigApp && !f.awaiting.has('app_signature') ? <Sig k="app_signature" label="Signed" /> : null}
        </DocCard>
      </div>
    </>
  );
}
