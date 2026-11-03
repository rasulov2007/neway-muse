import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtiUnitIssues } from '@neway/shared';
import { setFlagForTests } from '@/lib/feature-flags';
import { BoardPtiIssueMark, PtiIssueBadge, PtiIssueMark, TrailerPtiIssueBadge } from './PtiIssueBadge';

const apiGet = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGet: (...args: unknown[]) => apiGet(...args),
}));

/**
 * The "PTI issue" sign beside a unit's status (owner, 2026-10-21): symbol, word and colour - the
 * octagon in the urgent family for an out-of-service or replace-now defect, the diamond in the
 * warning family otherwise - with the count when there is more than one.
 */

function issues(patch: Partial<PtiUnitIssues> = {}): PtiUnitIssues {
  return {
    open: 1,
    worst: 'warning',
    summary: 'Brakes: Slack adjuster out of stroke (Replace soon, assigned)',
    defects: [],
    unitNumber: '0086',
    ...patch,
  };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  setFlagForTests('fleet_v2', null);
  apiGet.mockReset();
});

describe('PtiIssueBadge', () => {
  it('draws the diamond and "PTI issue" in the warning family for a mild defect', () => {
    const { container } = render(<PtiIssueBadge issues={issues()} />);
    const badge = screen.getByText('PTI issue');
    expect(badge.className).toMatch(/bg-nw-warning-bg/);
    expect(badge.getAttribute('data-pti-issue')).toBe('warning');
    // The diamond: the warning symbol's path.
    expect(container.querySelector('path')?.getAttribute('d')).toBe('M8 .3l7.7 7.7L8 15.7.3 8z');
    expect(badge.getAttribute('title')).toContain('Brakes: Slack adjuster out of stroke');
  });

  it('draws the octagon in the urgent family for replace-now and out-of-service, with the count', () => {
    const { container, rerender } = render(<PtiIssueBadge issues={issues({ worst: 'urgent', open: 2 })} />);
    const badge = screen.getByText('2 PTI issues');
    expect(badge.className).toMatch(/bg-nw-urgent-bg/);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M5\.1 \.8h5\.8/);

    rerender(<PtiIssueBadge issues={issues({ worst: 'oos', open: 3 })} />);
    const oos = screen.getByText('3 PTI issues');
    expect(oos.className).toMatch(/bg-nw-urgent-bg/);
    expect(oos.getAttribute('title')).toMatch(/^3 PTI issues · out-of-service risk/);
  });

  it('the board mark keeps the symbol and a word', () => {
    render(<PtiIssueMark issues={issues({ worst: 'urgent' })} />);
    expect(screen.getByText('PTI')).toBeTruthy();
    expect(screen.getByText(': PTI issue')).toBeTruthy();
  });
});

describe('the connected signs', () => {
  it('draws nothing before the answer arrives, then finds the truck by its number on the board', async () => {
    setFlagForTests('fleet_v2', true);
    let resolve: (value: Record<string, PtiUnitIssues>) => void = () => {};
    apiGet.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = render(withQuery(<BoardPtiIssueMark unitNumber=" 0086 " />));
    expect(container.textContent).toBe('');

    resolve({ trk_1: issues({ worst: 'oos' }) });
    expect(await screen.findByText('PTI')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/fleet/pti/unit-issues');
  });

  it('draws nothing for a unit with no issue, and does not ask when fleet_v2 is off', async () => {
    setFlagForTests('fleet_v2', true);
    apiGet.mockResolvedValue({ trk_1: issues() });
    const { container } = render(withQuery(<TrailerPtiIssueBadge trailerId="trl_9" />));
    await vi.waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');

    apiGet.mockReset();
    setFlagForTests('fleet_v2', false);
    const off = render(withQuery(<TrailerPtiIssueBadge trailerId="trk_1" />));
    expect(off.container.textContent).toBe('');
    expect(apiGet).not.toHaveBeenCalled();
  });
});
