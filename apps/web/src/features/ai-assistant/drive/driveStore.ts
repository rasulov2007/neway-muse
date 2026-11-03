import type { AiClientToolCall, AiMessageView } from '@neway/shared';
import { useSyncExternalStore } from 'react';
import { cursorStore } from './cursor';
import { sleep } from './dom';
import { chatPanelOpen, isExcluded } from './snapshot';
import { runScreenTool, type RunnerHost } from './runner';

/**
 * One screen run at a time: the browser runs the tool calls the server handed over, posts the
 * results, and repeats until the answer has no more screen steps. Kept outside React so the run
 * survives the chat panel closing and pages changing. The person stays in control: Stop cancels
 * at once, and their own click or key press outside the chat pauses the run until they say
 * Continue.
 */

export type DrivePhase = 'idle' | 'running' | 'confirm' | 'paused' | 'done';

export interface DriveAsk {
  verb: string;
  name: string;
  where: string;
}

export interface DriveState {
  phase: DrivePhase;
  conversationId: string | null;
  messageId: string | null;
  /** The live step line: "Clicking ‘Create invoice’…". */
  line: string;
  /** What NeWay AI last said. */
  said: string;
  ask: DriveAsk | null;
  error: string | null;
}

export interface DriveResultsBody {
  messageId: string;
  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
  stop: boolean;
}

export interface DriveDeps {
  conversationId: string;
  dryRun: boolean;
  post: (conversationId: string, body: DriveResultsBody) => Promise<{ messages: AiMessageView[] }>;
  /** Each answer the server sends back while the run goes on (the chat updates its cache). */
  onMessage: (message: AiMessageView) => void;
}

const IDLE: DriveState = { phase: 'idle', conversationId: null, messageId: null, line: '', said: '', ask: null, error: null };
let state: DriveState = IDLE;
const listeners = new Set<() => void>();
const set = (next: Partial<DriveState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

let navigateFn: ((to: string) => Promise<void>) | null = null;
let abort: AbortController | null = null;
let stopRequested = false;
let resumeWaiters: Array<() => void> = [];
let askResolve: ((ok: boolean) => void) | null = null;

const STOPPED = 'Cancelled: the person pressed Stop.';

function release() {
  const w = resumeWaiters;
  resumeWaiters = [];
  w.forEach((f) => f());
}

/** The person's own click or key outside the chat hands control back to them. */
function onPersonInput(e: Event) {
  if (!e.isTrusted || stopRequested || state.phase !== 'running') return;
  const t = e.target as Element | null;
  if (t && typeof t.closest === 'function' && isExcluded(t)) return;
  set({ phase: 'paused' });
}

function listen(on: boolean) {
  const f = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
  f('pointerdown', onPersonInput, true);
  f('keydown', onPersonInput, true);
}

export const driveStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** The router's navigate, registered by the dock (it lives inside the router). */
  setNavigate(fn: ((to: string) => Promise<void>) | null) {
    navigateFn = fn;
  },
  active: () => state.phase === 'running' || state.phase === 'confirm' || state.phase === 'paused',

  /** Runs the screen steps of `message` and every answer after it. */
  async start(message: AiMessageView, deps: DriveDeps): Promise<void> {
    if (!message.pendingClientTools?.length || driveStore.active()) return;
    abort = new AbortController();
    stopRequested = false;
    set({ ...IDLE, phase: 'running', conversationId: deps.conversationId, messageId: message.id, said: message.text, line: 'Starting…' });
    listen(true);
    let current: AiMessageView = message;
    try {
      // The chat drawer slides away first: while it is open the page behind it is inert.
      for (let i = 0; i < 40 && chatPanelOpen(); i++) await sleep(50, abort.signal).catch(() => undefined);
      while (current.pendingClientTools?.length) {
        const results = await runAll(current.pendingClientTools, deps.dryRun);
        set({ line: stopRequested ? 'Stopping…' : 'Thinking…' });
        const r = await deps.post(deps.conversationId, { messageId: current.id, results, stop: stopRequested });
        const next = r.messages[0];
        if (!next) break;
        deps.onMessage(next);
        current = next;
        set({ messageId: next.id, said: next.text });
        if (stopRequested) break;
      }
      set({ phase: 'done', line: stopRequested ? 'Stopped.' : 'Done.', ask: null });
    } catch (e) {
      set({ phase: 'done', line: 'Stopped.', ask: null, error: e instanceof Error ? e.message : 'NeWay AI could not go on.' });
    } finally {
      listen(false);
      cursorStore.hide();
      abort = null;
    }
  },

  /** Stop: the step in progress is abandoned, the rest are reported as cancelled. */
  stop() {
    if (!driveStore.active()) return;
    stopRequested = true;
    abort?.abort();
    askResolve?.(false);
    release();
    set({ line: 'Stopping…', ask: null, phase: 'running' });
  },
  /** Continue after the person took over. */
  resume() {
    if (state.phase !== 'paused') return;
    set({ phase: 'running' });
    release();
  },
  answer(ok: boolean) {
    const r = askResolve;
    askResolve = null;
    set({ ask: null, phase: stopRequested ? state.phase : 'running' });
    r?.(ok);
  },
  dismiss() {
    if (driveStore.active()) return;
    set(IDLE);
  },
};

async function runAll(calls: AiClientToolCall[], dryRun: boolean) {
  const results: DriveResultsBody['results'] = [];
  const host: RunnerHost = {
    dryRun,
    signal: abort!.signal,
    navigate: async (to) => {
      if (!navigateFn) throw new Error('The app cannot open pages right now.');
      await navigateFn(to);
    },
    confirm: (ask) =>
      new Promise<boolean>((resolve) => {
        askResolve = resolve;
        set({ phase: 'confirm', ask });
      }),
    waitIfPaused: () =>
      state.phase !== 'paused'
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            resumeWaiters.push(resolve);
          }),
    step: (line) => set({ line }),
  };
  for (const call of calls) {
    if (stopRequested) {
      results.push({ tool_use_id: call.id, content: STOPPED, is_error: true });
      continue;
    }
    try {
      await host.waitIfPaused();
      if (stopRequested) throw new DOMException('Stopped', 'AbortError');
      const out = await runScreenTool(call, host);
      results.push({ tool_use_id: call.id, content: out.content, is_error: out.isError });
    } catch (e) {
      const stopped = stopRequested || (e instanceof DOMException && e.name === 'AbortError');
      results.push({ tool_use_id: call.id, content: stopped ? STOPPED : `The step failed in the browser: ${e instanceof Error ? e.message : String(e)}`, is_error: true });
    }
  }
  return results;
}

export function useDrive(): DriveState {
  return useSyncExternalStore(driveStore.subscribe, driveStore.get, driveStore.get);
}
