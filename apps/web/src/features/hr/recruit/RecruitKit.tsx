import type { ReactNode } from 'react';
import { Briefcase, Building2, Globe, Megaphone, PhoneIncoming, Users } from 'lucide-react';
import { RECRUIT_PROGRESS_LABELS, type RecruitProgress } from '@neway/shared';
import { StatusSymbol, cn } from '@/design-system';

/**
 * Recruiting's own small kit (owner's redesign, 2026-10-08): the progress badge, the metric card,
 * the main panel and the quiet states, all on Porcelain tokens. One component per thing so every
 * screen reads the same.
 */

type SymbolKind = 'neutral' | 'warning' | 'moving' | 'info' | 'done' | 'urgent';

const PROGRESS_LOOK: Record<RecruitProgress, { pill: string; icon: string; symbol: SymbolKind }> = {
  // New lead is red (owner, 2026-10-11, later the same day): an untouched lead needs someone now.
  // The urgent family with its octagon, so the word and the symbol carry it as well as the colour.
  new: { pill: 'bg-nw-urgent-bg text-nw-urgent-text ring-nw-urgent-border', icon: 'text-nw-urgent-icon', symbol: 'urgent' },
  // Called, nobody answered (owner, 2026-10-12): still to reach, the warning family.
  no_answer: { pill: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border', icon: 'text-nw-warning-icon', symbol: 'warning' },
  contacted: { pill: 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent/30', icon: 'text-nw-accent', symbol: 'moving' },
  prequalified: { pill: 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent/30', icon: 'text-nw-accent', symbol: 'done' },
  // Waiting on the driver: the warning family, pale.
  consent_sent: { pill: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border', icon: 'text-nw-warning-icon', symbol: 'warning' },
  consent_received: { pill: 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent/30', icon: 'text-nw-accent', symbol: 'done' },
  // With Safety: the moving family with the info glyph (lavender has no Porcelain token).
  safety_review: { pill: 'bg-nw-moving-bg text-nw-moving-text ring-nw-moving-border', icon: 'text-nw-moving-icon', symbol: 'info' },
  application_sent: { pill: 'bg-nw-warning-bg text-nw-warning-text ring-nw-warning-border', icon: 'text-nw-warning-icon', symbol: 'warning' },
  application_received: { pill: 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent/30', icon: 'text-nw-accent', symbol: 'moving' },
  onboarding: { pill: 'bg-nw-accent-tint text-nw-accent-ink ring-nw-accent/30', icon: 'text-nw-accent', symbol: 'moving' },
  ready_to_hire: { pill: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border', icon: 'text-nw-done-icon', symbol: 'done' },
  hired: { pill: 'bg-nw-done-bg text-nw-done-text ring-nw-done-icon/50', icon: 'text-nw-done-icon', symbol: 'done' },
  closed: { pill: 'bg-nw-subtle text-nw-text-3 ring-nw-border', icon: 'text-nw-text-3', symbol: 'neutral' },
};

/**
 * The progress badge. Every badge is the same size (208×38 on a desktop, the cell's width on a
 * phone) with the word centred, so a column of them reads as one system; the symbol and the word
 * carry the status, never the colour alone.
 */
/**
 * Safety qualified the candidate and the application link has not gone out yet: the step is
 * "Qualified" (owner, 2026-10-11), not "Application sent".
 */
const QUALIFIED_LOOK = { pill: 'bg-nw-done-bg text-nw-done-text ring-nw-done-border', icon: 'text-nw-done-icon', symbol: 'done' as SymbolKind };

export function ProgressBadge({ progress, size = 'md', className, nextStep }: { progress: RecruitProgress; size?: 'md' | 'sm'; className?: string; nextStep?: string }) {
  const qualified = progress === 'application_sent' && nextStep === 'Send application';
  const look = qualified ? QUALIFIED_LOOK : PROGRESS_LOOK[progress];
  return (
    <span
      data-testid="progress-badge"
      data-progress={progress}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[9px] px-3 text-center font-semibold ring-1 ring-inset whitespace-nowrap',
        'transition-colors duration-150 motion-reduce:transition-none',
        size === 'md' ? 'h-8 w-full max-w-[176px] min-w-[132px] text-[12.5px] sm:w-[176px]' : 'h-7 min-w-[120px] px-2.5 text-xs',
        look.pill,
        className,
      )}
    >
      <StatusSymbol family={look.symbol} size={size === 'md' ? 14 : 12} className={look.icon} />
      <span className="truncate">{qualified ? 'Qualified' : RECRUIT_PROGRESS_LABELS[progress]}</span>
    </span>
  );
}

/** One of the three numbers on the home page: bordered, equal size, label above the figure. */
export function MetricCard({
  label,
  value,
  loading,
  error,
  tone,
  hint,
  onClick,
  testId,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  error?: boolean;
  tone?: 'warning';
  hint?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-[13px] font-medium text-nw-text-2">
        {tone === 'warning' ? <StatusSymbol family="warning" size={12} className="text-nw-warning-icon" /> : null}
        {label}
      </span>
      <span className="text-[26px] leading-[30px] font-bold tracking-tight text-nw-text" data-testid={testId ? `${testId}-value` : undefined}>
        {loading ? <span className="text-lg font-medium text-nw-text-3">Loading…</span> : error ? <span className="text-lg font-medium text-nw-text-3">Unavailable</span> : value}
      </span>
      {hint ? <span className="text-xs text-nw-text-3">{hint}</span> : null}
    </>
  );
  const cls =
    'flex min-h-[72px] flex-col justify-between gap-0.5 rounded-xl border border-nw-border-strong bg-nw-panel px-5 py-3 text-left shadow-card';
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(cls, 'cursor-pointer transition-colors duration-150 hover:border-nw-accent hover:bg-nw-hover focus-visible:outline-2 focus-visible:outline-nw-accent motion-reduce:transition-none')}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/** The main panel: radius 16, thin sage-gray border, no shadow. */
export function RecruitPanel({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('rounded-[16px] border border-nw-border bg-nw-panel', className)} {...rest}>
      {children}
    </section>
  );
}

/** A card inside a panel: radius 12. */
export function RecruitCard({ title, action, children, className, testId }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn('rounded-xl border border-nw-border bg-nw-panel', className)} data-testid={testId}>
      {title || action ? (
        <header className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
          {title ? <h2 className="text-sm font-semibold text-nw-text">{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A calm empty, loading or error block for lists and cards. */
export function QuietState({
  title,
  description,
  action,
  tone = 'neutral',
  testId,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
  testId?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-testid={testId} role={tone === 'error' ? 'alert' : undefined}>
      <StatusSymbol family={tone === 'error' ? 'urgent' : 'neutral'} size={20} className={tone === 'error' ? 'text-nw-urgent-icon' : 'text-nw-text-3'} />
      <p className="text-[15px] font-semibold text-nw-text">{title}</p>
      {description ? <p className="max-w-md text-sm text-nw-text-3">{description}</p> : null}
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  );
}

/** Initials in a soft sage circle (the candidate's, never a photo). */
export function Initials({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const letters =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join('') || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-nw-accent-tint font-semibold text-nw-accent-ink',
        size === 'lg' ? 'size-14 text-lg' : 'size-10 text-[13px]',
      )}
    >
      {letters}
    </span>
  );
}

/**
 * The source's mark before its label. This lucide version has no brand icons, so Instagram and
 * Facebook are drawn here in the same 1.8 outline style, in the text colour (no brand colours:
 * Porcelain has no token for them).
 */
export function SourceIcon({ source, className }: { source: string; className?: string }) {
  const cls = cn('size-4 shrink-0 text-nw-text-2', className);
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: cls };
  switch (source) {
    case 'instagram':
    case 'social':
      return (
        <svg {...common} data-testid="source-icon-instagram">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.3" cy="6.7" r="0.6" fill="currentColor" />
        </svg>
      );
    case 'facebook':
      return (
        <svg {...common} data-testid="source-icon-facebook">
          <path d="M15 3h-2.5A3.5 3.5 0 0 0 9 6.5V10H6.5v3.5H9V21h3.5v-7.5H15l.5-3.5h-3V7a1 1 0 0 1 1-1H15z" />
        </svg>
      );
    case 'website':
      return <Globe aria-hidden className={cls} />;
    case 'referral':
      return <Users aria-hidden className={cls} />;
    case 'job_board':
    case 'agency':
      return <Briefcase aria-hidden className={cls} />;
    case 'phone_call':
      return <PhoneIncoming aria-hidden className={cls} />;
    case 'walk_in':
      return <Building2 aria-hidden className={cls} />;
    default:
      return <Megaphone aria-hidden className={cls} />;
  }
}

/** A person as a round initial and their first name — the assignee control's face. */
export function PersonChip({ name, size = 'sm' }: { name: string | null; size?: 'sm' | 'md' }) {
  const label = name ?? 'Nobody';
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-nw-subtle font-semibold text-nw-text-2 ring-1 ring-nw-border',
          size === 'md' ? 'size-8 text-[13px]' : 'size-7 text-xs',
        )}
      >
        {name ? (name.trim()[0] ?? '?').toUpperCase() : '–'}
      </span>
      <span className="truncate text-sm font-medium text-nw-text">{name ? label.split(/\s+/)[0] : label}</span>
    </span>
  );
}
