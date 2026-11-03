import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { companies } from '../../database/schema/roster';
import { FilesService, parseDataUrl } from '../files/files.service';
import { StateService } from './state.service';

/** The legacy single-blob keys the web client wrote until this change. */
export const LEGACY_KEY = 'demo-data-v1';
export const LEGACY_FILES_KEY = 'demo-documents-v1';
/** One row per collection from here on: `ws2-<collection, lower-cased>`. */
export const COLLECTION_PREFIX = 'ws2-';

export function collectionKey(name: string): string {
  return `${COLLECTION_PREFIX}${name.toLowerCase()}`;
}

/**
 * Splits the single workspace blob into one row per collection, once, and moves every file that
 * was riding inside it as base64 into real storage.
 *
 * Measured on the production workspace before this ran: 17.5 MB of snapshot, of which 15.5 MB
 * was 42 work orders carrying their invoice PDFs inline. Every save re-sent all of it and every
 * boot re-read all of it uncompressed, which is what "everything is slow and nothing shows up"
 * was. Afterwards a broker create writes the brokers row alone (a few KB).
 *
 * Runs only while no split rows exist, so it is a one-time move; the legacy rows are left in
 * place untouched, as a fallback that nothing reads any more.
 */
@Injectable()
export class StateSplitService implements OnApplicationBootstrap {
  private readonly log = new Logger(StateSplitService.name);

  constructor(
    private readonly state: StateService,
    private readonly files: FilesService,
    private readonly database: DatabaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.split();
    } catch (error) {
      // A failed split leaves the legacy rows exactly as they were; the next boot tries again.
      this.log.error(`Workspace split failed: ${(error as Error).message}`);
    }
  }

  async split(): Promise<{ collections: number; filesMoved: number } | null> {
    const already = await this.state.list(COLLECTION_PREFIX);
    if (already.length > 0) return null;
    const legacy = await this.state.get(LEGACY_KEY);
    if (!legacy) return null;

    const snapshot = JSON.parse(legacy.value) as Record<string, unknown>;
    const filesRow = await this.state.get(LEGACY_FILES_KEY);
    if (filesRow) {
      try {
        overlayLoadFiles(snapshot, JSON.parse(filesRow.value) as Record<string, DocLike[]>);
      } catch {
        // Unreadable file blob: the loads keep their metadata and lose nothing else.
      }
    }

    const [company] = await this.database.db
      .select({ id: companies.id })
      .from(companies)
      .orderBy(asc(companies.createdAt))
      .limit(1);
    if (!company) {
      this.log.warn('Workspace split skipped: no company to own the files yet');
      return null;
    }

    let filesMoved = 0;
    const move = async (doc: DocLike): Promise<void> => {
      const parsed = parseDataUrl(doc.dataUrl ?? '');
      if (!parsed) {
        delete doc.dataUrl;
        return;
      }
      const stored = await this.files.store(company.id, {
        fileName: String(doc.fileName ?? 'file'),
        contentType: String(doc.mimeType ?? parsed.contentType),
        bytes: parsed.bytes,
        uploadedBy: String(doc.uploadedBy ?? ''),
      });
      doc.fileUrl = stored.url;
      doc.fileId = stored.id;
      delete doc.dataUrl;
      filesMoved += 1;
    };
    await walk(snapshot, move);

    let collections = 0;
    for (const [name, value] of Object.entries(snapshot)) {
      if (value === undefined) continue;
      await this.state.put(collectionKey(name), JSON.stringify(value));
      collections += 1;
    }
    this.log.log(
      `Workspace split into ${collections} collections; ${filesMoved} inline files moved to storage`,
    );
    return { collections, filesMoved };
  }
}

interface DocLike {
  dataUrl?: string;
  fileUrl?: string;
  fileId?: string;
  fileName?: unknown;
  mimeType?: unknown;
  uploadedBy?: unknown;
  type?: unknown;
  loadNumber?: unknown;
}

/** Re-attaches the separately saved load files to their loads, as the client used to at boot. */
function overlayLoadFiles(snapshot: Record<string, unknown>, files: Record<string, DocLike[]>) {
  const loads = snapshot.loads;
  if (!Array.isArray(loads)) return;
  for (const load of loads as Array<{ loadNumber?: string; documents?: DocLike[] }>) {
    const saved = load.loadNumber ? files[load.loadNumber] : undefined;
    if (!saved || !Array.isArray(load.documents)) continue;
    for (const doc of saved) {
      const existing = load.documents.find((d) => d.type === doc.type);
      if (existing) Object.assign(existing, doc, { id: (existing as { id?: string }).id });
      else load.documents.push(doc);
    }
  }
}

/** Visits every object in the snapshot that carries an inline `data:` URL. */
async function walk(value: unknown, visit: (doc: DocLike) => Promise<void>): Promise<void> {
  if (Array.isArray(value)) {
    for (const item of value) await walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.dataUrl === 'string') await visit(obj as DocLike);
  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') await walk(child, visit);
  }
}
