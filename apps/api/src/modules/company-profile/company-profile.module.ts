import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FilesModule } from '../files/files.module';
import { PeopleModule } from '../people/people.module';
import { CompanyProfileController } from './company-profile.controller';
import { CompanyProfileService } from './company-profile.service';

/** Company info (owner, 2026-10-19). */
@Module({
  imports: [DatabaseModule, PeopleModule, FilesModule],
  controllers: [CompanyProfileController],
  providers: [CompanyProfileService],
})
export class CompanyProfileModule {}
