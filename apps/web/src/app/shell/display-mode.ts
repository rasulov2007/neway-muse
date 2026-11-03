import { useCallback, useEffect, useState } from 'react';

/**
 * Display mode (owner, 2026-10-15): a dashboard shown on a wall screen or a TV attached to a
 * computer. The user turns it on - a big viewport is never taken to mean a TV. It hides the
 * sidebar and the top bar, enlarges the figures (CSS keyed on `data-display` on <html>, see
 * tokens.css) and asks the browser for fullscreen; Escape or the Exit button turns it off.
 * Nothing about the data changes: same company, same permissions, same refresh.
 */
export function useDisplayMode() {
  const [on, setOn] = useState(false);

  const exit = useCallback(() => {
    setOn(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  const enter = useCallback(() => {
    setOn(true);
    // Fullscreen is a courtesy; a browser that refuses it still gets the display layout.
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (on) root.setAttribute('data-display', 'on');
    else root.removeAttribute('data-display');
    return () => root.removeAttribute('data-display');
  }, [on]);

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
    };
    // Leaving fullscreen with the browser's own control leaves display mode too.
    const onFullscreen = () => {
      if (!document.fullscreenElement) setOn(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [on, exit]);

  return { on, enter, exit };
}
