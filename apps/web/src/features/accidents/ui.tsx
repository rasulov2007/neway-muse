import { Lock } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { safetyRules as R } from '@neway/shared';
import { Avatar, Badge, cn, type BadgeTone } from '@/design-system';
import { nowMs } from '@/lib/clock';

/**
 * Small pieces the Accident & Claims v2 screens share. Porcelain tokens only; every status is a symbol plus a word
 * (Badge with its status symbol), never colour alone.
 */

const TONE: Record<string, BadgeTone> = { urgent: 'danger', warning: 'warning', done: 'success', moving: 'info', neutral: 'neutral', accent: 'info', info: 'info' };

export function ToneBadge({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <Badge tone={TONE[tone] ?? 'neutral'} dot title={title}>
      {children}
    </Badge>
  );
}

const SEV_TONE: Record<R.Severity, string> = { minor: 'neutral', moderate: 'warning', serious: 'urgent', critical: 'urgent' };
export function SevBadge({ sev }: { sev: R.Severity }) {
  return <ToneBadge tone={SEV_TONE[sev]}>{R.SEVERITY_LABEL[sev]}</ToneBadge>;
}

export function StageBadge({ stage }: { stage: R.Stage }) {
  return <ToneBadge tone={stage === 'closed' ? 'done' : stage === 'draft' ? 'warning' : 'moving'}>{R.STAGE_LABEL[stage]}</ToneBadge>;
}

export function Panel({
  title,
  sub,
  actions,
  children,
  pad = true,
  className,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn('min-w-0 rounded-[10px] border border-nw-border bg-nw-panel', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-nw-border px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-[15px] font-bold text-nw-text">{title}</h2> : null}
            {sub ? <div className="mt-0.5 text-xs text-nw-text-3">{sub}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function KV({ k, hint, children }: { k: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 border-b border-nw-border py-2 last:border-b-0">
      <dt className="text-xs font-semibold text-nw-text-3">{k}</dt>
      <dd className="min-w-0 text-sm text-nw-text">
        {children}
        {hint ? <div className="mt-0.5 text-xs text-nw-text-3">{hint}</div> : null}
      </dd>
    </div>
  );
}

export function Field({ label, hint, error, required, htmlFor, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; required?: boolean; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-nw-text-2">
        {label}
        {required ? <span className="text-nw-urgent-text"> *</span> : null}
      </label>
      {children}
      {error ? (
        <div className="text-xs font-semibold text-nw-urgent-text" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="text-xs text-nw-text-3">{hint}</div>
      ) : null}
    </div>
  );
}

const controlCls =
  'h-9 w-full min-w-0 rounded-md bg-nw-field px-2.5 text-sm text-nw-text ring-1 ring-inset ring-nw-border-strong focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-nw-accent disabled:bg-nw-subtle disabled:text-nw-text-2';

export function NSelect({ value, onChange, children, id, ariaLabel, className, disabled }: { value: string; onChange: (v: string) => void; children: ReactNode; id?: string; ariaLabel?: string; className?: string; disabled?: boolean }) {
  return (
    <select id={id} aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(controlCls, 'pr-7', className)}>
      {children}
    </select>
  );
}

export function NInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(controlCls, props.className)} />;
}

export function NTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(controlCls, 'h-auto min-h-[64px] py-2', props.className)} />;
}

/** Segmented control; clicking the active option of a five-state answer clears it (SPEC §7.1). */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  clearable,
  size = 'md',
}: {
  value: T | null;
  options: { v: T; label: ReactNode }[];
  onChange: (v: T | null) => void;
  id?: string;
  ariaLabel?: string;
  clearable?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <div id={id} role="radiogroup" aria-label={ariaLabel} className="inline-flex max-w-full flex-wrap gap-0.5 rounded-[9px] bg-nw-segment p-[3px]">
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(on && clearable ? null : o.v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-[7px] px-2.5 font-semibold whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-6 text-xs' : 'h-7 text-sm',
              on ? 'bg-nw-panel text-nw-text shadow-sm' : 'text-nw-text-2 hover:text-nw-text',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const TRI_OPTS = [
  { v: 'yes' as const, label: 'Yes' },
  { v: 'no' as const, label: 'No' },
  { v: 'unknown' as const, label: 'Unknown' },
];
export function TriField({ value, onChange, id, ariaLabel }: { value: R.Tri; onChange: (v: R.Tri) => void; id?: string; ariaLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Seg id={id} ariaLabel={ariaLabel} value={value === 'na' ? null : value} options={TRI_OPTS} clearable onChange={(v) => onChange(v)} />
      {value === null ? <span className="text-xs text-nw-text-3">Not reported yet</span> : null}
    </div>
  );
}

export function DueText({ iso, tz }: { iso?: string; tz?: string }) {
  if (!iso) return null;
  const d = R.dueLabel(iso, tz ?? R.EASTERN, nowMs());
  return <span className={cn('text-xs font-semibold whitespace-nowrap', d.overdue ? 'text-nw-urgent-text' : d.soon ? 'text-nw-warning-text' : 'text-nw-text-3')}>{d.text}</span>;
}

export function Person({ name, size = 'sm' }: { name?: string | null; size?: 'sm' | 'md' }) {
  if (!name) return <span className="text-xs text-nw-text-3">Unassigned</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-nw-text">
      <Avatar name={name} size={size} />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function DeptChip({ dept }: { dept: string }) {
  return <span className="inline-flex h-5 items-center rounded-[5px] bg-nw-subtle px-1.5 text-[11px] font-semibold text-nw-text-2">{dept}</span>;
}

const PROV_LABEL: Record<string, string> = { verified: 'Verified', driver: 'Driver-reported', preliminary: 'Preliminary', unresolved: 'Unresolved', system: 'From linked records' };
export function ProvTag({ p }: { p: string }) {
  return (
    <span className={cn('ml-1 inline-flex h-[18px] items-center rounded-[5px] px-1.5 align-middle text-[11px] font-semibold', p === 'unresolved' ? 'bg-nw-warning-bg text-nw-warning-text' : 'bg-nw-subtle text-nw-text-2')}>
      {PROV_LABEL[p] ?? p}
    </span>
  );
}

export function Restricted({ text = 'Restricted' }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-nw-text-3">
      <Lock className="size-3" aria-hidden />
      {text}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="text-sm font-semibold text-nw-text">{title}</div>
      {children ? <div className="mt-1 text-xs text-nw-text-3">{children}</div> : null}
    </div>
  );
}

export function Loading() {
  return <div className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</div>;
}

export function LoadError({ error }: { error: unknown }) {
  return (
    <div className="rounded-[10px] border border-nw-urgent-border bg-nw-urgent-bg px-4 py-3 text-sm text-nw-urgent-text">
      Could not load: {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
