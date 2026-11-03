import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError, api, loadToken, onUnauthorized, setToken } from '@/api/client';
import { routes, type AuthAccount, type LoginResponse, type MeResponse } from '@/api/contract';
import { registerPushDevice, revokePushDevice } from '@/lib/push';

import { authenticate, biometricEnabled, setBiometricEnabled, type BiometricResult } from './biometric';
import { draftStore } from '@/offline/db';
import { queue } from '@/offline/queue';
import type { QueueScope } from '@/offline/queue-core';

/**
 * Who is signed in, and which shell they see.
 *
 * Driver vs Office: a membership the server marks `kind: driver` (linked to a roster driver) opens
 * the Driver shell; otherwise `driver_app.use` opens it, any other permission the Office shell, and
 * a person with both picks in More. A 401 sends the person to login but
 * keeps their drafts and queue (paused) for when the same membership signs in again; signing out
 * on purpose clears that membership's data from the phone.
 */
export const DRIVER_PERMISSION = 'driver_app.use';

export type Shell = 'driver' | 'office';

export type SessionState =
  | { status: 'booting' }
  /** A stored session waits for Face ID / fingerprint (the person turned it on). */
  | { status: 'locked' }
  | { status: 'signedOut'; reason?: 'expired' | 'signedOut' | 'locked' }
  | { status: 'signedIn'; account: AuthAccount; offline: boolean };

interface SessionApi {
  state: SessionState;
  account: AuthAccount | null;
  shell: Shell;
  canDrive: boolean;
  canOffice: boolean;
  /** `keep: false` keeps the session in memory only: the next start asks for the password. */
  login(identifier: string, password: string, options?: { keep?: boolean }): Promise<AuthAccount>;
  /** Face ID / fingerprint, then the stored session is checked as at a normal start. */
  unlock(prompt: string): Promise<BiometricResult>;
  /** Cancel on the lock: the password form, the stored session kept for another try. */
  skipUnlock(): void;
  logout(): Promise<void>;
  switchCompany(companyId: string): Promise<void>;
  setShell(shell: Shell): Promise<void>;
  refresh(): Promise<void>;
  /** Called after the temporary password is replaced. */
  passwordChanged(): void;
}

const APP_SCOPE = '_app';
const ACCOUNT_KEY = 'account';
const SHELL_KEY = 'shell';

export function scopeOf(account: AuthAccount | null): QueueScope | null {
  return account ? { companyId: account.companyId, membershipId: account.membershipId } : null;
}

export function scopeKey(account: AuthAccount): string {
  return `${account.companyId}:${account.membershipId}`;
}

export function capabilities(account: AuthAccount | null): { canDrive: boolean; canOffice: boolean } {
  if (!account) return { canDrive: false, canOffice: false };
  // The server says which shell a membership opens (0081 `kind`); older servers: permissions.
  if (account.kind === 'driver') return { canDrive: true, canOffice: false };
  const canDrive = account.permissions.includes(DRIVER_PERMISSION);
  const canOffice = account.isOwner || account.permissions.some((p) => p !== DRIVER_PERMISSION);
  return { canDrive, canOffice };
}

export function defaultShell(account: AuthAccount | null, preferred: Shell | null): Shell {
  const { canDrive, canOffice } = capabilities(account);
  if (preferred === 'driver' && canDrive) return 'driver';
  if (preferred === 'office' && canOffice) return 'office';
  // Both: Office until the person picks Driver in More (an owner holds every permission).
  return canDrive && !canOffice ? 'driver' : 'office';
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'booting' });
  const [preferredShell, setPreferredShell] = useState<Shell | null>(null);
  const accountRef = useRef<AuthAccount | null>(null);

  const enter = useCallback(async (account: AuthAccount, offline = false) => {
    accountRef.current = account;
    await draftStore.set(APP_SCOPE, ACCOUNT_KEY, account);
    setPreferredShell(await draftStore.get<Shell>(scopeKey(account), SHELL_KEY));
    await queue.setScope(scopeOf(account));
    setState({ status: 'signedIn', account, offline });
    if (!offline && !account.mustChangePassword) void registerPushDevice();
  }, []);

  /** A stored token is checked with /auth/me; offline, the last account opens the app. */
  const resume = useCallback(async (): Promise<boolean> => {
    try {
      const me = await api.get<MeResponse>(routes.me, { quietUnauthorized: true });
      await enter(me);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'offline') {
        const cached = await draftStore.get<AuthAccount>(APP_SCOPE, ACCOUNT_KEY);
        if (cached) {
          await enter(cached, true);
          return true;
        }
      }
      await setToken(null);
      await setBiometricEnabled(false);
      setState({ status: 'signedOut', reason: 'expired' });
      return false;
    }
  }, [enter]);

  // Boot: drafts and the queue stay reachable offline, and every screen still says it is offline.
  // With Face ID / fingerprint on, nothing is read until the phone confirms its owner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await loadToken();
      if (cancelled) return;
      if (!token) {
        setState({ status: 'signedOut' });
        return;
      }
      if (await biometricEnabled()) {
        if (!cancelled) setState({ status: 'locked' });
        return;
      }
      if (!cancelled) await resume();
    })();
    return () => {
      cancelled = true;
    };
  }, [resume]);

  const unlock = useCallback(
    async (prompt: string) => {
      const token = await loadToken();
      if (!token) {
        setState({ status: 'signedOut' });
        return 'unavailable' as const;
      }
      const result = await authenticate(prompt);
      if (result === 'success') await resume();
      return result;
    },
    [resume],
  );

  const skipUnlock = useCallback(() => setState({ status: 'signedOut', reason: 'locked' }), []);

  // A 401 anywhere: back to login, nothing deleted. The queue stops (scope null) and resumes for
  // the same membership after the next sign-in.
  useEffect(
    () =>
      onUnauthorized(() => {
        if (!accountRef.current) return;
        accountRef.current = null;
        void setToken(null);
        void queue.setScope(null);
        setState({ status: 'signedOut', reason: 'expired' });
      }),
    [],
  );

  const login = useCallback(
    async (identifier: string, password: string, options?: { keep?: boolean }) => {
      const response = await api.post<LoginResponse>(
        routes.login,
        { email: identifier.trim(), password, client: 'mobile' },
        { quietUnauthorized: true },
      );
      const keep = options?.keep !== false;
      await setToken(response.token, { persist: keep });
      // A new sign-in that is not kept on the phone cannot be unlocked by face later.
      if (!keep) await setBiometricEnabled(false);
      await enter(response.account);
      return response.account;
    },
    [enter],
  );

  const logout = useCallback(async () => {
    const account = accountRef.current;
    await revokePushDevice();
    try {
      await api.post(routes.logout, {}, { quietUnauthorized: true });
    } catch {
      // Offline or already expired: the token is still forgotten below.
    }
    accountRef.current = null;
    if (account) {
      const scope = scopeOf(account)!;
      await queue.clearScope(scope);
      await draftStore.clearScope(scopeKey(account));
    }
    await draftStore.remove(APP_SCOPE, ACCOUNT_KEY);
    await queue.setScope(null);
    await setToken(null);
    await setBiometricEnabled(false);
    setState({ status: 'signedOut', reason: 'signedOut' });
  }, []);

  const switchCompany = useCallback(
    async (companyId: string) => {
      const response = await api.post<LoginResponse>(routes.switchCompany, { companyId });
      await setToken(response.token);
      await enter(response.account);
    },
    [enter],
  );

  const refresh = useCallback(async () => {
    const me = await api.get<MeResponse>(routes.me);
    await enter(me);
  }, [enter]);

  const setShell = useCallback(async (shell: Shell) => {
    const account = accountRef.current;
    if (!account) return;
    setPreferredShell(shell);
    await draftStore.set(scopeKey(account), SHELL_KEY, shell);
  }, []);

  const passwordChanged = useCallback(() => {
    const account = accountRef.current;
    if (!account) return;
    const next = { ...account, mustChangePassword: false };
    accountRef.current = next;
    setState({ status: 'signedIn', account: next, offline: false });
    void registerPushDevice();
  }, []);

  const value = useMemo<SessionApi>(() => {
    const account = state.status === 'signedIn' ? state.account : null;
    const caps = capabilities(account);
    return {
      state,
      account,
      shell: defaultShell(account, preferredShell),
      ...caps,
      login,
      unlock,
      skipUnlock,
      logout,
      switchCompany,
      setShell,
      refresh,
      passwordChanged,
    };
  }, [state, preferredShell, login, unlock, skipUnlock, logout, switchCompany, setShell, refresh, passwordChanged]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

export function useAccount(): AuthAccount {
  const { account } = useSession();
  if (!account) throw new Error('Not signed in');
  return account;
}
