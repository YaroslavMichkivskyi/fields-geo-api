import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rivers, streams and canals as lines, with the width of their protection
 * strip. Water Code of Ukraine, art. 88: along small rivers and streams no
 * pesticides within 25 m of the water, medium rivers 50 m, large rivers 100 m.
 *
 * Reference data, the same for every organisation (no org_id): in a real
 * deployment it is imported from OpenStreetMap / the state water cadastre by
 * an admin job.
 *
 * Distances to fields are asked in metres (`geom::geography`), hence the GiST
 * index on that expression — as for fields in M6.
 */
export class WaterBodies1795400007000 implements MigrationInterface {
  name = 'WaterBodies1795400007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE water_bodies (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text        NOT NULL,
        size       text        NOT NULL CHECK (size IN ('small', 'medium', 'large')),
        -- protection strip width, derived from the size class (art. 88)
        zone_m     smallint    GENERATED ALWAYS AS (
                     CASE size WHEN 'small' THEN 25 WHEN 'medium' THEN 50 ELSE 100 END) STORED,
        geom       geometry(MultiLineString, 4326) NOT NULL CHECK (ST_IsValid(geom) AND NOT ST_IsEmpty(geom)),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query('CREATE INDEX water_bodies_geog_gist ON water_bodies USING GIST ((geom::geography))');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE water_bodies');
  }
}
