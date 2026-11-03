import type { ShellName } from './deep-link';

/** The web build (development and screenshots) has no push: these do nothing. */
export async function registerPushDevice(): Promise<void> {}

export function pushSupported(): boolean {
  return false;
}

export async function pushPreferences(): Promise<{ on: boolean; sound: boolean }> {
  return { on: false, sound: false };
}

export async function setPushPreferences(_next: { on: boolean; sound: boolean }): Promise<void> {}

export async function revokePushDevice(): Promise<void> {}

export function usePushRouting(_shell: ShellName | null): void {}
