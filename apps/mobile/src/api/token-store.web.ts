/**
 * The web build (used for development and screenshots) has no keychain. The token is kept in
 * sessionStorage, so it dies with the tab, and in memory when storage is blocked.
 */
const KEY = 'neway.session.token';
let memory: string | null = null;

export async function readToken(): Promise<string | null> {
  try {
    return globalThis.sessionStorage?.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export async function writeToken(token: string | null): Promise<void> {
  memory = token;
  try {
    if (token) globalThis.sessionStorage?.setItem(KEY, token);
    else globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    // memory only
  }
}
