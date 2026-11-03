import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { FilesModule } from '../files/files.module';
import { DriverContextService } from '../mobile/driver-context.service';
import { IdempotencyService } from '../mobile/idempotency.service';
import { MobileModule } from '../mobile/mobile.module';
import { MessageAudienceService } from './message-audience.service';
import { DriverMessagesController, MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

/**
 * Messages (mobile M4): conversations between drivers and the office, on the 0081 tables.
 * DriverContextService and IdempotencyService are stateless and provided here again so the mobile
 * module's own provider list stays as M1 left it.
 */
@Module({
  imports: [DatabaseModule, FilesModule, MobileModule],
  controllers: [DriverMessagesController, MessagesController],
  providers: [MessagesService, MessageAudienceService, DriverContextService, IdempotencyService],
  exports: [MessagesService, MessageAudienceService],
})
export class MessagesModule {}
