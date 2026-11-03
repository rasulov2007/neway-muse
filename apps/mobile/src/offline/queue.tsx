import { t } from '../i18n/core';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, uploadRaw } from '@/api/client';
import {
  UPLOAD_HEADERS,
  routes,
  type DriverDocumentUploadResponse,
  type DriverFileUploadResponse,
  type DriverPtiSubmitRequest,
  type DriverStopEventRequest,
} from '@/api/contract';

import { queueStore } from './db';
import { deleteFile } from './files';
import { subscribeOnline, onlineNow } from './network';
import type { NewItem, QueueItem } from './queue-core';
import { QueueRunner, type SendContext, type Sender } from './queue-runner';

/**
 * How each kind of queued item reaches the TMS (docs/mobile/PLAN.md §D, backend M1). Every request
 * carries the item's Idempotency-Key, so a retry after a lost answer returns the first result and
 * never files a second record. A scanned paper is ONE file (a PDF when it has several pages).
 */
const sendLoadDocument: Sender = async (item, ctx) => {
  const { loadId, docType, stopId, pageCount, replacesId } = item.payload as {
    loadId: string;
    docType: string;
    stopId?: string | null;
    pageCount: number;
    replacesId?: string | null;
  };
  const file = item.files[0];
  if (!file) throw new Error(t('The scan is missing from this phone.'));
  if (file.done) return file.response;
  const headers: Record<string, string> = {
    [UPLOAD_HEADERS.docType]: docType,
    [UPLOAD_HEADERS.pageCount]: String(pageCount || 1),
  };
  if (stopId) headers[UPLOAD_HEADERS.stopId] = stopId;
  if (replacesId) headers[UPLOAD_HEADERS.replacesId] = replacesId;
  const response = await uploadRaw<DriverDocumentUploadResponse>(routes.driverLoadDocuments(loadId), {
    fileUri: file.uri,
    fileName: file.name,
    contentType: file.type,
    idempotencyKey: item.idempotencyKey,
    headers,
    onProgress: ctx.onProgress,
  });
  await ctx.fileDone(0, response);
  return response;
};

/**
 * Sends each file of an item to POST /driver/files (once: a finished file is never sent again) and
 * returns the stored ids in order, with each file's tag.
 */
async function uploadDriverFiles(item: QueueItem, ctx: SendContext): Promise<Array<{ fileId: string; tag: string | null }>> {
  const out: Array<{ fileId: string; tag: string | null }> = [];
  for (let i = 0; i < item.files.length; i++) {
    const file = item.files[i]!;
    let response = file.response as DriverFileUploadResponse | undefined;
    if (!file.done) {
      response = await uploadRaw<DriverFileUploadResponse>(routes.driverFiles, {
        fileUri: file.uri,
        fileName: file.name,
        contentType: file.type,
        idempotencyKey: `${item.idempotencyKey}:file${i + 1}`,
        onProgress: ctx.onProgress,
      });
      await ctx.fileDone(i, response);
    }
    if (response?.fileId) out.push({ fileId: response.fileId, tag: file.tag ?? null });
  }
  return out;
}

const sendPti: Sender = async (item, ctx) => {
  const uploaded = await uploadDriverFiles(item, ctx);
  const payload = item.payload as DriverPtiSubmitRequest;
  // A photo tagged with a checklist key belongs to that item; the rest are the walk-around's.
  const body: DriverPtiSubmitRequest = {
    ...payload,
    checklist: payload.checklist.map((c) => ({
      ...c,
      photoFileIds: [...(c.photoFileIds ?? []), ...uploaded.filter((u) => u.tag === c.key).map((u) => u.fileId)],
    })),
    photoFileIds: uploaded.filter((u) => !u.tag).map((u) => u.fileId),
  };
  return api.post(routes.driverPti, body, { idempotencyKey: item.idempotencyKey });
};

/** What a 'driver-post' item carries: the route, the JSON body, and where the file ids go. */
export interface DriverPostPayload {
  route: string;
  body: Record<string, unknown>;
  /** Body field that receives the uploaded file ids. */
  fileField?: string;
  /** `array` (default) appends every id; `single` sets the first one. */
  fileMode?: 'array' | 'single';
  /** Anything the screens want to find the item by (a load id, a conversation id). */
  ref?: Record<string, string | null>;
}

const sendDriverPost: Sender = async (item, ctx) => {
  const { route, body, fileField, fileMode = 'array' } = item.payload as unknown as DriverPostPayload;
  const uploaded = await uploadDriverFiles(item, ctx);
  const next: Record<string, unknown> = { ...body };
  if (fileField && uploaded.length) {
    if (fileMode === 'single') next[fileField] = uploaded[0]!.fileId;
    else next[fileField] = [...((next[fileField] as string[] | undefined) ?? []), ...uploaded.map((u) => u.fileId)];
  }
  return api.post(route, next, { idempotencyKey: item.idempotencyKey });
};

const sendStopEvent: Sender = async (item) => {
  const { loadId, ...body } = item.payload as { loadId: string } & DriverStopEventRequest;
  return api.post(routes.driverStopEvent(loadId), body, { idempotencyKey: item.idempotencyKey });
};

const sendLoadAck: Sender = async (item) => {
  const { loadId } = item.payload as { loadId: string };
  return api.post(routes.driverLoadAck(loadId), {}, { idempotencyKey: item.idempotencyKey });
};

export const queue = new QueueRunner({
  store: queueStore,
  deleteFile,
  senders: {
    'load-document': sendLoadDocument,
    pti: sendPti,
    'stop-event': sendStopEvent,
    'load-ack': sendLoadAck,
    breakdown: sendDriverPost,
    reimbursement: sendDriverPost,
    care: sendDriverPost,
    referral: sendDriverPost,
    vacation: sendDriverPost,
    'vacation-parked': sendDriverPost,
    'vacation-cancel': sendDriverPost,
    'driver-document': sendDriverPost,
    'safety-report': sendDriverPost,
    conversation: sendDriverPost,
    message: sendDriverPost,
  },
});

/**
 * Resolves when the item reaches the TMS (with the server's answer) or stops (failed / waiting
 * offline after `timeoutMs`): a screen that needs the answer — a new conversation's id — waits a
 * moment, and otherwise tells the person it is kept on the phone.
 */
export function waitForItem(id: string, timeoutMs = 15_000): Promise<QueueItem | null> {
  return new Promise((resolve) => {
    let settled = false;
    let off: () => void = () => undefined;
    const finish = (value: QueueItem | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // subscribe() calls the listener synchronously, before `off` is assigned.
      setTimeout(() => off(), 0);
      resolve(value);
    };
    const timer = setTimeout(() => finish(queue.get(id) ?? null), timeoutMs);
    off = queue.subscribe((items) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      if (item.status === 'received' || item.status === 'failed') finish(item);
    });
  });
}

interface QueueApi {
  items: QueueItem[];
  enqueue(input: NewItem): Promise<QueueItem>;
  save(input: NewItem): Promise<QueueItem>;
  send(id: string): Promise<QueueItem>;
  retry(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}

const QueueContext = createContext<QueueApi | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<QueueItem[]>([]);

  useEffect(() => {
    void queue.load();
    void queue.setOnline(onlineNow());
    const offItems = queue.subscribe(setItems);
    const offOnline = subscribeOnline((online) => void queue.setOnline(online));
    return () => {
      offItems();
      offOnline();
    };
  }, []);

  const value = useMemo<QueueApi>(
    () => ({
      items,
      enqueue: (input) => queue.enqueue(input),
      save: (input) => queue.save(input),
      send: (id) => queue.send(id),
      retry: (id) => queue.retry(id),
      discard: (id) => queue.discard(id),
    }),
    [items],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueApi {
  const value = useContext(QueueContext);
  if (!value) throw new Error('useQueue outside QueueProvider');
  return value;
}
