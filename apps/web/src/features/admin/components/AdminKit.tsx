import type { ReactNode } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { Alert, Badge, Card, ErrorState, Skeleton, StatusSymbol, cn, type BadgeTone } from '@/design-system';
import type { PermissionCheck } from '../useAdmin';

/**
 * The pieces every Administration screen is built from.
 *
 * The two that matter most are at the bottom: `NotBuilt` and `PermissionWall`. Between them they
 * are how this module tells the truth — one says a capability does not exist and why, the other
 * says the server would refuse this and what it would take. Neither hides anything, and neither
 * pretends.
 */

// ------------------------------------------------------------------------------------ kpi strip

export interface AdminStat {
  key: string;
  label: string;
  /** `null` renders an em dash. Never a zero standing in for "not known". */
  value: number | null;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  onSelect?: () => void;
}

export function AdminStatStrip({
  stats,
  activeKey,
  loading,
}: {
  stats: AdminStat[];
  activeKey?: string | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="flex gap-2 overflow-x-auto">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-36 shrink-0" />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {stats.map((stat) => {
        const active = activeKey !== undefined && stat.key === activeKey;
        const Tag = stat.onSelect ? 'button' : 'div';
        return (
          <Tag
            key={stat.key}
            {...(stat.onSelect
              ? { type: 'button' as const, onClick: stat.onSelect, 'aria-pressed': active }
              : {})}
            className={cn(
              'flex min-w-32 shrink-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left',
              'transition-colors duration-(--duration-base) ease-(--ease-standard)',
              stat.onSelect &&
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              active
                ? 'border-primary-border bg-primary-soft'
                : cn('border-line bg-surface', stat.onSelect && 'hover:bg-surface-hover'),
            )}
          >
            <span className="text-xs font-medium text-muted">{stat.label}</span>
            <span
              className={cn(
                'text-lg font-semibold tabular-nums',
                stat.value === null && 'text-faint',
                stat.tone === 'success' && 'text-success-text',
                stat.tone === 'warning' && 'text-warning-text',
                stat.tone === 'danger' && 'text-danger-text',
                (!stat.tone || stat.tone === 'default') && stat.value !== null && 'text-ink',
              )}
              title={stat.value === null ? 'Not available' : undefined}
            >
              {stat.value === null ? '—' : stat.value.toLocaleString()}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------------------- badges

const ACCOUNT_TONES: Record<string, BadgeTone> = {
  active: 'success',
  invited: 'info',
  suspended: 'warning',
  disabled: 'neutral',
};

const ACCOUNT_FAMILY: Record<string, 'done' | 'moving' | 'warning' | 'neutral'> = {
  active: 'done',
  invited: 'moving',
  suspended: 'warning',
  disabled: 'neutral',
};

/** Symbol + word + colour, never colour alone. */
export function AccountStatusBadge({ status }: { status: string }) {
  const word = status.replace(/_/g, ' ');
  return (
    <Badge tone={ACCOUNT_TONES[status] ?? 'neutral'} variant="soft" size="sm">
      <StatusSymbol family={ACCOUNT_FAMILY[status] ?? 'neutral'} size={11} />
      {word.charAt(0).toUpperCase() + word.slice(1)}
    </Badge>
  );
}

/** Connected is earned by the provider answering; a stored key is only ever blue. */
const INTEGRATION_TONES: Record<string, BadgeTone> = {
  not_configured: 'neutral',
  credentials_stored: 'info',
  connected: 'success',
  disabled: 'neutral',
  error: 'danger',
};

export function IntegrationStatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge tone={INTEGRATION_TONES[status] ?? 'neutral'} variant="soft" size="sm" dot>
      {label}
    </Badge>
  );
}

const RUN_TONES: Record<string, BadgeTone> = {
  matched: 'success',
  succeeded: 'success',
  skipped: 'warning',
  failed: 'danger',
};

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={RUN_TONES[status] ?? 'neutral'} variant="soft" size="sm">
      {status}
    </Badge>
  );
}

const WORKFLOW_TONES: Record<string, BadgeTone> = {
  active: 'success',
  draft: 'neutral',
  paused: 'warning',
  disabled: 'neutral',
};

export function WorkflowStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={WORKFLOW_TONES[status] ?? 'neutral'} variant="soft" size="sm">
      {status}
    </Badge>
  );
}

// ------------------------------------------------------------------------------- masked secrets

/**
 * A stored credential, shown as the four characters that identify it.
 *
 * There is no "reveal" affordance and there is nothing to reveal: the server does not return the
 * value, so the browser has never held it. An administrator who cannot identify a key replaces it,
 * which is the right operation anyway when a key might have leaked.
 */
export function CredentialHint({
  hint,
  updatedAt,
}: {
  hint: string | null;
  updatedAt: string | null;
}) {
  if (!hint) return <span className="text-sm text-faint">No credential stored</span>;
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Lock aria-hidden className="size-3.5 text-muted" />
      <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-ink">
        {hint}
      </code>
      {updatedAt ? (
        <span className="text-xs text-muted">
          set {new Date(updatedAt).toLocaleDateString('en-US')}
        </span>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------------------------ honesty notices

/**
 * A capability that does not exist yet, with the reason.
 *
 * Used wherever the alternative would be a control that looks live and is not — an integration
 * that would say "Connected", a workflow action that would claim to have sent an email. Saying so
 * costs a line of text; not saying so costs the administrator's trust in every other line.
 */
export function NotBuilt({ title, reason }: { title: string; reason: string }) {
  return (
    <Alert tone="info" title={title}>
      {reason}
    </Alert>
  );
}

/** Shown in place of a screen the principal's roles do not open. */
export function PermissionWall({ permission, what }: { permission: string; what: string }) {
  return (
    <Card className="p-8">
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
        <ShieldAlert aria-hidden className="size-8 text-muted" />
        <h2 className="text-md font-bold text-ink">You cannot open {what}</h2>
        <p className="text-sm text-muted">
          This needs the <code className="font-mono text-xs">{permission}</code> permission, which
          none of your roles grants. An administrator can add it to one of your roles.
        </p>
      </div>
    </Card>
  );
}

/**
 * Gates a whole screen on a permission.
 *
 * The three outcomes are kept apart deliberately. "Still asking" is a skeleton, "could not ask" is
 * an error with a retry, and only a real refusal shows the wall — telling someone they lack a
 * permission when the truth is that the server was unreachable sends them to an administrator to
 * fix something that is not broken.
 */
export function PermissionGate({
  check,
  permission,
  what,
  children,
}: {
  check: PermissionCheck;
  permission: string;
  what: string;
  children: ReactNode;
}) {
  if (check.status === 'loading') {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (check.status === 'error') {
    return (
      <ErrorState
        title="Could not check your permissions"
        description="The server did not answer, so this page cannot say what you are allowed to do. Nothing has been hidden from you."
        error={check.error}
        onRetry={check.retry}
      />
    );
  }
  if (check.status === 'denied') {
    return <PermissionWall permission={permission} what={what} />;
  }
  return <>{children}</>;
}

/** A labelled value in a detail panel. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

/** An em dash for a value that is genuinely absent, never a zero or a blank. */
export function Absent({ children = '—' }: { children?: ReactNode }) {
  return <span className="text-faint">{children}</span>;
}
