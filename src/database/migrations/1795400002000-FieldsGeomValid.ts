import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Last line of defence: whatever path writes to `fields` (the API, a script,
 * a manual UPDATE), the database refuses an invalid or empty boundary.
 * The API repairs or rejects first, so this should never fire from it.
 */
export class FieldsGeomValid1795400002000 implements MigrationInterface {
  name = 'FieldsGeomValid1795400002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE fields
        ADD CONSTRAINT fields_geom_valid CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE fields DROP CONSTRAINT fields_geom_valid');
  }
}
