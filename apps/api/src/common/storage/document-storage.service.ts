import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AppError } from '../errors/app-error';
import { env } from '../../config/env';

/**
 * Where document bytes live.
 *
 * `STORAGE_DRIVER=local` keeps files under `STORAGE_LOCAL_PATH` (the production compose file
 * mounts a volume there). Keys are relative paths the caller chooses —
 * `compliance/<company>/<doc>.pdf` — and are checked so a key can never escape the root. `s3` is
 * declared in the environment schema and not implemented; asking for it fails loudly rather than
 * writing to disk and calling it S3.
 */
@Injectable()
export class DocumentStorageService {
  private readonly root: string;

  constructor() {
    if (env.STORAGE_DRIVER !== 'local') {
      throw new Error(`STORAGE_DRIVER=${env.STORAGE_DRIVER} is not implemented; use local`);
    }
    this.root = isAbsolute(env.STORAGE_LOCAL_PATH)
      ? env.STORAGE_LOCAL_PATH
      : resolve(process.cwd(), env.STORAGE_LOCAL_PATH);
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new AppError({ status: 400, title: 'Bad Request', detail: 'Invalid storage key' });
    }
    return path;
  }

  /** Removes the bytes; a key that is already gone is not an error. */
  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async put(key: string, bytes: Uint8Array): Promise<{ key: string; sizeBytes: number }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { key, sizeBytes: bytes.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Where a key lands on disk; for logs and tests, never for clients. */
  locate(key: string): string {
    return join(this.root, key);
  }
}
