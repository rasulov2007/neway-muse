import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccessorialSplitResponse } from '../useInsights';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { AccessorialSplitCard, SplitMeter } from './AccessorialSplitCard';

const REASON = 'In the driver’s percentage base: known once the statement is approved.';

const DATA: AccessorialSplitResponse = {
  range: { from: '2026-10-12', to: '2026-10-18' },
  source: 'database',
  rows: [
    { type: 'detention', label: 'Detention', loads: 3, charges: 3, claims: 1, billed: 500, toDriver: null, toDriverReason: REASON, unknownDriver: 1, toDispatcher: 40, companyKeeps: null },
    { type: 'tonu', label: 'TONU', loads: 1, charges: 1, claims: 1, billed: 250, toDriver: 100, toDriverReason: null, unknownDriver: 0, toDispatcher: 25, companyKeeps: 125 },
  ],
  totals: { loads: 4, charges: 4, claims: 2, billed: 750, toDriver: null, toDriverReason: REASON, unknownDriver: 1, toDispatcher: 65, companyKeeps: null },
  loads: {
    items: [
      { loadId: 'l2', loadNumber: 'L-100002', brokerReference: 'REF-77', type: 'tonu', label: 'TONU', day: '2026-10-15', charges: 1, billed: 250, toDriver: 100, driverBasis: 'statement', driverReason: null, toDispatcher: 25, companyKeeps: 125, driverName: 'Bob Stone', dispatcherName: 'Sam', claimStatus: 'paid', href: '/loads/L-100002' },
      { loadId: 'l3', loadNumber: 'L-100003', brokerReference: null, type: 'detention', label: 'Detention', day: '2026-10-16', charges: 1, billed: 120, toDriver: null, driverBasis: 'unknown', driverReason: REASON, toDispatcher: 0, companyKeeps: null, driverName: 'Ann Lee', dispatcherName: null, claimStatus: null, href: '/loads/L-100003' },
    ],
    total: 2,
    page: 1,
    pageSize: 10,
  },
  driverBases: { statement: 1, unknown: 1 },
  notes: [],
};

describe('AccessorialSplitCard', () => {
  it('shows one row per type and a totals row with Billed / Driver / Dispatcher / Company', () => {
    render(<AccessorialSplitCard data={DATA} />);
    const card = screen.getByTestId('accessorial-split');
    expect(within(card).getByText('Accessorials — who gets what')).toBeInTheDocument();
    const tonu = screen.getByRole('row', { name: /TONU/ });
    expect(within(tonu).getByText('$250.00')).toBeInTheDocument();
    expect(within(tonu).getByText('$100.00')).toBeInTheDocument();
    expect(within(tonu).getByText('$25.00')).toBeInTheDocument();
    expect(within(tonu).getByText('$125.00')).toBeInTheDocument();
    const total = screen.getByRole('row', { name: /Total/ });
    expect(within(total).getByText('$750.00')).toBeInTheDocument();
    expect(within(total).getByText('$65.00')).toBeInTheDocument();
  });

  it('an unknown driver share is a dash with its reason, never $0, and so is Company', () => {
    render(<AccessorialSplitCard data={DATA} />);
    const detention = screen.getByRole('row', { name: /Detention/ });
    const dashes = within(detention).getAllByLabelText(`Not known: ${REASON}`);
    expect(dashes).toHaveLength(2);
    expect(dashes[0]).toHaveTextContent('—');
    expect(within(detention).queryByText('$0.00')).toBeNull();
    expect(within(detention).getByText('1 driver share not known')).toBeInTheDocument();
    expect(within(detention).getByTestId('split-unknown')).toHaveAttribute('aria-label', `Split not known: ${REASON}`);
  });

  it('the split bar has a segment for each of driver, dispatcher and company, sized by share', () => {
    const { container } = render(<SplitMeter driver={100} dispatcher={25} company={125} />);
    const segments = container.querySelectorAll('[data-segment]');
    expect([...segments].map((s) => s.getAttribute('data-segment'))).toEqual(['driver', 'dispatcher', 'company']);
    expect((segments[0] as HTMLElement).style.width).toBe('40%');
    expect((segments[1] as HTMLElement).style.width).toBe('10%');
    expect((segments[2] as HTMLElement).style.width).toBe('50%');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Driver 40%, Dispatcher 10%, Company 50%');
  });

  it('Show loads opens the per-load list, most recent first as the server sent it', async () => {
    render(<AccessorialSplitCard data={DATA} />);
    expect(screen.queryByRole('table', { name: 'Accessorial loads' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show loads · 2/ }));
    const list = screen.getByRole('table', { name: 'Accessorial loads' });
    const rows = within(list).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('link', { name: 'L-100002' })).toHaveAttribute('href', '/loads/L-100002');
    expect(within(rows[0]!).getByText(/REF REF-77/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Bob Stone')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Sam')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('paid')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('not known')).toBeInTheDocument();
  });

  it('empty period: says so', () => {
    render(<AccessorialSplitCard data={{ ...DATA, rows: [], loads: { items: [], total: 0, page: 1, pageSize: 10 } }} />);
    expect(screen.getByText('No detention, layover or TONU in this period')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
