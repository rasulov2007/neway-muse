import { apiGet, apiPost } from '@/lib/api-client';
import { sessionToken } from '@/lib/session';
import type { NotificationQuery } from './api';
import type { Notification } from './types';

/**
 * Notifications the server writes for a person (owner, 2026-10-07: "New DOT application from …
 * — needs review"), shown in the same bell and page as the workspace's own. Only the hiring kind
 * is taken for now: other server notifications (the workflow engine's) were never shown here and
 * stay out until someone decides they should be. A refused or failed read is an empty list — the
 * bell must never break because of it.
 */
interface ServerNotification {
  id: string;
  severity: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  source: string;
  readAt: string | null;
  createdAt: string;
}

const PATH = '/admin/notifications';
/** Server ids share the workspace's `ntf_` prefix, so they are told apart on the way in. */
const PREFIX = 'srv:';

function toNotification(n: ServerNotification): Notification {
  const severity = (['critical', 'warning', 'info', 'success'] as const).find((s) => s === n.severity) ?? 'info';
  return {
    id: `${PREFIX}${n.id}`,
    kind: 'driver',
    severity,
    title: n.title,
    body: n.body ?? '',
    department: n.entityType === 'hiring_safety' ? 'safety' : 'hr',
    entity: n.entityId
      ? n.entityType === 'hiring_safety'
        ? { type: 'hiring_safety', id: n.entityId, label: 'Hiring decision' }
        : { type: 'applicant', id: n.entityId, label: 'Candidate' }
      : null,
    source: 'system',
    actionRequired: false,
    at: n.createdAt,
    readAt: n.readAt,
  } as Notification;
}

export function isServerNotification(id: string): boolean {
  return id.startsWith(PREFIX);
}

export async function serverNotifications(query: NotificationQuery = {}): Promise<Notification[]> {
  if (!sessionToken()) return [];
  try {
    const rows = await apiGet<ServerNotification[]>(PATH, undefined, { background: true });
    return rows
      .filter((n) => n.entityType === 'applicant' || n.entityType === 'hiring_safety')
      .map(toNotification)
      .filter(
        (n) =>
          (!query.unreadOnly || n.readAt === null) &&
          (!query.severity || n.severity === query.severity) &&
          (!query.department || n.department === query.department),
      );
  } catch {
    return [];
  }
}

export async function markServerNotificationRead(id: string): Promise<void> {
  try {
    await apiPost(`${PATH}/${encodeURIComponent(id.slice(PREFIX.length))}/read`, {}, { background: true });
  } catch {
    /* the next read shows it unread again; nothing else to do */
  }
}

export async function markAllServerNotificationsRead(): Promise<void> {
  if (!sessionToken()) return;
  try {
    await apiPost(`${PATH}/read-all`, {}, { background: true });
  } catch {
    /* as above */
  }
}
