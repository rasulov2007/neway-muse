import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { InvoiceDocuments } from './InvoiceDocuments';

/** The invoice's Documents tab lists its load's current paperwork (owner, 2026-10-15). */
const doc = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, type, status: 'pending', review: 'received', fileName: `${id}.pdf`, fileUrl: `/api/v1/files/${id}`, uploadedAt: '2026-10-15T11:00:00Z', uploadedBy: 'Dispatcher', ...over,
});

vi.mock('@/demo', () => ({
  getLoad: vi.fn(async () => ({
    id: 'ld_1',
    loadNumber: 'TEST-INV-1',
    documents: [
      doc('pod', 'pod', { review: 'reviewed' }),
      doc('rc', 'rate_confirmation'),
      doc('old-rc', 'rate_confirmation', { supersededBy: 'rc' }),
      doc('gone', 'bol', { status: 'missing' }),
    ],
  })),
}));

describe('the invoice documents tab', () => {
  it('lists the load’s current files, RC first, without replaced or missing ones', async () => {
    renderPage(<InvoiceDocuments loadNumber="TEST-INV-1" />, { routePath: '/', path: '/' });
    const rows = await screen.findAllByTestId('invoice-document');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('rc.pdf');
    expect(rows[1]).toHaveTextContent('pod.pdf');
    expect(rows[1]).toHaveTextContent('Reviewed');
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
  });

  it('says so when the invoice has no load', async () => {
    renderPage(<InvoiceDocuments loadNumber={null} />, { routePath: '/', path: '/' });
    expect(await screen.findByText('No load on this invoice')).toBeVisible();
  });
});
