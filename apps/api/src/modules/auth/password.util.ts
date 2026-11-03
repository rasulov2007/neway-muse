import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password storage.
 *
 * scrypt from the Node standard library rather than a dependency: the cost parameters are the
 * defaults (N=16384, r=8, p=1), the salt is 16 random bytes per password, and the comparison is
 * constant time. Stored as `scrypt$<salt hex>$<hash hex>` so the format can be recognised and
 * migrated later without guessing.
 */

const KEY_LENGTH = 64;
const PREFIX = 'scrypt';

/**
 * A temporary password an administrator can read down a phone line.
 *
 * Drawn from randomBytes, not Math.random, and from an alphabet with no 0/O, 1/l/I or 5/S, so
 * that reading it aloud cannot produce a different password than the one stored. Sixteen
 * characters from a 29-symbol alphabet is about 77 bits - far beyond the 10-character minimum,
 * and it only has to survive until first sign-in.
 */
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';

export function generateTemporaryPassword(): string {
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => TEMP_ALPHABET[b % TEMP_ALPHABET.length]);
  const group = (from: number) => chars.slice(from, from + 4).join('');
  return [group(0), group(4), group(8), group(12)].join('-');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** False for anything that is not a password this function stored — never throws on bad input. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== PREFIX || !saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
