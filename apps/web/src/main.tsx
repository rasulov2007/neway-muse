import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Geist is the single UI family. Weights are imported explicitly rather than via the package's
// index so the bundle carries only the three the type scale uses.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import { AppProviders } from './app/providers';
import { queryClient } from './app/query-client';
import { router } from './app/router';
import { initPersistedState, startStatePersistence } from './demo/state-persist';
import './index.css';
// The board's status palette on every page: the loads list wears DISPATCHED's board colour (owner, 2026-10-30).
import './features/dispatch/board/board-colors.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

/*
 * The PostgreSQL snapshot lays saved work back over the generated dataset, then the autosave loop
 * keeps it current.
 *
 * Deliberately NOT awaited before render. It used to be, which made first paint wait on the
 * network and - worse - put an authenticated call in front of the login screen, where it could
 * only fail.
 *
 * Because render starts first, queries can and do resolve against the generated dataset before
 * the snapshot lands on top of it. Those answers are stale the instant it does, and nothing short
 * of saying so brings them back: the cache holds them for the stale time, which is how a load
 * could sit in the register showing a POD on file and a status that never moved. So the cache is
 * emptied once hydration finishes, and every mounted page asks again.
 */
void initPersistedState()
  .then(() => queryClient.invalidateQueries())
  .finally(() =>
    startStatePersistence({ onRemoteChange: () => void queryClient.invalidateQueries() }),
  );

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
