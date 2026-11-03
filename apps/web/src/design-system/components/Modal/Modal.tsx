import { X } from 'lucide-react';
import { Dialog, VisuallyHidden } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { IconButton } from '../IconButton';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** sm 420 · md 560 · lg 760 */
  size?: ModalSize;
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned action row. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Optional element that opens the modal. */
  trigger?: ReactElement;
  /** Keep the title for screen readers only. */
  hideTitle?: boolean;
  /** When false, hides the close button and ignores Escape / outside clicks (e.g. while submitting). */
  dismissible?: boolean;
  /** Class name for the panel. */
  className?: string;
}

const sizes: Record<ModalSize, string> = {
  sm: 'max-w-105',
  md: 'max-w-140',
  lg: 'max-w-190',
};

/** Centered Radix dialog. Focus is trapped and restored; the title is always rendered for a11y. */
export function Modal({
  open,
  defaultOpen,
  onOpenChange,
  size = 'md',
  title,
  description,
  footer,
  children,
  trigger,
  hideTitle = false,
  dismissible = true,
  className,
}: ModalProps) {
  const titleHidden = hideTitle || !title;
  const hasHeader = !titleHidden || description || dismissible;
  const block = (e: Event) => e.preventDefault();

  const titleNode = titleHidden ? (
    <VisuallyHidden.Root asChild>
      <Dialog.Title>{title ?? 'Dialog'}</Dialog.Title>
    </VisuallyHidden.Root>
  ) : (
    <Dialog.Title className="text-md font-bold text-nw-text">{title}</Dialog.Title>
  );

  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-nw-backdrop data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onEscapeKeyDown={dismissible ? undefined : block}
          onPointerDownOutside={dismissible ? undefined : block}
          onInteractOutside={dismissible ? undefined : block}
          className={cn(
            // Near-fullscreen on a phone; dvh so the browser bar and the keyboard never hide the footer.
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] -translate-x-1/2 -translate-y-1/2 flex-col sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)]',
            'rounded-lg border border-nw-border-strong bg-nw-raised shadow-menu outline-none',
            'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out',
            sizes[size],
            className,
          )}
        >
          {hasHeader ? (
            <div className="flex items-start justify-between gap-4 px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
              <div className="min-w-0 flex-1">
                {titleNode}
                {description ? (
                  <Dialog.Description className="mt-1 text-xs text-nw-text-3">
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
              {dismissible ? (
                <Dialog.Close asChild>
                  <IconButton label="Close" size="sm" className="-mt-1.5 -mr-1.5">
                    <X />
                  </IconButton>
                </Dialog.Close>
              ) : null}
            </div>
          ) : (
            titleNode
          )}
          <div
            className={cn(
              'scroll-quiet min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-4 text-sm text-nw-text-2 sm:px-5 sm:pb-5',
              !hasHeader && 'pt-4 sm:pt-5',
            )}
          >
            {children}
          </div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-nw-border px-4 py-3 sm:px-5">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalClose = Dialog.Close;
