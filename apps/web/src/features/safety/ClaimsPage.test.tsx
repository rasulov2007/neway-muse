import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { ClaimsPage } from './ClaimsPage';
import type { Claim } from '@/demo';

/** The claims the bundle drains are this file's own, so the assertions do not follow the seed. */
const mocks = vi.hoisted(() => ({ listClaims: vi.fn() }));

vi.mock('@/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo')>()),
  listClaims: (query: unknown) => mocks.listClaims(query),
}));

const { demoData } = await import('@/demo');

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`the demo book has no ${what}`);
  return row;
}
const TEMPLATE = must(demoData.claims[0], 'claims');

function claim(over: Partial<Claim> = {}): Claim {
  const base: Claim = {
    ...structuredClone(TEMPLATE),
    id: 'clm_1',
    claimNumber: 'CLM-2026-0008',
    accidentId: 'acc_1',
    accidentNumber: 'ACC-2026-0099',
    unitNumber: '3022',
    insurer: 'Great West Casualty',
    kind: 'liability',
    status: 'investigating',
    openedAt: '2026-03-14T09:00:00.000Z',
  };
  return Object.assign(base, over);
}

/** The safety bundle pages through its lists; this answers in pages of 200, as the store does. */
function paged(rows: Claim[]) {
  return async (query: { page?: number; pageSize?: number }) => {
    const size = query.pageSize ?? 200;
    const page = query.page ?? 1;
    return { data: rows.slice((page - 1) * size, page * size), total: rows.length };
  };
}

function render() {
  return renderPage(<ClaimsPage />, { routePath: '/safety/claims', path: '/safety/claims' });
}

describe('the claims register', () => {
  beforeEach(() => {
    mocks.listClaims.mockReset();
  });

  it('lists the claims with the accident, unit, insurer, status and date', async () => {
    mocks.listClaims.mockImplementation(paged([claim()]));

    render();

    const table = await screen.findByRole('table', { name: 'Claims' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    expect(within(table).getByRole('link', { name: 'CLM-2026-0008' })).toHaveAttribute(
      'href',
      '/safety/claims/clm_1',
    );
    expect(within(table).getByRole('link', { name: 'ACC-2026-0099' })).toHaveAttribute(
      'href',
      '/safety/accidents/acc_1',
    );
    expect(table).toHaveTextContent('3022');
    expect(table).toHaveTextContent('Great West Casualty');
    expect(table).toHaveTextContent('Liability');
    expect(within(table).getByRole('link', { name: 'View claim' })).toBeInTheDocument();
  });

  it('says plainly that these are our records, not filings', async () => {
    mocks.listClaims.mockImplementation(paged([claim()]));
    render();
    expect(await screen.findByText(/Nothing here is submitted to an insurer/i)).toBeVisible();
  });

  it('keeps every page of results', async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      claim({ id: `clm_${i}`, claimNumber: `CLM-${String(i).padStart(4, '0')}` }),
    );
    mocks.listClaims.mockImplementation(paged(many));

    render();

    await screen.findByRole('table', { name: 'Claims' });
    // The 201st record is on the bundle's second page; a single request would lose it.
    await waitFor(() => expect(mocks.listClaims).toHaveBeenCalledTimes(2));
  });

  it('filters by what was typed', async () => {
    const user = userEvent.setup();
    mocks.listClaims.mockImplementation(
      paged([
        claim(),
        claim({
          id: 'clm_2',
          claimNumber: 'CLM-2026-0009',
          insurer: 'Sentry',
          accidentNumber: 'ACC-2026-0100',
          accidentId: 'acc_2',
        }),
      ]),
    );

    render();
    const table = await screen.findByRole('table', { name: 'Claims' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(2));

    await user.type(
      screen.getByPlaceholderText('Search claim, accident, unit or insurer'),
      'Sentry',
    );
    await waitFor(() => expect(screen.queryByText('CLM-2026-0008')).toBeNull());
    expect(screen.getByText('CLM-2026-0009')).toBeVisible();
  });

  it('counts them by where they have got to, and filters on the count', async () => {
    const user = userEvent.setup();
    mocks.listClaims.mockImplementation(
      paged([
        claim({ id: 'clm_open', claimNumber: 'CLM-OPEN', status: 'submitted' }),
        claim({ id: 'clm_draft', claimNumber: 'CLM-DRAFT', status: 'draft' }),
        claim({ id: 'clm_done', claimNumber: 'CLM-DONE', status: 'settled' }),
        claim({ id: 'clm_closed', claimNumber: 'CLM-CLOSED', status: 'closed' }),
        claim({ id: 'clm_no', claimNumber: 'CLM-DENIED', status: 'denied' }),
      ]),
    );

    render();
    await screen.findByRole('table', { name: 'Claims' });

    const strip = (label: string) => screen.getByRole('button', { name: new RegExp(label, 'i') });
    await waitFor(() => expect(strip('Claims')).toHaveTextContent('5'));
    expect(strip('^Open')).toHaveTextContent('2');
    expect(strip('Settled or closed')).toHaveTextContent('2');
    expect(strip('Denied')).toHaveTextContent('1');

    await user.click(strip('Denied'));
    await waitFor(() => expect(screen.queryByText('CLM-OPEN')).toBeNull());
    expect(screen.getByText('CLM-DENIED')).toBeVisible();

    // Pressing it again lets everything back in.
    await user.click(strip('Denied'));
    await waitFor(() => expect(screen.getByText('CLM-OPEN')).toBeVisible());
  });

  it('opens a claim from the accident it belongs to, and offers no accident twice', async () => {
    const user = userEvent.setup();
    mocks.listClaims.mockImplementation(paged([claim()]));

    render();
    await screen.findByRole('table', { name: 'Claims' });

    await user.click(screen.getByRole('button', { name: 'Create claim' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('one claim per incident');

    // The accidents offered are the ones with no claim on them.
    await user.click(within(dialog).getByRole('button', { name: 'Accident' }));
    const offered = await screen.findAllByRole('option');
    expect(offered.length).toBeGreaterThan(0);
    for (const option of offered) {
      expect(option.textContent).not.toContain('ACC-2026-0099');
    }
  });

  it('says so when there is nothing on file', async () => {
    mocks.listClaims.mockImplementation(paged([]));
    render();
    expect(await screen.findByText('No claims on file')).toBeVisible();
  });
});
