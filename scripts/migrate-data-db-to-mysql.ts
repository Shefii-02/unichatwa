// One-time cutover tool: copies the 'data' connection's tables (sessions, messages, webhooks,
// templates, engine state, integrations, status-store, automation rules) from SQLite into MySQL,
// so DATABASE_TYPE=mysql can be switched on without losing existing data.
//
// Generalized over every entity TypeORM resolves for the data connection (via entityMetadatas) —
// not a hardcoded per-table list — so it stays correct as entities are added/changed. Foreign-key
// checks are disabled for the duration of the load (MySQL session-scoped SET), so table insert
// order doesn't need to match the FK dependency graph.
//
// Run this BEFORE setting DATABASE_TYPE=mysql and restarting the app — the target schema is
// created here (via the same entities the app uses, so it matches exactly, including the
// MySQL-only mysqlIndexLength() guards — see src/common/utils/column-types.ts), then every row is
// copied across with its original id/timestamps preserved. Safe to point at a brand-new, empty
// MySQL database; refuses to run against a target that already has data in ANY of these tables
// (see --force below).
//
// KNOWN GAP: full-text search (messages_fts / body_ts) is SQLite/Postgres-only schema with no
// entity representation — it is NOT recreated on MySQL. /api/search 501s there; see
// BuiltInFtsProvider and app.module.ts's mysql branch comment for the data connection.
//
// Usage:
//   npx ts-node scripts/migrate-data-db-to-mysql.ts
//   npx ts-node scripts/migrate-data-db-to-mysql.ts --force   (bypass the "target is empty" guard)
//
// Source (SQLite):
//   SOURCE_SQLITE_PATH   path to the openwa.sqlite to read from (default: ./data/openwa.sqlite)
//
// Target (MySQL) — same variable names app.module.ts reads once DATABASE_TYPE=mysql is on, so you
// can point this script at your real .env values without renaming anything:
//   DATABASE_HOST       (default: localhost)
//   DATABASE_PORT       (default: 3306)
//   DATABASE_USERNAME   (required)
//   DATABASE_PASSWORD   (default: empty — a blank MySQL password is accepted)
//   DATABASE_NAME       (required — the MySQL database name; it must already exist, this script
//                        does not create it)
//
// After it reports success: set DATABASE_TYPE=mysql (plus the DATABASE_* vars above) in the live
// .env and restart the app. Any writes that land in the SQLite file between running this script
// and restarting are NOT carried over — keep that window short.
import 'reflect-metadata';
// Loads .env / data/.env.generated into process.env exactly like the app does, so DATABASE_* /
// MAIN_DATABASE_* values set in .env are picked up without prefixing the command with them inline.
import '../src/config/load-env';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
import { DataSource } from 'typeorm';

const DATA_ENTITY_GLOBS = [
  __dirname + '/../src/modules/session/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/webhook/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/message/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/template/**/*.entity{.ts,.js}',
  __dirname + '/../src/engine/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/integration/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/status-store/**/*.entity{.ts,.js}',
  __dirname + '/../src/modules/automation/**/*.entity{.ts,.js}',
];

async function main() {
  const force = process.argv.includes('--force');
  const sqlitePath = process.env.SOURCE_SQLITE_PATH || './data/openwa.sqlite';

  const host = process.env.DATABASE_HOST || 'localhost';
  const port = parseInt(process.env.DATABASE_PORT || '3306', 10);
  const username = process.env.DATABASE_USERNAME;
  const password = process.env.DATABASE_PASSWORD || '';
  const database = process.env.DATABASE_NAME;

  if (!username) throw new Error('DATABASE_USERNAME is required');
  if (!database) throw new Error('DATABASE_NAME is required (the target MySQL database name)');

  // The entity decorators (jsonColumnType/mysqlIndexLength/textColumnDefault in column-types.ts)
  // read process.env.DATABASE_TYPE to pick their MySQL-safe column shapes — the same env var the
  // real app boots with. This script runs BEFORE that's set in the live .env (that's the point —
  // cut over the data first, flip the switch after), so it must force it here for its own process,
  // before TypeORM resolves the entity globs below (inside initialize()) and those decorators run.
  process.env.DATABASE_TYPE = 'mysql';

  console.log(`Connecting to MySQL: ${username}@${host}:${port}/${database}`);
  const mysql = new DataSource({
    type: 'mysql',
    host,
    port,
    username,
    password,
    database,
    entities: DATA_ENTITY_GLOBS,
    synchronize: true, // creates every data-owned table matching the entities exactly
    logging: false,
  });
  await mysql.initialize();
  console.log(`MySQL schema ready (synchronized): ${mysql.entityMetadatas.length} tables`);

  console.log(`Reading from SQLite: ${sqlitePath}`);
  const sqlite = new Database(sqlitePath, { readonly: true });

  // Collect {tableName, columnNames, rows} per entity up front so the empty-target guard below can
  // check every table before any INSERT runs.
  const plan = mysql.entityMetadatas.map(meta => {
    const tableName = meta.tableName;
    const columnNames = meta.columns.map(c => c.databaseName);
    const rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all() as Record<string, unknown>[];
    return { tableName, columnNames, rows };
  });

  for (const { tableName, rows } of plan) {
    console.log(`  ${tableName}: ${rows.length} row(s)`);
  }

  if (!force) {
    const nonEmpty: string[] = [];
    for (const { tableName } of plan) {
      const existing = await mysql.query(`SELECT COUNT(*) c FROM \`${tableName}\``);
      if (Number(existing[0].c) > 0) nonEmpty.push(tableName);
    }
    if (nonEmpty.length > 0) {
      await mysql.destroy();
      throw new Error(
        `Refusing to migrate: target already has data in: ${nonEmpty.join(', ')}. ` +
          `Re-run with --force to insert anyway (may duplicate rows if this was already run once).`,
      );
    }
  }

  const runner = mysql.createQueryRunner();
  await runner.connect();
  // Table insert order here does not follow the FK dependency graph (it's whatever order
  // entityMetadatas resolved in) — disable FK checks for the duration of the load instead of
  // computing a topological order. Scoped to this session only; re-enabled in the `finally` below
  // even on failure.
  await runner.query('SET FOREIGN_KEY_CHECKS = 0');
  await runner.startTransaction();
  try {
    for (const { tableName, columnNames, rows } of plan) {
      if (rows.length === 0) continue;
      const columnList = columnNames.map(c => `\`${c}\``).join(', ');
      const placeholders = columnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO \`${tableName}\` (${columnList}) VALUES (${placeholders})`;
      for (const row of rows) {
        await runner.query(
          insertSql,
          columnNames.map(c => row[c]),
        );
      }
    }
    await runner.commitTransaction();
  } catch (err) {
    await runner.rollbackTransaction();
    throw err;
  } finally {
    await runner.query('SET FOREIGN_KEY_CHECKS = 1');
    await runner.release();
  }

  console.log('Verifying row counts...');
  let mismatches = 0;
  for (const { tableName, rows } of plan) {
    const result = await mysql.query(`SELECT COUNT(*) c FROM \`${tableName}\``);
    const got = Number(result[0].c);
    const status = got === rows.length ? 'OK' : 'MISMATCH';
    if (got !== rows.length) mismatches++;
    console.log(`  ${tableName}: sqlite=${rows.length} mysql=${got} [${status}]`);
  }

  if (mismatches > 0) {
    throw new Error(`${mismatches} table(s) have a row-count mismatch after migration — see above.`);
  }

  console.log('All tables verified. Now set DATABASE_TYPE=mysql (and the DATABASE_* vars above) in .env and restart the app.');
  console.log('Known gap: full-text search has no MySQL backend — /api/search will 501 (set SEARCH_ENABLED=false to unmount it cleanly).');

  await mysql.destroy();
  sqlite.close();
}

main().catch(err => {
  console.error('MIGRATION FAILED:', err);
  process.exit(1);
});
