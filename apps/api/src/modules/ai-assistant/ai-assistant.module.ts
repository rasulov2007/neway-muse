import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { AdminModule } from '../admin/admin.module';
import { DispatchBoardModule } from '../dispatch-board/dispatch-board.module';
import { FilesModule } from '../files/files.module';
import { LoadsModule } from '../loads/loads.module';
import { PeopleModule } from '../people/people.module';
import { StateModule } from '../state/state.module';
import { AiAssistantController } from './ai-assistant.controller';
import { AiBriefController } from './ai-brief.controller';
import { AiBriefScheduler } from './ai-brief.scheduler';
import { AiBriefService } from './ai-brief.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiTtsService } from './ai-tts.service';

/** NeWay AI, Phase 1: the Accounting assistant (owner, 2026-10-20). */
@Module({
  imports: [DatabaseModule, PeopleModule, FilesModule, AccountingModule, DispatchBoardModule, LoadsModule, AdminModule, StateModule],
  controllers: [AiAssistantController, AiBriefController],
  providers: [AiAssistantService, AiTtsService, AiBriefService, AiBriefScheduler],
  exports: [AiAssistantService],
})
export class AiAssistantModule {}
