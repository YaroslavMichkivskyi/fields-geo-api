import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spatial index on the field boundary. GiST keeps an R-tree of bounding
 * boxes: `geom && box` and ST_Intersects / ST_DWithin / ST_Covers walk the
 * tree instead of reading every row.
 */
export class FieldsGeomIndex1795400004000 implements MigrationInterface {
  name = 'FieldsGeomIndex1795400004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX fields_geom_gist ON fields USING GIST (geom)');
    // fresh statistics, or the planner may still believe a full scan is cheaper
    await queryRunner.query('ANALYZE fields');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX fields_geom_gist');
  }
}
