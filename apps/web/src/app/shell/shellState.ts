import { createContext, useContext } from 'react';

/** localStorage key for the persisted sidebar collapse state. */
export const SIDEBAR_STORAGE_KEY = 'neway.sidebar.collapsed';

export interface ShellState {
  /** Desktop sidebar collapsed to icons. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  /** Slide-over navigation below the `lg` breakpoint. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;
  /** Active tenant (demo only until authentication lands in Phase 3). */
  activeCompanyId: string;
  setActiveCompanyId: (companyId: string) => void;
}

export const ShellStateContext = createContext<ShellState | null>(null);

/** Shell-wide UI state: sidebar, overlays and the active company. */
export function useShellState(): ShellState {
  const ctx = useContext(ShellStateContext);
  if (!ctx) throw new Error('useShellState must be used inside <AppShell>');
  return ctx;
}

export function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
  } catch {
    // Private mode or storage disabled: the state simply does not persist.
  }
}

/** True when a keystroke happened inside a text field, so single-key shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** Human label for the command palette shortcut. */
export const PALETTE_SHORTCUT = isMac ? '⌘ K' : 'Ctrl K';
