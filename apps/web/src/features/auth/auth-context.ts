import { createContext, useContext } from 'react';
import type { AuthAccount } from '@neway/shared';

/**
 * The signed-in identity, as a context.
 *
 * Split from the provider component so this module exports no component: the fast-refresh rule is
 * not pedantry here - a file mixing a provider with the hooks that read it reloads the provider on
 * every hook edit, which remounts the tree and signs the developer out mid-task.
 */
export interface AuthState {
  account: AuthAccount | null;
  /** The first `/auth/me` has not answered yet and there is a token worth asking about. */
  loading: boolean;
  /** The server could not be reached at all, as opposed to answering "nobody". */
  offline: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The signed-in account, or null. For components that only need the identity. */
export function useAccount(): AuthAccount | null {
  return useAuth().account;
}
