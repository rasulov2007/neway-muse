import type { QueueItem } from './queue-core';
import type { QueueStore } from './queue-runner';

/**
 * The web build (development and screenshots) keeps the queue in localStorage instead of SQLite,
 * which on the web needs cross-origin isolation the dev server does not give. Same shape, same
 * rules; storage can be blocked, so every access is guarded and falls back to memory.
 */
const QUEUE_KEY = 'neway.queue.v1';
const DRAFT_KEY = 'neway.drafts.v1';
const memory = new Map<string, string>();

function read(key: string): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: Record<string, unknown>): void {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    globalThis.localStorage?.setItem(key, raw);
  } catch {
    // memory only
  }
}

export const queueStore: QueueStore = {
  async all() {
    return Object.values(read(QUEUE_KEY)) as QueueItem[];
  },
  async put(item) {
    const all = read(QUEUE_KEY);
    all[item.id] = item;
    write(QUEUE_KEY, all);
  },
  async remove(id) {
    const all = read(QUEUE_KEY);
    delete all[id];
    write(QUEUE_KEY, all);
  },
};

export const draftStore = {
  async get<T>(scope: string, key: string): Promise<T | null> {
    return (read(DRAFT_KEY)[`${scope}|${key}`] as T | undefined) ?? null;
  },
  async set(scope: string, key: string, value: unknown): Promise<void> {
    const all = read(DRAFT_KEY);
    all[`${scope}|${key}`] = value;
    write(DRAFT_KEY, all);
  },
  async remove(scope: string, key: string): Promise<void> {
    const all = read(DRAFT_KEY);
    delete all[`${scope}|${key}`];
    write(DRAFT_KEY, all);
  },
  async clearScope(scope: string): Promise<void> {
    const all = read(DRAFT_KEY);
    for (const k of Object.keys(all)) if (k.startsWith(`${scope}|`)) delete all[k];
    write(DRAFT_KEY, all);
  },
};
