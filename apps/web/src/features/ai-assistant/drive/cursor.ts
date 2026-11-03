import { sleep } from './dom';

/**
 * The AI cursor's position, as a small store the overlay draws. `moveTo` resolves when the glide
 * has finished, so the runner presses only once the cursor is on the control.
 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CursorState {
  visible: boolean;
  x: number;
  y: number;
  /** Glide time of the current move, ms. */
  duration: number;
  /** One id per press still rippling; each fades after ~half a second. */
  ripples: number[];
  /** The control being worked on, outlined. */
  ring: Box | null;
}

/** Tests turn the animation off: moves and pauses take no time. */
export const driveConfig = { animate: true };

let state: CursorState = { visible: false, x: 0, y: 0, duration: 0, ripples: [], ring: null };
let rippleId = 0;
const listeners = new Set<() => void>();
const set = (next: Partial<CursorState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const cursorStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Glides to (x, y) in 400-600 ms, by distance. */
  async moveTo(x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (!state.visible) {
      // It comes in from the corner where the chat lives.
      set({ visible: true, x: window.innerWidth - 90, y: window.innerHeight - 90, duration: 0 });
      if (driveConfig.animate) await sleep(30, signal);
    }
    const dist = Math.hypot(x - state.x, y - state.y);
    const duration = !driveConfig.animate ? 0 : reducedMotion() ? 120 : Math.round(Math.min(600, Math.max(400, 400 + dist * 0.2)));
    set({ x, y, duration });
    await sleep(duration, signal);
  },
  async ripple(signal?: AbortSignal): Promise<void> {
    const id = ++rippleId;
    set({ ripples: [...state.ripples, id] });
    setTimeout(() => set({ ripples: state.ripples.filter((r) => r !== id) }), 520);
    if (driveConfig.animate) await sleep(160, signal);
  },
  ring(box: Box | null) {
    set({ ring: box });
  },
  hide() {
    set({ visible: false, ring: null });
  },
};
