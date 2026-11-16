import { Module } from '@nestjs/common';
import { StaffNotifyGateway } from './staff-notify.gateway';
import { WidgetVisitorGateway } from './widget-visitor.gateway';
import { InternalController } from './internal.controller';
import { TeamChatService } from './team-chat.service';
import { WaChatModule } from '../wa-chat/wa-chat.module';

@Module({
  imports: [WaChatModule],
  providers: [StaffNotifyGateway, WidgetVisitorGateway, TeamChatService],
  controllers: [InternalController],
  exports: [StaffNotifyGateway, WidgetVisitorGateway],
})
export class StaffNotifyModule {}
