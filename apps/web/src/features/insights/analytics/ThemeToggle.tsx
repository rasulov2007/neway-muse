import { Moon, Sun } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { useReducedMotion } from '@/design-system';
import { useAuth } from '@/features/auth/auth-context';
import { chooseAppearance } from '@/features/auth/appearance';

/** The theme on screen now, from the `data-theme` attribute appearance.js keeps on <html>. */
function readTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('neway:appearance', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    window.removeEventListener('neway:appearance', onChange);
    observer.disconnect();
  };
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Light / dark switch on the Analytics header (owner, 2026-10-25).
 *
 * It saves through the same `chooseAppearance` as the account menu, so the choice lands in
 * `users.appearance` and follows the worker to every computer. The new theme grows as a circle
 * from the button (View Transitions, 620 ms); without that API, or with reduced motion, it simply
 * changes.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light' as const);
  const { account } = useAuth();
  const reduced = useReducedMotion();
  const button = useRef<HTMLButtonElement>(null);
  const next = theme === 'dark' ? 'light' : 'dark';

  function apply() {
    void chooseAppearance(account?.userId ?? '', next);
  }

  function onClick() {
    const doc = document as ViewTransitionDocument;
    if (reduced || typeof doc.startViewTransition !== 'function') {
      apply();
      return;
    }
    const rect = button.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const root = document.documentElement.style;
    root.setProperty('--nw-an-wipe-x', `${x}px`);
    root.setProperty('--nw-an-wipe-y', `${y}px`);
    root.setProperty('--nw-an-wipe-r', `${radius}px`);
    doc.startViewTransition(() => flushSync(apply));
  }

  const label = next === 'dark' ? 'Switch to dark theme' : 'Switch to light theme';
  return (
    <button
      ref={button}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-9 items-center justify-center rounded-an-pill border border-an-card-border bg-an-card text-nw-text-2 shadow-an-card transition-colors hover:text-nw-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-an-accent"
    >
      {theme === 'dark' ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
    </button>
  );
}
