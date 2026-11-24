import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

/** 0.01° x 0.01° near Poltava: ~0.72 x 1.11 km, 80.41 ha on the spheroid. */
const SQUARE = [[34.55, 49.59], [34.56, 49.59], [34.56, 49.60], [34.55, 49.60], [34.55, 49.59]];

/** A "C" open to the east: its centroid falls in the empty bay, outside the field. */
const C_SHAPE = [
  [34.55, 49.59], [34.58, 49.59], [34.58, 49.595], [34.56, 49.595],
  [34.56, 49.605], [34.58, 49.605], [34.58, 49.61], [34.55, 49.61], [34.55, 49.59],
];

describe('measurements (M3)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;

  const create = (ring: number[][]) =>
    app
      .inject({
        method: 'POST',
        url: '/fields',
        headers: { 'x-org-id': org },
        payload: { type: 'Feature', properties: { name: 'm' }, geometry: { type: 'Polygon', coordinates: [ring] } },
      })
      .then((r) => r.json());

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name = 'test measure'`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test measure') RETURNING id`);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id = $1', [org]);
    await app.close();
  });

  it('reports area in hectares and perimeter in metres, measured on the spheroid', async () => {
    const { properties } = await create(SQUARE);

    expect(properties.areaHa).toBeCloseTo(80.4088, 4);
    expect(properties.perimeterM).toBeCloseTo(3670.3, 1);
  });

  it('puts the label point inside a concave field, where the centroid is not', async () => {
    const { id, properties } = await create(C_SHAPE);

    const [check] = await db.query(
      `SELECT ST_Covers(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)) AS label_inside,
              ST_Covers(geom, ST_Centroid(geom))                      AS centroid_inside
         FROM fields WHERE id = $1`,
      [id, ...properties.labelPoint],
    );

    expect(check).toEqual({ label_inside: true, centroid_inside: false });
  });

  it('recomputes the stored area when the boundary changes (generated column)', async () => {
    const { id } = await create(SQUARE);

    // halve the field to the west half
    await db.query(
      `UPDATE fields
          SET geom = ST_Multi('SRID=4326;POLYGON((34.55 49.59,34.555 49.59,34.555 49.60,34.55 49.60,34.55 49.59))'::geometry)
        WHERE id = $1`,
      [id],
    );
    const [{ area_ha }] = await db.query('SELECT area_ha FROM fields WHERE id = $1', [id]);

    expect(Number(area_ha)).toBeCloseTo(80.4088 / 2, 2);
  });

  it('refuses a hand-written area (GENERATED ALWAYS)', async () => {
    const { id } = await create(SQUARE);

    await expect(db.query('UPDATE fields SET area_ha = 1 WHERE id = $1', [id])).rejects.toMatchObject({
      code: '428C9', // generated_always
    });
  });
});
