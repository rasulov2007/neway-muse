import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, Modal, Skeleton, cn } from '@/design-system';
import { fetchDocumentBlob } from '@/features/fleet/unit-documents';
import { fetchFileBlob, type FetchProgress, type FileRef } from '@/lib/files';

/**
 * The one way a document is opened in this product.
 *
 * Every file this system holds sits behind the session: `GET /compliance/documents/:id/file` and
 * `GET /files/:id` both want the bearer token. A plain `<a href>` to either is a browser
 * navigation, and a browser navigation carries no `Authorization` header — the API answered 401
 * and the click did nothing at all. So nothing here ever puts an API URL in an `href` or a `src`:
 * the bytes are fetched with the session and shown through a blob URL, which is released when the
 * viewer closes.
 *
 * Two kinds of file exist. Compliance documents are rows in the compliance store, fetched by id.
 * Work-order invoices and load paperwork are stored files the workspace snapshot points at by
 * URL. The difference is where the bytes come from and nothing else, so it is one prop.
 */
export type DocumentSource =
  | { kind: 'compliance'; id: string }
  | { kind: 'file'; file: FileRef };

export interface DocumentViewerProps {
  source: DocumentSource;
  /** What the document is — the heading of the viewer. */
  title: string;
  /** The line under it: who uploaded it, when, what it is filed against. */
  subtitle?: string;
  /** What the file is, when the caller knows. Falls back to the blob's own type, then the name. */
  contentType?: string;
  /** The name the download is saved under. */
  fileName?: string;
  onClose: () => void;
  /** Offered only when the caller can put a new file in this one's place. */
  onReplace?: () => void;
  /** Offered only when the caller can remove the document. Always confirmed first. */
  onDelete?: () => void;
  replaceLabel?: string;
  deleteTitle?: string;
  deleteDescription?: string;
  deleteConfirmLabel?: string;
  /** True while the caller's delete is in flight. */
  deleting?: boolean;
}

/** A key that changes exactly when the bytes behind the viewer change. */
function sourceKey(source: DocumentSource): string {
  if (source.kind === 'compliance') return `compliance:${source.id}`;
  const { fileUrl, fileId, dataUrl } = source.file;
  return `file:${fileUrl ?? fileId ?? dataUrl?.slice(0, 64) ?? 'none'}`;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function loadBlob(
  source: DocumentSource,
  onProgress?: (progress: FetchProgress) => void,
): Promise<Blob> {
  return source.kind === 'compliance'
    ? fetchDocumentBlob(source.id)
    : fetchFileBlob(source.file, onProgress);
}

/** The type to preview by: what the caller knows, what the bytes claim, then the extension. */
function resolveType(declared: string | undefined, blob: Blob | null, fileName?: string): string {
  const fromCaller = (declared ?? '').trim();
  if (fromCaller && fromCaller !== 'application/octet-stream') return fromCaller;
  const fromBlob = (blob?.type ?? '').trim();
  if (fromBlob && fromBlob !== 'application/octet-stream') return fromBlob;
  const extension = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return fromCaller || fromBlob || 'application/octet-stream';
  }
}

/**
 * The bytes behind a source, fetched with the session and held as a blob URL that is released
 * when the source changes or the caller unmounts.
 */
function useDocumentBlob(source: DocumentSource) {
  const key = sourceKey(source);
  /*
   * Both are remembered with the key they were produced for, rather than cleared as the effect
   * starts: a stale blob must never be shown for a newer file, and clearing state inside the
   * effect is a cascading render.
   */
  const [loaded, setLoaded] = useState<{ forKey: string; url: string; blob: Blob } | null>(null);
  const [failed, setFailed] = useState<{ forKey: string; message: string } | null>(null);
  /*
   * How far the download is. A 3 MB licence photo on a slow office link takes a minute, and a
   * blank placeholder for a minute reads as broken; "1.2 of 3.0 MB" reads as loading.
   */
  const [progressState, setProgressState] = useState<{ forKey: string; at: FetchProgress } | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    loadBlob(source, (at) => {
      if (active) setProgressState({ forKey: key, at });
    })
      .then((bytes) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(bytes);
        setLoaded({ forKey: key, url: objectUrl, blob: bytes });
      })
      .catch((e: unknown) => {
        if (!active) return;
        setFailed({
          forKey: key,
          message: e instanceof Error ? e.message : 'The file could not be loaded',
        });
      });
    return () => {
      active = false;
      // The blob URL is this component's; nothing outside it may keep showing the bytes.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `key` is the identity of the bytes; `source` is a fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const url = loaded?.forKey === key ? loaded.url : null;
  const progress = progressState?.forKey === key ? progressState.at : null;
  const blob = loaded?.forKey === key ? loaded.blob : null;
  const error = failed?.forKey === key ? failed.message : null;
  const fail = useCallback((message: string) => setFailed({ forKey: key, message }), [key]);
  return { url, progress, blob, error, fail };
}

/**
 * What the file looks like, on paper (white in both modes, SPEC §7 "Documents"): the image, the
 * PDF, or a line saying it cannot be previewed. The viewer's body, and each half of the CDL's
 * front-and-back viewer.
 */
export function DocumentPreview({
  source,
  title,
  contentType,
  fileName,
  className,
  imageClassName = 'max-h-[70vh]',
  frameClassName = 'h-[70vh]',
}: {
  source: DocumentSource;
  title: string;
  contentType?: string;
  fileName?: string;
  className?: string;
  imageClassName?: string;
  frameClassName?: string;
}) {
  const { url, progress, blob, error } = useDocumentBlob(source);
  return <PreviewBody url={url} progress={progress} blob={blob} error={error} title={title} contentType={contentType} fileName={fileName} className={className} imageClassName={imageClassName} frameClassName={frameClassName} />;
}

function PreviewBody({
  url,
  progress,
  blob,
  error,
  title,
  contentType,
  fileName,
  className,
  imageClassName = 'max-h-[70vh]',
  frameClassName = 'h-[70vh]',
}: {
  url: string | null;
  progress: FetchProgress | null;
  blob: Blob | null;
  error: string | null;
  title: string;
  contentType?: string;
  fileName?: string;
  className?: string;
  imageClassName?: string;
  frameClassName?: string;
}) {
  const type = resolveType(contentType, blob, fileName);
  const isImage = type.startsWith('image/');
  const isPdf = type === 'application/pdf';
  return (
    // Documents stay white in both modes (SPEC §7 "Documents"): the paper class, not the panel.
    <div
      className={cn('nw-paper flex min-h-96 items-center justify-center overflow-hidden rounded-lg border border-nw-border', className)}
      data-testid="document-viewer"
    >
      {error ? (
        <p className="text-sm text-nw-urgent-text">{error}</p>
      ) : !url ? (
        <div className="relative h-80 w-full">
          <Skeleton className="h-80 w-full" />
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4">
            {progress?.total ? (
              <div className="h-1.5 w-64 overflow-hidden rounded-full bg-nw-border">
                <div
                  className="h-full rounded-full bg-nw-accent transition-[width]"
                  style={{ width: `${Math.min(100, Math.round((progress.loaded / progress.total) * 100))}%` }}
                />
              </div>
            ) : null}
            <p className="text-xs text-nw-text-3" aria-live="polite">
              {progress
                ? progress.total
                  ? `Loading ${formatMb(progress.loaded)} of ${formatMb(progress.total)} MB`
                  : `Loading ${formatMb(progress.loaded)} MB…`
                : 'Loading…'}
            </p>
          </div>
        </div>
      ) : isImage ? (
        <img src={url} alt={title} className={`${imageClassName} max-w-full object-contain`} />
      ) : isPdf ? (
        <iframe title={title} src={url} className={`${frameClassName} w-full rounded-lg`} />
      ) : (
        <p className="text-sm text-nw-paper-text">
          This file type is not previewed; download it to open.
        </p>
      )}
    </div>
  );
}

/** Saves a source's bytes under a name, through a blob URL (never an API URL in an href). */
export function downloadDocument(source: DocumentSource, name: string, onError?: (message: string) => void) {
  void loadBlob(source)
    .then((loaded) => {
      const temporary = URL.createObjectURL(loaded);
      saveAs(temporary, name);
      setTimeout(() => URL.revokeObjectURL(temporary), 60_000);
    })
    .catch((e: unknown) => onError?.(e instanceof Error ? e.message : 'The file could not be downloaded'));
}

function saveAs(from: string, name: string) {
  const link = document.createElement('a');
  link.href = from;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function DocumentViewer({
  source,
  title,
  subtitle,
  contentType,
  fileName,
  onClose,
  onReplace,
  onDelete,
  replaceLabel = 'Replace',
  deleteTitle,
  deleteDescription,
  deleteConfirmLabel = 'Delete document',
  deleting = false,
}: DocumentViewerProps) {
  const [confirming, setConfirming] = useState(false);
  const { url, progress, blob, error, fail } = useDocumentBlob(source);

  const download = useCallback(() => {
    const name = fileName ?? title ?? 'document';
    if (url) {
      saveAs(url, name);
      return;
    }
    downloadDocument(source, name, fail);
  }, [url, source, fail, fileName, title]);

  return (
    <>
      <Modal
        open
        onOpenChange={(next) => !next && onClose()}
        size="lg"
        title={title}
        description={subtitle}
        footer={
          <>
            {onDelete ? (
              <Button
                variant="ghost"
                className="mr-auto text-danger-text"
                icon={<Trash2 />}
                loading={deleting}
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            ) : null}
            {onReplace ? (
              <Button variant="secondary" icon={<RefreshCw />} onClick={onReplace}>
                {replaceLabel}
              </Button>
            ) : null}
            <Button variant="secondary" icon={<Download />} onClick={download}>
              Download
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <PreviewBody url={url} progress={progress} blob={blob} error={error} title={title} contentType={contentType} fileName={fileName} />
      </Modal>

      {onDelete ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          tone="danger"
          title={deleteTitle ?? `Delete ${fileName ?? title}?`}
          description={
            deleteDescription ?? 'The file and its record are removed. This cannot be undone.'
          }
          confirmLabel={deleteConfirmLabel}
          cancelLabel="Keep it"
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      ) : null}
    </>
  );
}
