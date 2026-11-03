import { Popover as RadixPopover } from 'radix-ui';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';
import { popoverMotion, popoverSurface } from './popoverStyles';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export type PopoverContentProps = ComponentPropsWithoutRef<typeof RadixPopover.Content> & {
  /**
   * Where the panel is portalled to. Defaults to the document body.
   *
   * Inside a modal it must be the dialog itself: a panel portalled to the body sits outside the
   * dialog's scroll lock, which cancels every wheel event over it — the list is scrollable and
   * simply refuses to scroll.
   */
  container?: HTMLElement | null;
};

/** Portalled, token-styled popover panel. Default width 288px with 12px padding; override via `className`. */
export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent({ className, align = 'start', sideOffset = 4, container, ...rest }, ref) {
    return (
      <RadixPopover.Portal container={container ?? undefined}>
        <RadixPopover.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          className={cn(popoverSurface, popoverMotion, 'w-72 p-3', className)}
          {...rest}
        />
      </RadixPopover.Portal>
    );
  },
);
