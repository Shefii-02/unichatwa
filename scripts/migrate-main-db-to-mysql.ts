// One-time cutover tool: copies the 'main' (auth/audit) connection's data from its SQLite file
// into a MySQL database, so MAIN_DATABASE_TYPE=mysql can be switched on without losing existing
// API keys or audit history.
//
// Run this BEFORE setting MAIN_DATABASE_TYPE=mysql and restarting the app — the target schema is
// created here (via the same entities the app uses, so it matches exactly), then every row is
// copied across with its original id/timestamps preserved. Safe to point at a brand-new, empty
// MySQL database; refuses to run against a target that already has data (see --force below).
//
// Usage:
//   npx ts-node scripts/migrate-main-db-to-mysql.ts
//   npx ts-node scripts/migrate-main-db-to-mysql.ts --force   (bypass the "target is empty" guard)
//
// Source (SQLite):
//   SOURCE_SQLITE_PATH   path to the main.sqlite to read from (default: ./data/main.sqlite)
//
// Target (MySQL) — same variable names main.module.ts reads once MAIN_DATABASE_TYPE=mysql is on,
// so you can point this script at your real .env values without renaming anything:
//   MAIN_DATABASE_HOST       (default: localhost)
//   MAIN_DATABASE_PORT       (default: 3306)
//   MAIN_DATABASE_USERNAME   (required)
//   MAIN_DATABASE_PASSWORD   (default: empty — a blank MySQL password is accepted)
//   MAIN_DATABASE_NAME       (required — the MySQL database name; it must already exist, this
//                             script does not create it)
//
// After it reports success: set MAIN_DATABASE_TYPE=mysql (plus the MAIN_DATABASE_* vars above) in
// the live .env and restart the app. Any writes that land in the SQLite file between running this
// script and restarting (e.g. a usageCount bump, a new audit log row) are NOT carried over — keep
// that window short.
import 'reflect-metadata';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
import { DataSource } from 'typeorm';
import { ApiKey } from '../src/modules/auth/entities/api-key.entity';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';

async function main() {
  const force = process.argv.includes('--force');
  const sqlitePath = process.env.SOURCE_SQLITE_PATH || './data/main.sqlite';

  const host = process.env.MAIN_DATABASE_HOST || 'localhost';
  const port = parseInt(process.env.MAIN_DATABASE_PORT || '3306', 10);
  const username = process.env.MAIN_DATABASE_USERNAME;
  const password = process.env.MAIN_DATABASE_PASSWORD || '';
  const database = process.env.MAIN_DATABASE_NAME;

  if (!username) throw new Error('MAIN_DATABASE_USERNAME is required');
  if (!database) throw new Error('MAIN_DATABASE_NAME is required (the target MySQL database name)');

  console.log(`Reading from SQLite: ${sqlitePath}`);
  const sqlite = new Database(sqlitePath, { readonly: true });
  const apiKeyRows = sqlite.prepare('SELECT * FROM api_keys').all() as Record<string, unknown>[];
  const auditLogRows = sqlite.prepare('SELECT * FROM audit_logs').all() as Record<string, unknown>[];
  console.log(`  ${apiKeyRows.length} api_keys, ${auditLogRows.length} audit_logs`);

  console.log(`Connecting to MySQL: ${username}@${host}:${port}/${database}`);
  const mysql = new DataSource({
    type: 'mysql',
    host,
    port,
    username,
    password,
    database,
    entities: [ApiKey, AuditLog],
    synchronize: true, // creates api_keys/audit_logs tables matching the entities exactly
    logging: false,
  });
  await mysql.initialize();
  console.log('MySQL schema ready (synchronized)');

  const existingKeys = await mysql.query('SELECT COUNT(*) c FROM api_keys');
  const existingLogs = await mysql.query('SELECT COUNT(*) c FROM audit_logs');
  if (!force && (Number(existingKeys[0].c) > 0 || Number(existingLogs[0].c) > 0)) {
    await mysql.destroy();
    throw new Error(
      `Refusing to migrate: target already has data (api_keys=${existingKeys[0].c}, audit_logs=${existingLogs[0].c}). ` +
        `Re-run with --force to insert anyway (may duplicate rows if this was already run once).`,
    );
  }

  const runner = mysql.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    for (const row of apiKeyRows) {
      await runner.query(
        `INSERT INTO api_keys (id, name, keyHash, keyPrefix, role, allowedIps, allowedSessions, isActive, expiresAt, lastUsedAt, usageCount, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.name,
          row.keyHash,
          row.keyPrefix,
          row.role,
          row.allowedIps,
          row.allowedSessions,
          row.isActive,
          row.expiresAt,
          row.lastUsedAt,
          row.usageCount,
          row.createdAt,
          row.updatedAt,
        ],
      );
    }
    for (const row of auditLogRows) {
      await runner.query(
        `INSERT INTO audit_logs (id, action, severity, apiKeyId, apiKeyName, sessionId, sessionName, ipAddress, userAgent, method, path, statusCode, metadata, errorMessage, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.action,
          row.severity,
          row.apiKeyId,
          row.apiKeyName,
          row.sessionId,
          row.sessionName,
          row.ipAddress,
          row.userAgent,
          row.method,
          row.path,
          row.statusCode,
          row.metadata,
          row.errorMessage,
          row.createdAt,
        ],
      );
    }
    await runner.commitTransaction();
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.release();
  }

  const finalKeys = await mysql.query('SELECT COUNT(*) c FROM api_keys');
  const finalLogs = await mysql.query('SELECT COUNT(*) c FROM audit_logs');
  console.log(`MySQL now has: ${finalKeys[0].c} api_keys, ${finalLogs[0].c} audit_logs`);
  console.log('Done. Now set MAIN_DATABASE_TYPE=mysql (and the MAIN_DATABASE_* vars above) in .env and restart the app.');

  await mysql.destroy();
  sqlite.close();
}

main().catch(err => {
  console.error('MIGRATION FAILED:', err);
  process.exit(1);
});
