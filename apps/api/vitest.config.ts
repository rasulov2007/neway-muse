import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // unplugin-swc compiles TypeScript with decorator metadata (required by NestJS DI),
  // which esbuild (Vite's default transformer) cannot emit.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    // The e2e specs share ONE real database: they seed it, create accounts in it and assert
    // counts from it. Run the files one at a time so they cannot race each other - concurrent
    // seeding was making the suite report every test passing while exiting non-zero.
    fileParallelism: false,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // E2E_DATABASE_URL points one run at another LOCAL copy (e.g. the cutover rehearsal database); default the dev DB.
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://neway:neway@localhost:5432/neway',
      APP_SECRET: 'test-secret-test-secret-test-secret-0000',
      // The e2e suite proves RBAC by acting as specific accounts, which is what these headers are
      // for. `loadEnv` refuses the flag when NODE_ENV is production, so this cannot leak.
      AUTH_DEV_HEADERS: 'true',
    },
  },
});
