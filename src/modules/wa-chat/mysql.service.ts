import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as mysql from 'mysql2/promise';

/** Bound parameter values accepted by a prepared statement. mysql2's own `ExecuteValues` type is
 *  not re-exported from the package root, so this mirrors the useful subset. */
type SqlParam = string | number | bigint | boolean | Date | Buffer | null;

@Injectable()
export class MysqlService implements OnModuleDestroy {
  private pool: mysql.Pool | null = null;
  private readonly logger = new Logger(MysqlService.name);

  private getPool(): mysql.Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: process.env.SHARED_DB_HOST || 'localhost',
        port: parseInt(process.env.SHARED_DB_PORT || '3306', 10),
        database: process.env.SHARED_DB_DATABASE || 'waapi',
        user: process.env.SHARED_DB_USERNAME || 'root',
        password: process.env.SHARED_DB_PASSWORD || '',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
    }
    return this.pool;
  }

  async query<T = unknown>(sql: string, values: SqlParam[] = []): Promise<T[]> {
    const [rows] = await this.getPool().execute(sql, values);
    return rows as T[];
  }

  async execute(sql: string, values: SqlParam[] = []): Promise<void> {
    await this.getPool().execute(sql, values);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
