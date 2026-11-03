import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { PerformancePage } from './PerformancePage';

/**
 * The page renders at all.
 *
 * It did not: a leaderboard that throws during render puts the whole page behind "Unable to load
 * this page", and neither the typechecker nor the bundler notices. This mounts it the way the app
 * does, against the stubbed server, so a render-time throw fails here instead of in production.
 */
describe('the performance board', () => {
  it('renders without throwing', async () => {
    renderPage(<PerformancePage />, {
      routePath: '/dispatch/performance',
      path: '/dispatch/performance',
    });
    await waitFor(() => {
      expect(screen.getByText('Dispatcher Performance')).toBeVisible();
    });
  });

  it('shows the podium, the leader and the ranked rows', async () => {
    renderPage(<PerformancePage />, {
      routePath: '/dispatch/performance',
      path: '/dispatch/performance',
    });
    await waitFor(() => {
      expect(screen.getAllByText('MAX').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('ADIN').length).toBeGreaterThan(0);
    // The leader says it twice: once on the podium, once on their row.
    expect(screen.getAllByText('Holding the crown').length).toBeGreaterThan(0);
  });

  it('opens a board to the drivers on it', async () => {
    const user = userEvent.setup();
    renderPage(<PerformancePage />, {
      routePath: '/dispatch/performance',
      path: '/dispatch/performance',
    });
    await waitFor(() => expect(screen.getAllByText('MAX').length).toBeGreaterThan(0));
    await user.click(screen.getByLabelText(/Show the drivers on MAX/));
    expect(await screen.findByText('MAX driver')).toBeVisible();
  });
});
