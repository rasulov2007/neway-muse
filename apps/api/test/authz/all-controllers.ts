import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every controller class in the API, found by file name rather than listed by hand, so a new
 * controller is covered by the authorization suite the day it is written.
 */
const SRC = join(__dirname, '..', '..', 'src');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

export function controllerFileCount(): number {
  return controllerFiles(SRC).length;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export async function loadAllControllers(): Promise<Function[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const found: Function[] = [];
  for (const file of controllerFiles(SRC)) {
    const exports = (await import(file)) as Record<string, unknown>;
    for (const value of Object.values(exports)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      if (typeof value === 'function' && /Controller$/.test(value.name)) found.push(value as Function);
    }
  }
  return found;
}
