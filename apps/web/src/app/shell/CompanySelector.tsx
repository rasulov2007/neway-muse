import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { AuthAccount, LoginResponse } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { apiPost } from '@/lib/api-client';
import { saveSession } from '@/lib/session';
import { demoMemberships, type Membership } from '@/demo';
import { DropdownMenu, MenuCheckboxItem, MenuLabel, cn, useToast } from '@/design-system';
import { initials } from '@/lib/format';
import { useShellState } from './shellState';

function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm bg-surface-active text-2xs font-semibold text-secondary select-none',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/**
 * The signed-in person's companies (owner, 2026-10-13: one login across companies). Shown only
 * when they belong to more than one; switching starts a session in the other company and reloads,
 * so nothing from the first company's cache can answer for the second.
 */
function RealCompanySelector({ account }: { account: AuthAccount }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const companies = account.companies ?? [];
  if (companies.length < 2) return null;
  const activeName = account.companyName ?? companies.find((c) => c.companyId === account.companyId)?.companyName ?? 'Company';
  async function switchTo(companyId: string) {
    if (companyId === account.companyId || busy) return;
    setBusy(true);
    try {
      const result = await apiPost<LoginResponse>('/auth/switch-company', { companyId });
      let remember = true;
      try {
        remember = window.localStorage.getItem('neway.session.token') !== null;
      } catch {
        remember = true;
      }
      saveSession({ token: result.token, account: result.account }, { remember });
      window.location.assign('/');
    } catch (caught) {
      setBusy(false);
      toast({ tone: 'danger', title: 'Could not switch company', description: caught instanceof Error ? caught.message : 'Try again.' });
    }
  }
  const trigger = (
    <button
      type="button"
      data-testid="company-switcher"
      className={cn(
        'flex h-9 max-w-56 min-w-0 items-center gap-2 rounded-md px-1.5 text-left',
        'transition-colors duration-(--duration-fast) hover:bg-surface-hover data-[state=open]:bg-surface-active',
      )}
    >
      <Monogram name={activeName} />
      <span className="flex min-w-0 flex-col">
        <span className="hidden text-2xs leading-3 font-semibold tracking-eyebrow text-muted uppercase lg:block">Company</span>
        <span className="truncate text-sm leading-4 font-medium text-ink">{busy ? 'Switching…' : activeName}</span>
      </span>
      <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
    </button>
  );
  return (
    <DropdownMenu trigger={trigger} align="start" className="w-64">
      <MenuLabel>Switch company</MenuLabel>
      {companies.map((c) => (
        <MenuCheckboxItem key={c.companyId} checked={c.companyId === account.companyId} onSelect={() => void switchTo(c.companyId)} className="h-auto py-1.5">
          <span className="flex items-center gap-2">
            <Monogram name={c.companyName} />
            <span className="truncate text-sm leading-4 text-ink">{c.companyName}</span>
          </span>
        </MenuCheckboxItem>
      ))}
    </DropdownMenu>
  );
}

/**
 * A signed-in account with one company: its own company's name, no menu. (Owner, 2026-10-27: the
 * demo "Northwind Freight" list showed here for everyone with a single company.)
 */
function OwnCompany({ account }: { account: AuthAccount }) {
  const name = account.companyName ?? account.companies?.find((c) => c.companyId === account.companyId)?.companyName ?? null;
  if (!name) return null;
  return (
    <div data-testid="company-name" className="flex h-9 max-w-56 min-w-0 items-center gap-2 px-1.5">
      <Monogram name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="hidden text-2xs leading-3 font-semibold tracking-eyebrow text-muted uppercase lg:block">Company</span>
        <span className="truncate text-sm leading-4 font-medium text-ink">{name}</span>
      </span>
    </div>
  );
}

/** Tenant switcher in the topbar: the real companies when signed in, the demo list only without a session. */
export function CompanySelector() {
  const account = useAccount();
  if (account && (account.companies?.length ?? 0) > 1) return <RealCompanySelector account={account} />;
  if (account) return <OwnCompany account={account} />;
  return <DemoCompanySelector />;
}

/** Tenant switcher in the topbar. Lists the user's memberships; the active company is prominent. */
function DemoCompanySelector() {
  const { activeCompanyId, setActiveCompanyId } = useShellState();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const active = demoMemberships.find((m) => m.companyId === activeCompanyId) ?? demoMemberships[0];
  if (!active) return null;

  function switchTo(membership: Membership) {
    if (membership.companyId === active?.companyId) return;
    setActiveCompanyId(membership.companyId);
    // Every query is tenant-scoped: reload data for the new company.
    void queryClient.invalidateQueries();
    toast({
      tone: 'success',
      title: `Switched to ${membership.companyName}`,
      description: 'Data now reflects this company.',
    });
  }

  const trigger = (
    <button
      type="button"
      className={cn(
        'flex h-9 max-w-56 min-w-0 items-center gap-2 rounded-md px-1.5 text-left',
        'transition-colors duration-(--duration-fast) hover:bg-surface-hover data-[state=open]:bg-surface-active',
      )}
    >
      <Monogram name={active.companyName} />
      <span className="flex min-w-0 flex-col">
        <span className="hidden text-2xs leading-3 font-semibold tracking-eyebrow text-muted uppercase lg:block">
          Company
        </span>
        <span className="truncate text-sm leading-4 font-medium text-ink">
          {active.companyName}
        </span>
      </span>
      <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
    </button>
  );

  return (
    <DropdownMenu trigger={trigger} align="start" className="w-64">
      <MenuLabel>Switch company</MenuLabel>
      {demoMemberships.map((membership) => {
        const pending = membership.status !== 'active';
        return (
          <MenuCheckboxItem
            key={membership.companyId}
            checked={membership.companyId === active.companyId}
            disabled={pending}
            onSelect={() => switchTo(membership)}
            className="h-auto py-1.5"
          >
            <span className="flex items-center gap-2">
              <Monogram name={membership.companyName} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm leading-4 text-ink">
                  {membership.companyName}
                </span>
                <span className="truncate text-xs leading-4 text-muted">
                  {pending
                    ? 'Invitation pending'
                    : `${membership.companyCity} · ${membership.role}`}
                </span>
              </span>
            </span>
          </MenuCheckboxItem>
        );
      })}
    </DropdownMenu>
  );
}
