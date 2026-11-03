import type * as LocalAuthModule from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { t } from '@/i18n/core';

/**
 * Face ID / fingerprint unlock (mobile M6). Off by default; the person turns it on after a
 * password sign-in or in Settings. When on, the session token already kept in the keychain
 * (api/token-store) is only used after the phone confirms the owner's face or finger; the
 * password itself is never stored. Signing out turns it off.
 *
 * expo-local-authentication ships in Expo Go. In Expo Go on iOS Face ID is not allowed (Expo
 * Go's Info.plist has no Face ID purpose string) and the phone asks for the passcode instead; a
 * development or store build carries NSFaceIDUsageDescription from app.json.
 */
const ENABLED_KEY = 'neway.biometric.enabled';
const OFFERED_KEY = 'neway.biometric.offered';

let loaded: typeof LocalAuthModule | null | undefined;
function auth(): typeof LocalAuthModule | null {
  if (loaded !== undefined) return loaded;
  if (Platform.OS === 'web') return (loaded = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('expo-local-authentication') as typeof LocalAuthModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'device';

export interface BiometricSupport {
  available: boolean;
  kind: BiometricKind;
  /** "Face ID", "Fingerprint", "Face unlock" … for labels. */
  label: string;
}

export async function biometricSupport(): Promise<BiometricSupport> {
  const la = auth();
  const none: BiometricSupport = { available: false, kind: 'device', label: t('Face ID / fingerprint') };
  if (!la) return none;
  try {
    const [hardware, enrolled, types] = await Promise.all([la.hasHardwareAsync(), la.isEnrolledAsync(), la.supportedAuthenticationTypesAsync()]);
    if (!hardware || !enrolled) return none;
    const T = la.AuthenticationType;
    if (types.includes(T.FACIAL_RECOGNITION)) return { available: true, kind: 'face', label: Platform.OS === 'ios' ? t('Face ID') : t('Face unlock') };
    if (types.includes(T.FINGERPRINT)) return { available: true, kind: 'fingerprint', label: Platform.OS === 'ios' ? t('Touch ID') : t('Fingerprint') };
    if (types.includes(T.IRIS)) return { available: true, kind: 'iris', label: t('Iris unlock') };
    return { ...none, available: true };
  } catch {
    return none;
  }
}

async function read(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // keychain unavailable: the feature simply stays off
  }
}

export async function biometricEnabled(): Promise<boolean> {
  return (await read(ENABLED_KEY)) === '1';
}

export async function setBiometricEnabled(on: boolean): Promise<void> {
  await write(ENABLED_KEY, on ? '1' : null);
  if (on) await write(OFFERED_KEY, '1');
}

/** Whether the "use it next time?" question was already asked on this phone. */
export async function biometricOffered(): Promise<boolean> {
  return (await read(OFFERED_KEY)) === '1';
}

export async function markBiometricOffered(): Promise<void> {
  await write(OFFERED_KEY, '1');
}

export type BiometricResult = 'success' | 'cancel' | 'unavailable' | 'failed';

/** Asks the phone to confirm the owner. The passcode is offered when the biometric fails. */
export async function authenticate(prompt: string): Promise<BiometricResult> {
  const la = auth();
  if (!la) return 'unavailable';
  try {
    const result = await la.authenticateAsync({ promptMessage: prompt, cancelLabel: t('Use password'), disableDeviceFallback: false });
    if (result.success) return 'success';
    const error = (result as { error?: string }).error ?? '';
    if (error === 'user_cancel' || error === 'system_cancel' || error === 'app_cancel' || error === 'user_fallback') return 'cancel';
    if (error === 'not_enrolled' || error === 'not_available' || error === 'passcode_not_set') return 'unavailable';
    return 'failed';
  } catch {
    return 'failed';
  }
}
