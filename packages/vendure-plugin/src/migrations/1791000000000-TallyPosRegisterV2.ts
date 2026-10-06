import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Register v2's device identity, take-over and permanent aliases (ADR-078). SQL from TypeORM's schema builder against Postgres. */
export class TallyPosRegisterV21791000000000 implements MigrationInterface {
  name = 'TallyPosRegisterV21791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "tally_register_session_alias" ("channelId" character varying NOT NULL, "id" character varying NOT NULL, "sessionId" character varying NOT NULL, "commandId" character varying NOT NULL, "receivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b759fdc911b503ab399194b2cde" PRIMARY KEY ("channelId", "id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_bd172624d55396a2353622b924" ON "tally_register_session_alias" ("channelId", "sessionId") `);
    await queryRunner.query(`ALTER TABLE "tally_register_session" ADD "deviceId" character varying`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" ADD "deviceName" character varying`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" ADD "supersedes" character varying`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" ADD CONSTRAINT "UQ_d767ba1e95deebc176f4a7b9b4c" UNIQUE ("channelId", "supersedes")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_register_session" DROP CONSTRAINT "UQ_d767ba1e95deebc176f4a7b9b4c"`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" DROP COLUMN "supersedes"`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" DROP COLUMN "deviceName"`);
    await queryRunner.query(`ALTER TABLE "tally_register_session" DROP COLUMN "deviceId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bd172624d55396a2353622b924"`);
    await queryRunner.query(`DROP TABLE "tally_register_session_alias"`);
  }
}
