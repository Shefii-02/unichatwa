import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { MysqlService } from '../wa-chat/mysql.service';
import { TeamChatService } from './team-chat.service';
import type { SendPayload } from './team-chat.service';

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

  constructor(
    private readonly db: MysqlService,
    private readonly teamChat: TeamChatService,
  ) {
    // Team chat fans out through this gateway's per-staff rooms (every device of a member gets it).
    this.teamChat.setEmitter((staffId, event, data) => this.emitToStaff(staffId, event, data));
  }

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
    // Company room — every tab/device of every staff member in the company, for broadcast events (e.g. website chat updates).
    await client.join(`company:${companyId}`);
    // Per-staff room: every device / tab of this staff member receives targeted events (team chat, notifications).
    await client.join(`staff:${staffId}`);

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
   * Team chat typing indicator: relays `{chat_id, user_id, name, typing}` to the other active members of
   * that chat. Membership is checked against the DB with the socket's verified staff id, so a client can't
   * spoof typing into a chat it isn't in.
   */
  @SubscribeMessage('team_typing')
  async handleTeamTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { chat_id?: number; typing?: boolean },
  ): Promise<void> {
    const staffId = (client.data as Partial<AuthenticatedSocketData>).staffId;
    const chatId = Number(body?.chat_id);
    if (!staffId || !chatId) return;
    const members = await this.db.query<{ user_id: number; name: string | null }>(
      `SELECT m.user_id, (SELECT name FROM users WHERE id = ?) AS name
         FROM team_chat_members m WHERE m.chat_id = ? AND m.left_at IS NULL`,
      [staffId, chatId],
    );
    if (!members.some((m) => Number(m.user_id) === staffId)) return;
    for (const m of members) {
      if (Number(m.user_id) !== staffId) {
        this.emitToStaff(Number(m.user_id), 'team_typing', {
          chat_id: chatId,
          user_id: staffId,
          name: m.name,
          typing: body?.typing !== false,
        });
      }
    }
  }

  // ── Team chat commands (acked: the app shows sent / failed from the reply) ──

  private authedStaffId(client: Socket): number | null {
    return (client.data as Partial<AuthenticatedSocketData>).staffId ?? null;
  }

  @SubscribeMessage('chat:send')
  onChatSend(@ConnectedSocket() c: Socket, @MessageBody() b: SendPayload) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.send(id, b) : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:edit')
  onChatEdit(@ConnectedSocket() c: Socket, @MessageBody() b: { message_id: number; body: string }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.edit(id, b?.message_id, b?.body) : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:delete')
  onChatDelete(@ConnectedSocket() c: Socket, @MessageBody() b: { message_id: number; scope?: 'me' | 'everyone' }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.delete(id, b?.message_id, b?.scope === 'me' ? 'me' : 'everyone') : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:react')
  onChatReact(@ConnectedSocket() c: Socket, @MessageBody() b: { message_id: number; emoji: string }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.react(id, b?.message_id, b?.emoji) : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:read')
  onChatRead(@ConnectedSocket() c: Socket, @MessageBody() b: { chat_id: number }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.read(id, b?.chat_id) : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:delivered')
  onChatDelivered(@ConnectedSocket() c: Socket, @MessageBody() b: { chat_id: number }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.delivered(id, b?.chat_id) : { ok: false, error: 'Not authenticated' };
  }

  @SubscribeMessage('chat:forward')
  onChatForward(@ConnectedSocket() c: Socket, @MessageBody() b: { message_id: number; chat_ids: number[] }) {
    const id = this.authedStaffId(c);
    return id ? this.teamChat.forward(id, b?.message_id, b?.chat_ids) : { ok: false, error: 'Not authenticated' };
  }

  /** Emit a named event to every connected staff socket of one company. */
  emitToCompany(companyId: number, event: string, data: unknown): void {
    this.server.to(`company:${companyId}`).emit(event, data);
  }

  /**
   * Emit a named event to a specific staff member's socket.
   * Called by the InternalController when Laravel pushes a notification.
   */
  emitToStaff(staffId: number, event: string, data: unknown): boolean {
    // Room-based so every connected device gets it (the old single-socket map only reached the last one).
    const room = `staff:${staffId}`;
    const online = (this.server.of('/staff').adapter.rooms.get(room)?.size ?? 0) > 0;
    this.server.to(room).emit(event, data);
    return online;
  }
}
