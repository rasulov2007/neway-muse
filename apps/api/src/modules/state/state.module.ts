import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FilesModule } from '../files/files.module';
import { StateController } from './state.controller';
import { StateSplitService } from './state-split.service';
import { StateService } from './state.service';
import { StolenUnitsService } from './stolen-units.service';
import { AuditService } from '../people/audit.service';

/**
 * A named JSON blob per key, in PostgreSQL.
 *
 * The web client's operational dataset (loads, documents, invoices, notes…)
 * is still generated client-side; this store is what lets every page's writes
 * survive a refresh TODAY, while the module-by-module Postgres migration
 * proceeds. One row per key; the client owns the shape.
 */
@Module({
  imports: [DatabaseModule, FilesModule],
  controllers: [StateController],
  // AuditService: every accepted PUT /state is audited (key and size, never the payload).
  providers: [StateService, StateSplitService, StolenUnitsService, AuditService],
  // Reporting reads the same snapshot, so the dashboard answers from the workspace's own book.
  // StolenUnitsService: every reader that can return a stolen unit's details asks it who may see them.
  exports: [StateService, StolenUnitsService],
})
export class StateModule {}
