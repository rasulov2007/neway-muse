#!/usr/bin/env node
/**
 * One command for the hackathon demo stack: database + API + web, local only.
 *
 *   node scripts/hackathon/demo-up.mjs                 real local PostgreSQL (127.0.0.1:5432), db neway_demo
 *   node scripts/hackathon/demo-up.mjs --pglite        PGlite fallback on 127.0.0.1:5433 (see pglite-server.mjs)
 *
 * Options:
 *   --api-port 3100      API port (default 3100, so it does not fight a dev server on 3000)
 *   --web-port 5180      web port (default 5180)
 *   --seed               re-seed the demo company even if it is already there
 *   --no-build           skip building packages/shared and the API (use the last build)
 *   --keep-fresh         keep ELD positions and load times fresh every 5 min (for long recordings)
 *
 * Ctrl+C stops the API, the web server and (in --pglite mode) the database. A real PostgreSQL is
 * left running. Logs go to scripts/hackathon/logs/. The Meta key comes from the
 * META_API_KEY environment variable, or else from a key file (META_KEY_FILE, default
 * %USERPROFILE%/.neway-secrets/meta-llama.env with a line LLAMA_API_KEY=... or META_API_KEY=...).
 * It is passed to the API process only and never printed or written anywhere.
 *
 * No cmd.exe and no npm scripts: every child is node (or postgres) started directly, so this
 * works where cmd.exe is blocked.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const usePglite = flag('pglite');
const apiPort = Number(opt('api-port', '3100'));
const webPort = Number(opt('web-port', '5180'));
const dbPort = usePglite ? Number(opt('db-port', '5433')) : Number(opt('db-port', '5432'));
const DATABASE_URL = process.env.DEMO_DATABASE_URL ?? `postgres://neway:neway@127.0.0.1:${dbPort}/neway_demo`;
const logDir = join(here, 'logs');
mkdirSync(logDir, { recursive: true });

const children = [];
let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  for (const c of children.reverse()) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

function start(name, args, { cwd = root, env = {} } = {}) {
  const log = createWriteStream(join(logDir, `${name}.log`), { flags: 'w' });
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${name} exited (${code}). See ${join(logDir, `${name}.log`)}`);
      stopAll(1);
    }
  });
  children.push(child);
  return child;
}

function runNode(label, args, { cwd = root, env = {} } = {}) {
  process.stdout.write(`${label}… `);
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    console.log('failed');
    console.error((r.stdout ?? '') + (r.stderr ?? '') + (r.error ? String(r.error) : ''));
    process.exit(1);
  }
  console.log('done');
  return r.stdout;
}

const portOpen = (port) =>
  new Promise((ok) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.end();
      ok(true);
    });
    s.on('error', () => ok(false));
    s.setTimeout(1500, () => {
      s.destroy();
      ok(false);
    });
  });

async function waitFor(what, check, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`${what} did not come up in ${seconds}s`);
  stopAll(1);
  await new Promise(() => {});
}

function metaKey() {
  if (process.env.META_API_KEY) return process.env.META_API_KEY;
  const file = process.env.META_KEY_FILE ?? join(homedir(), '.neway-secrets', 'meta-llama.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:LLAMA_API_KEY|META_API_KEY)\s*=\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

async function ensureDatabase() {
  if (usePglite) {
    if (!(await portOpen(dbPort))) {
      start('pglite', [join(here, 'pglite-server.mjs'), '--port', String(dbPort)]);
      await waitFor('PGlite', () => portOpen(dbPort), 60);
    }
    console.log(`database: PGlite on 127.0.0.1:${dbPort}`);
    return;
  }
  if (!(await portOpen(dbPort))) {
    // Same as `npm run db:start`, without going through npm/cmd.
    const pgHome = process.env.PGSQL_HOME ?? join(homedir(), 'pgsql');
    const pgCtl = join(pgHome, 'pgsql', 'bin', 'pg_ctl.exe');
    if (!existsSync(pgCtl)) {
      console.error(`PostgreSQL is not listening on 127.0.0.1:${dbPort} and ${pgCtl} was not found. Start it (npm run db:start) or use --pglite.`);
      process.exit(1);
    }
    console.log('starting PostgreSQL…');
    spawnSync(pgCtl, ['-D', join(pgHome, 'data'), '-l', join(pgHome, 'log', 'postgres.log'), '-w', 'start'], { stdio: 'inherit', windowsHide: true });
    await waitFor('PostgreSQL', () => portOpen(dbPort), 30);
  }
  // Create neway_demo (owned by neway) the first time, as the postgres superuser.
  const postgres = require('postgres');
  const admin = postgres(`postgres://postgres:${process.env.PG_SUPERUSER_PASSWORD ?? 'postgres'}@127.0.0.1:${dbPort}/postgres`, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await admin`select 1 as ok from pg_database where datname = 'neway_demo'`;
    if (!exists) {
      await admin.unsafe('create database neway_demo owner neway');
      console.log('created database neway_demo');
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  console.log(`database: PostgreSQL 127.0.0.1:${dbPort}/neway_demo`);
}

async function companySeeded() {
  const postgres = require('postgres');
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`select count(*)::int as n from trucks where company_id = 'co_silkway_demo'`;
    return row.n > 0;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  for (const [name, port] of [['API', apiPort], ['web', webPort]]) {
    if (await portOpen(port)) {
      console.error(`${name} port ${port} is already in use. Pick another with --${name === 'API' ? 'api' : 'web'}-port.`);
      process.exit(1);
    }
  }
  await ensureDatabase();

  if (!flag('no-build')) {
    runNode('building packages/shared', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: join(root, 'packages/shared') });
    runNode('building the API', [join(root, 'node_modules/@nestjs/cli/bin/nest.js'), 'build'], { cwd: join(root, 'apps/api') });
  }

  const key = metaKey();
  console.log(key ? 'Meta key: found (passed to the API as META_API_KEY)' : 'Meta key: not found - NeWay AI will say it is not set up');
  const apiEnv = {
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL,
    DATABASE_POOL_MAX: usePglite ? '1' : '10',
    APP_SECRET: process.env.APP_SECRET ?? 'hackathon-demo-local-secret-0123456789abcdef',
    SEED_DEMO_DATA: 'false',
    FLEET_V2: 'true',
    PM_MODULE: 'true',
    SAFETY_V2: 'true',
    ACCIDENTS_V2: 'true',
    INTEGRATION_SYNC_INTERVAL_MINUTES: '0',
    SAMSARA_POSITIONS_INTERVAL_MINUTES: '0',
    STORAGE_LOCAL_PATH: join(here, '.data', 'storage'),
    LOG_LEVEL: 'warn',
    ...(key ? { META_API_KEY: key, RC_READER_PROVIDER: 'muse' } : {}),
  };
  start('api', [join(root, 'apps/api/dist/main.js')], { cwd: join(root, 'apps/api'), env: apiEnv });
  await waitFor('API', async () => {
    try {
      return (await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`)).ok;
    } catch {
      return false;
    }
  }, 180);
  console.log(`API: http://127.0.0.1:${apiPort}/api/v1/health`);

  const seedEnv = { DATABASE_URL };
  if (flag('seed') || !(await companySeeded())) {
    process.stdout.write(runNode('seeding Silk Way Demo Lines', [join(here, 'seed-demo.mjs')], { env: seedEnv }));
  } else {
    runNode('refreshing positions', [join(here, 'seed-demo.mjs'), '--positions-only'], { env: seedEnv });
  }
  if (flag('keep-fresh')) start('keep-fresh', [join(here, 'seed-demo.mjs'), '--keep-fresh'], { env: seedEnv });

  start('web', [join(here, 'vite-launch.mjs'), '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: join(root, 'apps/web'),
    env: {
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      VITE_DATASET: 'empty',
      VITE_FLAGS: 'fleet_v2,pm_module,safety_v2,claims_v2,accidents_v2',
    },
  });
  await waitFor('web', () => portOpen(webPort), 120);
  console.log(`\nDemo is up: http://127.0.0.1:${webPort}/   (login in docs/hackathon/DEMO-RUNBOOK.md)`);
  console.log('Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(error);
  stopAll(1);
});
