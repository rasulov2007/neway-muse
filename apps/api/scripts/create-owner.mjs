#!/usr/bin/env node
/**
 * Creates (or repairs) an owner account that can sign in.
 *
 * Written for the case where the product itself cannot help: an administrator account is needed
 * before anybody can use the Users screen, because setting a password requires being signed in.
 * It is additive — an existing account with the same address is updated, never replaced, and no
 * other row is touched.
 *
 *   node apps/api/scripts/create-owner.mjs <identifier> <password> [First] [Last]
 *
 * The identifier is what gets typed into the sign-in box: an email address, or a plain name such
 * as `admin`. The password is read from the command line, so run this on a machine you control and
 * clear your shell history if the account is meant to stay private.
 */

import { randomBytes, randomUUID, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import postgres from 'postgres';

const scrypt = promisify(scryptCb);

const identifier = process.argv[2]?.trim().toLowerCase();
const password = process.argv[3];
const firstName = process.argv[4] ?? 'System';
const lastName = process.argv[5] ?? 'Administrator';

if (!identifier || !password) {
  console.error('Usage: node create-owner.mjs <identifier> <password> [First] [Last]');
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const salt = randomBytes(16);
const derived = await scrypt(password, salt, 64);
const passwordHash = `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;

const sql = postgres(url, { max: 1 });
try {
  const [company] = await sql`select id from companies order by created_at limit 1`;
  if (!company) throw new Error('No company exists yet; start the API once so the roster seeds.');

  // System roles are platform-wide (`company_id is null`); a carrier may also define its own.
  const [role] = await sql`
    select id from roles
     where code = 'administrator'
       and (company_id = ${company.id} or company_id is null)
     order by company_id nulls last
     limit 1
  `;
  if (!role) throw new Error('The administrator role is missing; start the API once to seed it.');

  const [existing] = await sql`
    select id from users where lower(email) = ${identifier} limit 1
  `;

  const userId = existing?.id ?? `usr_${randomUUID()}`;
  if (existing) {
    await sql`
      update users
         set password_hash = ${passwordHash},
             must_change_password = false,
             is_active = true,
             updated_at = now()
       where id = ${userId}
    `;
  } else {
    await sql`
      insert into users (id, email, first_name, last_name, password_hash, must_change_password, is_active)
      values (${userId}, ${identifier}, ${firstName}, ${lastName}, ${passwordHash}, false, true)
    `;
  }

  const [membership] = await sql`
    select id from memberships
     where company_id = ${company.id} and user_id = ${userId}
     limit 1
  `;

  // A company has exactly one owner — the account that cannot be disabled. If one already exists,
  // this account gets the administrator role instead, which grants the same permissions without
  // creating a second "last administrator" nobody is allowed to remove.
  const [owner] = await sql`
    select id from memberships
     where company_id = ${company.id} and is_owner = true
     limit 1
  `;
  const takeOwnership = !owner || owner.id === (membership?.id ?? null);
  const membershipId = membership?.id ?? `mbr_${randomUUID()}`;
  if (membership) {
    await sql`
      update memberships
         set status = 'active',
             is_owner = ${takeOwnership},
             accepted_at = coalesce(accepted_at, now())
       where id = ${membershipId}
    `;
  } else {
    await sql`
      insert into memberships (id, company_id, user_id, status, is_owner, accepted_at)
      values (${membershipId}, ${company.id}, ${userId}, 'active', ${takeOwnership}, now())
    `;
  }

  // The owner flag decides nothing on its own; the administrator role is what grants permissions.
  await sql`
    insert into membership_roles (membership_id, role_id, assigned_by_name)
    values (${membershipId}, ${role.id}, 'create-owner script')
    on conflict do nothing
  `;

  // A new credential must not leave older sessions alive.
  await sql`update auth_sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;

  console.log(
    `Administrator account ready: ${identifier} (membership ${membershipId})` +
      `${takeOwnership ? ', as the company owner' : '; the existing owner was left in place'}.`,
  );
  console.log('Sign in with the password you passed to this script. It is stored only as a hash.');
} finally {
  await sql.end({ timeout: 5 });
}
