import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warehouses (a distributor's question: "which fields are within 30 km of
 * this warehouse?") and a spatial index for distance queries in metres.
 *
 * Distances are measured on `geography`, which works in metres, so the queries
 * test `geom::geography`. The GiST index on `geom` is an index on a *different
 * expression* and is never used for that: the index has to be built on exactly
 * the expression the query uses. An expression index does it without storing
 * a second copy of every boundary (docs/explain.md compares it with a stored
 * geography column).
 */
export class WarehousesAndGeographyIndex1795400005000 implements MigrationInterface {
  name = 'WarehousesAndGeographyIndex1795400005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE warehouses (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name       text        NOT NULL,
        geom       geometry(Point, 4326) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query('CREATE INDEX warehouses_org_id_idx ON warehouses (org_id)');
    await queryRunner.query('CREATE INDEX fields_geog_gist ON fields USING GIST ((geom::geography))');
    await queryRunner.query('ANALYZE fields');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX fields_geog_gist');
    await queryRunner.query('DROP TABLE warehouses');
  }
}
