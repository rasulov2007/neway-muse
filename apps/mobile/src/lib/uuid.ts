import * as Crypto from 'expo-crypto';

/** A v4 uuid, made on the phone — the idempotency key of a draft from the moment it exists. */
export function uuid(): string {
  return Crypto.randomUUID();
}
