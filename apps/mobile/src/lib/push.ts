import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import type * as NotificationsModule from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { api } from '@/api/client';
import { routes, type MobileDevice, type RegisterDeviceRequest } from '@/api/contract';
import { draftStore } from '@/offline/db';

import { hrefFor, type ShellName } from './deep-link';

/**
 * Push registration and taps. Needs a real phone, the person's permission and the EAS project id
 * in app.json (extra.eas.projectId) — until those exist registration quietly does nothing. The
 * server stores the token against the membership and session (POST /mobile/devices); a push
 * carries only {type, id}: a tap opens that record, read with the current session, so access is
 * checked again then. Sign-out revokes the device (and the server revokes the session's devices).
 */
const APP_SCOPE = '_app';
const DEVICE_KEY = 'pushDeviceId';
/** The person turned push off for this phone in Settings (local; the server simply has no device). */
const OFF_KEY = 'pushOff';
/** Play a sound for a push that arrives while the app is open (this phone only). */
const SOUND_KEY = 'pushSound';
let playSound = false;

/**
 * expo-notifications is loaded only where push exists: a development/store build on a phone.
 * Expo Go (Android, SDK 53+) has no push module at all — importing it at the top crashed the app
 * on start ("Cannot find native module 'ExpoTopicSubscriptionModule'", owner's phone 2026-10-27).
 */
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
let loaded: typeof NotificationsModule | null | undefined;
function notifications(): typeof NotificationsModule | null {
  if (loaded !== undefined) return loaded;
  if (Platform.OS === 'web' || inExpoGo) return (loaded = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as typeof NotificationsModule;
    // A push that arrives while the app is open still shows as a banner; it never plays a sound.
    mod.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: playSound, shouldSetBadge: false }),
    });
    loaded = mod;
  } catch {
    loaded = null;
  }
  return loaded;
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId || Constants.easConfig?.projectId || null;
}

/** Whether this build on this phone can receive push at all (not Expo Go, not web, a project id). */
export function pushSupported(): boolean {
  return Boolean(notifications() && Device.isDevice && projectId());
}

export async function pushPreferences(): Promise<{ on: boolean; sound: boolean }> {
  const [off, sound] = await Promise.all([draftStore.get<boolean>(APP_SCOPE, OFF_KEY), draftStore.get<boolean>(APP_SCOPE, SOUND_KEY)]);
  playSound = sound === true;
  return { on: off !== true, sound: sound === true };
}

/** Settings: push on/off for this phone (registers or revokes the device) and the in-app sound. */
export async function setPushPreferences(next: { on: boolean; sound: boolean }): Promise<void> {
  playSound = next.sound;
  await draftStore.set(APP_SCOPE, SOUND_KEY, next.sound);
  await draftStore.set(APP_SCOPE, OFF_KEY, !next.on);
  if (next.on) await registerPushDevice();
  else await revokePushDevice();
}

export async function registerPushDevice(): Promise<void> {
  const Notifications = notifications();
  if (!Notifications || !Device.isDevice) return;
  if ((await draftStore.get<boolean>(APP_SCOPE, OFF_KEY)) === true) return;
  const id = projectId();
  if (!id) return;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'NeWay TMS', importance: Notifications.AndroidImportance.HIGH });
    }
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;
    const { data: expoToken } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const body: RegisterDeviceRequest = {
      expoToken,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: Constants.expoConfig?.version ?? null,
    };
    const device = await api.post<MobileDevice>(routes.devices, body);
    if (device?.id) await draftStore.set(APP_SCOPE, DEVICE_KEY, device.id);
  } catch {
    // Not available on this phone or server; the bell inside the app still works.
  }
}

/** Sign-out: this phone stops receiving pushes for the account (kept across restarts). */
export async function revokePushDevice(): Promise<void> {
  const id = await draftStore.get<string>(APP_SCOPE, DEVICE_KEY);
  if (!id) return;
  await draftStore.remove(APP_SCOPE, DEVICE_KEY);
  try {
    await api.post(routes.deviceRevoke(id));
  } catch {
    // The server also revokes the session's devices when it ends.
  }
}

interface PushData {
  type?: string;
  id?: string;
  parentId?: string | null;
  notificationId?: string;
}

/**
 * Opens the record a tapped push names: while the app runs (foreground or background) and when the
 * tap started the app (cold start). Waits until someone is signed in; each response is handled once.
 */
export function usePushRouting(shell: ShellName | null): void {
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const Notifications = notifications();
    if (!shell || !Notifications) return;
    const open = (response: NotificationsModule.NotificationResponse | null) => {
      if (!response) return;
      const key = response.notification.request.identifier;
      if (handled.current.has(key)) return;
      handled.current.add(key);
      const data = (response.notification.request.content.data ?? {}) as PushData;
      if (data.notificationId) void api.post(routes.notificationRead(data.notificationId)).catch(() => undefined);
      const href = data.type && data.id ? hrefFor(shell, { type: data.type, id: data.id, parentId: data.parentId ?? null }) : null;
      router.push(href ?? (shell === 'driver' ? '/driver/notifications' : '/office/notifications'));
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    };
    void Notifications.getLastNotificationResponseAsync().then(open, () => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [shell]);
}
