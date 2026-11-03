import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { demoData, HERO_LOAD_NUMBER, type Load } from '@/demo';
import { LoadDocumentsDialog } from './LoadDocumentsDialog';

/*
 * The dialog is opened from a row in the register, and that row is a snapshot taken at the moment
 * the eye was clicked. Filing a document refreshes the register underneath it, so a dialog that
 * keeps rendering the snapshot tells the dispatcher the POD never landed. These tests pin the
 * dialog to the live record - and, since P0.5, to the rule that filing suggests and a person
 * confirms.
 */

const liveLoads = vi.hoisted(() => ({ current: [] as Load[] }));
const mocks = vi.hoisted(() => ({
  uploadLoadDocument: vi.fn(),
  confirmUploadSuggestion: vi.fn(),
  reviewLoadDocument: vi.fn(),
}));

vi.mock('@/features/operations/useOperations', () => ({
  useOperations: () => ({ data: { loads: liveLoads.current.map((load) => ({ load })) } }),
}));

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/files')>()),
  uploadFile: vi.fn(async (file: File) => ({
    id: 'file_test',
    url: '/api/v1/files/file_test',
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  })),
  hashFile: vi.fn(async (file: File) => `hash-of-${file.name}`),
}));

vi.mock('@/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/demo')>();
  return {
    ...actual,
    uploadLoadDocument: (input: import('@/demo').UploadLoadDocumentInput) =>
      mocks.uploadLoadDocument(input),
    confirmUploadSuggestion: (id: string, input: unknown) =>
      mocks.confirmUploadSuggestion(id, input),
    reviewLoadDocument: (id: string, documentId: string, to: string) =>
      mocks.reviewLoadDocument(id, documentId, to),
  };
});

function hero(): Load {
  const load = demoData.loads.find((l) => l.loadNumber === HERO_LOAD_NUMBER);
  if (!load) throw new Error('hero load missing from the demo dataset');
  return structuredClone(load);
}

/** The load as it was before the POD was filed: in transit, no proof of delivery. */
function beforePod(): Load {
  const load = hero();
  load.status = 'in_transit';
  load.invoiceId = null;
  load.documents = load.documents.map((doc) =>
    doc.type === 'pod' ? { ...doc, status: 'missing' as const } : doc,
  );
  return load;
}

/** The same load after the upload: delivered, POD on file, never invoiced. */
function afterPod(): Load {
  const load = beforePod();
  load.status = 'delivered';
  load.documents = load.documents.map((doc) =>
    doc.type === 'pod'
      ? {
          ...doc,
          status: 'verified' as const,
          title: 'Proof of delivery',
          fileName: 'pod-scan.pdf',
          sizeBytes: 24_100,
          mimeType: 'application/pdf',
          uploadedAt: new Date().toISOString(),
        }
      : doc,
  );
  return load;
}

/** The Attach files area sits inline (2026-09-22): drop the file, say it is the POD, upload. */
async function attachPod(user: ReturnType<typeof userEvent.setup>, file: File) {
  const attach = screen.getByRole('region', { name: 'Attach files' });
  await user.upload(within(attach).getByLabelText('Files'), file);
  await user.click(within(attach).getByRole('combobox', { name: `Type of ${file.name}` }));
  await user.click(await screen.findByRole('option', { name: 'Proof of delivery (POD)' }));
  await user.click(screen.getByRole('button', { name: /Upload 1 file/ }));
  return attach;
}

describe('LoadDocumentsDialog', () => {
  beforeEach(() => {
    mocks.uploadLoadDocument.mockReset();
    mocks.confirmUploadSuggestion.mockReset();
    mocks.reviewLoadDocument.mockReset();
  });

  it('shows the filed POD and the billable note from the live load, not the stale row', async () => {
    liveLoads.current = [afterPod()];

    renderPage(<LoadDocumentsDialog load={beforePod()} open onOpenChange={() => {}} />);

    expect(await screen.findByText('POD verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Replace POD/ })).toBeVisible();
    expect(screen.getByText('pod-scan.pdf')).toBeVisible();
    expect(screen.getByText(/Ready to bill/)).toBeVisible();
  });

  it('falls back to the row it was opened with when the load is not in the live bundle', async () => {
    liveLoads.current = [];

    renderPage(<LoadDocumentsDialog load={beforePod()} open onOpenChange={() => {}} />);

    expect(await screen.findByText('POD missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload POD/ })).toBeVisible();
    expect(screen.queryByText(/Ready to bill/)).not.toBeInTheDocument();
  });

  describe('uploads suggest, people confirm (P0.5)', () => {
    it('filing a POD moves nothing; the dialog asks "Delivered at <arrival>?" and a yes goes to the server', async () => {
      const user = userEvent.setup();
      const load = beforePod();
      const delivery = load.stops[load.stops.length - 1]!;
      delivery.arrivedAt = '2026-09-06T20:40:00.000Z';
      delivery.timezone = 'America/Chicago';
      liveLoads.current = [load];
      mocks.uploadLoadDocument.mockImplementation(
        async (input: { type: Load['documents'][number]['type']; fileName: string }) => {
          const updated = structuredClone(load);
          updated.documents = updated.documents.map((doc) =>
            doc.type === input.type
              ? {
                  ...doc,
                  status: 'pending' as const,
                  review: 'received' as const,
                  fileName: input.fileName,
                  uploadedAt: '2026-09-06T21:00:00.000Z',
                }
              : doc,
          );
          liveLoads.current = [updated];
          return updated;
        },
      );
      mocks.confirmUploadSuggestion.mockImplementation(async () => {
        const updated = structuredClone(liveLoads.current[0]!);
        updated.status = 'delivered';
        return updated;
      });

      renderPage(<LoadDocumentsDialog load={load} open onOpenChange={() => {}} />);
      await screen.findByText('POD missing');
      await attachPod(user, new File(['signed'], 'pod-signed.pdf', { type: 'application/pdf' }));

      await waitFor(() => expect(mocks.uploadLoadDocument).toHaveBeenCalledTimes(1));
      expect(mocks.uploadLoadDocument.mock.calls[0]?.[0]).toMatchObject({
        type: 'pod',
        fileName: 'pod-signed.pdf',
        fileHash: 'hash-of-pod-signed.pdf',
      });

      // Nothing moved on the upload itself; the question is asked with the stop's own clock.
      const ask = await screen.findByRole('dialog', { name: /Delivered at/ });
      expect(ask).toHaveTextContent('Delivered at 3:40 PM CDT?');
      expect(ask).toHaveTextContent('The time is the arrival recorded at the stop.');
      expect(mocks.confirmUploadSuggestion).not.toHaveBeenCalled();

      await user.click(within(ask).getByRole('button', { name: 'Yes, delivered' }));
      await waitFor(() =>
        expect(mocks.confirmUploadSuggestion).toHaveBeenCalledWith(load.id, {
          kind: 'mark_delivered',
          stopId: delivery.id,
          at: '2026-09-06T20:40:00.000Z',
        }),
      );
    });

    it('"Not now" files the document and leaves the load exactly where it was', async () => {
      const user = userEvent.setup();
      const load = beforePod();
      liveLoads.current = [load];
      mocks.uploadLoadDocument.mockImplementation(async () => structuredClone(load));

      renderPage(<LoadDocumentsDialog load={load} open onOpenChange={() => {}} />);
      await screen.findByText('POD missing');
      await attachPod(user, new File(['signed'], 'pod-signed.pdf', { type: 'application/pdf' }));
      const ask = await screen.findByRole('dialog', { name: /Delivered at/ });
      await user.click(within(ask).getByRole('button', { name: 'Not now' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /Delivered at/ })).not.toBeInTheDocument(),
      );
      expect(mocks.confirmUploadSuggestion).not.toHaveBeenCalled();
    });

    it('warns before the same file lands under a second type', async () => {
      const user = userEvent.setup();
      const load = beforePod();
      const bol = load.documents.find((d) => d.type === 'bol')!;
      bol.fileName = 'scan-001.pdf';
      bol.fileHash = 'hash-of-scan-001.pdf';
      liveLoads.current = [load];
      mocks.uploadLoadDocument.mockImplementation(async () => structuredClone(load));

      renderPage(<LoadDocumentsDialog load={load} open onOpenChange={() => {}} />);
      await screen.findByText('POD missing');
      const attach = await attachPod(
        user,
        new File(['same'], 'scan-001.pdf', { type: 'application/pdf' }),
      );

      // The row is held, not filed: the warning sits on it with the way past it.
      expect(await within(attach).findByText('Same file, second type')).toBeVisible();
      expect(attach).toHaveTextContent(/already filed as the bol/);
      expect(within(attach).getByRole('button', { name: 'Upload anyway' })).toBeVisible();
      expect(mocks.uploadLoadDocument).not.toHaveBeenCalled();
      await user.click(within(attach).getByRole('button', { name: 'Remove scan-001.pdf' }));
      await waitFor(() =>
        expect(within(attach).queryByText('Same file, second type')).not.toBeInTheDocument(),
      );
      expect(mocks.uploadLoadDocument).not.toHaveBeenCalled();
    });

    it('a received document is marked reviewed and verified by a person, through the server', async () => {
      const user = userEvent.setup();
      const load = afterPod();
      const pod = load.documents.find((d) => d.type === 'pod')!;
      pod.status = 'pending';
      pod.review = 'received';
      liveLoads.current = [load];
      mocks.reviewLoadDocument.mockImplementation(async () => structuredClone(load));

      renderPage(<LoadDocumentsDialog load={load} open onOpenChange={() => {}} />);
      expect(await screen.findByText('POD received')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Verify POD' }));
      await waitFor(() =>
        expect(mocks.reviewLoadDocument).toHaveBeenCalledWith(load.id, pod.id, 'verified'),
      );
    });
  });
});
