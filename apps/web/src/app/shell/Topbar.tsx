import { Bell, CircleQuestionMark, Keyboard, Menu, Search } from 'lucide-react';
import { NIGHT_DESK_ZONE, zoneAbbreviation } from '@neway/shared';
import { COMPANY_TZ, now, nowMs } from '@/lib/clock';
import { type ReactNode, useEffect, useState } from 'react';
import { IconButton, Popover, PopoverContent, PopoverTrigger, cn } from '@/design-system';
import { AiHeaderButton } from '@/features/ai-assistant/AiLauncher';
import { CompanySelector } from './CompanySelector';
import { useNotificationAttention } from './notification-count';
import { PALETTE_SHORTCUT, useShellState } from './shellState';
import { UserMenu } from './UserMenu';

/** Small bordered keyboard chip. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        // A small key with a 1px border-strong edge (SPEC §7 "Search").
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-nw-border-strong bg-nw-panel px-1.5 font-sans text-2xs font-medium text-nw-text-3',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        aria-keyshortcuts="Control+K Meta+K"
        className={cn(
          // Fill, no border: the search is a quiet affordance, not a form field awaiting input.
          // 34px, radius 8, canvas fill, placeholder in text-3 (SPEC §7 "Search").
          'hidden h-[34px] w-full max-w-120 items-center gap-2 rounded-md bg-nw-bg px-2.5 text-sm text-nw-text-3 md:flex',
          'transition-colors duration-(--duration-base) ease-(--ease-standard) hover:bg-nw-hover',
        )}
      >
        <Search aria-hidden className="size-4 shrink-0 text-nw-text-3" />
        <span className="flex-1 truncate text-left">Search anything…</span>
        <Kbd aria-hidden>{PALETTE_SHORTCUT}</Kbd>
      </button>
      <IconButton label="Search" className="md:hidden" onClick={onOpen}>
        <Search />
      </IconButton>
    </>
  );
}

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'Command palette', keys: [PALETTE_SHORTCUT] },
  { label: 'Toggle sidebar', keys: ['['] },
  { label: 'Move between nav items', keys: ['↑', '↓'] },
  { label: 'Close overlay', keys: ['Esc'] },
];

const helpItem =
  'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-sm text-ink transition-colors duration-(--duration-fast) hover:bg-surface-hover [&_svg]:size-4 [&_svg]:text-muted';

function HelpMenu() {
  const [showShortcuts, setShowShortcuts] = useState(false);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="Help">
          <CircleQuestionMark />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        <div className="eyebrow px-2 pt-2 pb-1">Help</div>
        <button
          type="button"
          className={helpItem}
          aria-expanded={showShortcuts}
          onClick={() => setShowShortcuts((v) => !v)}
        >
          <Keyboard aria-hidden /> Keyboard shortcuts
        </button>
        {showShortcuts ? (
          <dl className="mx-1 my-1 flex flex-col gap-1.5 rounded-sm bg-surface-muted px-2 py-2 text-xs text-secondary">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center justify-between gap-2">
                <dt>{s.label}</dt>
                <dd className="flex gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k} className="bg-surface">
                      {k}
                    </Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** 56px sticky header: menu (mobile), company, search, notifications, help, account. */
export function Topbar() {
  const { setMobileNavOpen, setPaletteOpen, setNotificationsOpen } = useShellState();
  const unread = useNotificationAttention();

  return (
    // Panel fill, 1px bottom border, 20px side padding (SPEC §7 "Top bar").
    <header data-topbar className="sticky top-0 z-20 flex h-(--topbar-height) shrink-0 items-center gap-2 border-b border-nw-border bg-nw-panel px-3 md:px-5">
      <IconButton
        label="Open navigation"
        className="lg:hidden"
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu />
      </IconButton>
      <CompanySelector />

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <SearchTrigger onOpen={() => setPaletteOpen(true)} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <HeaderClock />
        <AiHeaderButton />
        <IconButton
          label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
          className="relative"
          onClick={() => setNotificationsOpen(true)}
        >
          <Bell />
          {unread > 0 ? (
            <span
              aria-hidden
              className="tabular absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-nw-urgent-icon px-1 text-2xs leading-none font-bold text-nw-status-glyph"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </IconButton>
        <HelpMenu />
        <UserMenu />
      </div>
    </header>
  );
}

const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: COMPANY_TZ, hour: 'numeric', minute: '2-digit' });
const DESK = new Intl.DateTimeFormat('en-US', { timeZone: NIGHT_DESK_ZONE, hour: 'numeric', minute: '2-digit' });

/**
 * The time, in Eastern, with Tashkent beside it.
 *
 * Everybody works the Eastern clock (rule 1.1), and a header that shows it is how a dispatcher in
 * Tashkent stops doing the arithmetic in their head. It reads the app's own clock, which is the
 * server's, so it is right even on a laptop whose clock is not.
 */
function HeaderClock() {
  const [at, setAt] = useState(() => nowMs());
  useEffect(() => {
    const timer = setInterval(() => setAt(nowMs()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const date = new Date(at);
  return (
    <div
      className="mr-1 hidden flex-col items-end leading-none sm:flex"
      title={`${DESK.format(date)} in Tashkent`}
      aria-label={`${CLOCK.format(date)} ${zoneAbbreviation(now(), COMPANY_TZ)}, ${DESK.format(date)} in Tashkent`}
    >
      <span className="tabular text-[13px] font-bold text-nw-text">
        {CLOCK.format(date)} <span className="text-[11px] font-semibold text-nw-text-3">{zoneAbbreviation(date, COMPANY_TZ)}</span>
      </span>
      <span className="tabular text-[10.5px] text-nw-text-3">{DESK.format(date)} Tashkent</span>
    </div>
  );
}
