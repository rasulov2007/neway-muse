import { createContext, type ReactNode } from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Screen-reader alternative describing what happens if the action is missed. */
  altText?: string;
}

export interface ToastOptions {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastAction;
  /** Milliseconds before auto-dismiss; defaults to the provider's 5000. */
  duration?: number;
}

export interface ToastItem extends ToastOptions {
  id: string;
  open: boolean;
}

export interface ToastContextValue {
  /** Show a toast; returns its id. */
  toast: (options: ToastOptions) => string;
  /** Dismiss one toast, or all when called without an id. */
  dismiss: (id?: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
