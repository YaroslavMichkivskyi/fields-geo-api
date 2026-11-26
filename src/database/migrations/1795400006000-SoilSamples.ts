import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Soil samples: a point where the agronomist took soil, with lab results.
 *
 * `field_id` is the field the point lies in, worked out by PostGIS when the
 * sample is stored (and again when a field is drawn later around old samples).
 * Stored, not recomputed on every read: stats per field become a plain
 * GROUP BY on an indexed column. NULL = the point is in no field of the
 * organisation (a GPS slip or a boundary drawn too tight).
 */
export class SoilSamples1795400006000 implements MigrationInterface {
  name = 'SoilSamples1795400006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE soil_samples (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        field_id   uuid        REFERENCES fields (id) ON DELETE SET NULL,
        taken_at   timestamptz NOT NULL,
        ph         numeric(3,1) CHECK (ph BETWEEN 0 AND 14),
        humus      numeric(5,2) CHECK (humus BETWEEN 0 AND 100),   -- % of soil mass
        geom       geometry(Point, 4326) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query('CREATE INDEX soil_samples_field_id_idx ON soil_samples (field_id)');
    // only the samples still waiting for a field: small, and exactly what a new field looks for
    await queryRunner.query(
      'CREATE INDEX soil_samples_unassigned_gist ON soil_samples USING GIST (geom) WHERE field_id IS NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE soil_samples');
  }
}
