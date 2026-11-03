import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DotAppAnswers, DotAppMissingItem } from '@neway/shared';
import { ApiError, type DotAppClient } from './api';

export type SaveState = 'saved' | 'saving' | 'error' | 'conflict';

export interface SavedResult {
  version: number;
  lastSavedAt: string;
  ssnOnFile: boolean;
  ssnLast4: string | null;
  bankOnFile: boolean;
  bankLast4: string | null;
  missing: DotAppMissingItem[];
  sentSsn: string | undefined;
  sentBank: { routing: string; account: string } | undefined;
}

/**
 * Autosave (prototype queueSave): ~800 ms after typing stops, one request in flight at a time,
 * the version the page read sent with every save. A stale version (409 'stale') stops saving and
 * asks for a reload — never an overwrite. Offline waits for the 'online' event; a failed save
 * retries every few seconds.
 */
export function useAutosave(opts: {
  client: DotAppClient;
  version: number;
  lastSavedAt: string | null;
  answers: () => DotAppAnswers;
  ssn: () => string | undefined;
  /** ACH bank numbers, only when typed or changed and complete (sealed on the server, never echoed). */
  bank?: () => { routing: string; account: string } | undefined;
  onSaved: (r: SavedResult) => void;
  onConflict: () => void;
  onAuthLost: () => void;
  onFrozen: () => void;
}) {
  const o = useRef(opts);
  useLayoutEffect(() => {
    o.current = opts;
  });
  const [state, setState] = useState<SaveState>('saved');
  const [at, setAt] = useState<string | null>(opts.lastSavedAt);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const r = useRef({ version: opts.version, dirty: false, inflight: null as Promise<void> | null, timer: 0 as unknown as ReturnType<typeof setTimeout>, stopped: false });

  const self = useRef<() => Promise<void>>(async () => undefined);
  const run = useCallback(async (): Promise<void> => {
    const s = r.current;
    clearTimeout(s.timer);
    if (s.inflight) await s.inflight;
    if (s.stopped || !s.dirty) return;
    if (!navigator.onLine) {
      setOnline(false);
      return;
    }
    s.dirty = false;
    const answers = o.current.answers();
    const ssn = o.current.ssn();
    const bank = o.current.bank?.();
    setState('saving');
    let retrying = false;
    s.inflight = (async () => {
      try {
        const res = await o.current.client.save(s.version, answers, ssn, bank);
        s.version = res.version;
        setAt(res.lastSavedAt);
        o.current.onSaved({ ...res, sentSsn: ssn, sentBank: bank });
        setState(s.dirty ? 'saving' : 'saved');
      } catch (e) {
        s.dirty = true;
        const err = e instanceof ApiError ? e : new ApiError('Save failed.', 0);
        if (err.status === 409 && err.code === 'stale') {
          s.stopped = true;
          setState('conflict');
          o.current.onConflict();
        } else if (err.status === 409 && err.code === 'submitted') {
          s.stopped = true;
          o.current.onFrozen();
        } else if (err.status === 401) {
          s.stopped = true;
          o.current.onAuthLost();
        } else {
          setState('error');
          retrying = true;
          if (err.network && !navigator.onLine) setOnline(false);
          s.timer = setTimeout(() => void self.current(), err.network ? 3000 : 8000);
        }
      }
    })();
    try {
      await s.inflight;
    } finally {
      s.inflight = null;
    }
    if (s.dirty && !s.stopped && !retrying) s.timer = setTimeout(() => void self.current(), 800);
  }, []);

  useLayoutEffect(() => {
    self.current = run;
  }, [run]);

  const touch = useCallback(() => {
    const s = r.current;
    if (s.stopped) return;
    s.dirty = true;
    setState('saving');
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void run(), 800);
  }, [run]);

  /** Save now (before signing or submitting). True when everything is on the server. */
  const flush = useCallback(async (): Promise<boolean> => {
    await run();
    if (r.current.inflight) await r.current.inflight;
    return !r.current.dirty && !r.current.stopped;
  }, [run]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      if (r.current.dirty) void run();
    };
    const down = () => setOnline(false);
    const state = r.current;
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearTimeout(state.timer);
    };
  }, [run]);

  return { state, at, online, touch, flush, version: () => r.current.version, setVersion: (v: number) => (r.current.version = v) };
}

/** The prototype's saveStatus wording. */
export function saveLabel(online: boolean, state: SaveState, at: string | null, fmt: (iso: string) => string): { cls: string; text: string } {
  if (!online) return { cls: 'offline', text: 'Offline — not saved yet' };
  if (state === 'conflict') return { cls: 'offline', text: 'Not saved — reload to continue' };
  if (state === 'saving') return { cls: 'saving', text: 'Saving…' };
  if (state === 'error') return { cls: 'offline', text: 'Save failed — retrying' };
  return { cls: '', text: at ? `Saved ${fmt(at)}` : 'All changes saved' };
}
