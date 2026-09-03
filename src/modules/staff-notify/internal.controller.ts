import { Controller, Post, Body, Headers, UnauthorizedException, Logger } from '@nestjs/common';
import { StaffNotifyGateway } from './staff-notify.gateway';
import { MysqlService } from '../wa-chat/mysql.service';

interface EmitPayload {
  type: string;
  staff_id: number;
  data: unknown;
}

interface StaffOnlinePayload {
  staff_id: number;
  company_id: number;
}

@Controller('api/internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private readonly gateway: StaffNotifyGateway,
    private readonly db: MysqlService,
  ) {}

  private checkAuth(key: string | undefined): void {
    const expected = process.env.INTERNAL_API_KEY || '';
    if (expected && key !== expected) {
      throw new UnauthorizedException('Invalid internal key');
    }
  }

  /** Called by Laravel when a staff member comes online via the app. */
  @Post('staff-online')
  async staffOnline(
    @Headers('x-internal-key') key: string,
    @Body() body: StaffOnlinePayload,
  ): Promise<{ ok: boolean }> {
    this.checkAuth(key);

    const { staff_id, company_id } = body;
    await this.db.execute(
      `INSERT INTO staff_availability (company_id, staff_id, is_online, status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 1, 'online', NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE is_online=1, status='online', last_seen_at=NOW(), updated_at=NOW()`,
      [company_id, staff_id],
    );

    this.logger.log(`Staff ${staff_id} marked online via internal API`);
    return { ok: true };
  }

  /** Called by Laravel jobs to push real-time notifications to specific staff. */
  @Post('emit-notification')
  emitNotification(
    @Headers('x-internal-key') key: string,
    @Body() body: EmitPayload,
  ): { ok: boolean; delivered: boolean } {
    this.checkAuth(key);

    const { type, staff_id, data } = body;
    const delivered = this.gateway.emitToStaff(staff_id, type, data);

    this.logger.log(`emit ${type} → staff ${staff_id}: ${delivered ? 'delivered' : 'offline'}`);
    return { ok: true, delivered };
  }
}
