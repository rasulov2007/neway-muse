import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearFileBlobCache, fetchFileBlob, hasFile, resolveFileFetchUrl, storedFileIdOf } from './files';

/**
 * Stored files are fetched through short-lived signed links (owner brief, 2026-10-25): the browser
 * asks `GET /files/:id/link`, the API checks the record the file belongs to, and the bytes come from
 * the link it returns - never from the file id itself.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  clearFileBlobCache();
});

describe('storedFileIdOf', () => {
  it('finds the id in a stored-file address', () => {
    expect(storedFileIdOf('/api/v1/files/file_abc')).toBe('file_abc');
    expect(storedFileIdOf('/api/v1/files/file%20x?x=1')).toBe('file x');
  });

  it('leaves signed links and other document routes alone', () => {
    expect(storedFileIdOf('/api/v1/files/signed/abc.def')).toBeNull();
    expect(storedFileIdOf('/api/v1/compliance/documents/doc_1/file')).toBeNull();
    expect(storedFileIdOf('/api/v1/files/raw')).toBeNull();
  });
});

describe('resolveFileFetchUrl', () => {
  it('trades a stored-file address for the signed link the API returns', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ url: '/api/v1/files/signed/p.s', expiresAt: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveFileFetchUrl('/api/v1/files/file_1')).resolves.toBe('/api/v1/files/signed/p.s');
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain('/files/file_1/link');
  });

  it('trades a driver / candidate document route for a signed link from /files/sign', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ url: '/api/v1/hiring/x/files/y?sig=abc', expiresAt: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveFileFetchUrl('/api/v1/hiring/x/files/y')).resolves.toBe('/api/v1/hiring/x/files/y?sig=abc');
    const asked = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(asked).toContain('/files/sign?path=');
    expect(decodeURIComponent(asked)).toContain('/api/v1/hiring/x/files/y');
  });

  it('fetches a route that is not a signed document as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'Not Found', detail: 'not signable', status: 404 }), { status: 404, headers: { 'content-type': 'application/problem+json' } })));
    await expect(resolveFileFetchUrl('/api/v1/accounting/invoices/i/pdf')).resolves.toBe('/api/v1/accounting/invoices/i/pdf');
  });

  it('leaves non-API URLs and existing signed links alone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolveFileFetchUrl('blob:x')).resolves.toBe('blob:x');
    await expect(resolveFileFetchUrl('/api/v1/files/signed?t=a.b')).resolves.toBe('/api/v1/files/signed?t=a.b');
    await expect(resolveFileFetchUrl('/api/v1/hiring/x/files/y?sig=abc')).resolves.toBe('/api/v1/hiring/x/files/y?sig=abc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refused link (403) is not turned into bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'Forbidden', detail: 'No access' }), { status: 403, headers: { 'content-type': 'application/problem+json' } })));
    await expect(fetchFileBlob({ fileUrl: '/api/v1/files/file_2' })).rejects.toBeTruthy();
  });
});

describe('a record that only knows the file id', () => {
  it('still counts as having a file, and is fetched through the same signed link', async () => {
    expect(hasFile({ fileId: 'file_3' })).toBe(true);
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).includes('/link')
        ? new Response(JSON.stringify({ url: '/api/v1/files/signed/q.t', expiresAt: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(new Blob(['%PDF']), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchFileBlob({ fileId: 'file_3' });
    expect(String((fetchMock.mock.calls[1] as unknown as [string])[0])).toBe('/api/v1/files/signed/q.t');
  });
});
