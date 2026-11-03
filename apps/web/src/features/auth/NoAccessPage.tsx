import type { AuthAccount } from '@neway/shared';
import { ShieldOff } from 'lucide-react';
import { Button } from '@/design-system';
import { useAuth } from './auth-context';

/**
 * Signed in, but the account carries no role.
 *
 * Every permission in the product comes from a role, so this person would be refused by every
 * screen they opened: an empty dashboard, empty lists, and nothing saying why. That reads as "the
 * system will not let me in". This says what is true, and what has to happen next.
 */
export function NoAccessPage({ account }: { account: AuthAccount }) {
  const { signOut } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-nw-bg px-4">
      <div className="w-full max-w-[28rem] rounded-lg border border-nw-border bg-nw-panel p-6">
        <span
          aria-hidden
          className="flex size-10 items-center justify-center rounded-lg bg-nw-warning-bg text-nw-warning-icon [&_svg]:size-5"
        >
          <ShieldOff />
        </span>
        <h1 className="mt-3 text-xl font-bold text-nw-text">Your account has no access yet</h1>
        <p className="mt-2 text-sm text-nw-text-2">
          You are signed in as {account.email}, but no role has been assigned to this account. A
          role is what opens the screens you need, so until an administrator gives you one there is
          nothing here for you to use.
        </p>
        <p className="mt-2 text-sm text-nw-text-2">
          Ask whoever set up your account to open <strong>Users and access</strong> and give you a
          role. Nothing else is wrong: your sign-in and your password are fine.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Check again
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
