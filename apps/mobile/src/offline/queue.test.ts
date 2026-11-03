import {
  MAX_AUTOMATIC_ATTEMPTS,
  STATUS_LABEL,
  applyOutcome,
  backoffMs,
  createItem,
  dueItems,
  outcomeForError,
  recoverInterrupted,
  resumeAfterSignIn,
  retryNow,
  submit,
  wakeOnReconnect,
  type NewItem,
  type QueueItem,
} from './queue-core';
import { QueueRunner, type QueueStore, type Sender } from './queue-runner';

const A = { companyId: 'co_a', membershipId: 'mem_1' };
const B = { companyId: 'co_a', membershipId: 'mem_2' };

function input(n = 1, files = 1): NewItem {
  return {
    id: `item_${n}`,
    idempotencyKey: `key_${n}`,
    kind: 'load-document',
    title: `POD ${n}`,
    payload: { loadId: 'L-1', documentType: 'pod' },
    files: Array.from({ length: files }, (_, i) => ({ uri: `file:///p${n}_${i}.jpg`, name: `p${i}.jpg`, type: 'image/jpeg' })),
  };
}

class MemoryStore implements QueueStore {
  rows = new Map<string, QueueItem>();
  async all() {
    return [...this.rows.values()].map((r) => JSON.parse(JSON.stringify(r)) as QueueItem);
  }
  async put(item: QueueItem) {
    this.rows.set(item.id, JSON.parse(JSON.stringify(item)) as QueueItem);
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
}

function apiError(kind: string, status = 0, detail = 'x') {
  return Object.assign(new Error(detail), { kind, status, detail });
}

describe('queue rules', () => {
  it('uses exactly the five driver-facing labels', () => {
    expect(Object.values(STATUS_LABEL)).toEqual([
      'Saved on phone',
      'Waiting to upload',
      'Uploading',
      'Received by TMS',
      'Upload failed',
    ]);
  });

  it('a new item is saved on the phone with its scope and key, and send makes it due', () => {
    const item = createItem(input(), A, 1000);
    expect(item).toMatchObject({ status: 'saved', companyId: 'co_a', membershipId: 'mem_1', idempotencyKey: 'key_1' });
    expect(dueItems([item], A, 1000, true)).toHaveLength(0);
    const sent = submit(item, 1000);
    expect(sent.status).toBe('waiting');
    expect(dueItems([sent], A, 1000, true)).toHaveLength(1);
  });

  it('never offers an item to another membership, nor while offline', () => {
    const sent = submit(createItem(input(), A, 0), 0);
    expect(dueItems([sent], B, 0, true)).toHaveLength(0);
    expect(dueItems([sent], null, 0, true)).toHaveLength(0);
    expect(dueItems([sent], A, 0, false)).toHaveLength(0);
  });

  it('backs off exponentially, capped, and fails after the automatic limit', () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(20)).toBe(15 * 60_000);
    let item = submit(createItem(input(), A, 0), 0);
    for (let i = 1; i < MAX_AUTOMATIC_ATTEMPTS; i++) {
      item = applyOutcome(item, { type: 'retry', message: 'offline' }, 0);
      expect(item.status).toBe('waiting');
      expect(item.nextAttemptAt).toBe(backoffMs(i));
    }
    item = applyOutcome(item, { type: 'retry', message: 'offline' }, 0);
    expect(item.status).toBe('failed');
    const again = retryNow(item, 50);
    expect(again).toMatchObject({ status: 'waiting', attempts: 0, nextAttemptAt: 50, lastError: null });
  });

  it('a 401 pauses the item for sign-in and only the same membership resumes it', () => {
    const paused = applyOutcome(submit(createItem(input(), A, 0), 0), { type: 'auth' }, 10);
    expect(paused).toMatchObject({ status: 'waiting', pausedForSignIn: true });
    expect(dueItems([paused], A, 10, true)).toHaveLength(0);
    expect(resumeAfterSignIn([paused], B, 20)[0]!.pausedForSignIn).toBe(true);
    const resumed = resumeAfterSignIn([paused], A, 20)[0]!;
    expect(resumed.pausedForSignIn).toBe(false);
    expect(dueItems([resumed], A, 20, true)).toHaveLength(1);
  });

  it('reconnecting makes backed-off items due at once; restarts put uploading items back', () => {
    const waiting = applyOutcome(submit(createItem(input(), A, 0), 0), { type: 'retry', message: 'x' }, 0);
    expect(dueItems([waiting], A, 1, true)).toHaveLength(0);
    expect(dueItems(wakeOnReconnect([waiting], A, 1), A, 1, true)).toHaveLength(1);
    const uploading = { ...waiting, status: 'uploading' as const };
    expect(recoverInterrupted([uploading], 5)[0]!.status).toBe('waiting');
  });

  it('maps API errors to queue outcomes', () => {
    expect(outcomeForError(apiError('offline')).type).toBe('retry');
    expect(outcomeForError(apiError('server', 500)).type).toBe('retry');
    expect(outcomeForError(apiError('unauthorized', 401)).type).toBe('auth');
    expect(outcomeForError(apiError('not_connected', 404)).type).toBe('not_ready');
    expect(outcomeForError(apiError('invalid', 422, 'Pick a stop')).type).toBe('fatal');
    expect(outcomeForError(apiError('invalid', 429)).type).toBe('retry');
  });
});

describe('QueueRunner', () => {
  function runner(store: QueueStore, sender: Sender, deleted: string[] = [], clock = { t: 1000 }) {
    return new QueueRunner({
      store,
      senders: { 'load-document': sender },
      now: () => clock.t,
      deleteFile: async (uri) => {
        deleted.push(uri);
      },
      setTimer: () => null,
      clearTimer: () => undefined,
    });
  }

  it('sends with the idempotency key, records each page, deletes files once received', async () => {
    const store = new MemoryStore();
    const deleted: string[] = [];
    const seen: string[] = [];
    const sender: Sender = async (item, ctx) => {
      for (let i = 0; i < item.files.length; i++) {
        if (item.files[i]!.done) continue;
        seen.push(`${item.idempotencyKey}:${i}`);
        ctx.onProgress(0.5);
        await ctx.fileDone(i, { page: i });
      }
      return { documentId: 'doc_1' };
    };
    const r = runner(store, sender, deleted);
    await r.setScope(A);
    await r.enqueue(input(1, 2));
    await r.run();
    const item = (await store.all())[0]!;
    expect(item.status).toBe('received');
    expect(item.result).toEqual({ documentId: 'doc_1' });
    expect(seen).toEqual(['key_1:0', 'key_1:1']);
    expect(deleted).toEqual(['file:///p1_0.jpg', 'file:///p1_1.jpg']);
  });

  it('resumes after the last finished page when a retry follows a failure', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const sent: number[] = [];
    const sender: Sender = async (item, ctx) => {
      calls++;
      for (let i = 0; i < item.files.length; i++) {
        if (item.files[i]!.done) continue;
        if (calls === 1 && i === 1) throw apiError('offline');
        sent.push(i);
        await ctx.fileDone(i, {});
      }
      return { ok: true };
    };
    const clock = { t: 1000 };
    const r = runner(store, sender, [], clock);
    await r.setScope(A);
    await r.enqueue(input(1, 3));
    await r.run();
    expect((await store.all())[0]!.status).toBe('waiting');
    clock.t += backoffMs(1);
    await r.run();
    expect((await store.all())[0]!.status).toBe('received');
    expect(sent).toEqual([0, 1, 2]);
  });

  it('pauses on 401, keeps the item through a restart, and never replays it under another account', async () => {
    const store = new MemoryStore();
    let fail401 = true;
    const sendsBy: string[] = [];
    const sender: Sender = async (item) => {
      sendsBy.push(item.membershipId);
      if (fail401) throw apiError('unauthorized', 401);
      return { ok: true };
    };
    const r1 = runner(store, sender);
    await r1.setScope(A);
    await r1.enqueue(input());
    await r1.run();
    expect((await store.all())[0]).toMatchObject({ status: 'waiting', pausedForSignIn: true });

    // App restarts; somebody else signs in on the phone.
    const r2 = runner(store, sender);
    await r2.setScope(B);
    await r2.run();
    expect(r2.visible()).toHaveLength(0);
    expect(sendsBy).toEqual(['mem_1']);

    // The original driver signs in again: it goes.
    fail401 = false;
    await r2.setScope(A);
    await r2.run();
    expect((await store.all())[0]!.status).toBe('received');
    expect(sendsBy).toEqual(['mem_1', 'mem_1']);
  });

  it('holds everything while offline and sends on reconnect', async () => {
    const store = new MemoryStore();
    const sender = jest.fn(async () => ({ ok: true }));
    const r = runner(store, sender);
    await r.setScope(A);
    await r.setOnline(false);
    await r.enqueue(input());
    await r.run();
    expect(sender).not.toHaveBeenCalled();
    expect((await store.all())[0]!.status).toBe('waiting');
    await r.setOnline(true);
    await r.run();
    expect(sender).toHaveBeenCalledTimes(1);
    expect((await store.all())[0]!.status).toBe('received');
  });

  it('sign-out clears only that membership and its files', async () => {
    const store = new MemoryStore();
    const deleted: string[] = [];
    const r = runner(store, async () => ({}), deleted);
    await r.setOnline(false);
    await r.setScope(A);
    await r.save(input(1));
    await r.setScope(B);
    await r.save(input(2));
    await r.clearScope(A);
    const left = await store.all();
    expect(left.map((i) => i.membershipId)).toEqual(['mem_2']);
    expect(deleted).toEqual(['file:///p1_0.jpg']);
  });

  it('a refused upload says Upload failed with the reason, and Retry sends it again', async () => {
    const store = new MemoryStore();
    let refuse = true;
    const r = runner(store, async () => {
      if (refuse) throw apiError('invalid', 422, 'Choose the stop this POD belongs to.');
      return { ok: true };
    });
    await r.setScope(A);
    const item = await r.enqueue(input());
    await r.run();
    expect(r.get(item.id)).toMatchObject({ status: 'failed', lastError: 'Choose the stop this POD belongs to.' });
    refuse = false;
    await r.retry(item.id);
    await r.run();
    expect(r.get(item.id)!.status).toBe('received');
  });
});
