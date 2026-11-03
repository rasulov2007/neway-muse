import { format, isSameDay } from 'date-fns';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { DATE_FORMAT, DateRangePicker, type DateRange } from '../DatePicker';
import { Input } from '../Input';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover';
import { isFilterActive } from './filterUtils';

export type FilterType = 'select' | 'multiselect' | 'daterange' | 'text';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDefinition {
  key: string;
  label: string;
  type: FilterType;
  /** Required for `select` and `multiselect`. */
  options?: FilterOption[];
  /** Placeholder for `text` filters. */
  placeholder?: string;
}

export interface FilterBarSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Delay before `onChange` fires while typing. Default 250ms. */
  debounceMs?: number;
}

export interface FilterBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  search?: FilterBarSearch;
  filters?: FilterDefinition[];
  /** Current value per filter key: `string`, `string[]`, `DateRange` or `undefined`. */
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onClear: () => void;
}

const DEFAULT_DEBOUNCE_MS = 250;

/* Filter chips: 24px, radius 12, 12/600, text-2 on subtle with a 1px border; active is tint + ink. */
const chipBase =
  'inline-flex h-6 max-w-60 items-center gap-1 rounded-xl border border-nw-border bg-nw-subtle px-2.5 text-xs font-semibold text-nw-text-2 ring-0 ' +
  'transition-colors duration-(--duration-base) ease-(--ease-standard) hover:bg-nw-hover hover:text-nw-text ' +
  '[&_svg]:size-3.5 [&_svg]:shrink-0';

const chipActive =
  'border-nw-accent-tint bg-nw-accent-tint text-nw-accent-ink hover:bg-nw-accent-tint hover:text-nw-accent-ink';

function optionLabel(options: FilterOption[] | undefined, value: string): string {
  return options?.find((option) => option.value === value)?.label ?? value;
}

function formatDateRange(range: DateRange): string {
  if (!range.from) return '';
  const from = format(range.from, DATE_FORMAT);
  if (!range.to || isSameDay(range.from, range.to)) return from;
  return `${from} – ${format(range.to, DATE_FORMAT)}`;
}

function describeValue(filter: FilterDefinition, value: unknown): string {
  switch (filter.type) {
    case 'select':
      return optionLabel(filter.options, String(value));
    case 'multiselect': {
      const list = Array.isArray(value) ? value.map(String) : [];
      if (list.length > 2) return `${list.length} selected`;
      return list.map((item) => optionLabel(filter.options, item)).join(', ');
    }
    case 'daterange':
      return formatDateRange(value as DateRange);
    default:
      return String(value);
  }
}

function SearchField({ value, onChange, placeholder = 'Search…', debounceMs }: FilterBarSearch) {
  const delay = debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    // External change (e.g. "Clear filters"): adopt it without emitting.
    setLastValue(value);
    setDraft(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <Input
      size="sm"
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      prefix={<Search aria-hidden />}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange(next), delay);
      }}
      className="w-64 max-w-full"
    />
  );
}

interface FilterChipProps {
  filter: FilterDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}

function FilterChip({ filter, value, onChange }: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const active = isFilterActive(value);

  if (filter.type === 'daterange') {
    return (
      <DateRangePicker
        size="sm"
        aria-label={filter.label}
        placeholder={filter.label}
        value={(value as DateRange | undefined) ?? null}
        onChange={(range) => onChange(range)}
        className={cn(chipBase, 'w-auto', active && chipActive)}
      />
    );
  }

  let content: ReactNode;
  if (filter.type === 'select') {
    const current = active ? String(value) : undefined;
    content = (
      <ul aria-label={filter.label} className="flex flex-col gap-0.5">
        <li>
          <OptionButton
            selected={!active}
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            Any
          </OptionButton>
        </li>
        {filter.options?.map((option) => (
          <li key={option.value}>
            <OptionButton
              selected={current === option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </OptionButton>
          </li>
        ))}
      </ul>
    );
  } else if (filter.type === 'multiselect') {
    const list = Array.isArray(value) ? value.map(String) : [];
    content = (
      <div role="group" aria-label={filter.label} className="flex flex-col gap-0.5">
        {filter.options?.map((option) => (
          <div
            key={option.value}
            className="flex h-8 items-center rounded-sm px-2 hover:bg-nw-highlight"
          >
            <Checkbox
              label={option.label}
              checked={list.includes(option.value)}
              onCheckedChange={(checked) => {
                const next =
                  checked === true
                    ? [...list, option.value]
                    : list.filter((item) => item !== option.value);
                onChange(next.length ? next : undefined);
              }}
            />
          </div>
        ))}
      </div>
    );
  } else {
    content = (
      <Input
        size="sm"
        aria-label={filter.label}
        placeholder={filter.placeholder ?? filter.label}
        value={active ? String(value) : ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') setOpen(false);
        }}
        autoFocus
      />
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(chipBase, active && chipActive)}>
          <span className="truncate">
            {filter.label}
            {active ? `: ${describeValue(filter, value)}` : ''}
          </span>
          <ChevronDown aria-hidden className="text-nw-text-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={`${filter.label} filter`}
        className={cn('w-56', filter.type === 'text' ? 'p-2' : 'p-1')}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}

function OptionButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-nw-text transition-colors duration-(--duration-fast)',
        'hover:bg-nw-highlight focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus',
        selected && 'font-semibold',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check aria-hidden className="size-4 text-nw-accent" /> : null}
    </button>
  );
}

/** Search box plus filter chips that open a popover per filter. Wraps on narrow widths. */
export function FilterBar({
  search,
  filters = [],
  values,
  onChange,
  onClear,
  className,
  children,
  ...rest
}: FilterBarProps) {
  const anyActive = filters.some((filter) => isFilterActive(values[filter.key]));
  return (
    <div
      role="group"
      aria-label="Filters"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      {...rest}
    >
      {search ? <SearchField {...search} /> : null}
      {filters.map((filter) => (
        <FilterChip
          key={filter.key}
          filter={filter}
          value={values[filter.key]}
          onChange={(value) => onChange(filter.key, value)}
        />
      ))}
      {anyActive ? (
        <Button variant="ghost" size="sm" icon={<X />} onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
      {children}
    </div>
  );
}
