import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotApplication, DotLinkStatus, HiringCase } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { DotLinkBar, DriverReviewBanner } from './DotLinkPanel';
import { dotLinkProgress } from './dot-link-progress';

/** Sending the DOT application to the driver: the staff dialog and the status line. */
const kase = { id: 'c1', applicantId: 'ap1', candidateName: 'Case Driver' } as HiringCase;
const URL_SENT = 'https://neway.example.com/dot/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const status = (over: Partial<DotLinkStatus> = {}): DotLinkStatus => ({
  id: 'dotl_1',
  state: 'live',
  createdAt: '2026-10-07T14:00:00.000Z',
  createdByName: 'Rita Recruiter',
  expiresAt: '2026-10-21T14:00:00.000Z',
  revokedAt: null,
  revokedBy: null,
  firstOpenedAt: '2026-10-07T19:10:00.000Z',
  lastOpenedAt: '2026-10-07T19:10:00.000Z',
  lastSavedAt: null,
  submittedAt: null,
  cdlUploadedAt: null,
  applicationStatus: 'draft',
  certifiedAt: null,
  acceptedAt: null,
  acceptedBy: null,
  returnedAt: null,
  returnedBy: null,
  ...over,
});

let calls: { method: string; path: string }[] = [];
const original = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path });
    const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (path === '/hiring/cases/c1/dot-application/link' && method === 'POST') {
      return reply({ url: URL_SENT, expiresAt: '2026-10-21T14:00:00.000Z', link: status() }, 201);
    }
    if (path === '/hiring/cases/c1/dot-application/link/files') return reply([]);
    if (path === '/hiring/cases/c1/dot-application/link' && method === 'DELETE') {
      return reply({ link: status({ state: 'revoked', revokedAt: '2026-10-08T14:00:00.000Z', revokedBy: 'Rita Recruiter' }) });
    }
    return reply({});
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

describe('Send to driver', () => {
  it('makes a link on the first press and shows it once, with its Eastern expiry and the warning', async () => {
    const user = userEvent.setup();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    renderPage(<DotLinkBar hiringCase={kase} link={null} loading={false} canEdit submitted={false} />);
    await user.click(await screen.findByTestId('send-to-driver'));
    const field = await screen.findByTestId('dot-link-url');
    expect(field).toHaveValue(URL_SENT);
    expect(field).toHaveAttribute('readonly');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const dialog = screen.getByTestId('send-to-driver-dialog');
    expect(within(dialog).getByText(/Anyone with this link can fill in this driver's application\. Send it only to the driver\./)).toBeVisible();
    expect(within(dialog).getByText(/Works until Oct 21, 2026, 10:00 AM EDT/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByText('Link copied')).toBeVisible());
  });

  it('with a live link it shows the progress and asks before making a new one', async () => {
    const user = userEvent.setup();
    renderPage(<DotLinkBar hiringCase={kase} link={status()} loading={false} canEdit submitted={false} />);
    expect(await screen.findByTestId('dot-link-status')).toHaveTextContent('Sent Oct 7, 2026, 10:00 AM EDT by Rita Recruiter · opened Oct 7, 2026, 3:10 PM EDT');
    await user.click(await screen.findByTestId('send-to-driver'));
    expect(await screen.findByTestId('dot-link-current')).toBeVisible();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Create a new link' }));
    expect(screen.getByText('Create a new link?')).toBeVisible();
    const confirm = screen.getAllByRole('button', { name: 'Create a new link' }).at(-1)!;
    await user.click(confirm);
    expect(await screen.findByTestId('dot-link-url')).toHaveValue(URL_SENT);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('turns the link off after a confirmation', async () => {
    const user = userEvent.setup();
    renderPage(<DotLinkBar hiringCase={kase} link={status()} loading={false} canEdit submitted={false} />);
    await user.click(await screen.findByTestId('send-to-driver'));
    await user.click(await screen.findByRole('button', { name: 'Turn off link' }));
    const confirm = screen.getAllByRole('button', { name: 'Turn off link' }).at(-1)!;
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('is hidden for view-only users and once the application and CDL are in', async () => {
    renderPage(<DotLinkBar hiringCase={kase} link={status({ submittedAt: '2026-10-07T20:00:00.000Z', cdlUploadedAt: '2026-10-07T20:05:00.000Z' })} loading={false} canEdit submitted />);
    await screen.findByTestId('dot-link-bar');
    expect(screen.queryByTestId('send-to-driver')).toBeNull();
  });
});

describe('dotLinkProgress', () => {
  it('names every step the driver took, in Eastern time', () => {
    const text = dotLinkProgress(status({ lastSavedAt: '2026-10-07T19:20:00.000Z', submittedAt: '2026-10-07T19:30:00.000Z', cdlUploadedAt: '2026-10-07T19:35:00.000Z' }));
    expect(text).toBe(
      'Sent Oct 7, 2026, 10:00 AM EDT by Rita Recruiter · opened Oct 7, 2026, 3:10 PM EDT · last saved Oct 7, 2026, 3:20 PM EDT · submitted Oct 7, 2026, 3:30 PM EDT · CDL uploaded Oct 7, 2026, 3:35 PM EDT',
    );
    expect(dotLinkProgress(status({ applicationStatus: 'driver_submitted', certifiedAt: '2026-10-07T19:30:00.000Z' }))).toContain(
      'Submitted by the driver Oct 7, 2026, 3:30 PM EDT — needs review',
    );
    expect(dotLinkProgress(status({ applicationStatus: 'submitted', acceptedAt: '2026-10-08T14:00:00.000Z', acceptedBy: 'Rita Recruiter' }))).toContain(
      'Accepted by Rita Recruiter Oct 8, 2026, 10:00 AM EDT',
    );
    expect(dotLinkProgress(status({ applicationStatus: 'draft', returnedAt: '2026-10-08T14:00:00.000Z', returnedBy: 'Rita Recruiter' }))).toContain(
      'Returned Oct 8, 2026, 10:00 AM EDT by Rita Recruiter',
    );
    expect(dotLinkProgress(status({ state: 'revoked', revokedAt: '2026-10-08T14:00:00.000Z', revokedBy: 'Rita Recruiter' }))).toBe(
      'Driver link turned off Oct 8, 2026, 10:00 AM EDT by Rita Recruiter',
    );
  });
});

describe('Driver review banner', () => {
  const app = {
    id: 'dot1', hiringCaseId: 'c1', applicantId: 'ap1', status: 'driver_submitted', form: {}, ssnLast4: null, documentId: null,
    driverId: null, verificationCaseId: null, consentIds: [], submittedAt: null, submittedBy: null, submittedVia: 'driver_link',
    certifiedAt: '2026-10-07T19:30:00.000Z', certifiedName: 'Dana Driver', reviewedAt: null, reviewedBy: null, returnedAt: null,
    returnedBy: null, returnNote: null, updatedAt: '2026-10-07T19:30:00.000Z',
  } as unknown as DotApplication;

  it('says it needs review with the certification time, and Accept asks first', async () => {
    const user = userEvent.setup();
    renderPage(<DriverReviewBanner hiringCase={kase} application={app} canEdit />);
    const banner = await screen.findByTestId('dot-review-banner');
    expect(within(banner).getByText('Submitted by the driver — needs review')).toBeVisible();
    expect(banner).toHaveTextContent('Dana Driver certified and submitted it through the link on Oct 7, 2026, 3:30 PM EDT');
    await user.click(screen.getByTestId('dot-accept'));
    await user.click(await screen.findByRole('button', { name: 'Accept and file' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/dot-application/accept'))).toBe(true));
  });

  it('Return to driver needs a note', async () => {
    const user = userEvent.setup();
    renderPage(<DriverReviewBanner hiringCase={kase} application={app} canEdit />);
    await user.click(await screen.findByTestId('dot-return'));
    const send = screen.getAllByRole('button', { name: 'Return to driver' }).at(-1)!;
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('What should the driver fix?'), 'Add your 2019 employer.');
    await user.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/dot-application/return'))).toBe(true));
  });
});
