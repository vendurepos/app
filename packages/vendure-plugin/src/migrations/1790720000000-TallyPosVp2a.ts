import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VP2a: the ledger keeps each sale's stock top-ups and their locations (TallyCommand.topUps), and an
 * admin-rejected order keeps its released client id and a flag (re-rulings 1 and 2).
 */
export class TallyPosVp2a1790720000000 implements MigrationInterface {
  name = 'TallyPosVp2a1790720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_command" ADD "topUps" text`);
    await queryRunner.query(`ALTER TABLE "order" ADD "customFieldsTallyrejectedclientorderid" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "order" ADD "customFieldsTallyrejected" boolean`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "customFieldsTallyrejected"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "customFieldsTallyrejectedclientorderid"`);
    await queryRunner.query(`ALTER TABLE "tally_command" DROP COLUMN "topUps"`);
  }
}
