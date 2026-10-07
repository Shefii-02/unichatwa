import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `origin` column to the `messages` table: who/what produced an OUTGOING message (ai / manual /
 * chatbot). Null for every incoming row and for outgoing rows written before this column existed.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL (and optional
 * on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: checks for column existence first, same
 * dialect-aware probe as AddMessageAuthor (avoids `queryRunner.getTable` tripping over the FTS
 * migration's generated `body_ts` column on Postgres).
 */
export class AddMessageOrigin1786400000000 implements MigrationInterface {
  name = 'AddMessageOrigin1786400000000';

  private async hasOriginColumn(queryRunner: QueryRunner): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'openwa_gw_messages' AND column_name = 'origin'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("openwa_gw_messages")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === 'origin');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasOriginColumn(queryRunner)) return; // already added by synchronize or a previous run

    await queryRunner.query(`ALTER TABLE "openwa_gw_messages" ADD COLUMN "origin" varchar NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasOriginColumn(queryRunner))) return;
    await queryRunner.query(`ALTER TABLE "openwa_gw_messages" DROP COLUMN "origin"`);
  }
}
