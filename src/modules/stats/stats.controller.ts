import { Controller, ForbiddenException, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MessageStatsResponseDto, OverviewStatsResponseDto, SessionStatsResponseDto } from './dto/stats-response.dto';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('statistics')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /**
   * The aggregate routes carry no `:sessionId`, so the ApiKeyGuard's allowedSessions fence can't
   * scope them. Instead: a **session-scoped** key gets the aggregate over its own sessions only
   * (safe — it's already confined to those), while an **unscoped** key must be ADMIN so a plain
   * VIEWER can't read platform-wide activity.
   */
  private assertMayReadAggregate(apiKey?: ApiKey): string[] | null {
    const scope = apiKey?.allowedSessions && apiKey.allowedSessions.length > 0 ? apiKey.allowedSessions : null;
    if (!scope && apiKey?.role !== ApiKeyRole.ADMIN) {
      throw new ForbiddenException('Global statistics require an admin key or a session-scoped key.');
    }
    return scope;
  }

  @Get('overview')
  @ApiOperation({ summary: 'Get overall statistics' })
  @ApiResponse({
    status: 200,
    description: 'Aggregate statistics — over the key\'s allowed sessions, or all sessions for an admin key.',
    type: OverviewStatsResponseDto,
  })
  async getOverview(@CurrentApiKey() apiKey?: ApiKey) {
    return this.statsService.getOverview(this.assertMayReadAggregate(apiKey));
  }

  @Get('messages')
  @ApiOperation({ summary: 'Get message statistics with time series' })
  @ApiResponse({
    status: 200,
    description: 'Message statistics with a time series for the requested period.',
    type: MessageStatsResponseDto,
  })
  async getMessageStats(@Query() query: StatsQueryDto, @CurrentApiKey() apiKey?: ApiKey) {
    return this.statsService.getMessageStats(query.period || '24h', this.assertMayReadAggregate(apiKey));
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Get statistics for a specific session' })
  @ApiResponse({
    status: 200,
    description: 'Per-session statistics for the requested session.',
    type: SessionStatsResponseDto,
  })
  async getSessionStats(@Param('sessionId') sessionId: string) {
    return this.statsService.getSessionStats(sessionId);
  }
}
