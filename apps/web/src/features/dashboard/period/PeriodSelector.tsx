import type { DashboardPeriodPreset } from '@neway/shared';
import { format, parseISO } from 'date-fns';
import { DateRangePicker, Select, type DateRange } from '@/design-system';
import type { PeriodState } from './usePeriod';

const PRESET_OPTIONS: Array<{ value: DashboardPeriodPreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'custom', label: 'Custom range' },
];

const ISO = 'yyyy-MM-dd';

function toDateRange(from?: string, to?: string): DateRange | undefined {
  if (!from) return undefined;
  return { from: parseISO(from), to: to ? parseISO(to) : undefined };
}

export interface PeriodSelectorProps {
  period: PeriodState;
}

/**
 * Preset select plus a date-range picker for custom ranges; drives every dashboard query. The
 * resolved range it produces is displayed once, on the Executive overview heading.
 */
export function PeriodSelector({ period }: PeriodSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Period"
        options={PRESET_OPTIONS}
        value={period.preset}
        onValueChange={(value) => period.setPreset(value as DashboardPeriodPreset)}
        className="w-40"
      />
      {period.preset === 'custom' ? (
        <DateRangePicker
          aria-label="Custom range"
          value={toDateRange(period.from, period.to)}
          presets={[]}
          onChange={(range) => {
            if (range?.from && range.to) {
              period.setCustomRange(format(range.from, ISO), format(range.to, ISO));
            }
          }}
          className="w-60"
        />
      ) : null}
    </div>
  );
}
