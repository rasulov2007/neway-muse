import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cn } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { insightsSearchSchema } from './insights-search';
import { PERIOD_PRESETS, useExecutiveAnalytics, useVendorAnalytics } from './useInsights';
import { VendorTrucksWidget } from '@/features/dashboard/widgets/VendorTrucksWidget';
import { ThemeToggle } from './analytics/ThemeToggle';
import { DataSourceBadge, PillToggle } from './analytics/ui';
import {
  DriverSection,
  ExecutiveSection,
  FinancialSection,
  FleetSection,
  OperationsSection,
  WorkforceSection,
} from './analytics/sections';

const TABS = [
  { value: 'executive', label: 'Executive' },
  { value: 'financial', label: 'Financial' },
  { value: 'operations', label: 'Operations' },
  { value: 'fleet', label: 'Fleet' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'drivers', label: 'Drivers' },
  { value: 'workforce', label: 'Workforce' },
] as const;

/**
 * Analytics.
 *
 * The dashboard answers "what is happening". This answers "why, and where is it moving" — every
 * headline is paired with the previous period, every cost is shown as a rate as well as a total,
 * and every ranking runs both ways so the worst performer is as easy to find as the best.
 *
 * Nothing on this page computes a financial figure. The server does it with the same engines the
 * dashboard uses, which is why the two agree. The look is the Analytics style the owner chose on
 * 2026-10-25 (`analytics-theme.css`); the figures, formulas and rules are unchanged.
 */
export function AnalyticsPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => insightsSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const preset = search.preset ?? 'this_month';
  const tab = TABS.some((t) => t.value === search.tab) ? (search.tab as string) : 'executive';

  const executive = useExecutiveAnalytics(preset);

  function update(patch: Record<string, unknown>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev, ...patch };
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === '' || v === null) delete next[k];
        }
        return next;
      },
      replace: true,
    });
  }

  return (
    <div className="nw-analytics flex flex-col gap-5 pb-4">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-1">
        <div className="min-w-0">
          <p className="text-[11px] font-bold tracking-[0.07em] text-nw-text-3 uppercase">Reports</p>
          <h1 className="mt-1 text-[30px] leading-9 font-extrabold tracking-[-0.02em] text-nw-text">
            Analytics
          </h1>
          <p className="mt-1 text-[13px] text-nw-text-3">
            Understand performance, trends, costs and where the business is moving.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PillToggle
            label="Period"
            value={preset}
            onValueChange={(value) => update({ preset: value })}
            options={PERIOD_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          />
          <ThemeToggle />
        </div>
      </header>

      <div className="-mt-2 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-nw-text-3">
        {executive.data ? (
          <>
            <span>
              {formatIsoDate(executive.data.range.from)} – {formatIsoDate(executive.data.range.to)},
              compared with {formatIsoDate(executive.data.comparison.from)} –{' '}
              {formatIsoDate(executive.data.comparison.to)}.
            </span>
            <DataSourceBadge source={executive.data.source} />
          </>
        ) : executive.isPending ? (
          <span role="status">Loading…</span>
        ) : null}
      </div>

      <RadixTabs.Root value={tab} onValueChange={(value) => update({ tab: value })}>
        <RadixTabs.List
          aria-label="Analytics"
          className="scroll-quiet inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-an-pill border border-an-card-border bg-an-card p-1 shadow-an-card"
        >
          {TABS.map((item) => (
            <RadixTabs.Trigger
              key={item.value}
              value={item.value}
              className={cn(
                'inline-flex h-9 shrink-0 items-center rounded-an-pill px-4 text-[13px] font-semibold whitespace-nowrap text-nw-text-2',
                'transition-colors duration-(--duration-base) hover:text-nw-text',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-an-accent',
                'data-[state=active]:bg-an-pill-active data-[state=active]:text-an-on-pill-active',
              )}
            >
              {item.label}
            </RadixTabs.Trigger>
          ))}
        </RadixTabs.List>

        <RadixTabs.Content value="executive" className="pt-5 outline-none">
          <ExecutiveSection query={executive} />
        </RadixTabs.Content>
        <RadixTabs.Content value="financial" className="pt-5 outline-none">
          <FinancialSection preset={preset} />
        </RadixTabs.Content>
        <RadixTabs.Content value="operations" className="pt-5 outline-none">
          <OperationsSection preset={preset} />
        </RadixTabs.Content>
        <RadixTabs.Content value="fleet" className="pt-5 outline-none">
          <FleetSection preset={preset} />
        </RadixTabs.Content>
        <RadixTabs.Content value="vendors" className="pt-5 outline-none">
          {tab === 'vendors' ? <VendorsSection preset={preset} /> : null}
        </RadixTabs.Content>
        <RadixTabs.Content value="drivers" className="pt-5 outline-none">
          <DriverSection preset={preset} />
        </RadixTabs.Content>
        <RadixTabs.Content value="workforce" className="pt-5 outline-none">
          <WorkforceSection />
        </RadixTabs.Content>
      </RadixTabs.Root>
    </div>
  );
}

/**
 * Vendor trucks (owner, 2026-10-28): the company keeps its percentage of a vendor truck's gross -
 * already inside the Executive and Financial revenue and profit - and the truck's costs are the
 * vendor's. This tab shows that money on its own.
 */
function VendorsSection({ preset }: { preset: string }) {
  const query = useVendorAnalytics(preset);
  if (query.isPending) return <p role="status" className="text-sm text-nw-text-3">Loading…</p>;
  if (query.isError) return <p className="text-sm text-danger-text">Vendor trucks could not be loaded.</p>;
  return <VendorTrucksWidget summary={query.data} />;
}
