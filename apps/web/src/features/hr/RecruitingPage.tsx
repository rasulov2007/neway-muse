import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button, DropdownMenu, MenuItem, MenuSeparator, cn } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { CampaignsTab } from './CampaignsTab';
import { hrSearchSchema } from './hr-search';
import { OpeningsTab } from './OpeningsTab';
import { PipelineBoard } from './PipelineBoard';
import { periodFromSearch } from './recruiting-kit';
import { RecruitAnalytics } from './recruit/RecruitAnalytics';
import { RecruitCalendar } from './recruit/RecruitCalendar';
import { RecruitDashboard } from './recruit/RecruitDashboard';
import { RecruitBoardView } from './recruit/RecruitBoard';
import { AddLeadModal } from './recruit/RecruitModals';
import { RecruitSettings } from './recruit/RecruitSettings';

/** Secondary pages, reached from More. Old tab names still land somewhere sensible. */
const SECONDARY = ['calendar', 'analytics', 'campaigns', 'openings', 'settings', 'pipeline'] as const;
type Secondary = (typeof SECONDARY)[number];

// All candidates was removed (owner, 2026-10-16); its old links land on the board.
type View = Secondary | 'board' | 'dashboard';
const MAIN_VIEWS: readonly View[] = ['board', 'dashboard'];

const TITLES: Record<View, { title: string; subtitle?: string }> = {
  // No tagline under the main title (owner, 2026-10-09).
  board: { title: 'Recruiting' },
  dashboard: { title: 'Recruiting' },
  calendar: { title: 'Calendar', subtitle: 'Stay on top of follow-ups and events.' },
  analytics: { title: 'Recruiting analytics', subtitle: 'Track your recruiting performance.' },
  campaigns: { title: 'Campaigns & Openings', subtitle: 'Manage your recruiting campaigns and job openings.' },
  openings: { title: 'Campaigns & Openings', subtitle: 'Manage your recruiting campaigns and job openings.' },
  settings: { title: 'Recruiting settings', subtitle: 'Configure links and HR rotation.' },
  pipeline: { title: 'Pipeline board', subtitle: 'Everyone in the hiring pipeline, by stage.' },
};

/**
 * Recruiting (owner's redesign, 2026-10-08): the home list (My leads / All leads) and, under More,
 * Calendar, Analytics, Campaigns, Openings and Recruiting settings. Every view, filter and page
 * lives in the URL, so a refresh or the back button returns to exactly the same place.
 */
export function RecruitingPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => hrSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const account = useAccount();
  const canManage = account?.permissions.includes('recruiting.manage') ?? false;
  const today = companyToday();
  const [leadOpen, setLeadOpen] = useState(false);
  // The board is the front page (owner mockup, 2026-10-15); old list links (my-leads…) land on it.
  const view: View =
    search.tab === 'dashboard'
      ? 'dashboard'
      : (SECONDARY as readonly string[]).includes(search.tab ?? '')
        ? (search.tab as Secondary)
        : 'board';
  const main = MAIN_VIEWS.includes(view);

  function update(patch: Record<string, unknown>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        if (!('page' in patch)) delete next.page;
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === '' || v === null) delete next[k];
        }
        return next;
      },
      replace: true,
    });
  }

  /** A secondary page is a new history entry, so Back returns to the list as it was. */
  function open(tab: string, extra: Record<string, unknown> = {}) {
    void navigate({ to: '/hr/recruiting', search: { tab, ...extra } as never });
  }

  const head = TITLES[view];
  return (
    <div className="flex w-full flex-col gap-6 pb-10" data-testid="recruiting-page">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-nw-text-3">
        <span>Workspace</span>
        <span aria-hidden>/</span>
        {main ? (
          <span className="text-nw-text">Recruiting</span>
        ) : (
          <>
            <Link to="/hr/recruiting" className="hover:text-nw-text hover:underline">
              Recruiting
            </Link>
            <span aria-hidden>/</span>
            <span className="text-nw-text">{head.title}</span>
          </>
        )}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {!main ? (
            <Link to="/hr/recruiting" className="mb-2 flex w-fit items-center gap-1.5 text-sm font-medium text-nw-text-2 hover:text-nw-text">
              <ArrowLeft aria-hidden className="size-4" />
              Back to leads
            </Link>
          ) : null}
          <h1 className="text-[26px] leading-[1.15] font-bold tracking-[-0.01em] text-nw-text sm:text-[28px]" data-testid="recruiting-title">
            {head.title}
          </h1>
          {head.subtitle ? (
            <p className="mt-1.5 text-[17px] text-nw-text-2 sm:text-[19px]">{head.subtitle}</p>
          ) : main && account?.companyName ? (
            <p className="mt-1 text-sm font-medium tracking-wide text-nw-text-2 uppercase" data-testid="recruiting-company">
              {account.companyName}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <MoreMenu view={view} onOpen={open} />
          {canManage && main ? (
            <Button variant="primary" size="lg" icon={<Plus />} onClick={() => setLeadOpen(true)} className="h-11 px-5 text-[15px]" data-testid="add-lead">
              Add lead
            </Button>
          ) : null}
        </div>
      </header>

      {main ? (
        // Board and Dashboard; All candidates was removed (owner, 2026-10-16).
        <SubTabs
          value={view}
          onChange={(v) =>
            void navigate({ to: '/hr/recruiting', search: (v === 'dashboard' ? { tab: 'dashboard' } : {}) as never })
          }
          items={[
            { value: 'board', label: 'Board' },
            { value: 'dashboard', label: 'Dashboard' },
          ]}
        />
      ) : null}
      {view === 'board' ? (
        <RecruitBoardView search={search} update={update} canSeeAll={canManage} canManage={canManage} />
      ) : view === 'dashboard' ? (
        <RecruitDashboard search={search} update={update} />
      ) : view === 'calendar' ? (
        <RecruitCalendar canSeeAll={canManage} canManage={canManage} />
      ) : view === 'analytics' ? (
        <RecruitAnalytics
          period={periodFromSearch(search, today)}
          today={today}
          onPeriod={(p) =>
            update(p.from ? { from: p.from, to: p.to, period: undefined } : { period: p.period === 'month' ? undefined : p.period, from: undefined, to: undefined })
          }
          onOpenTab={(t, extra) => open(t === 'leads' ? 'all-leads' : t, extra)}
        />
      ) : view === 'campaigns' || view === 'openings' ? (
        <div className="flex flex-col gap-4">
          <SubTabs value={view} onChange={(v) => update({ tab: v, opening: undefined })} items={[{ value: 'campaigns', label: 'Campaigns' }, { value: 'openings', label: 'Openings' }]} />
          <div className="rounded-[16px] border border-nw-border bg-nw-panel p-4 sm:p-5">
            {view === 'campaigns' ? <CampaignsTab onOpenTab={(t, extra) => open(t === 'leads' ? 'all-leads' : t, extra)} /> : <OpeningsTab search={search} update={update} />}
          </div>
        </div>
      ) : view === 'settings' ? (
        <RecruitSettings section={search.view === 'links' ? 'links' : 'rotation'} onSection={(s) => update({ view: s === 'rotation' ? undefined : s })} />
      ) : (
        <div className="rounded-[16px] border border-nw-border bg-nw-panel p-4 sm:p-5">
          <PipelineBoard search={search} update={update} onOpenTab={(t, extra) => open(t === 'leads' ? 'all-leads' : t, extra)} />
        </div>
      )}

      {leadOpen ? <AddLeadModal onClose={() => setLeadOpen(false)} onCreated={() => setLeadOpen(false)} /> : null}
    </div>
  );
}

function MoreMenu({ view, onOpen }: { view: View; onOpen: (tab: string) => void }) {
  const item = (tab: Secondary, label: string) => (
    <MenuItem onSelect={() => onOpen(tab)} className={cn(view === tab && 'font-semibold text-nw-accent-ink')}>
      {label}
    </MenuItem>
  );
  return (
    <DropdownMenu
      align="end"
      trigger={
        <Button variant="outline" size="lg" className="h-11 px-4 text-[15px]" iconRight={<ChevronDown />} data-testid="recruiting-more">
          More
        </Button>
      }
    >
      {item('calendar', 'Calendar')}
      {item('analytics', 'Analytics')}
      {item('campaigns', 'Campaigns')}
      {item('openings', 'Openings')}
      {item('settings', 'Recruiting settings')}
      <MenuSeparator />
      {item('pipeline', 'Pipeline board')}
    </DropdownMenu>
  );
}

function SubTabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: { value: string; label: string }[] }) {
  return (
    <nav className="flex items-end gap-6 border-b border-nw-border" role="tablist">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            'relative h-11 text-[15px] font-semibold transition-colors duration-150 motion-reduce:transition-none',
            'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full',
            value === i.value ? 'text-nw-text after:bg-nw-accent' : 'text-nw-text-3 after:bg-transparent hover:text-nw-text-2',
          )}
        >
          {i.label}
        </button>
      ))}
    </nav>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-ink">{label}</span>
      {children}
    </label>
  );
}
