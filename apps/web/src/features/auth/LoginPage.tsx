import { useState } from 'react';
import { destinationAfterLogin } from './login-destination';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { LoginResponse } from '@neway/shared';
import { Button, FormField, Input } from '@/design-system';
import { ApiError, apiPost } from '@/lib/api-client';
import { saveSession } from '@/lib/session';

/**
 * Sign in.
 *
 * The form asks for an email address and a password and nothing else. A wrong address and a wrong
 * password give the same answer, because a login screen that distinguishes them tells a stranger
 * which addresses have accounts.
 *
 * Every refusal the API can give is spelled out rather than collapsed into "login failed": an
 * account an administrator disabled, a server that cannot be reached, and a temporary password
 * that has to be replaced are three different problems with three different remedies.
 */

/** Turns the API's refusal into something the person can act on. */
function explain(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return 'The server could not be reached. Check your connection and try again.';
    }
    if (error.status === 401) return 'Invalid email or password.';
    if (error.status === 403) {
      return error.message || 'Your account is disabled. Contact an administrator.';
    }
    if (error.status === 422) return error.message || 'Enter an email address and a password.';
    if (error.status === 404) {
      return 'The server does not have a sign-in endpoint. It is running an older build than this app — redeploy the API.';
    }
    return error.message || 'Sign in could not be completed.';
  }
  return 'Sign in could not be completed.';
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => apiPost<LoginResponse>('/auth/login', { email: email.trim(), password }),
    onSuccess: (result) => {
      saveSession({ token: result.token, account: result.account }, { remember });
      // A full load, so every cached query is fetched again as the person who just signed in. The
      // destination is the page they were opening (a Telegram "Open in TMS" link, 2026-10-07), or
      // the root; `AuthGate` still sends a temporary credential to the change screen.
      window.location.href = destinationAfterLogin();
    },
    onError: (err: unknown) => setError(explain(err)),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-nw-bg px-4 py-10">
      <div className="w-full max-w-96">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            className="flex size-11 items-center justify-center rounded-lg bg-nw-accent text-lg font-black text-nw-on-accent select-none"
            aria-hidden
          >
            N
          </span>
          <h1 className="text-xl font-bold text-nw-text">NeWay</h1>
          <p className="text-sm text-nw-text-2">Transportation management</p>
        </div>

        <div className="rounded-lg border border-nw-border bg-nw-panel p-6">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setNotice(null);
              login.mutate();
            }}
          >
            {/* Not `type="email"`: an account may be a plain name such as `admin`, and the
                browser's own validation would refuse to submit it. */}
            <FormField label="Email or username" required>
              <Input
                type="text"
                inputMode="email"
                autoComplete="username"
                autoFocus
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </FormField>
            <FormField label="Password" required>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </FormField>

            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-nw-text-2">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  className="size-3.5"
                />
                Remember me
              </label>
              <button
                type="button"
                className="rounded-xs text-sm text-nw-accent-ink hover:underline"
                onClick={() =>
                  setNotice(
                    'Password resets are handled by an administrator: ask them to issue a new temporary password from the Users screen.',
                  )
                }
              >
                Forgot password?
              </button>
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2 text-sm text-nw-urgent-text"
              >
                {error}
              </p>
            ) : null}
            {notice ? (
              <p
                className="rounded-md border border-nw-moving-border bg-nw-moving-bg px-3 py-2 text-sm text-nw-moving-text"
              >
                {notice}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={login.isPending}>
              {login.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden /> Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-nw-text-3">
          New here? An administrator creates your account and gives you a temporary password.
        </p>
      </div>
    </div>
  );
}

