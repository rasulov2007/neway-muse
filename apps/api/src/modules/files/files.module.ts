import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { SignedDownloadService } from './signed-download.service';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { DatabaseModule } from '../../database/database.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { AuditService } from '../people/audit.service';

/** Bytes for records that still live in the workspace snapshot. */
@Module({
  imports: [DatabaseModule, DiscoveryModule],
  controllers: [FilesController],
  // AuditService: soft delete, restore, refused deletes and restricted reads are audited.
  providers: [FilesService, DocumentStorageService, AuditService, SignedDownloadService],
  exports: [FilesService],
})
export class FilesModule {}
