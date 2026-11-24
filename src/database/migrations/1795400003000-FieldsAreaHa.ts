import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Field area in hectares, kept by Postgres itself: a STORED generated column is
 * recomputed on every INSERT / UPDATE of geom, so it can never go stale, and it
 * can be filtered, sorted and indexed like any other column.
 *
 * geom::geography measures on the WGS 84 spheroid in m²; on plain geometry in
 * SRID 4326 ST_Area would return square degrees.
 */
export class FieldsAreaHa1795400003000 implements MigrationInterface {
  name = 'FieldsAreaHa1795400003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE fields
        ADD COLUMN area_ha numeric(12, 4)
        GENERATED ALWAYS AS (round((ST_Area(geom::geography) / 10000)::numeric, 4)) STORED`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE fields DROP COLUMN area_ha');
  }
}
