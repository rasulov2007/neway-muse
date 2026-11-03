import type { DotLinkStatus } from '@neway/shared';
import { formatDateTime } from '@/lib/format';

/** What the driver has done with the link, in one line, newest step last. Times are Eastern. */
export function dotLinkProgress(link: DotLinkStatus): string {
  if (link.state === 'revoked') {
    return `Driver link turned off ${formatDateTime(link.revokedAt ?? link.createdAt)}${link.revokedBy ? ` by ${link.revokedBy}` : ''}`;
  }
  const parts = [`Sent ${formatDateTime(link.createdAt)} by ${link.createdByName}`];
  parts.push(link.firstOpenedAt ? `opened ${formatDateTime(link.firstOpenedAt)}` : 'not opened yet');
  if (link.lastSavedAt) parts.push(`last saved ${formatDateTime(link.lastSavedAt)}`);
  if (link.applicationStatus === 'driver_submitted') {
    parts.push(`Submitted by the driver ${formatDateTime(link.certifiedAt ?? link.submittedAt ?? link.createdAt)} — needs review`);
  } else if (link.applicationStatus === 'submitted' && link.acceptedAt) {
    parts.push(`Accepted by ${link.acceptedBy ?? 'a recruiter'} ${formatDateTime(link.acceptedAt)}`);
  } else if (link.applicationStatus === 'draft' && link.returnedAt) {
    parts.push(`Returned ${formatDateTime(link.returnedAt)}${link.returnedBy ? ` by ${link.returnedBy}` : ''}`);
  } else if (link.submittedAt) {
    parts.push(`submitted ${formatDateTime(link.submittedAt)}`);
  }
  if (link.cdlUploadedAt) parts.push(`CDL uploaded ${formatDateTime(link.cdlUploadedAt)}`);
  if (link.state === 'expired') parts.push(`link expired ${formatDateTime(link.expiresAt)}`);
  return parts.join(' · ');
}

/** The link is still in use: the driver may yet save, certify or upload. */
export function dotLinkActive(link: DotLinkStatus | null | undefined): boolean {
  return Boolean(link && link.state === 'live' && link.applicationStatus !== 'submitted');
}
