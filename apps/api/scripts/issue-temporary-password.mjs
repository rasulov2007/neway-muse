#!/usr/bin/env node
/**
 * Locked out? Issue a temporary password from the server.
 *
 * This is the break-glass path for the case the Users screen cannot fix: nobody can sign in, so
 * nobody can set anybody's password. It writes the same scrypt hash the API writes and marks the
 * account as needing a change at first sign-in, so the temporary credential dies on use.
 *
 * The password is printed on the terminal of whoever runs it and nowhere else — not in a log, not
 * in the database, not in an audit entry.
 *
 *   docker exec -it neway-tms-api-1 node apps/api/scripts/issue-temporary-password.mjs <email>
 *
 * Run it only on a machine you control, and hand the password over in person or by a channel you
 * trust. It is valid until the person signs in and replaces it.
 */

import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import postgres from 'postgres';

const scrypt = promisify(scryptCb);
const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: node issue-temporary-password.mjs <email>');
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run this inside the API container.');
  process.exit(2);
}

// No 0/O, 1/l/I or 5/S: this password gets read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
const bytes = randomBytes(16);
const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
const password = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');

const salt = randomBytes(16);
const derived = await scrypt(password, salt, 64);
const hash = `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;

const sql = postgres(url, { max: 1 });
try {
  const [user] = await sql`
    select id, email from users where lower(email) = ${email} limit 1
  `;
  if (!user) {
    console.error(`No account with the address ${email}.`);
    process.exit(1);
  }

  await sql`
    update users
       set password_hash = ${hash},
           must_change_password = true,
           is_active = true,
           updated_at = now()
     where id = ${user.id}
  `;
  // A changed password must not leave old browsers signed in.
  await sql`
    update auth_sessions set revoked_at = now()
     where user_id = ${user.id} and revoked_at is null
  `;
  // An invited membership becomes usable; a suspended one is left alone on purpose.
  await sql`
    update memberships set status = 'active'
     where user_id = ${user.id} and status = 'invited'
  `;

  console.log(`\nTemporary password for ${user.email}:\n\n    ${password}\n`);
  console.log('They must replace it at first sign-in. It is not stored anywhere in readable form.');
} finally {
  await sql.end({ timeout: 5 });
}
