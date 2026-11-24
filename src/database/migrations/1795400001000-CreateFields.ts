import type { MigrationInterface, QueryRunner } from 'typeorm';

export const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Organisations and their fields. A field boundary is always stored as a
 * MultiPolygon in WGS 84 (SRID 4326): one column type for "one plot" and
 * "a plot split by a road", and the same coordinate system GeoJSON uses.
 *
 * The spatial (GiST) index arrives in M4, together with the queries that need it.
 */
export class CreateFields1795400001000 implements MigrationInterface {
  name = 'CreateFields1795400001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE organizations (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text        NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE fields (
        id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name       text        NOT NULL,
        crop       text,
        season     smallint,
        geom       geometry(MultiPolygon, 4326) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query('CREATE INDEX fields_org_id_idx ON fields (org_id)');
    // a fixed organisation to try the API by hand (x-org-id header)
    await queryRunner.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Demo farm')`, [
      DEMO_ORG_ID,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE fields');
    await queryRunner.query('DROP TABLE organizations');
  }
}
