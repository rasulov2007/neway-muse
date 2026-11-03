import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cursorStore } from './cursor';

/**
 * NeWay AI's cursor: an arrow with a small "NeWay AI" label that glides to the control it is about
 * to press, outlines it and shows a ripple on the press. Drawn above dialogs and never takes the
 * mouse (pointer-events: none), so the person's own pointer keeps working.
 */
export function DriveCursor() {
  const c = useSyncExternalStore(cursorStore.subscribe, cursorStore.get, cursorStore.get);
  if (!c.visible) return null;
  const glide = `transform ${c.duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
  return createPortal(
    <div data-ai-overlay aria-hidden className="pointer-events-none fixed inset-0 z-[200]">
      {c.ring ? (
        <div
          className="fixed rounded-[10px] border-2 border-nw-accent transition-all duration-200"
          style={{ left: c.ring.left - 4, top: c.ring.top - 4, width: c.ring.width + 8, height: c.ring.height + 8 }}
        />
      ) : null}
      <div className="absolute top-0 left-0" style={{ transform: `translate(${c.x}px, ${c.y}px)`, transition: glide }}>
        {c.ripples.map((r) => (
          <span key={r} className="absolute -top-4 -left-4 size-8 animate-ping rounded-full border-2 border-nw-accent" />
        ))}
        <svg width="22" height="24" viewBox="0 0 22 24" className="-mt-0.5 -ml-0.5 text-nw-accent drop-shadow-sm">
          <path d="M2 1.5 L2 19 L6.8 14.6 L10.2 22 L13.4 20.6 L10.1 13.4 L16.6 13.4 Z" fill="currentColor" className="stroke-nw-panel" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <span className="absolute top-5 left-4 rounded-full bg-nw-accent px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-nw-on-accent shadow-menu">NeWay AI</span>
      </div>
    </div>,
    document.body,
  );
}
