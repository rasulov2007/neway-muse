import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Copy, Info, Users } from 'lucide-react';
import { useState } from 'react';
import type { RotationMember, RotationSettings } from '@neway/shared';
import { Alert, Button, StatusSymbol, Switch, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '@/lib/format';
import { ApplyLinksModal } from '../ApplyLinksModal';
import { applyUrl } from '../apply-url';
import { useApplyLinks } from '../useHiring';
import { QuietState, RecruitCard } from './RecruitKit';
import { EXTERNAL_APPLICATION_URL } from './recruit-format';
import { recruitApi, useRecruitMutation, useRotationSettings } from './useRecruit';

/**
 * Recruiting settings (owner's redesign, 2026-10-08): who receives new leads, in what order, and
 * the links. The Instagram lead form (/apply/<slug>) is separate from the full driver application,
 * which is personal to each candidate and made from their page.
 */
export function RecruitSettings({ section, onSection }: { section: 'rotation' | 'links'; onSection: (s: 'rotation' | 'links') => void }) {
  const rotation = useRotationSettings();
  return (
    <div className="flex flex-col gap-5" data-testid="recruit-settings">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <nav className="flex items-end gap-6 border-b border-nw-border" role="tablist" aria-label="Recruiting settings">
          {(['rotation', 'links'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={section === s}
              onClick={() => onSection(s)}
              className={cn(
                'relative h-11 text-[15px] font-semibold transition-colors duration-150 motion-reduce:transition-none',
                'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full',
                section === s ? 'text-nw-text after:bg-nw-accent' : 'text-nw-text-3 after:bg-transparent hover:text-nw-text-2',
              )}
            >
              {s === 'rotation' ? 'HR assignment' : 'Links'}
            </button>
          ))}
        </nav>
        <NextCard rotation={rotation.data} loading={rotation.isPending} />
      </div>
      {section === 'rotation' ? <RotationPanel /> : <LinksPanel />}
    </div>
  );
}

function NextCard({ rotation, loading }: { rotation: RotationSettings | undefined; loading: boolean }) {
  return (
    <div className="flex min-w-60 items-center gap-3 rounded-xl border border-nw-border-strong bg-nw-panel px-4 py-3 shadow-card" data-testid="next-assignment">
      <span className="flex size-10 items-center justify-center rounded-full bg-nw-accent-tint text-nw-accent-ink">
        <Users aria-hidden className="size-5" />
      </span>
      <div>
        <p className="text-xs text-nw-text-3">Next assignment</p>
        <p className="text-[17px] font-semibold text-nw-text">{loading ? 'Loading…' : (rotation?.next?.name ?? 'Nobody — leads arrive unassigned')}</p>
      </div>
    </div>
  );
}

function RotationPanel() {
  const { toast } = useToast();
  const rotation = useRotationSettings();
  const reorder = useRecruitMutation((ids: string[]) => recruitApi.reorder(ids));
  const exclude = useRecruitMutation((v: { userId: string; excluded: boolean }) => recruitApi.setExcluded(v.userId, v.excluded, v.excluded ? 'Excluded in Recruiting settings' : null));
  if (rotation.isPending) return <RecruitCard><QuietState title="Loading…" /></RecruitCard>;
  if (rotation.error || !rotation.data) {
    return (
      <RecruitCard>
        <QuietState tone="error" title="The rotation could not be loaded" action={<Button variant="outline" onClick={() => void rotation.refetch()}>Try again</Button>} />
      </RecruitCard>
    );
  }
  const r = rotation.data;
  const ids = r.members.map((m) => m.userId);
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(index + by, 0, item);
    reorder.mutate(next, {
      onSuccess: () => toast({ tone: 'success', title: 'Order saved' }),
      onError: (e) => toast({ tone: 'danger', title: 'Order not saved', description: e instanceof ApiError ? e.message : undefined }),
    });
  };
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <RecruitCard title="Active HR rotation" testId="rotation-card">
        <p className="mb-3 text-sm text-nw-text-3">New online and hand-added leads go to the next person in this order. Old leads are never moved.</p>
        {r.unassignedWarning ? (
          <Alert tone="warning" title="Nobody is taking leads">
            New leads arrive unassigned until someone eligible is in the rotation. {r.unassignedLeads > 0 ? `${r.unassignedLeads} open lead${r.unassignedLeads === 1 ? ' is' : 's are'} unassigned now.` : ''}
          </Alert>
        ) : r.unassignedLeads > 0 ? (
          <p className="mb-2 text-xs text-nw-warning-text">{r.unassignedLeads} open lead{r.unassignedLeads === 1 ? ' is' : 's are'} unassigned — see All leads › Unassigned.</p>
        ) : null}
        {r.members.length === 0 ? (
          <QuietState title="No recruiters yet" description="Recruiters join automatically when their account is linked to an employee whose position is Recruiter." />
        ) : (
          <ol className="flex flex-col divide-y divide-nw-border" data-testid="rotation-list">
            {r.members.map((m, i) => (
              <MemberRow
                key={m.userId}
                member={m}
                index={i}
                count={r.members.length}
                isNext={r.next?.userId === m.userId}
                canManage={r.canManage}
                busy={reorder.isPending || exclude.isPending}
                onMove={(by) => move(i, by)}
                onToggle={(on) =>
                  exclude.mutate(
                    { userId: m.userId, excluded: !on },
                    {
                      onSuccess: () => toast({ tone: 'success', title: on ? `${m.name} takes turns again` : `${m.name} excluded` }),
                      onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof ApiError ? e.message : undefined }),
                    },
                  )
                }
              />
            ))}
          </ol>
        )}
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-nw-subtle px-3 py-2 text-xs text-nw-text-2">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          {r.rule}
        </p>
        {!r.canManage ? <p className="mt-2 text-xs text-nw-text-3">Only an administrator can change the order or exclude someone.</p> : null}
      </RecruitCard>
      <RecruitCard title="How a turn is taken">
        <ul className="flex flex-col gap-2 text-sm text-nw-text-2">
          <li>Last turn: {r.last.name ? `${r.last.name}, ${formatDateTime(r.last.at ?? '')}` : 'none yet'}</li>
          <li>A retried or duplicate application keeps its recruiter and takes no turn.</li>
          <li>A lead that applies again keeps whoever already has it.</li>
          <li>Someone added later joins at the end; the order does not restart.</li>
          <li>
            To add a recruiter, link their account to their employee record in{' '}
            <Link to="/admin/users" search={{} as never} className="font-semibold text-nw-accent-ink hover:underline">
              Administration › Users
            </Link>{' '}
            and set the position to Recruiter.
          </li>
        </ul>
      </RecruitCard>
    </div>
  );
}

function MemberRow({
  member: m,
  index,
  count,
  isNext,
  canManage,
  busy,
  onMove,
  onToggle,
}: {
  member: RotationMember;
  index: number;
  count: number;
  isNext: boolean;
  canManage: boolean;
  busy: boolean;
  onMove: (by: -1 | 1) => void;
  onToggle: (on: boolean) => void;
}) {
  const active = m.eligible && !m.excluded;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3" data-testid="rotation-member">
      <span className={cn('flex size-8 items-center justify-center rounded-full text-sm font-semibold', active ? 'bg-nw-accent-tint text-nw-accent-ink' : 'bg-nw-subtle text-nw-text-3')}>
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-nw-text">
          {m.name}
          {isNext ? <span className="rounded-md bg-nw-accent-tint px-1.5 py-0.5 text-xs font-semibold text-nw-accent-ink">Next</span> : null}
        </p>
        <p className="text-xs text-nw-text-3">
          {m.excluded ? `Excluded${m.excludedReason ? ` · ${m.excludedReason}` : ''}` : m.eligible ? 'Takes turns' : `Skipped · ${m.ineligibleReason ?? 'not eligible'}`}
        </p>
      </div>
      {canManage ? (
        <>
          <span className="flex items-center gap-1">
            <Button variant="ghost" size="sm" aria-label={`Move ${m.name} up`} disabled={busy || index === 0} onClick={() => onMove(-1)} icon={<ArrowUp />} />
            <Button variant="ghost" size="sm" aria-label={`Move ${m.name} down`} disabled={busy || index === count - 1} onClick={() => onMove(1)} icon={<ArrowDown />} />
          </span>
          <Switch aria-label={`${m.name} takes turns`} checked={!m.excluded} disabled={busy} onCheckedChange={(v) => onToggle(v === true)} />
        </>
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-nw-text-2">
          <StatusSymbol family={active ? 'done' : 'neutral'} size={12} className={active ? 'text-nw-done-icon' : 'text-nw-text-3'} />
          {active ? 'On' : 'Off'}
        </span>
      )}
    </li>
  );
}

function LinksPanel() {
  const { toast } = useToast();
  const links = useApplyLinks();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const [managing, setManaging] = useState(false);
  const copy = async (url: string) => {
    try {
      await copyText(url);
      toast({ tone: 'success', title: 'Link copied' });
    } catch {
      toast({ tone: 'warning', title: 'Copy is not available here', description: url });
    }
  };
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <RecruitCard
        title="Instagram lead form"
        testId="lead-form-links"
        action={canManage ? <Button variant="outline" size="sm" onClick={() => setManaging(true)}>Manage links</Button> : null}
      >
        <p className="mb-3 text-sm text-nw-text-3">The short form in the Instagram bio and ads. A driver leaves a name and phone; the lead lands in the next recruiter’s My leads.</p>
        {links.isPending ? (
          <p className="text-sm text-nw-text-3">Loading…</p>
        ) : links.error ? (
          <Alert tone="danger" title="Links could not be loaded" />
        ) : (links.data ?? []).length === 0 ? (
          <p className="text-sm text-nw-text-3">No lead form link yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(links.data ?? []).map((l) => {
              const url = `${applyUrl(l.slug)}${l.source === 'instagram' || l.source === 'social' ? '?utm_source=instagram' : ''}`;
              return (
                <li key={l.id} className="flex flex-col gap-1.5 rounded-lg border border-nw-border px-3 py-2.5">
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold text-nw-text">
                    {l.name}
                    <span className={cn('text-xs font-medium', l.active ? 'text-nw-done-text' : 'text-nw-text-3')}>{l.active ? 'Active' : 'Off'}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-nw-subtle px-2 py-1 text-xs text-nw-text-2">{url}</code>
                    <Button variant="ghost" size="sm" icon={<Copy />} aria-label={`Copy ${l.name}`} onClick={() => void copy(url)} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </RecruitCard>
      <RecruitCard title="Full driver application" testId="full-application-link">
        <p className="text-sm text-nw-text-2">
          The driver application is personal: each lead gets a private link from their own page (<strong>Send application</strong>). It opens the
          approved NORTHWIND FREIGHT application served by the TMS at <code className="text-xs">/application/</code>, and what the driver submits — answers,
          documents and the MVR / PSP authorizations — lands on that same candidate. The full DOT application link is under <strong>More</strong>.
        </p>
        <div className="mt-3 rounded-lg border border-nw-border px-3 py-2.5">
          <p className="text-xs text-nw-text-3">External application page</p>
          <code className="block truncate text-xs text-nw-text-2">{EXTERNAL_APPLICATION_URL}</code>
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-nw-warning-text">
            <StatusSymbol family="warning" size={12} className="mt-px text-nw-warning-icon" />
            Not connected: that copy saves to its own server, not to the TMS. Personal links use the copy the TMS serves until its owner adds the signed forwarder.
          </p>
        </div>
      </RecruitCard>
      {managing ? <ApplyLinksModal onClose={() => setManaging(false)} /> : null}
    </div>
  );
}
