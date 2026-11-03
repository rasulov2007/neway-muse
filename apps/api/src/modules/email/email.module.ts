import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { EmailTransport } from '../accounting/email.transport';
import { EmailService } from './email.service';
import { ResendWebhookController } from './resend-webhook.controller';

/** The shared email module: one EmailService for every feature (recruiting, accounting, …). */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [ResendWebhookController],
  providers: [EmailTransport, EmailService],
  exports: [EmailService, EmailTransport],
})
export class EmailModule {}
