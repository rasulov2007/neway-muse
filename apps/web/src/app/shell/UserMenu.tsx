import { ChevronDown, LogOut, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Avatar, DropdownMenu, MenuItem, MenuSeparator, cn } from '@/design-system';
import { useAuth } from '@/features/auth/auth-context';
import { chooseAppearance, useAppearance } from '@/features/auth/appearance';
import type { Appearance } from '@neway/shared';

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: Appearance;
  label: string;
  icon: typeof Sun;
}> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * Light / Dark / System (design/porcelain/SPEC.md §9): a segmented control in the account menu.
 * The choice shows at once and is saved on the worker's profile, so it follows them to every
 * computer; System follows the computer's own setting.
 */
function AppearanceControl({ userId }: { userId: string }) {
  const appearance = useAppearance();
  return (
    <div className="px-2 pt-1.5 pb-2" onKeyDown={(event) => event.stopPropagation()}>
      <div className="mb-1.5 text-xs font-semibold text-secondary" id="appearance-label">
        Appearance
      </div>
      <div
        role="radiogroup"
        aria-labelledby="appearance-label"
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-nw-segment p-0.5"
      >
        {APPEARANCE_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = appearance === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => void chooseAppearance(userId, value)}
              className={cn(
                'flex h-7 items-center justify-center gap-1 rounded-md text-xs font-semibold',
                'transition-colors duration-(--duration-fast)',
                active
                  ? 'bg-surface text-ink shadow-segment'
                  : 'text-secondary hover:bg-surface-hover hover:text-ink',
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-2xs leading-4 text-muted">
        {appearance === 'system'
          ? "Follows your computer's setting."
          : 'Saved to your account on every device.'}
      </p>
    </div>
  );
}

/**
 * Avatar + name opening the account menu.
 *
 * This is always a real signed-in account: nothing renders outside `AuthGate`, so there is no
 * "signed out" state to draw and no development identity to fall back to. Items that had no
 * destination (Profile, Preferences, and a second copy of the keyboard shortcuts the Help menu
 * already shows) are gone rather than toasting "available in a later phase".
 */
export function UserMenu() {
  const { account, signOut } = useAuth();
  const navigate = useNavigate();
  const user = {
    name: account?.name ?? 'Account',
    email: account?.email ?? '',
    title: account?.roles.join(', ') || 'Signed in',
  };

  const trigger = (
    <button
      type="button"
      aria-label={`Account menu (${user.name})`}
      className={cn(
        'flex h-9 max-w-56 items-center gap-2 rounded-md px-1.5 text-left',
        'transition-colors duration-(--duration-fast) hover:bg-nw-hover data-[state=open]:bg-nw-selected',
      )}
    >
      {/* 30px avatar in tint/ink; name 13/700; role 12px text-3 (SPEC §7 "User"). */}
      <Avatar
        name={user.name}
        size="sm"
        aria-hidden
        title={undefined}
        className="size-[30px] bg-nw-accent-tint text-2xs font-bold text-nw-accent-ink"
      />
      <span className="hidden min-w-0 flex-col lg:flex">
        <span className="truncate text-sm leading-4 font-bold text-nw-text">{user.name}</span>
        <span className="truncate text-xs leading-4 text-nw-text-3">{user.title}</span>
      </span>
      <ChevronDown aria-hidden className="hidden size-4 shrink-0 text-nw-text-3 lg:block" />
    </button>
  );

  return (
    <DropdownMenu trigger={trigger} align="end" className="w-60">
      <div className="px-2 pt-1.5 pb-2">
        <div className="truncate text-sm font-medium text-ink">{user.name}</div>
        <div className="truncate text-xs text-muted">{user.email}</div>
      </div>
      <MenuSeparator />
      {account ? (
        <>
          <AppearanceControl userId={account.userId} />
          <MenuSeparator />
        </>
      ) : null}
      {account?.isOwner || account?.permissions.includes('users.view') ? (
        <MenuItem icon={<ShieldCheck />} onSelect={() => void navigate({ href: '/admin/users' })}>
          Users and access
        </MenuItem>
      ) : null}
      <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
        Sign out
      </MenuItem>
    </DropdownMenu>
  );
}
