import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type TooltipProviderProps = ComponentProps<typeof RadixTooltip.Provider>;

/** Mount once near the app root. 200ms open delay, shared across tooltips. */
export function TooltipProvider({ delayDuration = 200, ...rest }: TooltipProviderProps) {
  return <RadixTooltip.Provider delayDuration={delayDuration} {...rest} />;
}

export interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A single focusable element; receives the trigger props. */
  children: ReactElement;
  className?: string;
}

/** Tooltip on the --nw-tooltip-bg surface. Renders the child alone when `content` is empty. */
export function Tooltip({
  content,
  side = 'top',
  align = 'center',
  sideOffset = 4,
  open,
  defaultOpen,
  onOpenChange,
  children,
  className,
}: TooltipProps) {
  if (content === null || content === undefined || content === false || content === '') {
    return children;
  }
  return (
    <RadixTooltip.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'z-50 max-w-xs rounded-sm bg-nw-tooltip-bg px-2 py-1 text-xs text-nw-tooltip-text select-none',
            'data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in',
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
