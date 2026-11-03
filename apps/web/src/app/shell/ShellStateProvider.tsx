import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { demoMemberships } from '@/demo';
import {
  ShellStateContext,
  isEditableTarget,
  readStoredCollapsed,
  writeStoredCollapsed,
  type ShellState,
} from './shellState';

function initialCompanyId(): string {
  return demoMemberships.find((m) => m.isCurrent)?.companyId ?? demoMemberships[0]?.companyId ?? '';
}

function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/**
 * The router mounts the shell only after the first route chunk has loaded, so a Ctrl/⌘+K pressed
 * right after page load would otherwise be lost. This module evaluates with the static import
 * graph (before the `load` event); remember the request and open the palette on mount.
 */
let paletteRequestedBeforeMount = false;
function rememberEarlyPaletteRequest(event: KeyboardEvent) {
  if (isPaletteShortcut(event)) {
    event.preventDefault();
    paletteRequestedBeforeMount = true;
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', rememberEarlyPaletteRequest);
}

/**
 * Holds sidebar, overlay and tenant state for the shell, persists the collapse state and wires
 * the global shortcuts: `[` toggles the sidebar, Ctrl/⌘+K opens the command palette.
 */
export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(readStoredCollapsed);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Read-only here (StrictMode calls initializers twice); the effect below clears the flag.
  const [paletteOpen, setPaletteOpen] = useState(() => paletteRequestedBeforeMount);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeCompanyId, setActiveCompanyId] = useState(initialCompanyId);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeStoredCollapsed(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      writeStoredCollapsed(next);
      return next;
    });
  }, []);

  useEffect(() => {
    paletteRequestedBeforeMount = false;
    window.removeEventListener('keydown', rememberEarlyPaletteRequest);
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (
        event.key === '[' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapsed]);

  const value = useMemo<ShellState>(
    () => ({
      collapsed,
      setCollapsed,
      toggleCollapsed,
      mobileNavOpen,
      setMobileNavOpen,
      paletteOpen,
      setPaletteOpen,
      notificationsOpen,
      setNotificationsOpen,
      activeCompanyId,
      setActiveCompanyId,
    }),
    [
      collapsed,
      setCollapsed,
      toggleCollapsed,
      mobileNavOpen,
      paletteOpen,
      notificationsOpen,
      activeCompanyId,
    ],
  );

  return <ShellStateContext.Provider value={value}>{children}</ShellStateContext.Provider>;
}
