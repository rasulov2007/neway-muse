import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BackButton } from './BackButton';

/**
 * Back pops history; with nothing to pop it goes to the parent.
 *
 * Both halves matter. The first is what makes it fast — the list page and its cached data are
 * still there, so nothing refetches. The second is what stops a pasted detail URL from walking
 * the person out of the application.
 */
function renderAt(entries: string[]) {
  const rootRoute = createRootRoute();
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/loads',
    component: () => <h1>list</h1>,
  });
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/loads/$id',
    component: () => <BackButton fallback="/loads" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([list, detail]),
    history: createMemoryHistory({ initialEntries: entries }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('BackButton', () => {
  it('pops history when there is somewhere to go back to', async () => {
    const user = userEvent.setup();
    const router = renderAt(['/loads', '/loads/L-1']);
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await expect.poll(() => router.state.location.pathname).toBe('/loads');
  });

  it('falls back to the parent route when the page was opened directly', async () => {
    const user = userEvent.setup();
    const router = renderAt(['/loads/L-1']);
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await expect.poll(() => router.state.location.pathname).toBe('/loads');
  });

  it('is labelled as an action, not as the destination page', async () => {
    renderAt(['/loads', '/loads/L-1']);
    const button = await screen.findByRole('button', { name: 'Back' });
    expect(button).toHaveAccessibleName('Back');
    expect(button).not.toHaveTextContent('Loads');
  });
});
