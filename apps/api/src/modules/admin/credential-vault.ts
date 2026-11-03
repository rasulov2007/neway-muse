import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../../config/env';

/**
 * Credentials at rest.
 *
 * AES-256-GCM. The key is derived from `APP_SECRET` — already required, already at least 32
 * characters — through HKDF with a fixed, purpose-specific info string, so the encryption key is
 * not `APP_SECRET` itself and compromising one does not hand over the other.
 *
 * Two properties worth stating plainly, because "encrypted" is a word that hides a lot:
 *
 *   - This protects a database dump, a backup file, or a stolen disk. It does **not** protect
 *     against someone who has both the database and `APP_SECRET`; that is what a KMS is for, and
 *     this system does not have one.
 *   - Nothing calls `decrypt` for a credential today. It exists because a connector will need it.
 *     No endpoint, logger, or serialiser in this codebase reads a credential back — the only
 *     thing that ever leaves the server is the four-character hint. The one caller of `decrypt`
 *     is the DOT application PDF, which prints the sealed social security number onto the
 *     document the qualification file keeps, and nowhere else.
 */

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const INFO = 'neway-tms:integration-credentials:v1';

/**
 * Each kind of secret gets its own derived key, so a key recovered for one purpose is useless for
 * another. `credentials` is the original and the default; `pii` seals the social security number
 * on a DOT application.
 */
export const VAULT_PURPOSES = {
  credentials: INFO,
  pii: 'neway-tms:applicant-pii:v1',
} as const;
export type VaultPurpose = keyof typeof VAULT_PURPOSES;

function key(purpose: VaultPurpose): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(env.APP_SECRET, 'utf8'),
      Buffer.alloc(0),
      VAULT_PURPOSES[purpose],
      KEY_LENGTH,
    ),
  );
}

export interface SealedCredential {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function encrypt(
  plaintext: string,
  purpose: VaultPurpose = 'credentials',
): SealedCredential {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(sealed: SealedCredential, purpose: VaultPurpose = 'credentials'): string {
  const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Seals every field of a credential set. Field names stay in the clear; values never do. */
export function sealAll(values: Record<string, string>): Record<string, SealedCredential> {
  const sealed: Record<string, SealedCredential> = {};
  for (const [name, value] of Object.entries(values)) sealed[name] = encrypt(value);
  return sealed;
}
