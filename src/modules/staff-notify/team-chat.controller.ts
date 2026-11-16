import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/auth.decorators';
import { TeamChatAuthGuard } from './team-chat-auth.guard';
import type { TeamChatRequest } from './team-chat-auth.guard';
import { TeamChatQueryService } from './team-chat-query.service';
import { TeamChatService } from './team-chat.service';
import type { SendPayload } from './team-chat.service';

/**
 * Team chat REST served by Node — fetch (chats, chat info, messages, users) and send / read / delivered — with the same
 * paths and shapes as Laravel's `/api/v1/team-chat/*`, plus the live `team_chat` socket events from the same server.
 * Global OpenWA key guard is bypassed with @Public; auth is the Laravel JWT (see TeamChatAuthGuard).
 */
@Public()
@UseGuards(TeamChatAuthGuard)
@Controller('team-chat')
export class TeamChatController {
  constructor(
    private readonly q: TeamChatQueryService,
    private readonly chat: TeamChatService,
  ) {}

  @Get('users')
  users(@Req() r: TeamChatRequest) { return this.q.users(r.teamUser); }

  @Get('chats')
  chats(@Req() r: TeamChatRequest, @Query() query: Record<string, string>) { return this.q.chats(r.teamUser, query); }

  @Post('chats')
  create(@Req() r: TeamChatRequest, @Body() body: { type?: string; user_id?: number; name?: string; member_ids?: number[] }) {
    return this.q.create(r.teamUser, body);
  }

  @Get('chats/:id')
  info(@Req() r: TeamChatRequest, @Param('id', ParseIntPipe) id: number) { return this.q.info(r.teamUser, id); }

  @Get('chats/:id/messages')
  messages(@Req() r: TeamChatRequest, @Param('id', ParseIntPipe) id: number, @Query() query: Record<string, string>) {
    return this.q.messages(r.teamUser, id, query);
  }

  /** JSON send (text / reply / mentions / location / contact). Files go through Laravel, which owns the upload storage. */
  @Post('chats/:id/messages')
  async send(@Req() r: TeamChatRequest, @Param('id', ParseIntPipe) id: number, @Body() body: Omit<SendPayload, 'chat_id'>) {
    const res = await this.chat.send(r.teamUser.id, { ...body, chat_id: id });
    if (!res.ok) throw new BadRequestException(res.error);
    return { id: (res as { message: { id: number } }).message.id, message: (res as { message: unknown }).message };
  }

  @Post('chats/:id/read')
  async read(@Req() r: TeamChatRequest, @Param('id', ParseIntPipe) id: number) {
    const res = await this.chat.read(r.teamUser.id, id);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  @Post('chats/:id/delivered')
  async delivered(@Req() r: TeamChatRequest, @Param('id', ParseIntPipe) id: number) {
    const res = await this.chat.delivered(r.teamUser.id, id);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
}
