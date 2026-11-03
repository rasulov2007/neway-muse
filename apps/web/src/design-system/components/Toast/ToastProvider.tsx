import { X } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { StatusSymbol } from '../Badge/StatusSymbol';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { ToastContext, type ToastItem, type ToastOptions, type ToastTone } from './ToastContext';

export interface ToastProviderProps {
  children: ReactNode;
  /** Auto-dismiss delay in ms. Hovering the toast pauses it. */
  duration?: number;
  /** Maximum toasts on screen; the rest wait in a queue. */
  max?: number;
}

/* The status symbol per tone (SPEC §7 toasts): done, info, warning, urgent. */
const toneIcon: Record<ToastTone, ReactNode> = {
  success: <StatusSymbol family="done" size={16} className="text-nw-done-icon" />,
  info: <StatusSymbol family="info" size={16} className="text-nw-neutral-icon" />,
  warning: <StatusSymbol family="warning" size={16} className="text-nw-warning-icon" />,
  danger: <StatusSymbol family="urgent" size={16} className="text-nw-urgent-icon" />,
};

const toneLabel: Record<ToastTone, string> = {
  success: 'Success',
  info: 'Info',
  warning: 'Warning',
  danger: 'Error',
};

// Time for the exit animation before the item leaves the queue.
const EXIT_MS = 200;

/** Mount once near the app root. Renders the bottom-right toast viewport. */
export function ToastProvider({ children, duration = 5000, max = 4 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const close = useCallback(
    (id: string) => {
      setToasts((list) => list.map((t) => (t.id === id ? { ...t, open: false } : t)));
      window.setTimeout(() => remove(id), EXIT_MS);
    },
    [remove],
  );

  const toast = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setToasts((list) => [...list, { ...options, id, open: true }]);
    return id;
  }, []);

  const dismiss = useCallback(
    (id?: string) => {
      if (id) close(id);
      else for (const t of toasts) close(t.id);
    },
    [close, toasts],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider duration={duration} swipeDirection="right" label="Notification">
        {children}
        {toasts.slice(0, max).map((item) => (
          <ToastView key={item.id} item={item} onClose={() => close(item.id)} />
        ))}
        <RadixToast.Viewport
          className={cn(
            'fixed right-4 bottom-4 z-100 flex w-90 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none',
          )}
        />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const tone = item.tone ?? 'info';
  return (
    <RadixToast.Root
      open={item.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      duration={item.duration}
      className={cn(
        'flex items-start gap-3 rounded-lg border border-nw-border-strong bg-nw-raised p-3 shadow-menu',
        'data-[state=open]:animate-toast-in data-[state=closed]:animate-fade-out',
        'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=cancel]:translate-x-0',
        'data-[swipe=end]:animate-toast-out',
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">
        <span className="sr-only">{toneLabel[tone]}: </span>
        {toneIcon[tone]}
      </span>
      <div className="min-w-0 flex-1">
        <RadixToast.Title className="text-sm font-semibold text-nw-text">{item.title}</RadixToast.Title>
        {item.description ? (
          <RadixToast.Description className="mt-0.5 text-xs text-nw-text-3">
            {item.description}
          </RadixToast.Description>
        ) : null}
        {item.action ? (
          <RadixToast.Action asChild altText={item.action.altText ?? item.action.label}>
            <Button variant="link" size="sm" className="mt-1.5" onClick={item.action.onClick}>
              {item.action.label}
            </Button>
          </RadixToast.Action>
        ) : null}
      </div>
      <RadixToast.Close asChild>
        <IconButton label="Dismiss" size="sm" className="-mt-1 -mr-1">
          <X />
        </IconButton>
      </RadixToast.Close>
    </RadixToast.Root>
  );
}
