import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { MAX_FEATURES } from '../src/fields/fields.service';
import { toleranceForZoom } from '../src/geo/viewport';
import { createTestApp } from './app';

const square = (lng: number, lat: number, size = 0.01) => [
  [lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat],
];

/** A circle of 256 vertices: plenty to drop at a low zoom. */
const circle = (lng: number, lat: number, r = 0.01, n = 256) => {
  const ring = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [+(lng + r * Math.cos(a)).toFixed(6), +(lat + r * Math.sin(a)).toFixed(6)];
  });
  return [...ring, ring[0]];
};

describe('map viewport (M4)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;

  const create = (name: string, ring: number[][]) =>
    app.inject({
      method: 'POST',
      url: '/fields',
      headers: { 'x-org-id': org },
      payload: { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } },
    });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-org-id': org } }).then((r) => r);
  const names = (fc: { features: { properties: { name: string } }[] }) => fc.features.map((f) => f.properties.name);

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name = 'test viewport'`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test viewport') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM fields WHERE org_id = $1', [org]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id = $1', [org]);
    await app.close();
  });

  it('returns only the fields whose box overlaps the viewport', async () => {
    await create('poltava', square(34.55, 49.59));
    await create('kremenchuk', square(33.41, 49.07));

    const res = await get('/fields?bbox=34.5,49.55,34.6,49.62');

    expect(res.statusCode).toBe(200);
    expect(names(res.json())).toEqual(['poltava']);
  });

  it('includes a field that only crosses the viewport edge', async () => {
    await create('edge', square(34.595, 49.59)); // sticks out east of 34.6

    expect(names((await get('/fields?bbox=34.5,49.55,34.6,49.62')).json())).toEqual(['edge']);
  });

  it('simplifies boundaries for a low zoom, keeps them intact without zoom', async () => {
    await create('round', circle(34.55, 49.59));
    const points = (fc: { features: { geometry: { coordinates: number[][][][] } }[] }) =>
      fc.features[0].geometry.coordinates[0][0].length;

    const full = (await get('/fields?bbox=34.5,49.55,34.6,49.62')).json();
    const z12 = (await get('/fields?bbox=34.5,49.55,34.6,49.62&zoom=12')).json();
    const z8 = (await get('/fields?bbox=34.5,49.55,34.6,49.62&zoom=8')).json();

    expect(points(full)).toBe(257);
    expect(points(z12)).toBeLessThan(points(full));
    expect(points(z8)).toBeLessThan(points(z12));
    expect(points(z8)).toBeGreaterThanOrEqual(4); // still a closed ring, the field is not lost
    // the measurements describe the real field, not the simplified drawing
    expect(z8.features[0].properties.areaHa).toBe(full.features[0].properties.areaHa);
  });

  it('half a pixel: the tolerance halves with every zoom level', () => {
    expect(toleranceForZoom(0)).toBeCloseTo(360 / 512);
    expect(toleranceForZoom(13) / toleranceForZoom(14)).toBe(2);
  });

  it(`cuts off at ${MAX_FEATURES} features and says so`, async () => {
    await db.query(
      `INSERT INTO fields (org_id, name, geom)
       SELECT $1, 'bulk ' || i, ST_Multi(ST_MakeEnvelope(34.5 + i * 1e-5, 49.5, 34.5 + i * 1e-5 + 0.002, 49.502, 4326))
         FROM generate_series(1, $2) i`,
      [org, MAX_FEATURES + 1],
    );

    const fc = (await get('/fields?bbox=34,49,35,50')).json();

    expect(fc.features).toHaveLength(MAX_FEATURES);
    expect(fc.truncated).toBe(true);
  });

  it.each([
    ['three numbers', 'bbox=34,49,35', /four numbers/],
    ['min above max', 'bbox=35,49,34,50', /below max/],
    ['latitude 95', 'bbox=34,49,35,95', /out of range/],
    ['zoom 30', 'bbox=34,49,35,50&zoom=30', /22/],
  ])('400 for %s', async (_, query, message) => {
    const res = await get(`/fields?${query}`);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(message);
  });

  it('extent: the box around all fields, null when there are none', async () => {
    expect((await get('/fields/extent')).json()).toEqual({ bbox: null });

    await create('a', square(34.55, 49.59));
    await create('b', square(33.41, 49.07));

    expect((await get('/fields/extent')).json()).toEqual({ bbox: [33.41, 49.07, 34.56, 49.6] });
  });
});
