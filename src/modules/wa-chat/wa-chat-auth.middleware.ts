import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { MysqlService } from './mysql.service';

export interface WaChatCompany {
  id: number;
  name: string;
  wa_chat_token: string;
  waha_enabled: number;
}

declare module 'express' {
  interface Request {
    waChatCompany?: WaChatCompany;
  }
}

@Injectable()
export class WaChatAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(WaChatAuthMiddleware.name);

  constructor(private readonly mysql: MysqlService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Skip non-API routes and health/docs
    const path = req.path;
    if (path.startsWith('/health') || path.startsWith('/docs') || path.startsWith('/swagger')) {
      return next();
    }

    const token =
      req.header('X-WA-Chat-Token') ||
      req.header('X-Wa-Chat-Token') ||
      (req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
      undefined;

    if (!token) {
      return next(); // Let WAHA's own ApiKeyGuard handle standard API keys
    }

    try {
      const rows = await this.mysql.query<WaChatCompany>(
        `SELECT id, name, wa_chat_token, waha_enabled
         FROM companies
         WHERE wa_chat_token = ? AND waha_enabled = 1
         LIMIT 1`,
        [token],
      );

      if (rows.length > 0) {
        req.waChatCompany = rows[0];
        this.logger.debug(`WaChat auth OK — company_id=${rows[0].id}`);
      }
    } catch (err) {
      this.logger.error('WaChatAuthMiddleware MySQL error', err);
    }

    return next();
  }
}
