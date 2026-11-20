import type { MigrationInterface, QueryRunner } from 'typeorm';

/** #345: the receipt-email route's durable per-order and daily windows; the table starts empty. */
export class TallyPosReceiptEmail1791400000000 implements MigrationInterface {
  name = 'TallyPosReceiptEmail1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "tally_receipt_email_window" ("key" character varying NOT NULL, "sends" integer NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_5c42b39a51e6e6588e0906511f3" PRIMARY KEY ("key"))`);
    await queryRunner.query(`CREATE INDEX "IDX_fe22f74cac6e8b89d66ac363a3" ON "tally_receipt_email_window" ("expiresAt") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_fe22f74cac6e8b89d66ac363a3"`);
    await queryRunner.query(`DROP TABLE "tally_receipt_email_window"`);
  }
}
