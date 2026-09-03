import { Injectable, Logger } from '@nestjs/common';
import { MysqlService } from './mysql.service';

interface WahaMessage {
  id: string;
  session: string;
  payload?: {
    from?: string;
    fromMe?: boolean;
    body?: string;
    type?: string;
    chatId?: string;
  };
}

@Injectable()
export class AutomationEventService {
  private readonly logger = new Logger(AutomationEventService.name);

  constructor(private readonly mysql: MysqlService) {}

  /**
   * Called by the WAHA webhook handler when a message arrives.
   * Looks up the company's Laravel webhook URL and forwards the event
   * so the Laravel AutomationEngine can process it.
   */
  async handleMessageEvent(sessionId: string, message: WahaMessage): Promise<void> {
    if (message.payload?.fromMe) return;

    try {
      const rows = await this.mysql.query<{ id: number; waha_webhook_url: string }>(
        `SELECT c.id, c.wa_chat_token,
                (SELECT webhook_url FROM waha_sessions WHERE session_id = ? LIMIT 1) as waha_webhook_url
         FROM companies c
         WHERE c.waha_enabled = 1
         LIMIT 1`,
        [sessionId],
      );

      if (!rows.length || !rows[0].waha_webhook_url) return;

      const laravelWebhookUrl = process.env.LARAVEL_WEBHOOK_URL
        || `${process.env.LARAVEL_BASE_URL || 'http://localhost:8000'}/api/v1/waha/webhook`;

      const eventBody = {
        event:   'message',
        session: sessionId,
        payload: {
          from:   message.payload?.from,
          fromMe: false,
          body:   message.payload?.body ?? '',
          type:   message.payload?.type ?? 'text',
          chatId: message.payload?.chatId ?? message.payload?.from,
        },
      };

      const resp = await fetch(laravelWebhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(eventBody),
        signal:  AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        this.logger.warn(`AutomationEventService: Laravel webhook returned ${resp.status}`);
      }
    } catch (err) {
      this.logger.error('AutomationEventService.handleMessageEvent error', err);
    }
  }

  /**
   * Log inbound message to shared MySQL for cross-system visibility.
   */
  async logInboundMessage(
    sessionId: string,
    companyId: number,
    from: string,
    body: string,
  ): Promise<void> {
    try {
      await this.mysql.execute(
        `INSERT INTO waha_message_logs
          (company_id, session_id, recipient_phone, recipient_type, message_type, status, created_at, updated_at)
         VALUES (?, ?, ?, 'contact', 'text', 'received', NOW(), NOW())`,
        [companyId, sessionId, from.replace(/@.*/, '')],
      );
    } catch (err) {
      this.logger.error('AutomationEventService.logInboundMessage error', err);
    }
  }
}
