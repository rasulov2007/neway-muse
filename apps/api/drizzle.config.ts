import { defineConfig } from 'drizzle-kit';

// Used by `drizzle-kit generate` / `drizzle-kit migrate`. Tables are added per phase.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://neway:neway@localhost:5432/neway',
  },
  strict: true,
  verbose: true,
});
