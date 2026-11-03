/**
 * Notification preferences.
 *
 * There is no settings service yet (`/admin/settings` is still a placeholder and the API has no
 * notifications module), so preferences are held per browser in `localStorage` — the same
 * mechanism the shell already uses for the sidebar. The shape below is deliberately the shape a
 * server-side `user_notification_preferences` row would have, so moving it behind an endpoint
 * later is a swap of the read/write functions and nothing else.
 *
 * Category toggles are real: an off category is filtered out of the list and out of the tab
 * counts on this page. Delivery channels are stored but only in-app is actually wired — see
 * `DELIVERY_CHANNELS`.
 */
import type { NotificationKind } from '@/demo';

export const PREFERENCES_STORAGE_KEY = 'neway.notifications.preferences';

export type CategoryKey = 'loads' | 'fleet' | 'drivers' | 'finance' | 'documents' | 'system';
export type ChannelKey = 'in_app' | 'email' | 'telegram';

export interface NotificationPreferences {
  categories: Record<CategoryKey, boolean>;
  channels: Record<ChannelKey, boolean>;
}

export interface CategoryDefinition {
  key: CategoryKey;
  label: string;
  description: string;
  /**
   * The event kinds this category covers. Every `NotificationKind` appears in exactly one
   * category, so switching all six off hides everything and no event is silently unreachable.
   */
  kinds: readonly NotificationKind[];
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: 'loads',
    label: 'Loads & dispatch',
    description: 'ETA changes, load status, appointments, dispatch messages',
    kinds: ['load', 'dispatch', 'comment'],
  },
  {
    key: 'fleet',
    label: 'Fleet & maintenance',
    description: 'Unit issues, regeneration, maintenance, repairs',
    kinds: ['fleet', 'maintenance'],
  },
  {
    key: 'drivers',
    label: 'Drivers',
    description: 'Driver status, safety events, settlements',
    kinds: ['driver'],
  },
  {
    key: 'finance',
    label: 'Finance',
    description: 'Invoices, payments, factoring, fuel spend',
    kinds: ['finance'],
  },
  {
    key: 'documents',
    label: 'Documents',
    description: 'Insurance, BOL, permits, expirations',
    kinds: ['document'],
  },
  {
    key: 'system',
    label: 'System',
    description: 'Integrations, platform maintenance, reports',
    kinds: ['system', 'report'],
  },
] as const;

export interface ChannelDefinition {
  key: ChannelKey;
  label: string;
  description: string;
  /**
   * False when no provider is implemented yet. The toggle still records the choice, but the row
   * says so rather than implying that mail is going out. `docs/INTEGRATIONS.md` puts email in
   * phase 3 and Telegram in phase 15; neither `MessagingProvider` exists in `apps/api` today.
   */
  connected: boolean;
  /** In-app delivery is this page, so it cannot be switched off. */
  locked?: boolean;
  note?: string;
}

export const DELIVERY_CHANNELS: readonly ChannelDefinition[] = [
  {
    key: 'in_app',
    label: 'In-app',
    description: 'Show notifications in the bell and on this page',
    connected: true,
    locked: true,
    note: 'Always on — this is where you are reading them.',
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Send a copy to your work email address',
    connected: false,
    note: 'Saved, but nothing is sent until the email provider is connected.',
  },
  {
    key: 'telegram',
    label: 'Telegram',
    description: 'Send a copy to your linked Telegram account',
    connected: false,
    note: 'Saved, but nothing is sent until the Telegram provider is connected.',
  },
] as const;

/** Which category an event kind belongs to. Built once from `CATEGORIES`. */
const KIND_CATEGORY = new Map<NotificationKind, CategoryKey>(
  CATEGORIES.flatMap((category) => category.kinds.map((kind) => [kind, category.key] as const)),
);

export function categoryOfKind(kind: NotificationKind): CategoryKey {
  // Every kind is mapped above; the fallback keeps an unmapped future kind visible, not hidden.
  return KIND_CATEGORY.get(kind) ?? 'system';
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  categories: {
    loads: true,
    fleet: true,
    drivers: true,
    finance: true,
    documents: true,
    system: true,
  },
  channels: { in_app: true, email: true, telegram: false },
};

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads stored preferences, keeping the defaults for anything missing or malformed. Storage can
 * hold a shape written by an older build, so every key is validated rather than trusted.
 */
export function readPreferences(): NotificationPreferences {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!raw) return DEFAULT_PREFERENCES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;

  const stored = parsed as { categories?: unknown; channels?: unknown };
  const categories = { ...DEFAULT_PREFERENCES.categories };
  if (isBooleanRecord(stored.categories)) {
    for (const category of CATEGORIES) {
      const value = stored.categories[category.key];
      if (typeof value === 'boolean') categories[category.key] = value;
    }
  }
  const channels = { ...DEFAULT_PREFERENCES.channels };
  if (isBooleanRecord(stored.channels)) {
    for (const channel of DELIVERY_CHANNELS) {
      const value = stored.channels[channel.key];
      if (typeof value === 'boolean' && !channel.locked) channels[channel.key] = value;
    }
  }
  return { categories, channels };
}

export function writePreferences(preferences: NotificationPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private mode or storage disabled: the choice simply does not survive a reload.
  }
  // Every other reader in this tab (the sidebar and bell counts) follows at once.
  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT, { detail: preferences }));
}

/** Fired in this tab whenever the preferences are written. */
export const PREFERENCES_CHANGED_EVENT = 'neway:notification-preferences';
