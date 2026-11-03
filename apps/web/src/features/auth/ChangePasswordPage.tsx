import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@neway/shared';
import { Button, FormField, Input } from '@/design-system';
import { ApiError, apiPost } from '@/lib/api-client';
import { forgetStoredAccount } from '@/lib/session';
import { useAuth } from './auth-context';

/**
 * Replacing a temporary password.
 *
 * Reached only by somebody who already proved the temporary password — they are holding a session
 * — so it does not ask for it again; asking would invite them to paste it into the new-password
 * field. Everything else in the product is refused by the API until this succeeds, so this is a
 * gate and not a reminder.
 */
export function ChangePasswordPage() {
  const { account, refresh, signOut } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const ready = newPassword.length >= PASSWORD_MIN_LENGTH && newPassword === confirmPassword;

  const change = useMutation({
    mutationFn: () => apiPost('/auth/password/temporary', { newPassword, confirmPassword }),
    onSuccess: async () => {
      // The stored account still says the password is temporary; it is written at sign-in and
      // never updated, so it has to go or it will hold the gate shut on the next boot.
      forgetStoredAccount();
      await refresh();
      window.location.href = '/';
    },
    onError: (err: unknown) =>
      setError(
        err instanceof ApiError
          ? err.message || 'The password could not be changed.'
          : 'The password could not be changed.',
      ),
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
          <h1 className="text-xl font-bold text-nw-text">Choose a password</h1>
          <p className="text-sm text-nw-text-2">
            Your temporary password must be changed before continuing.
          </p>
        </div>

        <div className="rounded-lg border border-nw-border bg-nw-panel p-6">
          {account ? (
            <p className="mb-4 text-sm text-nw-text-2">
              Signed in as <span className="font-medium text-nw-text">{account.email}</span>
            </p>
          ) : null}

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              if (ready) change.mutate();
            }}
          >
            <FormField
              label="New password"
              required
              description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              error={tooShort ? `Use at least ${PASSWORD_MIN_LENGTH} characters` : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </FormField>
            <FormField
              label="Confirm new password"
              required
              error={mismatch ? 'The two passwords do not match' : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </FormField>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2 text-sm text-nw-urgent-text"
              >
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={!ready || change.isPending}>
              {change.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden /> Saving…
                </>
              ) : (
                'Set password and continue'
              )}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
