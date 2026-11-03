import { ExternalLink, X } from 'lucide-react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../Button';
import { IconButton } from '../IconButton';

export type DrawerSize = 'md' | 'lg' | 'xl';

export interface DrawerProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** md 480 · lg 640 · xl 800. Full width below 768px. */
  size?: DrawerSize;
  title?: ReactNode;
  description?: ReactNode;
  /** Rendered next to the title (a StatusBadge, for example). */
  headerExtra?: ReactNode;
  /** Slot under the header, e.g. a Tabs strip. */
  tabs?: ReactNode;
  footer?: ReactNode;
  /** Renders an "Open full page" button in the header. */
  onOpenFullPage?: () => void;
  children?: ReactNode;
  trigger?: ReactElement;
  /** Class name for the panel. */
  className?: string;
  /** Class name for the scrollable body. */
  bodyClassName?: string;
  /**
   * `dim` (default) shades the page behind the panel. `clear` leaves it as it is: for a panel
   * that works a queue on the screen behind it, which must stay readable while it is open. The
   * panel is still the only thing that takes focus and pointer input.
   */
  backdrop?: 'dim' | 'clear';
}

const sizes: Record<DrawerSize, string> = {
  md: 'md:w-120',
  lg: 'md:w-160',
  xl: 'md:w-200',
};

/** Right-edge detail panel (Radix dialog). ESC and overlay close; focus is trapped. */
export function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  size = 'md',
  title,
  description,
  headerExtra,
  tabs,
  footer,
  onOpenFullPage,
  children,
  trigger,
  className,
  bodyClassName,
  backdrop = 'dim',
}: DrawerProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
            backdrop === 'dim' ? 'bg-nw-backdrop' : 'bg-transparent',
          )}
        />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-full flex-col border-l border-nw-border-strong bg-nw-raised shadow-menu outline-none',
            'data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
            sizes[size],
            className,
          )}
        >
          <div className="flex min-h-12 items-start gap-3 border-b border-nw-border px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {title ? (
                  <Dialog.Title className="truncate text-md font-bold text-nw-text">
                    {title}
                  </Dialog.Title>
                ) : (
                  <VisuallyHidden.Root asChild>
                    <Dialog.Title>Details</Dialog.Title>
                  </VisuallyHidden.Root>
                )}
                {headerExtra}
              </div>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs text-nw-text-3">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <div className="-mt-1 -mr-1.5 flex shrink-0 items-center gap-1">
              {onOpenFullPage ? (
                <Button variant="ghost" size="sm" icon={<ExternalLink />} onClick={onOpenFullPage}>
                  Open full page
                </Button>
              ) : null}
              <Dialog.Close asChild>
                <IconButton label="Close" size="sm">
                  <X />
                </IconButton>
              </Dialog.Close>
            </div>
          </div>
          {tabs ? <div className="border-b border-nw-border px-5">{tabs}</div> : null}
          <div
            className={cn('scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}
          >
            {children}
          </div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-nw-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DrawerClose = Dialog.Close;
