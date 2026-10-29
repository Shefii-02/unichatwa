import { Module } from '@nestjs/common';
import { WaChatModule } from '../wa-chat/wa-chat.module';
import { StaffNotifyModule } from '../staff-notify/staff-notify.module';
import { StaffAuthService } from './staff-auth.service';
import { StaffJwtGuard } from './staff-jwt.guard';
import { WidgetChatController } from './widget-chat.controller';
import { WidgetChatService } from './widget-chat.service';

@Module({
  imports: [WaChatModule, StaffNotifyModule],
  controllers: [WidgetChatController],
  providers: [WidgetChatService, StaffAuthService, StaffJwtGuard],
})
export class WidgetChatModule {}
