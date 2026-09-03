import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { MysqlService } from '../wa-chat/mysql.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/staff',
})
export class StaffNotifyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(StaffNotifyGateway.name);

  /** staffId → socket id */
  private readonly staffSockets = new Map<number, string>();

  constructor(private readonly db: MysqlService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Staff socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    // Remove from map and mark offline
    for (const [staffId, socketId] of this.staffSockets.entries()) {
      if (socketId === client.id) {
        this.staffSockets.delete(staffId);
        void this.db.execute(
          `UPDATE staff_availability SET is_online=0, status='offline', last_seen_at=NOW() WHERE staff_id=?`,
          [staffId],
        );
        this.logger.log(`Staff ${staffId} went offline`);
        break;
      }
    }
  }

  @SubscribeMessage('staff_online')
  async handleStaffOnline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { staff_id: number; company_id: number },
  ): Promise<void> {
    const { staff_id, company_id } = data;
    if (!staff_id || !company_id) return;

    this.staffSockets.set(staff_id, client.id);

    // Ensure staff_availability row exists and mark online
    await this.db.execute(
      `INSERT INTO staff_availability (company_id, staff_id, is_online, status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 1, 'online', NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE is_online=1, status='online', last_seen_at=NOW(), updated_at=NOW()`,
      [company_id, staff_id],
    );

    this.logger.log(`Staff ${staff_id} is online`);
    client.emit('staff_online_ack', { ok: true });
  }

  @SubscribeMessage('staff_offline')
  async handleStaffOffline(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { staff_id: number },
  ): Promise<void> {
    const { staff_id } = data;
    if (!staff_id) return;

    this.staffSockets.delete(staff_id);

    await this.db.execute(
      `UPDATE staff_availability SET is_online=0, status='offline', last_seen_at=NOW(), updated_at=NOW() WHERE staff_id=?`,
      [staff_id],
    );

    this.logger.log(`Staff ${staff_id} went offline (explicit)`);
  }

  /**
   * Emit a named event to a specific staff member's socket.
   * Called by the InternalController when Laravel pushes a notification.
   */
  emitToStaff(staffId: number, event: string, data: unknown): boolean {
    const socketId = this.staffSockets.get(staffId);
    if (!socketId) return false;
    this.server.to(socketId).emit(event, data);
    return true;
  }
}
