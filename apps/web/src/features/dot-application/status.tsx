import type { ReactNode } from 'react';
import { DOT_APP_STATUS_LABELS, type DotAppLinkView, type DotAppStatus } from '@neway/shared';
import { Badge, StatusSymbol, type BadgeTone, type StatusSymbolFamily } from '@/design-system';

/**
 * Status = symbol + word + colour (CLAUDE.md). The application's journey on Porcelain families:
 * the driver working on it is moving, Safety holding it is info, a question back to the driver is
 * a warning, a decision for is done and a rejection is urgent.
 */
export type DotAppFamily = 'moving' | 'info' | 'warning' | 'done' | 'urgent' | 'neutral';

export const DOT_APP_STATUS_FAMILY: Readonly<Record<DotAppStatus, DotAppFamily>> = {
  sent: 'moving',
  opened: 'moving',
  in_progress: 'moving',
  submitted: 'info',
  under_review: 'info',
  changes_requested: 'warning',
  approved: 'done',
  hired: 'done',
  rejected: 'urgent',
};

/** The journey as Recruiting reads it, in order (Rejected is off the line). */
export const DOT_APP_JOURNEY: readonly DotAppStatus[] = ['sent', 'opened', 'in_progress', 'submitted', 'under_review', 'changes_requested', 'approved', 'hired'];

export function dotAppStatusFamily(status: DotAppStatus): DotAppFamily {
  return DOT_APP_STATUS_FAMILY[status] ?? 'neutral';
}

/** Family → Badge tone and the symbol drawn before the word. "info" sits on the neutral colours. */
const LOOK: Record<DotAppFamily, { tone: BadgeTone; symbol: StatusSymbolFamily; icon: string }> = {
  moving: { tone: 'info', symbol: 'moving', icon: 'text-nw-moving-icon' },
  info: { tone: 'neutral', symbol: 'info', icon: 'text-nw-neutral-icon' },
  warning: { tone: 'warning', symbol: 'warning', icon: 'text-nw-warning-icon' },
  done: { tone: 'success', symbol: 'done', icon: 'text-nw-done-icon' },
  urgent: { tone: 'danger', symbol: 'urgent', icon: 'text-nw-urgent-icon' },
  neutral: { tone: 'neutral', symbol: 'neutral', icon: 'text-nw-neutral-icon' },
};

export function FamilyBadge({ family, children, testId, size = 'md' }: { family: DotAppFamily; children: ReactNode; testId?: string; size?: 'sm' | 'md' }) {
  const look = LOOK[family];
  return (
    <Badge tone={look.tone} size={size} icon={<StatusSymbol family={look.symbol} size={13} className={look.icon} />} data-testid={testId} data-family={family}>
      {children}
    </Badge>
  );
}

export function DotAppStatusBadge({ status, testId }: { status: DotAppStatus; testId?: string }) {
  return (
    <FamilyBadge family={dotAppStatusFamily(status)} testId={testId ?? 'dot-app-status'}>
      {DOT_APP_STATUS_LABELS[status] ?? status}
    </FamilyBadge>
  );
}

const LINK_LOOK: Record<DotAppLinkView['state'], { family: DotAppFamily; label: string }> = {
  live: { family: 'moving', label: 'Link live' },
  expired: { family: 'neutral', label: 'Link expired' },
  revoked: { family: 'urgent', label: 'Link revoked' },
  paused: { family: 'warning', label: 'Link paused' },
};

export function LinkStateBadge({ state }: { state: DotAppLinkView['state'] }) {
  const look = LINK_LOOK[state];
  return (
    <FamilyBadge family={look.family} testId="dot-app-link-state">
      {look.label}
    </FamilyBadge>
  );
}

/** The link email's delivery, as Resend reported it. A bounce is said plainly. */
export function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  if (status === 'bounced') return <FamilyBadge family="urgent" testId="dot-app-email-bounced">Email bounced — check address</FamilyBadge>;
  if (status === 'complained') return <FamilyBadge family="urgent">Marked as spam</FamilyBadge>;
  if (status === 'failed') return <FamilyBadge family="urgent">Email failed</FamilyBadge>;
  if (status === 'delivered') return <FamilyBadge family="done">Email delivered</FamilyBadge>;
  if (status === 'sent' || status === 'queued') return <FamilyBadge family="moving">Email sent</FamilyBadge>;
  return <FamilyBadge family="neutral">Email {status}</FamilyBadge>;
}

/** "drv_2118" → "D-2118" (the reserved Fleet driver number). */
export function driverNumber(driverId: string | null | undefined): string {
  if (!driverId) return '—';
  return `D-${driverId.replace(/^drv_/, '')}`;
}
