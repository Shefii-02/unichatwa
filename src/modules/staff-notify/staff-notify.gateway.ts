import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { MysqlService } from '../wa-chat/mysql.service';

interface AuthenticatedSocketData {
  staffId: number;
  companyId: number;
}

/**
 * Real-time notification relay for staff (new lead / AI handoff alerts) — the mobile app and web
 * frontend connect here to receive pushes InternalController forwards from Laravel.
 *
 * Connections authenticate with the SAME JWT the client already holds from Laravel login/device
 * claim (`client.handshake.auth.token`, or an `Authorization: Bearer <token>` header), verified
 * locally against JWT_SECRET (shared with Laravel's jwt.php) — no round-trip back to Laravel per
 * connection. The verified token's `sub` claim is the only source of truth for which staff member
 * a socket belongs to; `company_id` is resolved server-side from the `users` table, never trusted
 * from the client. Previously this gateway accepted any anonymous connection and then trusted a
 * client-supplied `{staff_id, company_id}` on the `staff_online` event outright — any connected
 * client could claim to be any staff member, silently stealing their notifications or forcing
 * them offline.
 */
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

  async handleConnection(client: Socket): Promise<void> {
    const handshakeAuth = client.handshake.auth as { token?: string } | undefined;
    const authHeader = client.handshake.headers.authorization;
    const token =
      handshakeAuth?.token ||
      (typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined);

    if (!token) {
      this.logger.warn(`Staff socket ${client.id} rejected: no token supplied`);
      client.disconnect();
      return;
    }

    let staffId: number;
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        // No shared secret configured — refuse rather than accept unverifiable tokens.
        this.logger.error('JWT_SECRET is not configured — rejecting all staff socket connections');
        client.disconnect();
        return;
      }
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      // Laravel's JWTAuth always encodes `sub` as the user id cast to a string.
      staffId = parseInt(payload.sub ?? '', 10);
      if (!staffId || Number.isNaN(staffId)) {
        throw new Error('token has no valid sub claim');
      }
    } catch (err) {
      this.logger.warn(`Staff socket ${client.id} rejected: invalid token (${(err as Error).message})`);
      client.disconnect();
      return;
    }

    // company_id is resolved server-side from the verified identity — never trusted from the client.
    const rows = await this.db.query<{ company_id: number }>('SELECT company_id FROM users WHERE id = ? LIMIT 1', [
      staffId,
    ]);
    if (rows.length === 0) {
      this.logger.warn(`Staff socket ${client.id} rejected: user ${staffId} not found`);
      client.disconnect();
      return;
    }
    const companyId = rows[0].company_id;

    (client.data as AuthenticatedSocketData).staffId = staffId;
    (client.data as AuthenticatedSocketData).companyId = companyId;
    this.staffSockets.set(staffId, client.id);

    await this.db.execute(
      `INSERT INTO staff_availability (company_id, staff_id, is_online, status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 1, 'online', NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE is_online=1, status='online', last_seen_at=NOW(), updated_at=NOW()`,
      [companyId, staffId],
    );

    this.logger.log(`Staff ${staffId} authenticated and online (socket ${client.id})`);
    client.emit('staff_online_ack', { ok: true });
  }

  handleDisconnect(client: Socket): void {
    const staffId = (client.data as Partial<AuthenticatedSocketData>).staffId;
    if (!staffId) return; // never completed authentication

    if (this.staffSockets.get(staffId) === client.id) {
      this.staffSockets.delete(staffId);
      void this.db.execute(
        `UPDATE staff_availability SET is_online=0, status='offline', last_seen_at=NOW() WHERE staff_id=?`,
        [staffId],
      );
      this.logger.log(`Staff ${staffId} went offline`);
    }
  }

  /** Explicit "I'm going offline" from the client — acts only on the id resolved at connection time. */
  @SubscribeMessage('staff_offline')
  async handleStaffOffline(@ConnectedSocket() client: Socket): Promise<void> {
    const staffId = (client.data as Partial<AuthenticatedSocketData>).staffId;
    if (!staffId) return;

    this.staffSockets.delete(staffId);
    await this.db.execute(
      `UPDATE staff_availability SET is_online=0, status='offline', last_seen_at=NOW(), updated_at=NOW() WHERE staff_id=?`,
      [staffId],
    );
    this.logger.log(`Staff ${staffId} went offline (explicit)`);
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
