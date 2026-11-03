import { t } from '../i18n/core';
import {
  applyOutcome,
  createItem,
  dueItems,
  expired,
  markFileDone,
  markUploading,
  nextWake,
  outcomeForError,
  progressOf,
  recoverInterrupted,
  resumeAfterSignIn,
  retryNow,
  sameScope,
  submit,
  wakeOnReconnect,
  type NewItem,
  type QueueItem,
  type QueueKind,
  type QueueScope,
} from './queue-core';

/** Where queue items live (SQLite on the phone, localStorage on the web build, memory in tests). */
export interface QueueStore {
  all(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Tools a sender gets: report progress and record a finished page so a retry resumes after it. */
export interface SendContext {
  onProgress(fraction: number): void;
  fileDone(index: number, response: unknown): Promise<void>;
}

/** Sends one item; resolves with the server's answer, rejects with the API error. */
export type Sender = (item: QueueItem, ctx: SendContext) => Promise<unknown>;

export interface RunnerDeps {
  store: QueueStore;
  senders: Partial<Record<QueueKind, Sender>>;
  now?: () => number;
  /** Removes a local file once the TMS has acknowledged it. */
  deleteFile?: (uri: string) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs the queue for the signed-in membership only. One item at a time, oldest first; survives
 * restarts because every change is written to the store before the next step.
 */
export class QueueRunner {
  private items = new Map<string, QueueItem>();
  private scope: QueueScope | null = null;
  private online = true;
  private running = false;
  private pass: Promise<void> | null = null;
  private rerun = false;
  private timer: unknown = null;
  private listeners = new Set<(items: QueueItem[]) => void>();
  private loaded: Promise<void> | null = null;
  private readonly deps: Required<Omit<RunnerDeps, 'deleteFile'>> & Pick<RunnerDeps, 'deleteFile'>;

  constructor(deps: RunnerDeps) {
    this.deps = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  /** Reads the store once, putting back anything a closed app left mid-upload. */
  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const now = this.deps.now();
        const stored = recoverInterrupted(await this.deps.store.all(), now);
        for (const item of stored) {
          if (expired(item, now)) {
            await this.deps.store.remove(item.id);
            continue;
          }
          this.items.set(item.id, item);
          await this.deps.store.put(item);
        }
        this.emit();
      })();
    }
    return this.loaded;
  }

  subscribe(listener: (items: QueueItem[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.visible());
    return () => this.listeners.delete(listener);
  }

  /** Only the signed-in membership's items are ever shown. */
  visible(): QueueItem[] {
    return [...this.items.values()].filter((i) => sameScope(i, this.scope)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): QueueItem | undefined {
    const item = this.items.get(id);
    return item && sameScope(item, this.scope) ? item : undefined;
  }

  /** Called on sign-in, switch and sign-out (null). A 401-paused item resumes only for its own scope. */
  async setScope(scope: QueueScope | null): Promise<void> {
    await this.load();
    this.scope = scope;
    if (scope) await this.replace(resumeAfterSignIn([...this.items.values()], scope, this.deps.now()));
    this.emit();
    void this.run();
  }

  async setOnline(online: boolean): Promise<void> {
    await this.load();
    const back = online && !this.online;
    this.online = online;
    if (back) await this.replace(wakeOnReconnect([...this.items.values()], this.scope, this.deps.now()));
    this.emit();
    void this.run();
  }

  /** Saves a new item on the phone (status Saved on phone). */
  async save(input: NewItem): Promise<QueueItem> {
    await this.load();
    if (!this.scope) throw new Error(t('Sign in first.'));
    const item = createItem(input, this.scope, this.deps.now());
    await this.write(item);
    return item;
  }

  /** Saves and hands to the queue in one step. */
  async enqueue(input: NewItem): Promise<QueueItem> {
    const saved = await this.save(input);
    return this.send(saved.id);
  }

  async send(id: string): Promise<QueueItem> {
    const item = this.get(id);
    if (!item) throw new Error(t('Not found on this phone.'));
    const next = submit(item, this.deps.now());
    await this.write(next);
    void this.run();
    return next;
  }

  async retry(id: string): Promise<void> {
    const item = this.get(id);
    if (!item) return;
    await this.write(retryNow(item, this.deps.now()));
    void this.run();
  }

  /** Deletes a draft or a finished item (and its files) from this phone. */
  async discard(id: string): Promise<void> {
    const item = this.get(id);
    if (!item || item.status === 'uploading') return;
    await this.dropFiles(item);
    this.items.delete(id);
    await this.deps.store.remove(id);
    this.emit();
  }

  /** Sign-out: every item of that membership leaves the phone. */
  async clearScope(scope: QueueScope): Promise<void> {
    await this.load();
    for (const item of [...this.items.values()]) {
      if (!sameScope(item, scope)) continue;
      await this.dropFiles(item);
      this.items.delete(item.id);
      await this.deps.store.remove(item.id);
    }
    this.emit();
  }

  /** Processes everything due; safe to call any time (one pass runs at once). */
  run(): Promise<void> {
    if (this.pass) {
      this.rerun = true;
      return this.pass;
    }
    this.pass = this.loop().finally(() => {
      this.pass = null;
    });
    return this.pass;
  }

  private async loop(): Promise<void> {
    await this.load();
    this.running = true;
    try {
      do {
        this.rerun = false;
        const due = dueItems([...this.items.values()], this.scope, this.deps.now(), this.online);
        for (const candidate of due) {
          // The scope may change mid-pass (sign-out); re-check before each item.
          if (!sameScope(candidate, this.scope) || !this.online) break;
          await this.process(candidate.id);
        }
      } while (this.rerun);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async process(id: string): Promise<void> {
    let item = this.items.get(id);
    if (!item || item.status !== 'waiting') return;
    const sender = this.deps.senders[item.kind];
    if (!sender) {
      await this.write(applyOutcome(item, { type: 'not_ready', message: t('This version of the app cannot send this yet.') }, this.deps.now()));
      return;
    }
    item = markUploading(item, this.deps.now());
    await this.write(item);

    const ctx: SendContext = {
      onProgress: (fraction) => {
        const current = this.items.get(id);
        if (!current || current.status !== 'uploading') return;
        this.items.set(id, { ...current, progress: progressOf(current, fraction) });
        this.emit();
      },
      fileDone: async (index, response) => {
        const current = this.items.get(id);
        if (current) await this.write(markFileDone(current, index, response, this.deps.now()));
      },
    };

    let outcome;
    try {
      const result = await sender(this.items.get(id) ?? item, ctx);
      outcome = { type: 'ok' as const, result };
    } catch (error) {
      outcome = outcomeForError(error as { kind?: string; status?: number; message?: string; detail?: string });
    }
    const latest = this.items.get(id) ?? item;
    const next = applyOutcome(latest, outcome, this.deps.now());
    await this.write(next);
    if (next.status === 'received') await this.dropFiles(next);
  }

  private schedule(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (!this.online) return;
    const wake = nextWake([...this.items.values()], this.scope);
    if (wake === null) return;
    const delay = Math.max(0, wake - this.deps.now());
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run();
    }, Math.min(delay, 2 ** 31 - 1));
  }

  private async dropFiles(item: QueueItem): Promise<void> {
    if (!this.deps.deleteFile) return;
    for (const file of item.files) {
      try {
        await this.deps.deleteFile(file.uri);
      } catch {
        // already gone
      }
    }
  }

  private async write(item: QueueItem): Promise<void> {
    this.items.set(item.id, item);
    await this.deps.store.put(item);
    this.emit();
  }

  private async replace(items: QueueItem[]): Promise<void> {
    for (const item of items) {
      if (this.items.get(item.id) !== item) await this.write(item);
    }
  }

  private emit(): void {
    const visible = this.visible();
    for (const listener of this.listeners) listener(visible);
  }
}
