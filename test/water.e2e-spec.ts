import turfArea from '@turf/area';
import { polygon } from '@turf/helpers';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

type Ring = number[][];

const LAT = 49.595;
/** metres east → degrees of longitude at this latitude, rounded like the API */
const east = (m: number) => +(m / (111_320 * Math.cos((LAT * Math.PI) / 180))).toFixed(6);
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const turfHa = (ring: Ring) => turfArea(polygon([ring])) / 1e4;

/** A: ~720 x 1110 m, ~80 ha */
const A = rect(34.55, 49.59, 34.56, 49.6);

describe('water protection zones (M8)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;
  let otherOrg: string;

  const post = (url: string, payload: object, orgId = org) =>
    app.inject({ method: 'POST', url, headers: { 'x-org-id': orgId }, payload });
  const field = async (ring: Ring, orgId = org) =>
    (await post('/fields', { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [ring] } }, orgId)).json();
  /** a river running north–south at longitude `lng`, past the whole field */
  const river = (lng: number, size: 'small' | 'medium' | 'large', name = 'test river') =>
    post('/water-bodies', {
      type: 'Feature',
      properties: { name, size },
      geometry: { type: 'LineString', coordinates: [[lng, 49.58], [lng, 49.61]] },
    });
  const zones = (id: string, query = '') =>
    app.inject({ method: 'GET', url: `/fields/${id}/water-zones${query}`, headers: { 'x-org-id': org } });
  const part = (body: { features: { id: string; geometry: { coordinates: unknown[] }; properties: { areaHa: number } }[] }, id: string) =>
    body.features.find((f) => f.id === id)!;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name IN ('test water', 'test water other')`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test water') RETURNING id`);
    [{ id: otherOrg }] = await db.query(`INSERT INTO organizations (name) VALUES ('test water other') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM water_bodies WHERE name LIKE 'test %'`);
    await db.query('DELETE FROM fields WHERE org_id IN ($1, $2)', [org, otherOrg]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM water_bodies WHERE name LIKE 'test %'`);
    await db.query('DELETE FROM organizations WHERE id IN ($1, $2)', [org, otherOrg]);
    await app.close();
  });

  it('stores a river with the strip width of its size class', async () => {
    const res = await river(34.6, 'medium');

    expect(res.statusCode).toBe(201);
    expect(res.json().geometry.type).toBe('MultiLineString');
    expect(res.json().properties).toMatchObject({ size: 'medium', zoneM: 50 });
  });

  it('a medium river 20 m east of the field takes a 30 m strip off it', async () => {
    const a = await field(A);
    await river(+(34.56 + east(20)).toFixed(6), 'medium'); // strip 50 m → 30 m of it inside the field

    const res = await zones(a.id);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const strip = turfHa(rect(+(34.56 - east(30)).toFixed(6), 49.59, 34.56, 49.6)); // ~3.3 ha, independent of PostGIS
    expect(Math.abs(body.restrictedHa / strip - 1)).toBeLessThan(0.02);
    expect(body.restrictedHa + body.sprayableHa).toBeCloseTo(body.fieldAreaHa, 1);
    expect(body.restrictedPercent).toBeCloseTo((100 * body.restrictedHa) / body.fieldAreaHa, 1);
    expect(part(body, 'restricted').geometry.coordinates.length).toBeGreaterThan(0);
    const water = body.features.find((f: { properties: { part: string } }) => f.properties.part === 'water');
    expect(water.properties).toMatchObject({ name: 'test river', zoneM: 50 });
    expect(water.properties.distanceM).toBeGreaterThan(18);
    expect(water.properties.distanceM).toBeLessThan(22);
  });

  it('a stream across the middle cuts the sprayable area in two', async () => {
    const a = await field(A);
    await river(34.555, 'small'); // 25 m each side → a ~50 m band through the field

    const body = (await zones(a.id)).json();

    expect(part(body, 'sprayable').geometry.coordinates).toHaveLength(2); // two pieces
    const band = turfHa(rect(+(34.555 - east(25)).toFixed(6), 49.59, +(34.555 + east(25)).toFixed(6), 49.6));
    expect(Math.abs(body.restrictedHa / band - 1)).toBeLessThan(0.02);
  });

  it('buffer_m overrides the strip width; water further away does not count', async () => {
    const a = await field(A);
    await river(+(34.56 + east(20)).toFixed(6), 'medium');

    const narrow = (await zones(a.id, '?buffer_m=10')).json();
    expect(narrow.restrictedHa).toBe(0);
    expect(narrow.sprayableHa).toBeCloseTo(narrow.fieldAreaHa, 2);

    await db.query(`DELETE FROM water_bodies WHERE name LIKE 'test %'`);
    await river(34.65, 'large'); // ~6 km away
    expect((await zones(a.id)).json()).toMatchObject({ restrictedHa: 0, restrictedPercent: 0 });
  });

  it('a buffer in degrees is not a strip: 0.00045° is 50 m north but 32 m east', async () => {
    // the river line, and a point 40 m east of it
    const [r] = await db.query(
      `WITH l AS (SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint(34.6, 49.58), ST_MakePoint(34.6, 49.61)), 4326) AS g),
            p AS (SELECT ST_SetSRID(ST_MakePoint(34.6 + $1, 49.595), 4326) AS g)
       SELECT ST_Covers(ST_Buffer(l.g, 0.00045), p.g)                       AS in_degree_buffer,
              ST_Covers(ST_Buffer(l.g::geography, 50)::geometry, p.g)       AS in_metre_buffer
         FROM l, p`,
      [east(40)],
    );

    expect(r).toEqual({ in_degree_buffer: false, in_metre_buffer: true });
  });

  it("404 for another organisation's field, 400 for a bad buffer or geometry", async () => {
    const theirs = await field(A, otherOrg);

    expect((await zones(theirs.id)).statusCode).toBe(404);
    const mine = await field(A);
    expect((await zones(mine.id, '?buffer_m=0')).statusCode).toBe(400);
    expect((await zones(mine.id, '?buffer_m=1000')).statusCode).toBe(400);

    const polygonRiver = await post('/water-bodies', {
      type: 'Feature', properties: { name: 'test lake', size: 'small' }, geometry: { type: 'Polygon', coordinates: [A] },
    });
    expect(polygonRiver.statusCode).toBe(400);
    const swapped = await post('/water-bodies', {
      type: 'Feature', properties: { name: 'test swapped', size: 'small' },
      geometry: { type: 'LineString', coordinates: [[49.58, 34.6], [49.61, 34.6]] },
    });
    expect(JSON.stringify(swapped.json().issues)).toMatch(/swapped/);
  });
});
