import { Check } from 'lucide-react';
import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/cn';
import { popoverMotion, popoverSurface } from '../Popover/popoverStyles';

export interface DropdownMenuProps {
  /** A single element (usually a Button / IconButton) that opens the menu. */
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  /** Class name for the menu panel. */
  className?: string;
}

/** Radix dropdown: trigger + portalled panel. Compose with MenuItem, MenuLabel, MenuSeparator, MenuCheckboxItem. */
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
  sideOffset = 4,
  open,
  defaultOpen,
  onOpenChange,
  modal,
  className,
}: DropdownMenuProps) {
  return (
    <RadixDropdownMenu.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          align={align}
          side={side}
          sideOffset={sideOffset}
          className={cn(popoverSurface, popoverMotion, 'min-w-45 overflow-hidden', className)}
        >
          {children}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

/* Rows: 8 x 12 padding, divided by 1px border lines; the highlighted row is --nw-highlight. */
const itemBase =
  'relative flex min-h-9 cursor-default select-none items-center gap-2 border-b border-nw-border px-3 py-2 text-sm text-nw-text outline-none last:border-b-0 ' +
  'transition-colors duration-(--duration-fast) data-[highlighted]:bg-nw-highlight ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-[0.62] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-nw-text-3';

const itemDestructive =
  'text-nw-urgent-text data-[highlighted]:bg-nw-urgent-bg data-[highlighted]:text-nw-urgent-text [&_svg]:text-nw-urgent-icon';

export interface MenuItemProps extends Omit<
  ComponentPropsWithoutRef<typeof RadixDropdownMenu.Item>,
  'asChild'
> {
  icon?: ReactNode;
  /** Red text and icon; keep destructive items last, after a separator. */
  destructive?: boolean;
  /** Keyboard hint rendered on the right ("⌘K"). */
  shortcut?: string;
}

export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  { icon, destructive = false, shortcut, className, children, ...rest },
  ref,
) {
  return (
    <RadixDropdownMenu.Item
      ref={ref}
      className={cn(itemBase, destructive && itemDestructive, className)}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-auto text-xs text-nw-text-3">{shortcut}</span> : null}
    </RadixDropdownMenu.Item>
  );
});

export type MenuCheckboxItemProps = Omit<
  ComponentPropsWithoutRef<typeof RadixDropdownMenu.CheckboxItem>,
  'asChild'
>;

export const MenuCheckboxItem = forwardRef<HTMLDivElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem({ className, children, ...rest }, ref) {
    return (
      <RadixDropdownMenu.CheckboxItem
        ref={ref}
        className={cn(itemBase, 'pl-8', className)}
        {...rest}
      >
        <RadixDropdownMenu.ItemIndicator className="absolute left-3 inline-flex items-center text-nw-accent [&_svg]:text-nw-accent">
          <Check aria-hidden />
        </RadixDropdownMenu.ItemIndicator>
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </RadixDropdownMenu.CheckboxItem>
    );
  },
);

export type MenuLabelProps = Omit<
  ComponentPropsWithoutRef<typeof RadixDropdownMenu.Label>,
  'asChild'
>;

export function MenuLabel({ className, ...rest }: MenuLabelProps) {
  return <RadixDropdownMenu.Label className={cn('eyebrow border-b border-nw-border bg-nw-subtle px-3 py-1.5', className)} {...rest} />;
}

export type MenuSeparatorProps = Omit<
  ComponentPropsWithoutRef<typeof RadixDropdownMenu.Separator>,
  'asChild'
>;

export function MenuSeparator({ className, ...rest }: MenuSeparatorProps) {
  return (
    <RadixDropdownMenu.Separator className={cn('h-px bg-nw-border-strong', className)} {...rest} />
  );
}

export const MenuGroup = RadixDropdownMenu.Group;
