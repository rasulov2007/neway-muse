import { format, isAfter, isBefore, startOfDay } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import {
  forwardRef,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type FocusEvent,
} from 'react';
import type { Matcher } from 'react-day-picker';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import {
  controlBase,
  controlSizes,
  controlWrapperStates,
  isInvalid,
  type ControlSize,
} from '../Input/controlStyles';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../Popover';
import { Calendar } from './Calendar';
import { maskDateTyping } from '../../lib/inputMasks';
import { DATE_PARSE_ERROR, ISO_FORMAT, parseDateInput, toDateValue } from './dateInput';
import { DATE_FORMAT } from './presets';

export interface DatePickerProps extends Pick<
  ComponentPropsWithoutRef<'input'>,
  | 'id'
  | 'className'
  | 'aria-label'
  | 'aria-labelledby'
  | 'aria-describedby'
  | 'aria-invalid'
  | 'aria-required'
  | 'onBlur'
  | 'autoFocus'
> {
  /** A Date, or an ISO `yyyy-MM-dd` string (what `<input type="date">` used to hold). */
  value?: Date | string | null;
  onChange?: (date: Date | undefined) => void;
  /** Same change as ISO `yyyy-MM-dd`; empty string when cleared. For callers that keep strings. */
  onIsoChange?: (iso: string) => void;
  placeholder?: string;
  size?: ControlSize;
  invalid?: boolean;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  /** Submits `yyyy-MM-dd` through a hidden input. */
  name?: string;
  /** date-fns format for the field text. */
  displayFormat?: string;
}

/**
 * A text field for a date, with a calendar on its trailing edge.
 *
 * Typed or pasted text is read on blur and on Enter in any of `DATE_INPUT_FORMATS`; the field
 * then shows the date in `displayFormat`. Text that does not read as a date stays in the field
 * with a message under it, so the person can fix it. The calendar picks a day and closes.
 */
export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  {
    value,
    onChange,
    onIsoChange,
    placeholder = 'MM/DD/YYYY',
    size = 'md',
    invalid,
    disabled,
    minDate,
    maxDate,
    name,
    displayFormat = DATE_FORMAT,
    className,
    onBlur,
    ...inputProps
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  // Text the person is editing; null while the field simply shows the value.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const selected = toDateValue(value);
  const showInvalid = isInvalid(invalid, inputProps['aria-invalid']) || error !== null;
  const disabledDays: Matcher[] = [];
  if (minDate) disabledDays.push({ before: minDate });
  if (maxDate) disabledDays.push({ after: maxDate });
  const text = draft ?? (selected ? format(selected, displayFormat) : '');

  function emit(date: Date | undefined) {
    onChange?.(date);
    onIsoChange?.(date ? format(date, ISO_FORMAT) : '');
  }

  function settle(date: Date | undefined) {
    setDraft(null);
    setError(null);
    emit(date);
  }

  /** Reads the draft; returns true when the field is now settled. */
  function commit(): boolean {
    if (draft === null) return true;
    if (!draft.trim()) {
      settle(undefined);
      return true;
    }
    const parsed = parseDateInput(draft);
    if (!parsed) {
      setError(DATE_PARSE_ERROR);
      return false;
    }
    if (minDate && isBefore(parsed, startOfDay(minDate))) {
      setError(`Enter a date on or after ${format(minDate, displayFormat)}`);
      return false;
    }
    if (maxDate && isAfter(parsed, startOfDay(maxDate))) {
      setError(`Enter a date on or before ${format(maxDate, displayFormat)}`);
      return false;
    }
    settle(parsed);
    return true;
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    commit();
    onBlur?.(event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && draft !== null) {
      // The draft is what Enter means here; the form does not submit on top of it.
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape' && draft !== null) {
      event.preventDefault();
      setDraft(null);
      setError(null);
    }
  }

  const describedBy =
    [inputProps['aria-describedby'], error ? errorId : undefined].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div
            data-invalid={showInvalid || undefined}
            data-disabled={disabled || undefined}
            className={cn(
              controlBase,
              controlSizes[size],
              controlWrapperStates,
              'gap-1.5 pr-1 focus-visible:outline-0',
              className,
            )}
          >
            <input
              ref={ref}
              type="text"
              autoComplete="off"
              disabled={disabled}
              value={text}
              placeholder={placeholder}
              className="input-bare h-full w-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-nw-text-3 disabled:cursor-not-allowed"
              {...inputProps}
              aria-describedby={describedBy}
              aria-invalid={showInvalid ? true : inputProps['aria-invalid']}
              onChange={(event) => {
                // MM/DD/YYYY: the slashes go in as the digits arrive (owner, 2026-10-13).
                setDraft(maskDateTyping(text, event.target.value));
                if (error) setError(null);
              }}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
            />
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label="Open calendar"
                className="flex size-7 shrink-0 items-center justify-center rounded-sm text-nw-text-3 transition-colors duration-(--duration-fast) hover:bg-nw-highlight hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <CalendarIcon aria-hidden />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        {name ? (
          <input type="hidden" name={name} value={selected ? format(selected, ISO_FORMAT) : ''} />
        ) : null}
        <PopoverContent className="w-auto p-0">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            disabled={disabledDays.length ? disabledDays : undefined}
            onSelect={(date) => {
              settle(date);
              if (date) setOpen(false);
            }}
          />
          <div className="flex items-center justify-between border-t border-nw-border px-3 py-2">
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                settle(new Date());
                setOpen(false);
              }}
            >
              Today
            </Button>
            {selected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  settle(undefined);
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {error ? (
        <p id={errorId} role="alert" className="text-2xs font-medium text-nw-urgent-text">
          {error}
        </p>
      ) : null}
    </div>
  );
});
