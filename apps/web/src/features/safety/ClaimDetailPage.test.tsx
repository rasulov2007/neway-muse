import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { ClaimDetailPage } from './ClaimDetailPage';
import type { Accident, Claim } from '@/demo';

/**
 * The bundle is fed by hand so the records under test are this file's own: the page's job is to
 * read what a claim holds, and a fixture built from the seed would make "what is on screen" depend
 * on whichever claim the generator happened to produce.
 */
const mocks = vi.hoisted(() => ({
  listClaims: vi.fn(),
  listAccidents: vi.fn(),
}));

vi.mock('@/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/demo')>();
  return {
    ...actual,
    listClaims: (query: unknown) => mocks.listClaims(query),
    listAccidents: (query: unknown) => mocks.listAccidents(query),
  };
});

const { demoData } = await import('@/demo');

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`the demo book has no ${what}`);
  return row;
}
const ACCIDENT_TEMPLATE = must(demoData.accidents[0], 'accidents');
const CLAIM_TEMPLATE = must(demoData.claims[0], 'claims');

function accident(over: Partial<Accident> = {}): Accident {
  const base: Accident = {
    ...structuredClone(ACCIDENT_TEMPLATE),
    id: 'acc_1',
    accidentNumber: 'ACC-2026-0099',
    at: '2026-03-13T19:30:00.000Z',
    location: { city: 'Joliet', state: 'IL', highway: 'I-80' },
    trailerUnit: 'T-5374',
  };
  return Object.assign(base, over);
}

function claim(over: Partial<Claim> = {}): Claim {
  const base: Claim = {
    ...structuredClone(CLAIM_TEMPLATE),
    id: 'clm_1',
    claimNumber: 'CLM-2026-0008',
    accidentId: 'acc_1',
    accidentNumber: 'ACC-2026-0099',
    kind: 'liability',
    insurer: 'Great West Casualty',
    insurerClaimNumber: 'GW-88213',
    status: 'investigating',
    reserveAmount: 45_000,
    paidAmount: null,
    deductible: 5_000,
    description: 'Third-party bodily injury alleged at the scene.',
    driverId: 'drv_1',
    driverName: 'Terrence Wood',
    truckId: 'trk_1',
    unitNumber: '3022',
    trailerId: 'trl_1',
    loadId: 'load_1',
    loadNumber: 'L-100245',
    customerId: 'cus_1',
    customerName: 'Midwest Steel',
    brokerId: null,
    brokerName: null,
    openedAt: '2026-03-14T09:00:00.000Z',
    closedAt: null,
    ownerId: 'usr_1',
    ownerName: 'Tom Brennan',
    notes: 'Adjuster assigned; statement taken.',
  };
  return Object.assign(base, over);
}

/** The safety bundle drains its lists, so every mock answers one full page. */
function page<T>(rows: T[]) {
  return async () => ({ data: rows, total: rows.length });
}

function render(claimId: string) {
  return renderPage(<ClaimDetailPage claimId={claimId} />, {
    routePath: '/safety/claims/$claimId',
    path: `/safety/claims/${claimId}`,
  });
}

/** The fact list pairs a term with its value; read the value beside the term. */
function fact(label: string): HTMLElement {
  const term = screen.getAllByText(label).find((node) => node.tagName === 'DT');
  const value = term?.nextElementSibling;
  if (!value) throw new Error(`no value beside "${label}"`);
  return value as HTMLElement;
}

describe('a claim on its own page', () => {
  beforeEach(() => {
    mocks.listClaims.mockReset();
    mocks.listAccidents.mockReset();
    mocks.listAccidents.mockImplementation(page([accident()]));
  });

  it('opens the claim the URL names, not merely the first one', async () => {
    mocks.listClaims.mockImplementation(
      page([
        claim(),
        claim({ id: 'clm_2', claimNumber: 'CLM-2026-0009', insurer: 'Sentry', accidentId: null }),
      ]),
    );

    render('clm_2');

    expect(await screen.findByRole('heading', { name: 'Claim CLM-2026-0009' })).toBeVisible();
    expect(screen.queryByText('CLM-2026-0008')).toBeNull();
  });

  it('shows the file: status, cover, insurer, dates, owner, exposure and notes', async () => {
    mocks.listClaims.mockImplementation(page([claim()]));

    render('clm_1');

    expect(await screen.findByRole('heading', { name: 'Claim CLM-2026-0008' })).toBeVisible();
    expect(fact('Cover')).toHaveTextContent('Liability');
    expect(fact('Insurer')).toHaveTextContent('Great West Casualty');
    expect(fact("Insurer's reference")).toHaveTextContent('GW-88213');
    expect(fact('Owner')).toHaveTextContent('Tom Brennan');
    expect(fact('Closed')).toHaveTextContent('Still open');
    expect(fact('Reserve')).toHaveTextContent('$45,000.00');
    expect(fact('Deductible')).toHaveTextContent('$5,000.00');
    expect(screen.getByText('Third-party bodily injury alleged at the scene.')).toBeVisible();
    expect(screen.getByText('Adjuster assigned; statement taken.')).toBeVisible();
    // A reserve is not a debt: no "outstanding" line, and the difference is never computed.
    expect(screen.queryByText('Outstanding')).toBeNull();
    expect(screen.queryByText('$40,000.00')).toBeNull();
    expect(screen.getByText(/money set aside against this claim, not money owed/i)).toBeVisible();
  });

  it('says what has no figure rather than printing a zero', async () => {
    mocks.listClaims.mockImplementation(
      page([claim({ reserveAmount: null, paidAmount: null, deductible: null })]),
    );

    render('clm_1');

    await screen.findByRole('heading', { name: 'Claim CLM-2026-0008' });
    for (const label of ['Reserve', 'Paid', 'Deductible']) {
      expect(fact(label)).toHaveTextContent('Not recorded');
      expect(fact(label)).not.toHaveTextContent('$0');
    }
  });

  it('links the related records by their ids', async () => {
    mocks.listClaims.mockImplementation(page([claim()]));

    render('clm_1');

    await screen.findByRole('heading', { name: 'Claim CLM-2026-0008' });
    expect(screen.getByRole('link', { name: 'ACC-2026-0099' })).toHaveAttribute(
      'href',
      '/safety/accidents/acc_1',
    );
    expect(screen.getByRole('link', { name: '3022' })).toHaveAttribute(
      'href',
      '/fleet/trucks/trk_1',
    );
    expect(screen.getByRole('link', { name: 'Terrence Wood' })).toHaveAttribute(
      'href',
      '/drivers/drv_1',
    );
    expect(screen.getByRole('link', { name: 'T-5374' })).toHaveAttribute(
      'href',
      '/fleet/trailers/trl_1',
    );
    expect(screen.getByRole('link', { name: 'L-100245' })).toHaveAttribute(
      'href',
      '/loads/L-100245',
    );
    // Read from the accident by id, not guessed from anything on screen.
    expect(fact('Where')).toHaveTextContent('Joliet, IL');
  });

  it('survives a claim with nothing attached to it', async () => {
    mocks.listClaims.mockImplementation(
      page([
        claim({
          accidentId: null,
          accidentNumber: null,
          truckId: null,
          unitNumber: null,
          driverId: null,
          driverName: null,
          trailerId: null,
          loadId: null,
          loadNumber: null,
          customerId: null,
          customerName: null,
          brokerId: null,
          brokerName: null,
          ownerId: null,
          ownerName: null,
          insurerClaimNumber: null,
          notes: null,
        }),
      ]),
    );

    render('clm_1');

    expect(await screen.findByRole('heading', { name: 'Claim CLM-2026-0008' })).toBeVisible();
    expect(fact('Accident')).toHaveTextContent('Not linked to an accident');
    expect(fact('Unit')).toHaveTextContent('Not recorded');
    expect(fact('Load')).toHaveTextContent('Not under load');
    expect(fact('Owner')).toHaveTextContent('Unassigned');
    expect(screen.getByText('No notes on this claim.')).toBeVisible();
    // Freight is only shown when something was recorded.
    expect(screen.queryByText('Freight')).toBeNull();
    expect(screen.queryByRole('link', { name: /ACC-/ })).toBeNull();
  });

  it('says so when the claim is not on file', async () => {
    mocks.listClaims.mockImplementation(page([claim()]));

    render('clm_nope');

    expect(await screen.findByText('That claim is not on file')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to claims' })).toBeInTheDocument();
  });

  it('offers a retry when safety cannot be read', async () => {
    mocks.listClaims.mockRejectedValue(new Error('safety is unreachable'));

    render('clm_1');

    await waitFor(() => expect(screen.getByText('Unable to load this claim')).toBeInTheDocument());
    expect(
      within(screen.getByRole('alert')).getByRole('button', { name: /try again/i }),
    ).toBeTruthy();
  });

  it('carries no status, payment or settlement controls', async () => {
    mocks.listClaims.mockImplementation(page([claim()]));

    render('clm_1');

    await screen.findByRole('heading', { name: 'Claim CLM-2026-0008' });
    for (const label of [/settle/i, /pay/i, /approve/i, /deny/i, /close claim/i, /submit/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });
});
