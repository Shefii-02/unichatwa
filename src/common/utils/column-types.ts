import type { ValueTransformer } from 'typeorm';

/**
 * Cross-database column type helpers.
 *
 * SQLite lacks native JSON and timestamp types, so we use `simple-json`
 * (JSON.stringify stored as TEXT) and `text` with DateTransformer.
 *
 * PostgreSQL has native `jsonb` and `timestamp` types with better
 * indexing and query performance.
 *
 * DATA CONNECTION ONLY. These resolve the dialect of the *data* connection from the global
 * `DATABASE_TYPE` env var. Use them only on entities bound to the data connection. Entities on the
 * MAIN connection (auth, audit) are ALWAYS SQLite — it is hardcoded `type: 'better-sqlite3'` in
 * app.module.ts regardless of DATABASE_TYPE — so they must hardcode `simple-json` / `datetime`
 * (see audit-log.entity.ts) and must NOT call these helpers, or a Postgres deployment would emit a
 * `jsonb`/`timestamp` column on the always-SQLite main DB.
 */

const isPostgres = (): boolean => process.env.DATABASE_TYPE === 'postgres';
const isMysql = (): boolean => process.env.DATABASE_TYPE === 'mysql';

/**
 * Always 'simple-json' (TypeORM JSON.stringify/parse over a `text` column), on BOTH dialects.
 *
 * The baseline migration created these columns as `text` on Postgres too (never `jsonb`). The pg
 * driver only auto-parses real json/jsonb columns, so a `jsonb`-typed entity reading the actual
 * `text` column hands back a RAW string — e.g. webhook.events comes through as the string
 * '["message.received"]', and the dashboard's events.map() throws (full-page crash). 'simple-json'
 * parses on read regardless of dialect, matching the real columns. No native jsonb queries exist
 * (all JSON filtering is done in JS), so nothing is lost.
 */
export const jsonColumnType = (): 'simple-json' => 'simple-json';

/**
 * Returns 'timestamp' for PostgreSQL, 'text' for SQLite.
 * Use with DateTransformer for SQLite compatibility.
 */
export const dateColumnType = (): 'timestamp' | 'text' => (isPostgres() ? 'timestamp' : 'text');

/**
 * Explicit column length for a MySQL composite unique index, a no-op `{}` on every other dialect.
 *
 * TypeORM's MySQL driver defaults an un-lengthed varchar column to varchar(255). With the utf8mb4
 * charset (4 bytes/char), a multi-column composite unique index over several un-lengthed columns
 * can total more than InnoDB's 3072-byte max index key length, which makes `synchronize: true`
 * fail with ER_TOO_LONG_KEY ("Specified key was too long"). SQLite and Postgres have no such
 * limit, so this is a true no-op there — those columns keep their existing unbounded shape,
 * matching the migration-managed schema already deployed on those dialects.
 *
 * Only apply this to a column that is part of a MySQL composite unique/index key; pick `length`
 * generously above the real maximum value that column ever stores (truncating indexed data would
 * silently break the uniqueness guarantee the index exists to enforce).
 */
export const mysqlIndexLength = (length: number): { length?: number } => (isMysql() ? { length } : {});

const jsonTransformer: ValueTransformer = {
  to: (value: unknown): string | null | undefined =>
    value === null || value === undefined ? value : JSON.stringify(value),
  from: (value: string | null): unknown =>
    value === null || value === undefined || value === '' ? null : JSON.parse(value),
};

/**
 * Column options (spread into `@Column({...})`) for a JSON-shaped value, portable across every
 * dialect. Use this instead of `type: jsonColumnType()` for every JSON column on the data
 * connection — e.g. `@Column({ ...jsonColumn(), nullable: true })`, or `@Column(jsonColumn('{}'))`
 * for a defaulted, non-nullable one.
 *
 * sqlite/postgres: identical to before — TypeORM's built-in 'simple-json' virtual type
 * (JSON.stringify/parse over a plain `text` column) via {@link jsonColumnType}, with a plain
 * literal `default:` when `defaultLiteral` is given. No behavior change on either already-shipped
 * dialect.
 *
 * mysql: a plain MySQL `text` column caps at 65,535 bytes, and several of these columns can carry a
 * full webhook/message payload (inline media included) well past that — MySQL has no
 * 'simple-json' driver support either, so this uses `longtext` (up to 4GB) with an equivalent
 * manual JSON.stringify/parse transformer instead. Applied uniformly to every JSON column rather
 * than judged case-by-case: the storage overhead of longtext vs text is negligible, and a column
 * that looks small today can still grow (a per-recipient batch field, a future value) — safer than
 * re-discovering ER_DATA_TOO_LONG on whichever one was judged small. `defaultLiteral` (when given)
 * is emitted via MySQL's parenthesized expression-default form (`DEFAULT ('{}')`, MySQL 8.0.13+):
 * a plain literal default on any TEXT/BLOB/JSON column is rejected outright
 * (ER_BLOB_CANT_HAVE_DEFAULT).
 */
export const jsonColumn = (defaultLiteral?: string): Record<string, unknown> => {
  if (isMysql()) {
    return {
      type: 'longtext',
      transformer: jsonTransformer,
      ...(defaultLiteral !== undefined ? { default: () => `('${defaultLiteral.replace(/'/g, "''")}')` } : {}),
    };
  }
  return {
    type: jsonColumnType(),
    ...(defaultLiteral !== undefined ? { default: defaultLiteral } : {}),
  };
};
