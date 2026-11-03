import * as SecureStore from 'expo-secure-store';

/** The bearer token lives in the phone's keychain / keystore, never in plain storage. */
const KEY = 'neway.session.token';

export async function readToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function writeToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
