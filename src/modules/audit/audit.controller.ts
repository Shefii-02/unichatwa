import { Controller, Get, Delete, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuditListResponseDto } from './dto/audit-response.dto';
import { AuditService, AuditQueryOptions } from './audit.service';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List audit logs with optional filters' })
  @ApiQuery({ name: 'action', required: false, enum: AuditAction })
  @ApiQuery({ name: 'severity', required: false, enum: AuditSeverity })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'apiKeyId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of audit logs', type: AuditListResponseDto })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('action') action?: AuditAction,
    @Query('severity') severity?: AuditSeverity,
    @Query('sessionId') sessionId?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ data: AuditLog[]; total: number }> {
    const options: AuditQueryOptions = {};
    if (action) options.action = action;
    if (severity) options.severity = severity;
    if (sessionId) options.sessionId = sessionId;
    if (apiKeyId) options.apiKeyId = apiKeyId;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    // Scope to the calling key's allowedSessions so a session-restricted ADMIN key cannot read
    // another tenant's audit rows via the `sessionId` query param (which bypasses the guard fence).
    return this.auditService.findAll(options, apiKey?.allowedSessions);
  }

  @Delete()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Delete audit logs older than N days (omit `days`, or pass 0, to delete all)' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Number of rows deleted' })
  async clear(@Query('days') days?: string): Promise<{ deleted: number }> {
    const parsed = days !== undefined ? Number.parseInt(days, 10) : 0;
    const olderThanDays = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    // cleanup() already exists for the scheduled retention prune (see AuditService.onModuleInit) —
    // reused here as-is; olderThanDays=0 sets the cutoff to "now", which is every current row.
    const deleted = await this.auditService.cleanup(olderThanDays);
    return { deleted };
  }
}
