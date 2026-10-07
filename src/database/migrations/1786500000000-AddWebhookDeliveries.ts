import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `webhook_deliveries` — a row per delivery ATTEMPT (success or failure), not just the
 * terminal failures `webhook_delivery_failures` already tracks. Lets an operator browse what was
 * actually POSTed and how the receiver answered. Append-only; retention/pruning is left for later
 * if this grows unbounded in practice (the way `webhook_delivery_failures` already prunes).
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres (and optional on
 * SQLite). No FK to sessions, matching `webhook_delivery_failures` — operational/audit data that
 * should survive the session it references.
 */
export class AddWebhookDeliveries1786500000000 implements MigrationInterface {
  name = 'AddWebhookDeliveries1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('openwa_gw_webhook_deliveries')) return;
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const id = isPostgres
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const createdTs = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : `(datetime('now'))`;
    const boolDefault = isPostgres ? 'false' : '(0)';

    await queryRunner.query(
      `CREATE TABLE "openwa_gw_webhook_deliveries" (${id}, "webhookId" varchar NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"event" varchar NOT NULL, "url" varchar NOT NULL, "requestPayload" text, "responseStatus" integer, ` +
        `"responseBody" text, "success" boolean NOT NULL DEFAULT ${boolDefault}, "attempt" integer NOT NULL, ` +
        `"durationMs" integer NOT NULL, "error" text, "createdAt" ${createdTs} NOT NULL DEFAULT ${now})`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_sessionId_createdAt" ON "openwa_gw_webhook_deliveries" ("sessionId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_webhookId_createdAt" ON "openwa_gw_webhook_deliveries" ("webhookId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_deliveries_webhookId_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_deliveries_sessionId_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "openwa_gw_webhook_deliveries"`);
  }
}
