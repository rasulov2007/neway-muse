import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentViewer } from './DocumentViewer';
import { clearFileBlobCache } from '@/lib/files';

/**
 * The viewer is the one place a document is opened, so what is asserted here is what the owner's
 * bug was: the bytes are fetched *with the session token*, never handed to the browser as a URL.
 */

const FILE = { fileUrl: '/api/v1/files/file_1', fileName: 'rate-con.pdf' };

/** The API answers the signed-link request with JSON and the signed link with the bytes. */
function stubFetch(blob: Blob) {
  const fetchMock = vi.fn(async (input: unknown) =>
    String(input).includes('/link')
      ? new Response(JSON.stringify({ url: '/api/v1/files/signed/tok.sig', expiresAt: '2026-10-25T12:05:00.000Z' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(blob, { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearFileBlobCache();
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DocumentViewer', () => {
  it('shows an image inline', async () => {
    stubFetch(new Blob(['x'], { type: 'image/png' }));
    render(
      <DocumentViewer
        source={{ kind: 'file', file: { ...FILE, fileName: 'card.png' } }}
        title="Insurance card"
        contentType="image/png"
        fileName="card.png"
        onClose={() => {}}
      />,
    );
    const image = await screen.findByRole('img', { name: 'Insurance card' });
    expect(image).toHaveAttribute('src', 'blob:mock');
    expect(screen.getByTestId('document-viewer')).toHaveClass('nw-paper');
  });

  it('embeds a PDF in an iframe', async () => {
    stubFetch(new Blob(['%PDF'], { type: 'application/pdf' }));
    render(
      <DocumentViewer
        source={{ kind: 'file', file: FILE }}
        title="Rate confirmation"
        contentType="application/pdf"
        fileName="rate-con.pdf"
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle('Rate confirmation').tagName.toLowerCase()).toBe('iframe'),
    );
    expect(screen.getByTitle('Rate confirmation')).toHaveAttribute('src', 'blob:mock');
  });

  it('offers the download for a type it cannot preview', async () => {
    stubFetch(new Blob(['zip'], { type: 'application/zip' }));
    render(
      <DocumentViewer
        source={{ kind: 'file', file: { ...FILE, fileName: 'paperwork.zip' } }}
        title="Paperwork"
        contentType="application/zip"
        fileName="paperwork.zip"
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(/This file type is not previewed; download it to open\./),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('asks the API for a signed link, then fetches the bytes from it', async () => {
    const fetchMock = stubFetch(new Blob(['%PDF'], { type: 'application/pdf' }));
    render(
      <DocumentViewer
        source={{ kind: 'file', file: FILE }}
        title="Rate confirmation"
        contentType="application/pdf"
        fileName="rate-con.pdf"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [linkUrl, linkInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(linkUrl).toContain('/files/file_1/link');
    expect(new Headers(linkInit.headers).get('Authorization')).toBe('Bearer test-session-token');
    const [bytesUrl] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    // The bytes come from the five-minute signed link, never from the file id.
    expect(bytesUrl).toBe('/api/v1/files/signed/tok.sig');
    // Nothing in the viewer points at the API directly.
    expect(document.querySelector('[src="/api/v1/files/file_1"]')).toBeNull();
  });

  it('asks for confirmation before deleting', async () => {
    stubFetch(new Blob(['%PDF'], { type: 'application/pdf' }));
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <DocumentViewer
        source={{ kind: 'file', file: FILE }}
        title="Rate confirmation"
        contentType="application/pdf"
        fileName="rate-con.pdf"
        onClose={() => {}}
        onDelete={onDelete}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(await screen.findByText('Delete rate-con.pdf?')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('hides Replace and Delete when the caller passes no handlers', async () => {
    stubFetch(new Blob(['%PDF'], { type: 'application/pdf' }));
    render(
      <DocumentViewer
        source={{ kind: 'file', file: FILE }}
        title="Rate confirmation"
        contentType="application/pdf"
        fileName="rate-con.pdf"
        onClose={() => {}}
      />,
    );
    await screen.findByRole('button', { name: 'Download' });
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  });
});
