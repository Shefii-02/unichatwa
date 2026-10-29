import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/auth.decorators';
import { StaffJwtGuard } from './staff-jwt.guard';
import type { StaffRequest } from './staff-jwt.guard';
import { WidgetChatService } from './widget-chat.service';

/**
 * Website live chat — staff API served by Node (MySQL tables shared with Laravel). Same paths/shapes as the old
 * Laravel `/widgets/live/*` endpoints, so the web portal and the Flutter app only change their base URL.
 * Auth: Laravel JWT + `widget_chat.handle` (see StaffJwtGuard); the global OpenWA key guard is bypassed via @Public.
 */
@Public()
@UseGuards(StaffJwtGuard)
@Controller('widget-chat')
export class WidgetChatController {
  constructor(private readonly svc: WidgetChatService) {}

  @Get('inbox')
  inbox(@Req() req: StaffRequest, @Query() q: Record<string, string>) {
    return this.svc.inbox(req.staff, q);
  }

  @Get('me')
  me(@Req() req: StaffRequest) {
    return this.svc.me(req.staff);
  }

  @Put('me')
  setMuted(@Req() req: StaffRequest, @Body() body: { muted?: unknown }) {
    return this.svc.setMuted(req.staff, body?.muted === true || body?.muted === 1 || body?.muted === '1' || body?.muted === 'true');
  }

  @Get(':id')
  show(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number, @Query('after') after?: string) {
    return this.svc.show(req.staff, id, Number(after) || 0);
  }

  @Get(':id/older')
  older(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number, @Query('before') before?: string, @Query('limit') limit?: string) {
    return this.svc.older(req.staff, id, Number(before) || Number.MAX_SAFE_INTEGER, Number(limit) || 50);
  }

  @Post(':id/read')
  read(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number) {
    return this.svc.markRead(req.staff, id);
  }

  @Post(':id/accept')
  accept(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number) {
    return this.svc.accept(req.staff, id);
  }

  @Post(':id/reply')
  reply(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { text?: string; reply_to_id?: number | string }) {
    return this.svc.reply(req.staff, id, String(body?.text ?? ''), body?.reply_to_id ? Number(body.reply_to_id) : null);
  }

  @Post(':id/end')
  end(@Req() req: StaffRequest, @Param('id', ParseIntPipe) id: number) {
    return this.svc.end(req.staff, id);
  }
}
