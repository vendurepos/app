import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The customer-display signalling tables (TallyUI ADR-085 U7): codes, pending pairings, the registry, snapshots, inboxes, claim windows. */
export class TallyPosDisplay1791200000000 implements MigrationInterface {
  name = 'TallyPosDisplay1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "tally_display_code" ("code" character varying NOT NULL, "channelId" character varying NOT NULL, "deviceId" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "spent" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_54ea19feab97dc0c5371030ff54" PRIMARY KEY ("code"))`);
    await queryRunner.query(`CREATE TABLE "tally_display_pending" ("id" character varying NOT NULL, "channelId" character varying NOT NULL, "deviceId" character varying NOT NULL, "secretHash" character varying NOT NULL, "displayName" character varying NOT NULL, "checkCode" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "movingDisplayId" character varying, CONSTRAINT "UQ_26c513189244bf279fbc6bc260c" UNIQUE ("secretHash"), CONSTRAINT "UQ_0cd26a37740342d0e9e934e33e6" UNIQUE ("checkCode"), CONSTRAINT "PK_ee2a57ca0c7852c927c5542f8c8" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE TABLE "tally_display" ("id" character varying NOT NULL, "channelId" character varying NOT NULL, "deviceId" character varying NOT NULL, "name" character varying NOT NULL, "cashierId" character varying NOT NULL, "confirmedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE, "tokenHash" character varying, "secretHash" character varying, CONSTRAINT "UQ_719ab85b069eb4be7ad6a3fecb3" UNIQUE ("tokenHash"), CONSTRAINT "UQ_a5152d99e13153f09332bef2777" UNIQUE ("secretHash"), CONSTRAINT "PK_1d7f964f3713e76074220a57b4c" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE TABLE "tally_display_snapshot" ("displayId" character varying NOT NULL, "body" text NOT NULL, "postedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_615afaa6c2c4ffadfcf3722c7ca" PRIMARY KEY ("displayId"))`);
    await queryRunner.query(`CREATE TABLE "tally_display_signal" ("seq" SERIAL NOT NULL, "displayId" character varying NOT NULL, "toTill" boolean NOT NULL, "type" character varying NOT NULL, "payload" text NOT NULL, CONSTRAINT "PK_a6576bb5b7b6ff896e8d63c951f" PRIMARY KEY ("seq"))`);
    await queryRunner.query(`CREATE INDEX "IDX_8bf211bd9f82df1e6aba881196" ON "tally_display_signal" ("displayId", "toTill") `);
    await queryRunner.query(`CREATE TABLE "tally_display_claim_window" ("key" character varying NOT NULL, "failures" integer NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_4217b7c3c4d4aba5158e3f838de" PRIMARY KEY ("key"))`);
    await queryRunner.query(`ALTER TABLE "tally_display_snapshot" ADD CONSTRAINT "FK_615afaa6c2c4ffadfcf3722c7ca" FOREIGN KEY ("displayId") REFERENCES "tally_display"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    await queryRunner.query(`ALTER TABLE "tally_display_signal" ADD CONSTRAINT "FK_58cfdc64c76ec3ac275a10b0189" FOREIGN KEY ("displayId") REFERENCES "tally_display"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_display_signal" DROP CONSTRAINT "FK_58cfdc64c76ec3ac275a10b0189"`);
    await queryRunner.query(`ALTER TABLE "tally_display_snapshot" DROP CONSTRAINT "FK_615afaa6c2c4ffadfcf3722c7ca"`);
    await queryRunner.query(`DROP TABLE "tally_display_claim_window"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8bf211bd9f82df1e6aba881196"`);
    await queryRunner.query(`DROP TABLE "tally_display_signal"`);
    await queryRunner.query(`DROP TABLE "tally_display_snapshot"`);
    await queryRunner.query(`DROP TABLE "tally_display"`);
    await queryRunner.query(`DROP TABLE "tally_display_pending"`);
    await queryRunner.query(`DROP TABLE "tally_display_code"`);
  }
}
