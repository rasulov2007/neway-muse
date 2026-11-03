import { z } from 'zod';

/**
 * Devices, notifications and push (docs/mobile/API.md).
 *
 * A notification is always a `notifications` row addressed to one user first; the push is a copy
 * of its title with a deep link, sent afterwards to that user's registered devices. A push never
 * carries an amount, a document's content or anything else sensitive: the app fetches the record
 * with the current session when the person taps it, and the permissions are checked again then.
 */

export const MOBILE_PLATFORMS = ['ios', 'android'] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

export const RegisterDeviceSchema = z.object({
  /** `ExponentPushToken[…]` from expo-notifications. */
  expoToken: z.string().trim().min(10).max(300),
  platform: z.enum(MOBILE_PLATFORMS),
  appVersion: z.string().trim().max(40).nullable().optional(),
});
export type RegisterDeviceRequest = z.input<typeof RegisterDeviceSchema>;

export interface MobileDevice {
  id: string;
  platform: MobilePlatform;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/** What a tap opens. `type` names the record; the app fetches it by `id` with the session. */
export const DEEP_LINK_TYPES = [
  'load',
  'load_document',
  'pti',
  'notification',
  // M3
  'breakdown',
  'reimbursement',
  'settlement',
  'care',
  'referral',
  'vacation',
  'driver_document',
  'safety_report',
  // M4
  'conversation',
] as const;
export type DeepLinkType = (typeof DEEP_LINK_TYPES)[number];

export interface DeepLink {
  type: DeepLinkType;
  id: string;
  /** For a load document: the load it sits on. */
  parentId?: string | null;
}

export interface MobileNotification {
  id: string;
  severity: string;
  title: string;
  body: string | null;
  target: DeepLink | null;
  readAt: string | null;
  createdAt: string;
  /** M4: `action` (warning / critical: someone has to do something) or `update` (info). */
  group?: MobileNotificationGroup;
}

export type MobileNotificationGroup = 'action' | 'update';

/** Action required vs Updates (office sheet 24): by severity, the same rule on every screen. */
export function notificationGroupOf(severity: string | null | undefined): MobileNotificationGroup {
  return severity === 'warning' || severity === 'critical' ? 'action' : 'update';
}

export interface MobileNotificationsResponse {
  notifications: MobileNotification[];
  unread: number;
  /** M4: unread counts per group. */
  unreadByGroup?: Record<MobileNotificationGroup, number>;
}

/**
 * The Expo push message the server sends. `data` is the deep link and nothing else; title and
 * body are generic sentences ("A document on L-1042 needs a correction").
 */
export interface MobilePushPayload {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  data: { type: DeepLinkType; id: string; parentId?: string | null; notificationId: string };
}
