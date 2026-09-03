import { Injectable, Logger } from '@nestjs/common';
import { MysqlService } from './mysql.service';

interface MessageLogEntry {
  company_id: number;
  session_id: string;
  recipient_phone?: string;
  recipient_type?: 'contact' | 'group';
  message_type?: string;
  status: 'sent' | 'failed';
  waha_message_id?: string;
  error_message?: string;
  campaign_name?: string;
}

@Injectable()
export class WaChatLogService {
  private readonly logger = new Logger(WaChatLogService.name);

  constructor(private readonly mysql: MysqlService) {}

  async logMessage(entry: MessageLogEntry): Promise<void> {
    try {
      await this.mysql.execute(
        `INSERT INTO waha_message_logs
          (company_id, session_id, recipient_phone, recipient_type, message_type, status, waha_message_id, error_message, campaign_name, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [
          entry.company_id,
          entry.session_id,
          entry.recipient_phone ?? null,
          entry.recipient_type ?? 'contact',
          entry.message_type ?? 'text',
          entry.status,
          entry.waha_message_id ?? null,
          entry.error_message ?? null,
          entry.campaign_name ?? null,
        ],
      );
    } catch (err) {
      this.logger.error('WaChatLogService failed to write message log', err);
    }
  }
}
