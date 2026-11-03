import { useState } from 'react';
import { useToast } from '@/design-system';
import { API_BASE_URL } from '@/lib/api';
import { sessionToken } from '@/lib/session';

/**
 * A link to a file the API only gives to a signed-in caller.
 *
 * Written as a button rather than an anchor on purpose: a browser sends no `Authorization` header
 * when it follows an `href`, so a plain link to one of these endpoints answers 401 and the reader
 * is told to sign in on a page they are already signed in to. This fetches the file with the
 * session, hands the browser a blob it already has, and revokes the object URL immediately after —
 * so no credential is ever put in a URL and nothing is left holding the bytes.
 */
export function AuthedFileLink({
  path,
  fileName,
  children,
  className,
}: {
  path: string;
  fileName: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const token = sessionToken();
      const response = await fetch(`${API_BASE_URL}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : undefined });
      if (!response.ok) {
        toast({
          tone: 'danger',
          title: 'The file could not be opened',
          description:
            response.status === 401
              ? 'Your session has expired. Sign in again and try once more.'
              : response.status === 403 || response.status === 404
                ? 'It belongs to another company, or is no longer on file.'
                : `The server answered ${response.status}.`,
        });
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The browser has the bytes; the handle is not needed and is not left lying about.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast({ tone: 'danger', title: 'The file could not be opened', description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" onClick={() => void open()} disabled={busy} className={className}>
      {busy ? 'Preparing…' : children}
    </button>
  );
}
