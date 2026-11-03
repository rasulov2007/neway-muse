import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from 'cmdk';
import { Check, ChevronsUpDown, LoaderCircle, Search, X } from 'lucide-react';
import { forwardRef, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  controlBase,
  controlMinHeights,
  controlSizes,
  controlWrapperStates,
  isInvalid,
  type ControlSize,
} from '../Input/controlStyles';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../Popover';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary line, e.g. "Freightliner Cascadia · Active". */
  description?: string;
  disabled?: boolean;
}

interface ComboboxBaseProps extends Pick<
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
  options: ComboboxOption[];
  /**
   * Async search. When provided, the caller filters `options` (client-side filtering is
   * turned off) and should set `loading` while fetching.
   */
  onSearch?: (query: string) => void | Promise<void>;
  loading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: ReactNode;
  /**
   * Offered as the last row when the person has typed something.
   *
   * A reference that does not exist yet is the one thing that stops a form dead: the name is in
   * their head, the record is not in the system, and the only way out is to abandon what they were
   * filling in. This lets the list create it instead.
   */
  onCreate?: (query: string) => void;
  /** Wording for that row; defaults to `+ Create "<typed>"`. */
  createLabel?: (query: string) => string;
  size?: ControlSize;
  invalid?: boolean;
  disabled?: boolean;
  renderOption?: (option: ComboboxOption, state: { selected: boolean }) => ReactNode;
  /** Class name for the popover panel. */
  contentClassName?: string;
}

export interface SingleComboboxProps extends ComboboxBaseProps {
  multiple?: false;
  value?: string | null;
  /** Selecting the current option again clears the value (`null`). */
  onValueChange?: (value: string | null) => void;
}

export interface MultipleComboboxProps extends ComboboxBaseProps {
  multiple: true;
  value?: string[];
  onValueChange?: (value: string[]) => void;
}

export type ComboboxProps = SingleComboboxProps | MultipleComboboxProps;

/**
 * How a typed query is matched against an option.
 *
 * cmdk's own scorer is a fuzzy subsequence match, which answers "allen" with "gabriel hall" —
 * technically a match, useless to a dispatcher looking for Derrick Allen. This is plain substring
 * matching over the label and its secondary line, with a word-start match ranked above a match in
 * the middle, so the obvious answer is the first one.
 */
function matches(value: string, query: string, keywords?: string[]): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const haystacks = [...(keywords ?? []), value].map((text) => text.toLowerCase());
  let best = 0;
  for (const text of haystacks) {
    const at = text.indexOf(needle);
    if (at < 0) continue;
    const wordStart = at === 0 || /[\s·,\-/]/.test(text[at - 1] ?? '');
    best = Math.max(best, at === 0 ? 1 : wordStart ? 0.8 : 0.5);
  }
  return best;
}

/** Keeps the forwarded ref working while the component also needs the node itself. */
function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object')
        (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/** cmdk list inside a popover. Type to filter, arrows to move, Enter to select, Esc to close. */
export const Combobox = forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox(props, ref) {
  const {
    options,
    onSearch,
    loading = false,
    placeholder = 'Select…',
    searchPlaceholder = 'Search…',
    emptyMessage = 'No results',
    onCreate,
    createLabel,
    size = 'md',
    invalid,
    disabled,
    renderOption,
    contentClassName,
    className,
    multiple,
    value,
    onValueChange,
    ...triggerProps
  } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Inside a modal the panel has to live in the dialog, or the dialog's scroll lock cancels every
  // wheel event over the list and it will not scroll.
  const container = open
    ? (triggerRef.current?.closest('[role="dialog"]') as HTMLElement | null)
    : null;
  const [query, setQuery] = useState('');
  // Labels of chosen values survive an async options change.
  const labels = useRef(new Map<string, string>());
  for (const option of options) labels.current.set(option.value, option.label);

  const selected: string[] = multiple
    ? ((value as string[] | undefined) ?? [])
    : value
      ? [value as string]
      : [];
  const isSelected = (v: string) => selected.includes(v);
  const labelFor = (v: string) => labels.current.get(v) ?? v;
  const showInvalid = isInvalid(invalid, triggerProps['aria-invalid']);

  function commit(next: string[]) {
    if (multiple) (onValueChange as MultipleComboboxProps['onValueChange'])?.(next);
    else (onValueChange as SingleComboboxProps['onValueChange'])?.(next[0] ?? null);
  }

  function choose(option: ComboboxOption) {
    if (props.multiple) {
      commit(
        isSelected(option.value)
          ? selected.filter((v) => v !== option.value)
          : [...selected, option.value],
      );
    } else {
      commit(isSelected(option.value) ? [] : [option.value]);
      setOpen(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && query) {
      setQuery('');
      void onSearch?.('');
    }
  }

  function handleQuery(q: string) {
    setQuery(q);
    void onSearch?.(q);
  }

  const chevron = <ChevronsUpDown aria-hidden className="shrink-0 text-nw-text-3" />;

  const trigger = multiple ? (
    <PopoverAnchor asChild>
      <div
        data-invalid={showInvalid || undefined}
        data-disabled={disabled || undefined}
        className={cn(
          controlBase,
          controlSizes[size],
          controlMinHeights[size],
          controlWrapperStates,
          'h-auto flex-wrap gap-1 py-1 focus-visible:outline-0',
          className,
        )}
      >
        {selected.map((v) => (
          <span
            key={v}
            className="inline-flex h-5 max-w-full items-center gap-1 rounded-sm border border-nw-border bg-nw-subtle pl-1.5 text-xs text-nw-text"
          >
            <span className="truncate">{labelFor(v)}</span>
            <button
              type="button"
              aria-label={`Remove ${labelFor(v)}`}
              disabled={disabled}
              onClick={() => commit(selected.filter((x) => x !== v))}
              className="inline-flex h-full items-center rounded-r-sm px-1 text-nw-text-3 hover:bg-nw-hover hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:pointer-events-none [&_svg]:size-3"
            >
              <X aria-hidden />
            </button>
          </span>
        ))}
        <PopoverTrigger asChild>
          <button
            ref={mergeRefs(ref, triggerRef)}
            type="button"
            disabled={disabled}
            className="flex h-5 min-w-20 flex-1 items-center justify-between gap-2 rounded-xs text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed"
            {...triggerProps}
            aria-invalid={showInvalid ? true : triggerProps['aria-invalid']}
          >
            <span className={cn('truncate', 'text-nw-text-3')}>
              {selected.length ? '' : placeholder}
            </span>
            {chevron}
          </button>
        </PopoverTrigger>
      </div>
    </PopoverAnchor>
  ) : (
    <PopoverTrigger asChild>
      <button
        ref={mergeRefs(ref, triggerRef)}
        type="button"
        disabled={disabled}
        className={cn(controlBase, controlSizes[size], 'justify-between gap-2', className)}
        {...triggerProps}
        aria-invalid={showInvalid ? true : triggerProps['aria-invalid']}
      >
        <span className={cn('min-w-0 flex-1 truncate', !selected.length && 'text-nw-text-3')}>
          {selected.length ? labelFor(selected[0] as string) : placeholder}
        </span>
        {chevron}
      </button>
    </PopoverTrigger>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {trigger}
      <PopoverContent
        container={container}
        className={cn('w-(--radix-popover-trigger-width) min-w-56 p-0', contentClassName)}
      >
        <Command shouldFilter={!onSearch} filter={matches} loop label="Options">
          <div className="flex items-center gap-2 border-b border-nw-border px-3">
            <Search aria-hidden className="size-4 shrink-0 text-nw-text-3" />
            <CommandInput
              value={query}
              onValueChange={handleQuery}
              placeholder={searchPlaceholder}
              className="input-bare h-9 w-full min-w-0 bg-transparent text-base text-nw-text outline-none placeholder:text-nw-text-3"
            />
            {loading ? (
              <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-nw-text-3" />
            ) : null}
          </div>
          <CommandList className="scroll-quiet max-h-64 overflow-y-auto">
            {loading ? (
              <CommandLoading>
                <div className="px-3 py-2 text-xs text-nw-text-3">Loading…</div>
              </CommandLoading>
            ) : (
              <CommandEmpty className="px-3 py-3 text-center text-sm text-nw-text-3">
                {emptyMessage}
              </CommandEmpty>
            )}
            {onCreate && query.trim() ? (
              <CommandItem
                value={`__create__ ${query.trim()}`}
                keywords={[query.trim()]}
                onSelect={() => {
                  onCreate(query.trim());
                  setOpen(false);
                  setQuery('');
                }}
                className="flex min-h-9 cursor-default items-center gap-2 border-b border-nw-border px-3 py-2 text-sm font-semibold text-nw-accent-ink outline-none select-none data-[selected=true]:bg-nw-highlight"
              >
                {createLabel ? createLabel(query.trim()) : `+ Create “${query.trim()}”`}
              </CommandItem>
            ) : null}
            {options.map((option) => {
              const active = isSelected(option.value);
              return (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.description ?? '']}
                  disabled={option.disabled}
                  onSelect={() => choose(option)}
                  className={cn(
                    'flex min-h-9 cursor-default items-center gap-2 border-b border-nw-border px-3 py-2 text-sm text-nw-text outline-none select-none last:border-b-0',
                    'data-[selected=true]:bg-nw-highlight data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-[0.62]',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    {renderOption ? (
                      renderOption(option, { selected: active })
                    ) : (
                      <>
                        <span className="block truncate">{option.label}</span>
                        {option.description ? (
                          <span className="block truncate text-2xs text-nw-text-3">
                            {option.description}
                          </span>
                        ) : null}
                      </>
                    )}
                  </span>
                  {active ? <Check aria-hidden className="size-4 shrink-0 text-nw-accent" /> : null}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});
