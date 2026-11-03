import { useEffect, useState } from 'react';
import { API_PREFIX } from '@neway/shared';
import { ApiError, apiGet, apiPost } from './api-client';
import { sessionToken } from './session';

/**
 * Files behind records the workspace snapshot still owns (work order invoices, load paperwork).
 *
 * The bytes go to `POST /files` the moment they are chosen and the record keeps only a URL.
 * They used to ride inside the snapshot as base64, which made every save and every boot carry
 * every file ever uploaded; a create that should take a moment took as long as re-uploading the
 * whole workspace.
 *
 * `/files/:id` needs the session token, so nothing here hands a raw URL to the browser: images
 * and PDFs are fetched with the token and shown through a blob URL.
 */
export interface StoredFile {
  id: string;
  url: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** What a record needs to remember about its file. `dataUrl` is the pre-file-store shape. */
export interface FileRef {
  fileUrl?: string;
  fileId?: string;
  dataUrl?: string;
  mimeType?: string;
  fileName?: string;
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsDataURL(file);
  });
}

/** Above this a phone photo is re-encoded before it travels; documents stay legible at 2400 px. */
const SHRINK_OVER_BYTES = 1.5 * 1024 * 1024;
const SHRINK_MAX_SIDE = 2400;

/**
 * A large photo, made smaller for the trip (owner, 2026-10-15: a 4 MB BOL took 40 s on a slow
 * uplink). JPEG / PNG / WebP photos over 1.5 MB are redrawn at most 2400 px on the long side as a
 * 0.82 JPEG - a page stays readable, the file is usually a tenth of the size. PDFs, small images
 * and anything the browser cannot draw go as they are; a result that is not smaller is dropped.
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_OVER_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, SHRINK_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff'; // a transparent PNG becomes a white page, not a black one
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/**
 * Stores the bytes and answers as soon as they are on disk; nothing is derived from them here.
 * The bytes go as they are (`/files/raw`) - base64 JSON made every file a third bigger on the wire.
 */
export async function uploadFile(original: File): Promise<StoredFile> {
  const file = await shrinkImage(original);
  const token = sessionToken();
  const response = await fetch(`/${API_PREFIX}/files/raw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Type': file.type || 'application/octet-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  }).catch(() => null);
  if (response?.ok) return (await response.json()) as StoredFile;
  // An older server without the raw door: the base64 upload, exactly as before.
  if (!response || response.status === 404 || response.status === 415) {
    const content = await readAsDataUrl(file);
    return apiPost<StoredFile>('/files', { fileName: file.name, contentType: file.type || 'application/octet-stream', content });
  }
  const problem = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
  throw new ApiError(response.status, problem?.title ?? 'Upload failed', problem?.detail ?? 'The file could not be uploaded.', null);
}

/** True when there are bytes to show, wherever they live. */
export function hasFile(doc: FileRef | null | undefined): boolean {
  return Boolean(doc && (doc.fileUrl || doc.fileId || doc.dataUrl));
}

/**
 * The stored-file id inside a `/files/<id>` address, or null for any other URL (a signed link, a
 * hiring or compliance document route, a data URL).
 */
const STORED_FILE_PATH = new RegExp(`^(?:https?://[^/]+)?/${API_PREFIX}/files/([^/?#]+)/?(?:[?#].*)?$`);

export function storedFileIdOf(url: string): string | null {
  // Only the stored-file route itself (`/api/v1/files/<id>`), never a module route that happens to
  // end in `/files/<id>` (a candidate's application files, a DOT link's files).
  const match = STORED_FILE_PATH.exec(url);
  if (!match || match[1] === 'signed' || match[1] === 'raw' || match[1] === 'deleted') return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
}

/**
 * Where the bytes are fetched from (owner brief, 2026-10-25): a stored file is never fetched by its
 * id. The API checks the record the file belongs to and hands back a five-minute link bound to this
 * user, this company and this file; that link is fetched.
 *
 * Any other API document route (consent forms, signatures, applications, CDL / medical / testing /
 * W-9 files) is traded for a signed link from `GET /files/sign?path=…`; those routes refuse a
 * session and open only through the link. A route that is not a signed document (the API answers
 * not-signable) is fetched as it is, with the session.
 */
export async function resolveFileFetchUrl(fileUrl: string): Promise<string> {
  const id = storedFileIdOf(fileUrl);
  if (id) {
    const link = await apiGet<{ url: string; expiresAt: string }>(`/files/${encodeURIComponent(id)}/link`, undefined, { background: true });
    return link.url;
  }
  const apiPath = API_PATH.exec(fileUrl)?.[1];
  if (!apiPath || /^\/[^/]+\/[^/]+\/files\/signed(?:[?/#]|$)/.test(apiPath) || /[?&]sig=/.test(apiPath)) return fileUrl;
  try {
    const link = await apiGet<{ url: string; expiresAt: string }>('/files/sign', { path: apiPath }, { background: true });
    return link.url;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return fileUrl;
    throw error;
  }
}

/** The API path (with its query) of an absolute or relative `/api/v1/…` URL. */
const API_PATH = new RegExp(`^(?:https?://[^/]+)?(/${API_PREFIX}/[^#]*)$`);

/** The bytes as a Blob, from the file store (with the session) or from an inline data URL. */
/**
 * Bytes already pulled this session, by URL.
 *
 * A phone photo of a licence is 3-6 MB, and on a slow link that is a minute of download. The
 * second look at the same document must not pay it again: a viewer that was closed before the
 * bytes finished, then reopened, used to start the whole download over - and on a 40 KB/s link
 * that read as "the preview never works".
 */
const blobCache = new Map<string, Blob>();
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

function remember(url: string, blob: Blob): void {
  if (blob.size > MAX_CACHED_BYTES / 4) return;
  while (cachedBytes + blob.size > MAX_CACHED_BYTES && blobCache.size > 0) {
    const [oldest, oldBlob] = blobCache.entries().next().value as [string, Blob];
    blobCache.delete(oldest);
    cachedBytes -= oldBlob.size;
  }
  blobCache.set(url, blob);
  cachedBytes += blob.size;
}

/** Forgets every cached file. Tests share one module; a session does not need this. */
export function clearFileBlobCache(): void {
  blobCache.clear();
  cachedBytes = 0;
}

export interface FetchProgress {
  loaded: number;
  /** Null when the server did not say how big the file is. */
  total: number | null;
}

/** Downloads already on their way, so a View pressed during a prefetch waits for it, not a second copy. */
const inFlight = new Map<string, Promise<Blob>>();

/**
 * Loads files in the background, one at a time, into the same memory cache View reads from.
 * Memory only - nothing is written to disk - and a failure is silent: View will simply try again.
 */
export async function prefetchFileBlobs(urls: string[]): Promise<void> {
  for (const url of urls) {
    if (blobCache.has(url) || inFlight.has(url)) continue;
    await fetchFileBlob({ fileUrl: url }).catch(() => undefined);
  }
}

export async function fetchFileBlob(
  original: FileRef,
  onProgress?: (progress: FetchProgress) => void,
): Promise<Blob> {
  const doc: FileRef = !original.fileUrl && original.fileId ? { ...original, fileUrl: `/${API_PREFIX}/files/${encodeURIComponent(original.fileId)}` } : original;
  if (doc.fileUrl) {
    const cached = blobCache.get(doc.fileUrl);
    if (cached) {
      onProgress?.({ loaded: cached.size, total: cached.size });
      return cached;
    }
    const pending = inFlight.get(doc.fileUrl);
    if (pending) {
      const blob = await pending;
      onProgress?.({ loaded: blob.size, total: blob.size });
      return blob;
    }
    const url = doc.fileUrl;
    const request = download(doc, url, onProgress);
    inFlight.set(url, request);
    try {
      return await request;
    } finally {
      inFlight.delete(url);
    }
  }
  if (doc.dataUrl) return (await fetch(doc.dataUrl)).blob();
  throw new Error('No file on record');
}

async function download(doc: FileRef, fileUrl: string, onProgress?: (progress: FetchProgress) => void): Promise<Blob> {
  {
    const token = sessionToken();
    const response = await fetch(await resolveFileFetchUrl(fileUrl), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`The file could not be loaded (${response.status})`);
    const type = response.headers.get('content-type') ?? doc.mimeType ?? '';
    const totalHeader = Number(response.headers.get('content-length'));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
    let blob: Blob;
    if (response.body && onProgress) {
      // Read the stream ourselves so the caller can say how far along a big file is.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      onProgress({ loaded: 0, total });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ loaded, total });
      }
      blob = new Blob(chunks as BlobPart[], { type });
    } else {
      blob = await response.blob();
    }
    remember(fileUrl, blob);
    return blob;
  }
}

/**
 * Opens the file in a new tab. Returns false when there is nothing to open.
 *
 * The tab is opened synchronously, inside the click, and pointed at the bytes once they arrive:
 * a `window.open` after an await is what popup blockers refuse.
 */
export function openFile(doc: FileRef): boolean {
  if (!hasFile(doc)) return false;
  const tab = window.open('', '_blank');
  void fetchFileBlob(doc)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch(() => tab?.close());
  return true;
}

/** Saves the file under its own name. Returns false when there is nothing to download. */
export function downloadFile(doc: FileRef, fileName?: string): boolean {
  if (!hasFile(doc)) return false;
  void fetchFileBlob(doc).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName ?? doc.fileName ?? 'document';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  return true;
}

/**
 * A URL an `<img>` or `<iframe>` can show for the file: the data URL as is, or a blob URL fetched
 * with the session and released when the component lets go of it.
 */
export function useFileObjectUrl(doc: FileRef | null | undefined): string | null {
  const fileUrl = doc?.fileUrl ?? null;
  const dataUrl = doc?.dataUrl ?? null;
  // Remembered with the URL it was made for, so a stale blob is never shown for a newer file.
  const [loaded, setLoaded] = useState<{ forUrl: string; url: string } | null>(null);
  useEffect(() => {
    if (!fileUrl) return;
    let active = true;
    let objectUrl: string | null = null;
    fetchFileBlob({ fileUrl })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ forUrl: fileUrl, url: objectUrl });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileUrl]);
  if (!fileUrl) return dataUrl;
  return loaded?.forUrl === fileUrl ? loaded.url : null;
}

/**
 * SHA-256 of a file's bytes as hex, or null where the browser cannot compute one (an insecure
 * origin, a very old browser). Used to notice the same scan filed under two document types; a
 * missing hash falls back to the file name, never to nothing.
 */
export async function hashFile(file: Blob): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Starts the upload the moment a file is chosen and hands the same upload back on save (owner,
 * 2026-10-15): the bytes travel while the form is filled in, so Save waits on nothing. A failed
 * early upload is tried again on save; a file replaced before save is simply not used.
 */
export function useEagerUpload() {
  const [entry, setEntry] = useState<{ file: File; upload: Promise<StoredFile> } | null>(null);
  return {
    start(file: File | null) {
      if (!file) return setEntry(null);
      const upload = uploadFile(file);
      upload.catch(() => undefined); // handled on save
      setEntry({ file, upload });
    },
    /** The stored file for `file`: the early upload when it is this file and succeeded. */
    async get(file: File): Promise<StoredFile> {
      if (entry?.file === file) {
        try {
          return await entry.upload;
        } catch {
          // Tried again below.
        }
      }
      return uploadFile(file);
    },
  };
}
