import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end checks against the Vite dev server. Run with `npm run e2e -w apps/web`.
 * Reuses an already running dev server on 5173 when present.
 *
 * The API is started too, because trucks and drivers are read from PostgreSQL now. Without it the
 * fleet and driver pages render an error state, which is the correct behaviour — an unreachable
 * server must not be shown as an empty fleet — but it is not what these tests are checking.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'npm run --silent start --workspace @neway/api',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: '../..',
    },
    {
      command: 'npx vite --port 5173',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
