import type { Appearance } from '@neway/shared/auth/index';
import * as SystemUI from 'expo-system-ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useColorScheme, View } from 'react-native';

import { api } from '@/api/client';
import { useSession } from '@/auth/session';
import { useRememberPlace } from '@/lib/keep-place';
import { draftStore } from '@/offline/db';

import { applyScheme, color, currentScheme, type Scheme } from './tokens';

/**
 * Light / Dark / System (Porcelain SPEC §9): each worker's own choice, kept on their profile
 * (`users.appearance`, read from /auth/me, changed with PATCH /auth/me/preferences). The last
 * choice is also kept on the phone so the login screen opens in it before anyone signs in.
 *
 * Changing it swaps the token values (tokens.applyScheme) and redraws the tree below this
 * provider; the session and the upload queue sit above it and are not touched.
 */
interface ThemeApi {
  scheme: Scheme;
  preference: Appearance;
  /** Applies the choice now; saved to the profile when someone is signed in. */
  setPreference(next: Appearance): Promise<void>;
}

const APP_SCOPE = '_app';
const KEY = 'appearance';
const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const { account } = useSession();
  const [preference, setPref] = useState<Appearance>('system');
  const seenAccount = useRef<string | null>(null);
  const rememberPlace = useRememberPlace();

  useEffect(() => {
    draftStore
      .get<Appearance>(APP_SCOPE, KEY)
      .then((saved) => {
        if (saved === 'light' || saved === 'dark' || saved === 'system') setPref(saved);
      })
      .catch(() => undefined);
  }, []);

  // The profile's choice wins once someone signs in (each worker's own).
  useEffect(() => {
    if (!account) {
      seenAccount.current = null;
      return;
    }
    const id = `${account.membershipId}:${account.appearance}`;
    if (seenAccount.current === id) return;
    seenAccount.current = id;
    if (account.appearance && account.appearance !== preference) {
      setPref(account.appearance);
      void draftStore.set(APP_SCOPE, KEY, account.appearance).catch(() => undefined);
    }
  }, [account, preference]);

  const scheme: Scheme = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
  if (currentScheme() !== scheme) applyScheme(scheme);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(color.background).catch(() => undefined);
  }, [scheme]);

  const setPreference = useCallback(
    async (next: Appearance) => {
      // The redraw below remounts the navigators: keep the person on the page they are on.
      rememberPlace();
      setPref(next);
      await draftStore.set(APP_SCOPE, KEY, next).catch(() => undefined);
      // The profile keeps it; the session's copy of the account is left as it was read, so the
      // effect above (which reacts to a different value coming from the server) does not undo it.
      if (account) await api.patch('/auth/me/preferences', { appearance: next });
    },
    [account, rememberPlace],
  );

  const value = useMemo<ThemeApi>(() => ({ scheme, preference, setPreference }), [scheme, preference, setPreference]);
  return (
    <ThemeContext.Provider value={value}>
      <View key={scheme} style={{ flex: 1, backgroundColor: color.background }}>
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeApi {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme outside ThemeProvider');
  return value;
}
