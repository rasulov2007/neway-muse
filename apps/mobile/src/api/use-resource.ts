import { t } from '../i18n/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOnline } from '@/offline/network';

import { ApiError, api } from './client';

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'error'; error: ApiError };

export type ResourceWithReload<T> = Resource<T> & { reload: () => void };

/**
 * GET one route and keep its state honest: "Loading…" until an answer arrives, the error kind
 * when it fails (offline, no permission, not connected yet), never a made-up zero. Reloads when
 * the screen regains focus and when the phone comes back online.
 */
export function useResource<T>(path: string | null): ResourceWithReload<T> {
  const [state, setState] = useState<Resource<T>>({ status: 'loading' });
  const online = useOnline();
  const seq = useRef(0);
  const wasOnline = useRef(online);

  const load = useCallback(
    (soft: boolean) => {
      if (!path) return;
      const id = ++seq.current;
      setState((prev) =>
        soft && prev.status === 'ready' ? { ...prev, refreshing: true } : { status: 'loading' },
      );
      api
        .get<T>(path)
        .then((data) => {
          if (id === seq.current) setState({ status: 'ready', data, refreshing: false });
        })
        .catch((error: unknown) => {
          if (id !== seq.current) return;
          const e =
            error instanceof ApiError ? error : new ApiError('server', 0, t('Something went wrong'), String(error));
          // A refresh that fails offline keeps what is on screen; the banner says why.
          setState((prev) =>
            soft && prev.status === 'ready' && e.kind === 'offline'
              ? { ...prev, refreshing: false }
              : { status: 'error', error: e },
          );
        });
    },
    [path],
  );

  useFocusEffect(
    useCallback(() => {
      load(true);
    }, [load]),
  );

  useEffect(() => {
    if (online && !wasOnline.current) load(true);
    wasOnline.current = online;
  }, [online, load]);

  return { ...state, reload: () => load(false) } as ResourceWithReload<T>;
}
