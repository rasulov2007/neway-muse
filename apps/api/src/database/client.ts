import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  /** Raw postgres-js connection pool (needed to close connections). */
  sql: postgres.Sql;
  /** Drizzle query builder bound to the application schema. */
  db: Database;
}

/**
 * Creates a Drizzle client over postgres-js. postgres-js opens connections
 * lazily on the first query, so calling this does not touch the network.
 */
export function createDatabaseClient(url: string, max = 10): DatabaseClient {
  const sql = postgres(url, { max });
  return { sql, db: drizzle(sql, { schema }) };
}

/** A transaction opened on `Database`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything a query can run on: the pool, or an open transaction. */
export type DbExecutor = Database | Transaction;
