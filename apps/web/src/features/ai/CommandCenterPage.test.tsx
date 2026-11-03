import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setClockForTests } from '@/lib/clock';
import { renderPage } from '@/features/common/test-router';
import { CommandCenterPage } from './CommandCenterPage';

vi.mock('@/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/demo')>();
  return {
    ...actual,
    listAiInsights: vi.fn(() => Promise.resolve(structuredClone(actual.demoData.aiInsights))),
  };
});

describe('CommandCenterPage', () => {
  // The greeting is a function of the hour, so the hour has to be a fact and not whenever the
  // suite happens to run.
  beforeEach(() => setClockForTests('2026-09-16T14:30:00-05:00'));
  afterEach(() => setClockForTests(null));

  it('renders the greeting, sections and counts from insights', async () => {
    renderPage(<CommandCenterPage />, { routePath: '/ai', path: '/ai' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Good afternoon, Sarah' }),
    ).toBeVisible();
    expect(
      await screen.findByText(/^\d+ items require attention across \d+ departments\.$/),
    ).toBeInTheDocument();

    expect(screen.getByText('Financial')).toBeInTheDocument();
    expect(screen.getByText('Recommendations')).toBeInTheDocument();
    // Operational counts are not restated here: they belong to the modules that own them, and a
    // second derivation of "loads at risk" would eventually disagree with the first.
    expect(screen.queryByText('3 loads are at risk')).not.toBeInTheDocument();
    expect(screen.queryByText('5 trucks have maintenance concerns')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pending approvals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI activity' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Token usage' })).toBeInTheDocument();
    expect(screen.getAllByText('require_approval').length).toBeGreaterThan(0);
  });

  it('dismisses a recommendation locally and opens the Ask AI preview', async () => {
    const user = userEvent.setup();
    renderPage(<CommandCenterPage />, { routePath: '/ai', path: '/ai' });

    const title = await screen.findByText('Review Unit 3012 fuel efficiency');
    const card = title.closest('section');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('81% confidence');
    expect(card).toHaveTextContent('30-day MPG: 5.93');

    const dismiss = Array.from(card?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Dismiss',
    );
    expect(dismiss).toBeDefined();
    await user.click(dismiss as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByText('Review Unit 3012 fuel efficiency')).toBeNull());
    expect(await screen.findByText('Recommendation dismissed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(await screen.findByRole('dialog', { name: 'Ask AI' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Ask about loads, trucks, drivers, fuel, money…'),
    ).toBeInTheDocument();
    expect(screen.getByText(/The assistant arrives in Phase 14/)).toBeInTheDocument();
  });
});
