import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../config/env';
import { createDatabaseClient, type Database, type DatabaseClient } from './client';

/**
 * Lazy database provider. Nothing is created until db is first accessed, so
 * the API boots without a reachable PostgreSQL instance (Phase 0 has no tables).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private client: DatabaseClient | undefined;

  get db(): Database {
    this.client ??= createDatabaseClient(env.DATABASE_URL, env.DATABASE_POOL_MAX);
    return this.client.db;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.sql.end({ timeout: 5 });
      this.client = undefined;
    }
  }
}
