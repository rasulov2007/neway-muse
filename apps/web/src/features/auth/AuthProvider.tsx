import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, type ReactNode } from 'react';
import type { AuthAccount } from '@neway/shared';
import { adoptSignedInAccount } from '@/demo/identity';
import { PROFILE_REQUIRED_EVENT, apiGet, apiPost } from '@/lib/api-client';
import { clearSession, currentAccount, sessionToken } from '@/lib/session';
import { syncAppearance } from './appearance';
import { AuthContext, type AuthState } from './auth-context';

/**
 * Who is signed in.
 *
 * The server is asked, once, through `GET /auth/me`; the copy in storage is only a first paint so
 * the header does not flicker. That ordering is the point - identity and permissions come from the
 * session row, not from something the browser kept and could edit.
 *
 * `account === null` means nobody, and the application does not render: see `AuthGate`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const hasToken = sessionToken() !== null;

  const query = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiGet<AuthAccount & { signedIn: boolean }>('/auth/me'),
    // A 401 is an answer ("nobody"), not a failure to retry.
    retry: false,
    staleTime: 60_000,
    // With no token there is nothing to ask about; skip the round trip and show the login screen.
    enabled: hasToken,
    /*
     * The stored copy is a FIRST PAINT, never the answer.
     *
     * It was `initialData`, which TanStack treats as a real cache entry - so with a 60 s
     * staleTime, `/auth/me` was not called at all on boot and the gate decided from whatever the
     * browser had kept. That copy is written once at sign-in and never updated, so after somebody
     * replaced their temporary password it still said `mustChangePassword: true` and the change
     * screen would not let go. `placeholderData` shows the same thing without ever being mistaken
     * for the truth: the request still goes out, and the server's answer replaces it.
     */
    placeholderData: hasToken
      ? (() => {
          const stored = currentAccount();
          return stored ? { ...stored, signedIn: true } : undefined;
        })()
      : undefined,
  });

  const signOut = useCallback(async () => {
    try {
      await apiPost('/auth/logout', {});
    } catch {
      // The session is being abandoned either way.
    }
    clearSession();
    queryClient.clear();
    window.location.href = '/login';
  }, [queryClient]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
    [queryClient],
  );

  // The server holds this session on Complete your profile: re-read who is signed in so the gate
  // comes up, whatever page asked first.
  useEffect(() => {
    const onRequired = () => void refresh();
    window.addEventListener(PROFILE_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(PROFILE_REQUIRED_EVENT, onRequired);
  }, [refresh]);

  // The client-side dataset attributes its own writes; in an empty workspace that is this person.
  useEffect(() => {
    if (query.data && !query.isError) adoptSignedInAccount(query.data);
  }, [query.data, query.isError]);

  // Light / Dark / System follows the profile: the server's answer wins, a choice that never
  // reached it is saved now. The placeholder is skipped - it is a first paint, not the truth.
  const userId = query.data?.userId;
  const appearance = query.data?.appearance;
  useEffect(() => {
    if (!userId || query.isError || query.isPlaceholderData) return;
    syncAppearance(userId, appearance);
  }, [userId, appearance, query.isError, query.isPlaceholderData]);

  const unreachable = query.isError && (query.error as { status?: number } | null)?.status === 0;

  const value: AuthState = {
    account: query.isError ? null : (query.data ?? null),
    // `isPending` covers the placeholder case that `isLoading` hides: while the stored copy is on
    // screen the answer is not in yet, and the gate must not decide from it.
    loading: hasToken && query.isPending,
    offline: unreachable,
    signOut,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
