import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The v5 shipping and custom-line fields (ADR 0005). TypeORM's schema builder against Postgres 16
 * produces this SQL; test/migration.e2e.ts proves the migration and an empty schema diff after it.
 */
export class TallyPosV51790900000000 implements MigrationInterface {
  name = 'TallyPosV51790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsTallycustomname" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "order_line" ADD "customFieldsTallycustomsku" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "order" ADD "customFieldsTallyshipping" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "customFieldsTallyshipping"`);
    await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsTallycustomsku"`);
    await queryRunner.query(`ALTER TABLE "order_line" DROP COLUMN "customFieldsTallycustomname"`);
  }
}
