#!/usr/bin/env node
/**
 * Starts the Vite CLI with one guard: on Windows Vite runs `net use` through cmd.exe the first time
 * it resolves a real path. Where cmd.exe may not be started (agent sandboxes), that exec throws
 * synchronously and every module request fails with "spawn EPERM". Here a synchronous throw from
 * child_process.exec is turned into the callback error Vite already handles (it then skips the
 * network-drive mapping). Everywhere else this changes nothing.
 *
 *   node scripts/hackathon/vite-launch.mjs [vite args...]    (run with cwd = apps/web)
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const original = childProcess.exec;
childProcess.exec = function guardedExec(command, ...rest) {
  try {
    return original.call(this, command, ...rest);
  } catch (error) {
    const callback = rest.find((a) => typeof a === 'function');
    if (callback) queueMicrotask(() => callback(error, '', ''));
    return null;
  }
};
syncBuiltinESMExports();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
await import(pathToFileURL(join(root, 'node_modules', 'vite', 'bin', 'vite.js')).href);
