import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PostGIS ships inside the Docker image but has to be enabled in every
 * database: types geometry / geography, the ST_* functions, spatial_ref_sys.
 */
export class EnablePostgis1795400000000 implements MigrationInterface {
  name = 'EnablePostgis1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP EXTENSION IF EXISTS postgis');
  }
}
