import * as Network from 'expo-network';
import { useEffect, useState } from 'react';

/**
 * Online / offline as the phone reports it. `isInternetReachable` can be unknown for a moment
 * after start; unknown counts as online so nothing is held back on a guess.
 */
export function isOnline(state: Network.NetworkState | null | undefined): boolean {
  if (!state) return true;
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

type Listener = (online: boolean) => void;
const listeners = new Set<Listener>();
let current = true;
let started = false;

function start(): void {
  if (started) return;
  started = true;
  Network.getNetworkStateAsync()
    .then((s) => publish(isOnline(s)))
    .catch(() => undefined);
  Network.addNetworkStateListener((s) => publish(isOnline(s)));
}

function publish(online: boolean): void {
  if (online === current) return;
  current = online;
  for (const listener of listeners) listener(online);
}

export function onlineNow(): boolean {
  start();
  return current;
}

export function subscribeOnline(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(onlineNow);
  useEffect(() => subscribeOnline(setOnline), []);
  return online;
}
