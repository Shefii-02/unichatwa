import { Module } from '@nestjs/common';
import { StaffNotifyGateway } from './staff-notify.gateway';
import { WidgetVisitorGateway } from './widget-visitor.gateway';
import { InternalController } from './internal.controller';
import { TeamChatService } from './team-chat.service';
import { TeamChatQueryService } from './team-chat-query.service';
import { TeamChatAuthGuard } from './team-chat-auth.guard';
import { TeamChatController } from './team-chat.controller';
import { StaffAuthService } from '../widget-chat/staff-auth.service';
import { WaChatModule } from '../wa-chat/wa-chat.module';

@Module({
  imports: [WaChatModule],
  providers: [StaffNotifyGateway, WidgetVisitorGateway, TeamChatService, TeamChatQueryService, TeamChatAuthGuard, StaffAuthService],
  controllers: [InternalController, TeamChatController],
  exports: [StaffNotifyGateway, WidgetVisitorGateway],
})
export class StaffNotifyModule {}
