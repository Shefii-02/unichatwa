import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { MysqlService } from '../wa-chat/mysql.service';

/**
 * Realtime channel for website-chat VISITORS (the embeddable widget on customer sites).
 *
 * Visitors have no login, so the credential is the widget's public key plus the conversation's
 * secret session_token (64 random chars, only the visitor's browser holds it). A socket joins exactly
 * one room — its own conversation — so it can never see another visitor's chat. The socket carries only a
 * "something changed" ping (no message content); the widget then calls its normal /live/poll endpoint.
 */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/widget' })
export class WidgetVisitorGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WidgetVisitorGateway.name);

  constructor(private readonly db: MysqlService) {}

  async handleConnection(client: Socket): Promise<void> {
    const auth = (client.handshake.auth ?? {}) as { key?: string; session_token?: string };
    const key = typeof auth.key === 'string' ? auth.key.slice(0, 40) : '';
    const token = typeof auth.session_token === 'string' ? auth.session_token.slice(0, 64) : '';
    if (!key || !token) return void client.disconnect();

    try {
      const rows = await this.db.query<{ id: number }>(
        `SELECT wc.id FROM widget_conversations wc
           JOIN chat_widgets cw ON cw.id = wc.chat_widget_id
          WHERE cw.public_key = ? AND wc.session_token = ? AND cw.is_active = 1 LIMIT 1`,
        [key, token],
      );
      if (rows.length === 0) return void client.disconnect();
      await client.join(`widget-convo:${rows[0].id}`);
    } catch (err) {
      this.logger.warn(`Widget socket ${client.id} lookup failed: ${(err as Error).message}`);
      client.disconnect();
    }
  }

  /** Ping the visitor of one conversation (if connected). */
  emitToConversation(conversationId: number, event: string, data: unknown): void {
    this.server.to(`widget-convo:${conversationId}`).emit(event, data);
  }
}
