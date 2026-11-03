import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type TabsVariant = 'underline' | 'segmented';
export type TabsSize = 'sm' | 'md';

export interface TabItem {
  value: string;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixTabs.Root>,
  'orientation' | 'dir'
> {
  items: TabItem[];
  /** `underline` for page tabs; `segmented` for filters. */
  variant?: TabsVariant;
  size?: TabsSize;
  /** Extra classes for the tab list. */
  listClassName?: string;
  /** Accessible name for the tab list. */
  'aria-label'?: string;
}

/* Page tabs: a row with a 1px border-strong bottom line. Segmented: a --nw-segment track, radius 9, 3px padding. */
const listStyles: Record<TabsVariant, string> = {
  // Too many tabs for the width scroll sideways instead of being cut off (owner, 2026-10-15); the
  // 1px bottom padding keeps the active underline inside the scroll box.
  underline: 'scroll-quiet flex max-w-full items-center gap-5 overflow-x-auto overflow-y-hidden border-b border-nw-border-strong pb-px',
  segmented: 'scroll-quiet inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[9px] bg-nw-segment p-[3px]',
};

const triggerBase =
  'group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold select-none ' +
  'transition-colors duration-(--duration-base) ease-(--ease-standard) ' +
  'disabled:pointer-events-none disabled:opacity-45';

const triggerStyles: Record<TabsVariant, Record<TabsSize, string>> = {
  underline: {
    sm: 'relative h-8 text-sm text-nw-text-2 hover:text-nw-text data-[state=active]:text-nw-accent-ink [&_svg]:size-3.5',
    md: 'relative h-9 text-base text-nw-text-2 hover:text-nw-text data-[state=active]:text-nw-accent-ink [&_svg]:size-4',
  },
  segmented: {
    sm: 'h-[22px] rounded-sm px-2 text-xs text-nw-text-2 hover:text-nw-text data-[state=active]:bg-nw-panel data-[state=active]:text-nw-accent-ink data-[state=active]:shadow-segment data-[state=active]:ring-1 data-[state=active]:ring-nw-border [&_svg]:size-3.5',
    md: 'h-[26px] rounded-sm px-2.5 text-xs text-nw-text-2 hover:text-nw-text data-[state=active]:bg-nw-panel data-[state=active]:text-nw-accent-ink data-[state=active]:shadow-segment data-[state=active]:ring-1 data-[state=active]:ring-nw-border [&_svg]:size-3.5',
  },
};

const underlineIndicator =
  'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent ' +
  'after:transition-colors after:duration-(--duration-base) data-[state=active]:after:bg-nw-accent';

/* Counts: small rounded badges — subtle with a border; tint and ink on the active tab. */
const countBadge =
  'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1.5 text-[11px] font-bold leading-none ' +
  'bg-nw-subtle text-nw-text-2 ring-1 ring-inset ring-nw-border ' +
  'group-data-[state=active]:bg-nw-accent-tint group-data-[state=active]:text-nw-accent-ink group-data-[state=active]:ring-transparent';

/**
 * Radix Tabs with the design-system look. Render panels as children with `TabsContent`:
 *
 *   <Tabs items={[{ value: 'a', label: 'A' }]} defaultValue="a">
 *     <TabsContent value="a">...</TabsContent>
 *   </Tabs>
 */
export function Tabs({
  items,
  variant = 'underline',
  size = 'md',
  listClassName,
  className,
  children,
  'aria-label': ariaLabel,
  ...rest
}: TabsProps) {
  return (
    <RadixTabs.Root className={cn('min-w-0', className)} {...rest}>
      <RadixTabs.List aria-label={ariaLabel} className={cn(listStyles[variant], listClassName)}>
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cn(
              triggerBase,
              triggerStyles[variant][size],
              variant === 'underline' && underlineIndicator,
            )}
          >
            {item.icon ? <span aria-hidden>{item.icon}</span> : null}
            {item.label}
            {item.count !== undefined ? (
              <span className={countBadge}>{item.count}</span>
            ) : null}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export type TabsContentProps = ComponentPropsWithoutRef<typeof RadixTabs.Content>;

/** Panel for one tab value. Unmounted when inactive unless `forceMount` is set. */
export function TabsContent({ className, ...rest }: TabsContentProps) {
  return (
    <RadixTabs.Content
      className={cn(className)}
      {...rest}
    />
  );
}
