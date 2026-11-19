import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Register contract 3 (#332): the manager approvals and the closure's `approvalId`; every existing closure keeps null. */
export class TallyPosRegisterApproval1791300000000 implements MigrationInterface {
  name = 'TallyPosRegisterApproval1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "tally_register_approval" ("id" character varying NOT NULL, "channelId" character varying NOT NULL, "tokenHash" character varying, "sessionId" character varying NOT NULL, "variance" text NOT NULL, "approvedBy" character varying, "approvedByName" character varying, "requestedBy" character varying NOT NULL, "targetIdentifier" character varying NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE, "usedAt" TIMESTAMP WITH TIME ZONE, "usedByCommandId" character varying, "closureId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_11d965948dc768c2038aadd10c0" UNIQUE ("tokenHash"), CONSTRAINT "PK_b86921a4047f233675e72bb1067" PRIMARY KEY ("id"))`);
    await queryRunner.query(`ALTER TABLE "tally_register_closure" ADD "approvalId" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_register_closure" DROP COLUMN "approvalId"`);
    await queryRunner.query(`DROP TABLE "tally_register_approval"`);
  }
}
