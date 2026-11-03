import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/**
 * "Show me" (owner, 2026-10-20): NeWay AI opens a page and points at the control to press - a
 * ring around it and a short hint beside it, like a person showing a colleague. The control is
 * found by what it says on screen (its text or accessible name), the way the guide names it.
 */
interface Guide {
  target: string;
  hint: string;
  at: number;
}

let current: Guide | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const guideStore = {
  show(target: string, hint: string) {
    current = { target, hint, at: Date.now() };
    emit();
  },
  clear() {
    current = null;
    emit();
  },
};

function useGuide() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The visible control whose words match best: exact, then starts with, then contains. */
function findTarget(label: string): HTMLElement | null {
  const want = norm(label);
  if (!want) return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="tab"], [role="menuitem"], [role="option"], [role="button"], label, th, summary, input, select, textarea'));
  const visible = nodes.filter((n) => {
    if (n.closest('[data-ai-chat]')) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const words = (n: HTMLElement) => norm(n.getAttribute('aria-label') || n.textContent || (n as HTMLInputElement).placeholder || '');
  return (
    visible.find((n) => words(n) === want) ??
    visible.find((n) => words(n).startsWith(want)) ??
    visible.find((n) => words(n).includes(want) && words(n).length < want.length + 40) ??
    null
  );
}

export function GuideOverlay() {
  const guide = useGuide();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const [missing, setMissing] = useState(false);

  // Look for the control for a few seconds: the page may still be loading.
  useEffect(() => {
    setEl(null);
    setBox(null);
    setMissing(false);
    if (!guide) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const found = findTarget(guide.target);
      if (found) {
        window.clearInterval(timer);
        found.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setEl(found);
      } else if (++tries > 30) {
        window.clearInterval(timer);
        setMissing(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [guide]);

  // Follow the control as the page scrolls or resizes; pressing it ends the guide.
  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const measure = () => {
      setBox(el.isConnected ? el.getBoundingClientRect() : null);
      raf = requestAnimationFrame(measure);
    };
    measure();
    const done = () => window.setTimeout(() => guideStore.clear(), 150);
    el.addEventListener('click', done);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('click', done);
    };
  }, [el]);

  useEffect(() => {
    if (!guide) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && guideStore.clear();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [guide]);

  if (!guide) return null;
  if (missing) {
    return createPortal(
      <div className="fixed right-5 bottom-20 z-[60] flex max-w-sm items-start gap-2 rounded-[10px] bg-nw-tooltip-bg px-3 py-2 text-sm text-nw-tooltip-text shadow-menu">
        <span>
          Look for <strong>“{guide.target}”</strong> on this page. {guide.hint}
        </span>
        <button type="button" aria-label="Close" className="cursor-pointer opacity-70 hover:opacity-100" onClick={() => guideStore.clear()}>
          <X className="size-4" />
        </button>
      </div>,
      document.body,
    );
  }
  if (!box) return null;
  const pad = 6;
  const below = box.bottom + 120 < window.innerHeight;
  const left = Math.min(Math.max(12, box.left), window.innerWidth - 332);
  return createPortal(
    <>
      <div
        aria-hidden
        className="nw-pulse pointer-events-none fixed z-[60] rounded-[10px] border-[3px] border-nw-accent"
        style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2, boxShadow: '0 0 0 9999px var(--nw-backdrop)' }}
      />
      <div
        role="status"
        className="fixed z-[61] flex w-80 items-start gap-2 rounded-[10px] bg-nw-tooltip-bg px-3 py-2 text-sm text-nw-tooltip-text shadow-menu"
        style={below ? { left, top: box.bottom + pad + 8 } : { left, top: box.top - pad - 8, transform: 'translateY(-100%)' }}
      >
        <span className="min-w-0 flex-1">
          <strong>Press “{guide.target}”.</strong> {guide.hint}
        </span>
        <button type="button" aria-label="Close" className="cursor-pointer opacity-70 hover:opacity-100" onClick={() => guideStore.clear()}>
          <X className="size-4" />
        </button>
      </div>
    </>,
    document.body,
  );
}
