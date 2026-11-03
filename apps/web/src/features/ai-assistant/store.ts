import { useSyncExternalStore } from 'react';

/**
 * NeWay AI's shell state: whether the drawer is open and which conversation is on screen. One
 * store, so the drawer and the full page show the same chat (owner brief, 2026-10-20). The active
 * conversation survives a reload in this tab only.
 */
interface AiState {
  open: boolean;
  activeId: string | null;
}

const KEY = 'neway.ai.active';
let state: AiState = { open: false, activeId: readActive() };
const listeners = new Set<() => void>();

function readActive(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

export const aiStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setOpen(open: boolean) {
    state = { ...state, open };
    emit();
  },
  setActive(activeId: string | null) {
    state = { ...state, activeId };
    try {
      if (activeId) sessionStorage.setItem(KEY, activeId);
      else sessionStorage.removeItem(KEY);
    } catch {
      // A private window keeps the chat for this page only.
    }
    emit();
  },
};

export function useAiStore(): AiState {
  return useSyncExternalStore(aiStore.subscribe, aiStore.get, aiStore.get);
}

/** Drafts per conversation, so a half-typed message survives moving around the app. */
export const drafts = {
  get(id: string | null): string {
    try {
      return sessionStorage.getItem(`neway.ai.draft.${id ?? 'new'}`) ?? '';
    } catch {
      return '';
    }
  },
  set(id: string | null, text: string) {
    try {
      if (text) sessionStorage.setItem(`neway.ai.draft.${id ?? 'new'}`, text);
      else sessionStorage.removeItem(`neway.ai.draft.${id ?? 'new'}`);
    } catch {
      // Not kept; nothing else depends on it.
    }
  },
};
