#!/usr/bin/env node
/**
 * Fallback database for machines where the portable PostgreSQL cannot start (for example an agent
 * sandbox that blocks cmd.exe, which pg_ctl needs). PGlite is Postgres compiled to WebAssembly and
 * runs inside this Node process; pglite-socket speaks the Postgres wire protocol on a TCP port, so
 * the API connects to it with its normal DATABASE_URL.
 *
 * Not the normal path: on the owner's machine `demo-up.mjs` uses the real local PostgreSQL. This
 * exists so the demo can still be built and checked where that is impossible.
 *
 *   (@electric-sql/pglite-socket is a root devDependency; `npm install` brings it)
 *   node scripts/hackathon/pglite-server.mjs [--port 5433] [--data scripts/hackathon/.data/pglite]
 *
 * Any user/password/database name is accepted; there is one database.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg('port', '5433'));
const dataDir = resolve(arg('data', resolve(here, '.data', 'pglite')));
mkdirSync(dataDir, { recursive: true });

let PGlite, PGLiteSocketServer;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket'));
} catch {
  console.error('PGlite is not installed. Run: npm install (it is a root devDependency)');
  process.exit(1);
}

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log(`PGlite listening on 127.0.0.1:${port} (data ${dataDir})`);

const stop = async () => {
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
