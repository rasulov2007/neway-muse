import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import type { BillingQueueRow } from '@/demo';
import { BillingDocuments } from './BillingDocuments';

/**
 * The review list in the billing drawer: RC, BOL and POD each with a state, a preview, and -
 * for someone allowed to - Mark reviewed and Reject. Without the permission the screen says why.
 */
const doc = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, type, status: 'pending', review: 'received', fileName: `${id}.pdf`, fileUrl: `/api/v1/files/${id}`, uploadedAt: '2026-09-29T11:00:00Z', uploadedBy: 'Dispatcher', ...over,
});

const row = (documents: unknown[]): BillingQueueRow =>
  ({
    load: { id: 'ld_1', loadNumber: 'TEST-BR-1', status: 'delivered', brokerReference: 'R-1', customerName: 'Broker', brokerName: 'Broker', rate: 3000, driverName: 'D', truckUnit: '1', deliveredAt: '2026-09-29T12:00:00Z', documents, charges: [], updatedAt: '2026-09-29T12:00:00Z', stops: [] },
    verdict: { loadId: 'ld_1', queue: 'needs_review', conditions: [], rc: { state: 'match' }, tonu: false },
    invoice: null,
  }) as unknown as BillingQueueRow;

const show = (r: BillingQueueRow, canReview: boolean) =>
  renderPage(<BillingDocuments row={r} canReview={canReview} onChanged={vi.fn(async () => {})} />, { routePath: '/', path: '/' });

describe('the billing documents review list', () => {
  it('lists RC, BOL and POD with their state', async () => {
    show(row([doc('rc', 'rate_confirmation'), doc('bol', 'bol', { review: 'reviewed', reviewedBy: 'Ann' }), doc('pod', 'pod', { review: 'rejected', reviewedBy: 'Ann', rejectedReason: 'Unsigned' })]), true);
    expect(await screen.findByText('Rate confirmation')).toBeVisible();
    expect(screen.getByText('Bill of lading')).toBeVisible();
    expect(screen.getByText('Proof of delivery')).toBeVisible();
    expect(screen.getByText('Uploaded')).toBeVisible();
    expect(screen.getAllByText('Reviewed').length).toBeGreaterThan(0);
    expect(screen.getByText('Rejected')).toBeVisible();
    expect(screen.getByText(/Unsigned/)).toBeVisible();
  });

  // No Mark reviewed: on file is enough, RTS checks the documents (owner, 2026-10-16).
  it('offers only Reject, on a file nobody has decided on', async () => {
    show(row([doc('rc', 'rate_confirmation'), doc('bol', 'bol', { review: 'reviewed', reviewedBy: 'Ann' })]), true);
    expect(await screen.findAllByRole('button', { name: 'Reject' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(1);
  });

  it('will not reject without a reason', async () => {
    const user = userEvent.setup();
    show(row([doc('rc', 'rate_confirmation')]), true);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('button', { name: 'Confirm reject' })).toBeDisabled();
    await user.type(screen.getByLabelText(/Why RC is rejected/), 'Wrong load number');
    expect(screen.getByRole('button', { name: 'Confirm reject' })).toBeEnabled();
  });

  it('explains, rather than hides, when the person may not review', async () => {
    show(row([doc('rc', 'rate_confirmation')]), false);
    expect(await screen.findByText(/can view these documents but not review them/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  });

  it('lists a replaced file as history, not as something to review', async () => {
    show(row([doc('pod_old', 'pod', { review: 'reviewed', supersededBy: 'pod_new' }), doc('pod_new', 'pod')]), true);
    expect(await screen.findByText('pod_new.pdf')).toBeVisible();
    expect(screen.queryByText('pod_old.pdf')).toBeNull();
    expect(screen.getByText(/1 earlier file was replaced/)).toBeVisible();
  });

  it('shows a missing document as missing', async () => {
    show(row([doc('rc', 'rate_confirmation')]), true);
    expect((await screen.findAllByText('Not uploaded')).length).toBe(2);
  });
});
