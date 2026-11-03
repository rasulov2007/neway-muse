import { format, isSameDay } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import type { Matcher } from 'react-day-picker';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { controlBase, controlSizes, isInvalid, type ControlSize } from '../Input/controlStyles';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover';
import { Calendar } from './Calendar';
import {
  DATE_FORMAT,
  defaultDateRangePresets,
  type DateRange,
  type DateRangePreset,
} from './presets';

export interface DateRangePickerProps extends Pick<
  ComponentPropsWithoutRef<'button'>,
  | 'id'
  | 'className'
  | 'aria-label'
  | 'aria-labelledby'
  | 'aria-describedby'
  | 'aria-invalid'
  | 'aria-required'
  | 'onBlur'
> {
  value?: DateRange | null;
  onChange?: (range: DateRange | undefined) => void;
  /** Defaults to Today, Yesterday, Last 7 days, Last 30 days, This month, Last month. */
  presets?: DateRangePreset[];
  placeholder?: string;
  size?: ControlSize;
  invalid?: boolean;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  numberOfMonths?: number;
  displayFormat?: string;
  /** Replaces the trigger text for a chosen range, e.g. `Sep 6 – Oct 5, 2026`. */
  formatValue?: (range: DateRange) => string;
  /** Rendered at the end of the trigger, e.g. a chip naming the active preset. */
  trailing?: ReactNode;
}

function sameRange(a: DateRange | null | undefined, b: DateRange): boolean {
  if (!a?.from || !b.from) return false;
  if (!isSameDay(a.from, b.from)) return false;
  if (!a.to && !b.to) return true;
  return Boolean(a.to && b.to && isSameDay(a.to, b.to));
}

function formatRange(range: DateRange, displayFormat: string): string {
  if (!range.from) return '';
  const from = format(range.from, displayFormat);
  if (!range.to || isSameDay(range.from, range.to)) return from;
  return `${from} – ${format(range.to, displayFormat)}`;
}

/** Range trigger with presets on the left and a two-month calendar on the right. */
export const DateRangePicker = forwardRef<HTMLButtonElement, DateRangePickerProps>(
  function DateRangePicker(
    {
      value,
      onChange,
      presets = defaultDateRangePresets,
      placeholder = 'Pick a date range',
      size = 'md',
      invalid,
      disabled,
      minDate,
      maxDate,
      numberOfMonths = 2,
      displayFormat = DATE_FORMAT,
      formatValue,
      trailing,
      className,
      ...triggerProps
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    // Number of day clicks since the popover opened; the second completes a custom range.
    const [clicks, setClicks] = useState(0);
    const showInvalid = isInvalid(invalid, triggerProps['aria-invalid']);
    const disabledDays: Matcher[] = [];
    if (minDate) disabledDays.push({ before: minDate });
    if (maxDate) disabledDays.push({ after: maxDate });
    const selected = value ?? undefined;
    const activePreset = presets.find((p) => sameRange(selected, p.range()));

    function handleOpenChange(next: boolean) {
      setOpen(next);
      setClicks(0);
    }

    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            className={cn(controlBase, controlSizes[size], 'gap-2', className)}
            {...triggerProps}
            aria-invalid={showInvalid ? true : triggerProps['aria-invalid']}
          >
            <CalendarIcon aria-hidden className="shrink-0 text-nw-text-3" />
            <span className={cn('min-w-0 flex-1 truncate', !selected?.from && 'text-nw-text-3')}>
              {selected?.from
                ? formatValue
                  ? formatValue(selected)
                  : formatRange(selected, displayFormat)
                : placeholder}
            </span>
            {trailing}
          </button>
        </PopoverTrigger>
        <PopoverContent className="flex w-auto p-0">
          <ul
            className="flex min-w-36 flex-col gap-0.5 border-r border-nw-border p-2"
            aria-label="Presets"
          >
            {presets.map((preset) => {
              const active = activePreset === preset;
              return (
                <li key={preset.label}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      onChange?.(preset.range());
                      setOpen(false);
                    }}
                    className={cn(
                      'flex h-8 w-full items-center rounded-sm px-2 text-left text-sm text-nw-text-2 transition-colors duration-(--duration-fast)',
                      'hover:bg-nw-highlight hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
                      active &&
                        'bg-nw-accent-tint font-semibold text-nw-accent-ink hover:bg-nw-accent-tint',
                    )}
                  >
                    {preset.label}
                  </button>
                </li>
              );
            })}
            <li>
              <span
                className={cn(
                  'flex h-8 items-center px-2 text-sm text-nw-text-2',
                  selected?.from && !activePreset && 'font-semibold text-nw-accent-ink',
                )}
              >
                Custom
              </span>
            </li>
          </ul>
          <div>
            <Calendar
              mode="range"
              numberOfMonths={numberOfMonths}
              selected={selected}
              defaultMonth={selected?.from}
              disabled={disabledDays.length ? disabledDays : undefined}
              onSelect={(range) => {
                onChange?.(range);
                const count = clicks + 1;
                setClicks(count);
                if (count >= 2 && range?.from && range.to) setOpen(false);
              }}
            />
            <div className="flex items-center justify-end border-t border-nw-border px-3 py-2">
              {selected?.from ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onChange?.(undefined);
                    setOpen(false);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
