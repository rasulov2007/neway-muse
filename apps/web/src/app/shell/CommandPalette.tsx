import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  defaultFilter,
} from 'cmdk';
import {
  Building2,
  Container,
  CornerDownLeft,
  FileText,
  Handshake,
  LoaderCircle,
  Package,
  Receipt,
  Search,
  Truck,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { allowedPages } from '@/app/navigation';
import { useAccount } from '@/features/auth/auth-context';
import { globalSearch, type GlobalSearchResult, type SearchHit } from '@/demo';
import { getStatus, cn } from '@/design-system';
import { useShellState } from './shellState';
import { Kbd } from './Topbar';

type EntityKey = keyof Omit<GlobalSearchResult, 'query' | 'total'>;

interface EntityGroup {
  key: EntityKey;
  label: string;
  icon: LucideIcon;
  /** Primary label as shown in the list. */
  primary: (hit: SearchHit) => string;
  /** Route to open; detail routes arrive with each module's phase, so lists take a query hint. */
  href: (hit: SearchHit) => string;
}

const enc = encodeURIComponent;
const unitOf = (hit: SearchHit) => hit.label.replace(/^Unit\s+/i, '');

const ENTITY_GROUPS: EntityGroup[] = [
  {
    key: 'trucks',
    label: 'Trucks',
    icon: Truck,
    primary: (h) => (/^Unit\s/i.test(h.label) ? h.label : `Unit ${h.label}`),
    href: (h) => `/fleet/trucks?unit=${enc(unitOf(h))}`,
  },
  {
    key: 'trailers',
    label: 'Trailers',
    icon: Container,
    primary: (h) => `Trailer ${unitOf(h)}`,
    href: (h) => `/fleet/trailers?unit=${enc(unitOf(h))}`,
  },
  {
    key: 'drivers',
    label: 'Drivers',
    icon: UserRound,
    primary: (h) => h.label,
    href: (h) => `/drivers?driver=${enc(h.id)}`,
  },
  {
    key: 'loads',
    label: 'Loads',
    icon: Package,
    primary: (h) => (/^Load\s/i.test(h.label) ? h.label : `Load ${h.label}`),
    href: (h) => `/loads/${enc(h.label.replace(/^Load\s+/i, ''))}`,
  },
  {
    key: 'customers',
    label: 'Customers',
    icon: Building2,
    primary: (h) => h.label,
    href: (h) => `/customers?customer=${enc(h.id)}`,
  },
  {
    key: 'brokers',
    label: 'Brokers',
    icon: Handshake,
    primary: (h) => h.label,
    href: (h) => `/brokers?broker=${enc(h.id)}`,
  },
  {
    key: 'invoices',
    label: 'Invoices',
    icon: Receipt,
    primary: (h) => (/^Invoice\s/i.test(h.label) ? h.label : `Invoice ${h.label}`),
    href: (h) => `/accounting/invoices?invoice=${enc(h.label)}`,
  },
  {
    key: 'employees',
    label: 'Employees',
    icon: Users,
    primary: (h) => h.label,
    href: (h) => `/hr/employees?employee=${enc(h.id)}`,
  },
];

function secondaryOf(hit: SearchHit): string {
  const status = hit.status ? getStatus(hit.status).label : null;
  return status ? `${hit.secondary} · ${status}` : hit.secondary;
}

/** A parent and a child can share a path; the first (parent) entry wins. */
function uniquePages(pages: ReturnType<typeof allowedPages>) {
  return pages.filter(
    (page, index, all) => all.findIndex((other) => other.to === page.to) === index,
  );
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

const groupClass =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 ' +
  '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase ' +
  '[&_[cmdk-group-heading]]:tracking-eyebrow [&_[cmdk-group-heading]]:text-muted';

const itemClass =
  'flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-sm text-ink outline-none select-none ' +
  'data-[selected=true]:bg-surface-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted';

/** ⌘K search: pages always, entity groups from `globalSearch` once the query has two characters. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useShellState();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, DEBOUNCE_MS);
  const searchTerm = debounced.length >= MIN_QUERY ? debounced : '';

  const search = useQuery({
    queryKey: ['global-search', searchTerm],
    queryFn: () => globalSearch(searchTerm),
    enabled: searchTerm.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const account = useAccount();
  const pages = useMemo(() => {
    const UNIQUE_PAGES = uniquePages(allowedPages(account));
    if (!trimmed) return UNIQUE_PAGES;
    return UNIQUE_PAGES.map((page) => ({
      page,
      score: defaultFilter(page.parent ? `${page.parent} ${page.label}` : page.label, trimmed),
    }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => entry.page);
  }, [trimmed, account]);

  const results = searchTerm ? search.data : undefined;
  const entityGroups = results
    ? ENTITY_GROUPS.map((group) => ({ group, hits: results[group.key] })).filter(
        ({ hits }) => hits.length > 0,
      )
    : [];
  const waiting = trimmed.length >= MIN_QUERY && (search.isFetching || debounced !== trimmed);

  function close() {
    setPaletteOpen(false);
    setQuery('');
  }

  function go(href: string) {
    close();
    void router.navigate({ href });
  }

  return (
    <Dialog.Root
      open={paletteOpen}
      onOpenChange={(open) => (open ? setPaletteOpen(true) : close())}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed top-[15vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-140 -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-lg outline-none',
            'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out',
          )}
        >
          <VisuallyHidden.Root asChild>
            <Dialog.Title>Search and commands</Dialog.Title>
          </VisuallyHidden.Root>
          <Command shouldFilter={false} label="Search and commands" className="flex flex-col">
            <div className="flex h-11 items-center gap-2 border-b border-line px-3">
              <Search aria-hidden className="size-4 shrink-0 text-muted" />
              <CommandInput
                value={query}
                onValueChange={setQuery}
                placeholder="Search pages, trucks, loads, drivers…"
                className="input-bare h-full w-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-faint"
              />
              {waiting ? (
                <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-muted" />
              ) : null}
              <Kbd aria-hidden>Esc</Kbd>
            </div>
            <CommandList className="scroll-quiet max-h-80 overflow-y-auto p-1.5">
              {!waiting ? (
                <CommandEmpty className="px-3 py-8 text-center text-sm text-muted">
                  No results for “{trimmed}”
                </CommandEmpty>
              ) : null}
              {pages.length > 0 ? (
                <CommandGroup heading="Pages" className={groupClass}>
                  {pages.map((page) => (
                    <CommandItem
                      key={page.to}
                      value={`page:${page.to}`}
                      onSelect={() => go(page.to)}
                      className={itemClass}
                    >
                      <FileText aria-hidden />
                      <span className="truncate">{page.label}</span>
                      <span className="ml-auto shrink-0 text-xs text-faint">
                        {page.parent ? `${page.group} · ${page.parent}` : page.group}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {entityGroups.map(({ group, hits }) => {
                const Icon = group.icon;
                return (
                  <CommandGroup key={group.key} heading={group.label} className={groupClass}>
                    {hits.map((hit) => (
                      <CommandItem
                        key={hit.id}
                        value={`${group.key}:${hit.id}`}
                        onSelect={() => go(group.href(hit))}
                        className={itemClass}
                      >
                        <Icon aria-hidden />
                        <span className="truncate">{group.primary(hit)}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted">
                          {secondaryOf(hit)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
            <div className="flex items-center gap-4 border-t border-line px-3 py-2 text-xs text-muted">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>
                  <CornerDownLeft aria-hidden className="size-3" />
                </Kbd>{' '}
                open
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
