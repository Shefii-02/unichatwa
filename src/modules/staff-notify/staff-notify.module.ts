import { Module } from '@nestjs/common';
import { StaffNotifyGateway } from './staff-notify.gateway';
import { InternalController } from './internal.controller';
import { WaChatModule } from '../wa-chat/wa-chat.module';

@Module({
  imports: [WaChatModule],
  providers: [StaffNotifyGateway],
  controllers: [InternalController],
  exports: [StaffNotifyGateway],
})
export class StaffNotifyModule {}
