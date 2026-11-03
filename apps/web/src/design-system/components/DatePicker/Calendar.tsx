import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import {
  DayPicker,
  type ClassNames,
  type DayButtonProps,
  type DayPickerProps,
} from 'react-day-picker';
import { cn } from '../../lib/cn';

const navButton =
  'inline-flex size-7 items-center justify-center rounded-md text-nw-text-2 transition-colors duration-(--duration-base) ' +
  'hover:bg-nw-highlight hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:pointer-events-none disabled:opacity-40';

const calendarClassNames: Partial<ClassNames> = {
  root: 'relative p-3 text-sm text-nw-text',
  months: 'relative flex flex-col gap-4 sm:flex-row',
  month: 'flex flex-col gap-2',
  month_caption: 'flex h-7 items-center justify-center px-8',
  caption_label: 'text-sm font-semibold text-nw-text',
  nav: 'absolute inset-x-0 top-0 flex h-7 items-center justify-between',
  button_previous: navButton,
  button_next: navButton,
  chevron: 'size-4',
  month_grid: 'w-full border-collapse',
  weekdays: '',
  weekday: 'h-8 w-8 text-center text-2xs font-medium tracking-eyebrow text-nw-text-3 uppercase',
  week: '',
  weeks: '',
  day: 'p-0 text-center',
  day_button: '',
  today: '',
  outside: '',
  disabled: '',
  hidden: 'invisible',
  focused: '',
  selected: '',
  range_start: 'rounded-l-md bg-nw-accent-tint',
  range_middle: 'bg-nw-accent-tint',
  range_end: 'rounded-r-md bg-nw-accent-tint',
  footer: 'pt-2 text-xs text-nw-text-3',
  week_number: 'text-2xs text-nw-text-3',
  week_number_header: '',
};

type ChevronProps = {
  className?: string;
  size?: number;
  disabled?: boolean;
  orientation?: 'up' | 'down' | 'left' | 'right';
};

function Chevron({ orientation = 'left', className }: ChevronProps) {
  const Icon =
    orientation === 'left'
      ? ChevronLeft
      : orientation === 'right'
        ? ChevronRight
        : orientation === 'up'
          ? ChevronUp
          : ChevronDown;
  return <Icon aria-hidden className={cn('size-4', className)} />;
}

/** Day cell button. Modifier styling lives here so precedence is explicit (range middle beats selected). */
function DayButton({ day, modifiers, className, ...rest }: DayButtonProps) {
  void day; // kept out of `rest` so it never reaches the DOM
  return (
    <button
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md text-sm text-nw-text transition-colors duration-(--duration-base)',
        'hover:bg-nw-highlight focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
        modifiers.today && 'font-semibold text-nw-accent-ink',
        modifiers.outside && 'text-nw-text-3',
        modifiers.disabled && 'pointer-events-none text-nw-text-3 opacity-45',
        modifiers.selected && 'bg-nw-accent text-nw-on-accent hover:bg-nw-accent-hover',
        modifiers.range_middle &&
          'rounded-none bg-transparent text-nw-accent-ink hover:bg-nw-accent-tint',
        className,
      )}
      {...rest}
    />
  );
}

/** react-day-picker styled with tokens. Accepts every DayPicker prop (mode, selected, onSelect…). */
export function Calendar(props: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays
      {...props}
      className={cn(props.className)}
      classNames={{ ...calendarClassNames, ...props.classNames }}
      components={{ Chevron, DayButton, ...props.components }}
    />
  );
}
