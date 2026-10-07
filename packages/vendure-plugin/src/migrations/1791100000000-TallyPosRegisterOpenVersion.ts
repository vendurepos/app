import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Record the session's open version so superseded refusals follow what its till understands (TallyUI/tallyui#515). */
export class TallyPosRegisterOpenVersion1791100000000 implements MigrationInterface {
  name = 'TallyPosRegisterOpenVersion1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_register_session" ADD "openVersion" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tally_register_session" DROP COLUMN "openVersion"`);
  }
}
