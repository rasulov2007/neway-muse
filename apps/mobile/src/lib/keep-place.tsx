import { useNavigationContainerRef } from 'expo-router';
import { useEffect } from 'react';

/**
 * Switching the appearance or the language redraws the whole tree below the theme (every colour
 * and word is read at render time). Redrawing remounts the navigators, which would drop the person
 * back on their first page; so the place they were at (the whole navigation state, every stack and
 * tab) is remembered just before the switch and put back right after it.
 */
type RootState = ReturnType<ReturnType<typeof useNavigationContainerRef>['getRootState']>;

let remembered: RootState | null = null;

/** Called by the theme and language providers just before they redraw. */
export function useRememberPlace(): () => void {
  const ref = useNavigationContainerRef();
  return () => {
    try {
      remembered = ref.isReady() ? ref.getRootState() : null;
    } catch {
      remembered = null;
    }
  };
}

/** Mounted inside the redrawn tree: once the navigators are back, restores the remembered place. */
export function RestorePlace() {
  const ref = useNavigationContainerRef();
  useEffect(() => {
    const state = remembered;
    if (!state) return;
    remembered = null;
    const t = setTimeout(() => {
      try {
        if (ref.isReady()) ref.reset(state);
      } catch {
        // the shape of the app changed under it (signed out meanwhile): stay where the app put us
      }
    }, 0);
    return () => clearTimeout(t);
  }, [ref]);
  return null;
}
