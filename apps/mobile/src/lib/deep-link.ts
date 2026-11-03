import type { Href } from 'expo-router';

import type { DeepLink } from '@neway/shared/mobile/notifications';

export type ShellName = 'driver' | 'office';

/**
 * Where a notification, a push or an attention line opens. The screen it lands on reads the record
 * with the current session, so the server checks access again (a 403 shows "No access", a 404
 * "Not found") — a link never carries the record itself.
 */
export function hrefFor(shell: ShellName, target: Pick<DeepLink, 'type' | 'id' | 'parentId'> | { type: string; id: string; parentId?: string | null } | null | undefined): Href | null {
  if (!target || !target.id) return null;
  const { type, id, parentId } = target;
  if (shell === 'driver') {
    switch (type) {
      case 'load':
        return `/driver/load/${id}`;
      case 'load_document':
        return parentId ? `/driver/load/${parentId}` : null;
      case 'pti':
        return '/driver/pti';
      case 'breakdown':
      case 'reimbursement':
      case 'care':
      case 'safety_report':
      case 'referral':
        return `/driver/request/${type}/${id}`;
      case 'settlement':
        return { pathname: '/driver/money', params: { statement: id } };
      case 'vacation':
        return '/driver/vacation';
      case 'driver_document':
        return '/driver/documents';
      case 'conversation':
        return `/driver/conversation/${id}`;
      default:
        return '/driver/notifications';
    }
  }
  switch (type) {
    case 'load':
      return `/office/load/${id}`;
    case 'load_document':
      return parentId ? `/office/load/${parentId}` : null;
    case 'pti':
      return { pathname: '/office/safety', params: { inspection: id } };
    case 'breakdown':
      return `/office/breakdown/${id}`;
    case 'reimbursement':
      return { pathname: '/office/accounting', params: { tab: 'reimbursements' } };
    case 'settlement':
      return { pathname: '/office/accounting', params: { tab: 'settlements' } };
    case 'vacation':
      return { pathname: '/office/approvals', params: { kind: 'vacations' } };
    case 'driver_document':
    case 'safety_report':
    case 'accident':
    case 'driver':
      return '/office/safety';
    case 'referral':
    case 'lead':
      return '/office/recruiting';
    case 'conversation':
      return `/office/conversation/${id}`;
    default:
      return '/office/notifications';
  }
}
