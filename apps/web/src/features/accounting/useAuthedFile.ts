import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL, ApiError } from '@/lib/api';
import { sessionToken } from '@/lib/session';

/**
 * A file behind the API, fetched with the session the rest of the app uses.
 *
 * A browser does not put an `Authorization` header on an `<iframe src>` or an `<a href>`, so an
 * endpoint that needs a bearer token answers those with 401 and the reader sees "Sign in to
 * continue" on a page they are already signed in to. The fix is not to open the endpoint: it is to
 * fetch the file the way every other request is made, and hand the browser a blob it already has.
 *
 * The object URL belongs to this document, carries no credential, and is revoked when the file
 * changes or the screen closes — so nothing is left holding the bytes, and no token ever appears
 * in a URL, a history entry or a server log.
 */
export interface AuthedFile {
  /** An object URL for the fetched file, or null while it is loading or has failed. */
  url: string | null;
  loading: boolean;
  /** A sentence to show the reader; the raw problem body is never rendered. */
  error: string | null;
  retry: () => void;
}

export function useAuthedFile(path: string | null, fileName?: string): AuthedFile & { download: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!path) { setUrl(null); setError(null); setLoading(false); return undefined; }
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const token = sessionToken();
        const response = await fetch(`${API_BASE_URL}${path}`, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) {
          // A refusal here is usually one of three things, and the reader can act on each.
          const message =
            response.status === 401
              ? 'Your session has expired. Sign in again and reopen this statement.'
              : response.status === 403 || response.status === 404
                ? 'This statement belongs to another company, or is no longer on file.'
                : `The statement could not be prepared (${response.status}).`;
          throw new ApiError({ type: 'about:blank', title: 'Could not load the PDF', status: response.status, detail: message });
        }
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : 'The statement could not be loaded. Check your connection and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  /** Saves the file the reader is already looking at, with a name they will recognise. */
  const download = useCallback(() => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName ?? 'statement.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [url, fileName]);

  return { url, loading, error, retry, download };
}
