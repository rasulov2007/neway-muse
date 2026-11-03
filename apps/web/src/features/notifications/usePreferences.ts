import { useCallback, useEffect, useState } from 'react';
import type { NotificationKind } from '@/demo';
import {
  PREFERENCES_CHANGED_EVENT,
  PREFERENCES_STORAGE_KEY,
  categoryOfKind,
  readPreferences,
  writePreferences,
  type CategoryKey,
  type ChannelKey,
  type NotificationPreferences,
} from './preferences';

export interface PreferencesState {
  preferences: NotificationPreferences;
  setCategory: (key: CategoryKey, enabled: boolean) => void;
  setChannel: (key: ChannelKey, enabled: boolean) => void;
  /** Turns off the category that owns this event kind — the row menu's "Mute" action. */
  muteKind: (kind: NotificationKind) => CategoryKey;
  /** False when the category owning this kind is switched off. */
  isKindEnabled: (kind: NotificationKind) => boolean;
}

/**
 * Notification preferences held in `localStorage` (see `./preferences`). Read lazily on mount so
 * a server render or a storage-less browser still gets the defaults.
 */
export function useNotificationPreferences(): PreferencesState {
  const [preferences, setPreferences] = useState<NotificationPreferences>(readPreferences);

  // Another reader changed them (this tab's page, or another tab): pick the new choice up, so a
  // muted category leaves the sidebar and bell counts too (owner's bug report, 2026-10-06).
  useEffect(() => {
    const sync = () => setPreferences(readPreferences());
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFERENCES_STORAGE_KEY) sync();
    };
    window.addEventListener(PREFERENCES_CHANGED_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setCategory = useCallback((key: CategoryKey, enabled: boolean) => {
    setPreferences((current) => {
      const next = { ...current, categories: { ...current.categories, [key]: enabled } };
      writePreferences(next);
      return next;
    });
  }, []);

  const setChannel = useCallback((key: ChannelKey, enabled: boolean) => {
    setPreferences((current) => {
      const next = { ...current, channels: { ...current.channels, [key]: enabled } };
      writePreferences(next);
      return next;
    });
  }, []);

  const muteKind = useCallback(
    (kind: NotificationKind) => {
      const category = categoryOfKind(kind);
      setCategory(category, false);
      return category;
    },
    [setCategory],
  );

  const isKindEnabled = useCallback(
    (kind: NotificationKind) => preferences.categories[categoryOfKind(kind)],
    [preferences],
  );

  return { preferences, setCategory, setChannel, muteKind, isKindEnabled };
}
