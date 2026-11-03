import type { AuthAccount } from '@neway/shared';

/**
 * The signed-in session, browser side.
 *
 * The token is a key to a server-side session row, not the session itself: the server decides
 * whether it is still live, and revoking it there signs this browser out whatever it kept. The
 * account details below are a convenience for drawing the header — every permission decision is
 * made again on the server.
 */

const TOKEN_KEY = 'neway.session.token';
const ACCOUNT_KEY = 'neway.session.account';

export interface StoredSession {
  token: string;
  account: AuthAccount;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionToken(): string | null {
  return read(TOKEN_KEY);
}

export function currentAccount(): AuthAccount | null {
  const raw = read(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthAccount;
  } catch {
    return null;
  }
}

/**
 * Keeps the session for this browser.
 *
 * `remember: false` puts it in sessionStorage instead, so closing the tab ends it - which is what
 * somebody unticking the box on a shared machine is asking for.
 */
export function saveSession(session: StoredSession, options: { remember: boolean }): void {
  try {
    const store = options.remember ? window.localStorage : window.sessionStorage;
    const other = options.remember ? window.sessionStorage : window.localStorage;
    other.removeItem(TOKEN_KEY);
    other.removeItem(ACCOUNT_KEY);
    store.setItem(TOKEN_KEY, session.token);
    store.setItem(ACCOUNT_KEY, JSON.stringify(session.account));
  } catch {
    // A browser that refuses storage still works for this tab; the sign-in will not persist.
  }
}

/**
 * Forgets the cached account while keeping the session token.
 *
 * Used after the account changes underneath the copy - replacing a temporary password is the
 * case that matters, because the stale copy would otherwise keep the change screen shut.
 */
export function forgetStoredAccount(): void {
  try {
    window.localStorage.removeItem(ACCOUNT_KEY);
    window.sessionStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function clearSession(): void {
  try {
    for (const store of [window.localStorage, window.sessionStorage]) {
      store.removeItem(TOKEN_KEY);
      store.removeItem(ACCOUNT_KEY);
    }
  } catch {
    // Nothing to clear.
  }
}
