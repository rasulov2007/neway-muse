import { Download, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/design-system';
import { fetchFileBlob } from '@/lib/files';

/**
 * A receipt, actually shown.
 *
 * The drawer used to hand a PDF to `<object>` and fall back to `<img>`: that leans on the
 * browser's PDF plugin, which a headless or locked-down browser does not have, and an `<img>` of a
 * PDF is a broken image. A 200 from the file store proves nothing about what the person sees.
 *
 * So the bytes are fetched with the session, the type is read from the bytes themselves (a stored
 * MIME type can be wrong), a PDF's pages are drawn onto canvases with the pdf.js the app already
 * ships, and an image is shown only once it has actually decoded. Anything else - an unreadable
 * file, a type that cannot be previewed, a refused request - says so, with Retry and Download.
 *
 * `data-state` on the frame is `rendered` only after pixels are on screen, which is what the
 * end-to-end check reads: a receipt counts as previewed when it rendered, not when it was served.
 */
type Kind = 'pdf' | 'image' | 'other';

function sniff(head: Uint8Array): Kind {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return 'pdf'; // %PDF
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image'; // PNG
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image'; // JPEG
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image'; // GIF
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) return 'image'; // WEBP
  return 'other';
}

type State =
  | { phase: 'loading' }
  | { phase: 'pdf'; pages: number }
  | { phase: 'image'; url: string }
  | { phase: 'other'; blob: Blob }
  | { phase: 'error'; message: string; blob: Blob | null };

async function drawPdf(blob: Blob, into: HTMLDivElement, width: number): Promise<number> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  into.replaceChildren();
  const pages = Math.min(doc.numPages, 3);
  for (let n = 1; n <= pages; n += 1) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = '100%';
    canvas.style.display = 'block';
    canvas.setAttribute('aria-label', `Receipt page ${n}`);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the receipt.');
    await page.render({ canvasContext: context, viewport }).promise;
    into.appendChild(canvas);
  }
  return doc.numPages;
}

/** `url` shows any file the API serves to a signed-in caller (an invoice PDF); `fileId` a stored file. */
export function ReceiptPreview({ fileId, fileName, url }: { fileId?: string; fileName: string; url?: string }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const pagesRef = useRef<HTMLDivElement>(null);
  const blobRef = useRef<Blob | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setState({ phase: 'loading' });
    setImageReady(false);
    (async () => {
      let blob: Blob | null = null;
      try {
        blob = await fetchFileBlob({ fileUrl: url ?? `/api/v1/files/${encodeURIComponent(fileId ?? '')}` });
        blobRef.current = blob;
        const kind = sniff(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
        if (!active) return;
        if (kind === 'image') {
          objectUrl = URL.createObjectURL(blob);
          setState({ phase: 'image', url: objectUrl });
        } else if (kind === 'pdf') {
          setState({ phase: 'pdf', pages: 0 });
          // The container exists once the pdf phase has rendered; wait a frame for it.
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const into = pagesRef.current;
          if (!into || !active) return;
          const pages = await drawPdf(blob, into, into.clientWidth || 480);
          if (active) setState({ phase: 'pdf', pages });
        } else {
          setState({ phase: 'other', blob });
        }
      } catch (error) {
        if (!active) return;
        const text = error instanceof Error ? error.message : '';
        setState({
          phase: 'error',
          blob,
          message: /\b401\b/.test(text)
            ? 'Your session has expired. Sign in again and reopen this receipt.'
            : /\b40[34]\b/.test(text)
              ? 'This receipt belongs to another company or is no longer on file.'
              : blob
                ? 'The receipt could not be read. The file may be damaged.'
                : 'The receipt could not be loaded. Check your connection and try again.',
        });
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, url, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const download = useCallback(() => {
    const blob = blobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [fileName]);

  const rendered = (state.phase === 'pdf' && state.pages > 0) || (state.phase === 'image' && imageReady);

  return (
    <div
      className="nw-paper overflow-hidden rounded-lg border border-line"
      data-theme="light"
      data-testid="receipt-preview"
      data-state={rendered ? 'rendered' : state.phase === 'error' ? 'error' : state.phase === 'other' ? 'unsupported' : 'loading'}
    >
      {state.phase === 'loading' ? <p className="p-4 text-xs text-muted">Loading…</p> : null}

      {state.phase === 'pdf' ? (
        <>
          <div ref={pagesRef} className="max-h-96 overflow-y-auto" />
          {state.pages === 0 ? <p className="p-4 text-xs text-muted">Loading…</p> : null}
          {state.pages > 3 ? <p className="border-t border-line px-3 py-2 text-2xs text-muted">Showing 3 of {state.pages} pages. Download for the rest.</p> : null}
        </>
      ) : null}

      {state.phase === 'image' ? (
        <img
          src={state.url}
          alt="Receipt"
          className="max-h-96 w-full object-contain"
          onLoad={(e) => setImageReady((e.currentTarget as HTMLImageElement).naturalWidth > 0)}
          onError={() => setState({ phase: 'error', blob: blobRef.current, message: 'The receipt image could not be decoded. The file may be damaged.' })}
        />
      ) : null}

      {state.phase === 'other' ? (
        <div className="flex flex-col items-start gap-2 p-4 text-xs text-ink">
          <p>This file type cannot be previewed here.</p>
          <Button variant="secondary" size="sm" icon={<Download />} onClick={download}>Download {fileName}</Button>
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-4 text-xs text-ink">
          <p>{state.message}</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={<RotateCw />} onClick={retry}>Retry</Button>
            {state.blob ? <Button variant="secondary" size="sm" icon={<Download />} onClick={download}>Download</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
