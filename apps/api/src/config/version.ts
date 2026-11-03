import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJson {
  version?: string;
}

function readPackageVersion(): string {
  try {
    // src/config -> apps/api and dist/config -> apps/api share the same depth.
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as PackageJson;
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Version of the running API, taken from apps/api/package.json. */
export const APP_VERSION: string = readPackageVersion();
