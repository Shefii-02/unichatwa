import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { MysqlService } from './mysql.service';
import { WaChatAuthMiddleware } from './wa-chat-auth.middleware';
import { WaChatLogService } from './wa-chat-log.service';
import { AutomationEventService } from './automation-event.service';

@Module({
  providers: [MysqlService, WaChatAuthMiddleware, WaChatLogService, AutomationEventService],
  exports: [MysqlService, WaChatLogService, AutomationEventService],
})
export class WaChatModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Apply WaChat token validation middleware to all API routes
    consumer.apply(WaChatAuthMiddleware).forRoutes('*');
  }
}
