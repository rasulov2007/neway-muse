import { endOfMonth, startOfMonth, subDays, subMonths } from 'date-fns';
import type { DateRange } from 'react-day-picker';

export type { DateRange };

export interface DateRangePreset {
  label: string;
  /** Computed at click time so "Today" is always today. */
  range: () => DateRange;
}

export const DATE_FORMAT = 'MMM d, yyyy';

export const defaultDateRangePresets: DateRangePreset[] = [
  { label: 'Today', range: () => ({ from: new Date(), to: new Date() }) },
  {
    label: 'Yesterday',
    range: () => ({ from: subDays(new Date(), 1), to: subDays(new Date(), 1) }),
  },
  { label: 'Last 7 days', range: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: 'Last 30 days', range: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  {
    label: 'This month',
    range: () => ({ from: startOfMonth(new Date()), to: endOfMonth(new Date()) }),
  },
  {
    label: 'Last month',
    range: () => {
      const previous = subMonths(new Date(), 1);
      return { from: startOfMonth(previous), to: endOfMonth(previous) };
    },
  },
];
