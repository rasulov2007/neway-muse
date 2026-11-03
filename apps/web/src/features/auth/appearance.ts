import { useSyncExternalStore } from 'react';
import { AppearanceSchema, type Appearance } from '@neway/shared';
import { apiPatch } from '@/lib/api-client';

/**
 * Light / Dark / System, per worker (design/porcelain/SPEC.md §9).
 *
 * The switch itself lives in `index.html` as `window.NewayAppearance`, inlined so the theme is set
 * before the first paint. This module is the typed doorway to it: the profile is the source of
 * truth, the browser copy is only what keeps a choice through a failed save and across tabs.
 */
interface NewayAppearanceApi {
  get(): Appearance;
  theme(): 'light' | 'dark' | null;
  set(pref: Appearance, userId: string | null): boolean;
  sync(userId: string, serverPref: Appearance | null | undefined): Appearance | null;
  markSaved(userId: string): void;
}

declare global {
  interface Window {
    NewayAppearance?: NewayAppearanceApi;
  }
}

const EVENT = 'neway:appearance';

function bridge(): NewayAppearanceApi | undefined {
  return typeof window === 'undefined' ? undefined : window.NewayAppearance;
}

/** The saved choice on screen now: `system` until the switch has said otherwise. */
export function currentAppearance(): Appearance {
  const value = bridge()?.get();
  return AppearanceSchema.catch('system').parse(value);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

/** Re-renders when the theme changes, including from another tab or the computer's own setting. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, currentAppearance, () => 'system');
}

/** Saves the choice on the worker's profile; the server confirms the value it kept. */
export async function saveAppearance(userId: string, appearance: Appearance): Promise<void> {
  await apiPatch<{ appearance: Appearance }>('/auth/me/preferences', { appearance });
  bridge()?.markSaved(userId);
}

/**
 * The worker picked a value. It shows at once; the save follows, and a save that fails leaves the
 * choice marked pending so the next profile load retries it.
 */
export function chooseAppearance(userId: string, appearance: Appearance): Promise<void> {
  bridge()?.set(appearance, userId);
  return saveAppearance(userId, appearance).catch(() => undefined);
}

/**
 * The profile loaded: the switch applies the profile's value, or asks for a choice that never
 * reached the server to be saved now.
 */
export function syncAppearance(userId: string, serverPref: Appearance | null | undefined): void {
  const toSave = bridge()?.sync(userId, serverPref);
  if (toSave) void saveAppearance(userId, toSave).catch(() => undefined);
}
