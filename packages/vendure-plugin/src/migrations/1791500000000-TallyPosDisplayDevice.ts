import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TallyUI#754: the till device keys. Every device that owns a paired display gets a keyless row, which adopts its
 * displays at its first `registerDevice`. Codes and pending pairings live minutes, so their devices just register fresh.
 */
export class TallyPosDisplayDevice1791500000000 implements MigrationInterface {
  name = 'TallyPosDisplayDevice1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "tally_display_device" ("channelId" character varying NOT NULL, "deviceId" character varying NOT NULL, "keyHash" character varying, "adoptedBy" character varying, "adoptedAt" TIMESTAMP WITH TIME ZONE, "lastCallAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_ecad5a1633b10c85d5d3c5f7450" PRIMARY KEY ("channelId", "deviceId"))`);
    await queryRunner.query(`CREATE INDEX "IDX_1cfc018cafb2a3033d784b3ac5" ON "tally_display_device" ("lastCallAt") `);
    await queryRunner.query(`INSERT INTO "tally_display_device" ("channelId", "deviceId", "lastCallAt") SELECT DISTINCT "channelId", "deviceId", now() FROM "tally_display"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_1cfc018cafb2a3033d784b3ac5"`);
    await queryRunner.query(`DROP TABLE "tally_display_device"`);
  }
}
