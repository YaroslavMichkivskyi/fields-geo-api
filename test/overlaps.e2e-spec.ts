import turfArea from '@turf/area';
import { polygon } from '@turf/helpers';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

type Ring = number[][];

const LAT = 49.59;
/** metres east → degrees of longitude at this latitude, rounded like the API */
const east = (m: number) => +(m / (111_320 * Math.cos((LAT * Math.PI) / 180))).toFixed(6);

/** counter-clockwise rectangle [w, s, e, n] */
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/** A: ~720 x 1110 m, ~80 ha */
const A = rect(34.55, 49.59, 34.56, 49.6);

describe('overlaps between fields (M5)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;
  let otherOrg: string;

  const post = (name: string, ring: Ring, orgId = org) =>
    app
      .inject({
        method: 'POST',
        url: '/fields',
        headers: { 'x-org-id': orgId },
        payload: { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } },
      })
      .then((r) => r.json());
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-org-id': org } });

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name IN ('test overlaps', 'test overlaps other')`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test overlaps') RETURNING id`);
    [{ id: otherOrg }] = await db.query(`INSERT INTO organizations (name) VALUES ('test overlaps other') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM fields WHERE org_id IN ($1, $2)', [org, otherOrg]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id IN ($1, $2)', [org, otherOrg]);
    await app.close();
  });

  it('neighbours sharing a boundary do not overlap', async () => {
    const a = await post('A', A);
    const b = await post('B', rect(34.56, 49.59, 34.57, 49.6)); // starts exactly at A's east edge

    expect(b.overlaps).toEqual([]);
    expect((await get(`/fields/${a.id}/overlaps`)).json().features).toEqual([]);
  });

  it('a 20 m encroachment is an overlap, with the right area', async () => {
    const a = await post('A', A);
    const west = +(34.56 - east(20)).toFixed(6);
    const b = await post('B', rect(west, 49.59, 34.57, 49.6));

    const strip = turfArea(polygon([rect(west, 49.59, 34.56, 49.6)])) / 1e4; // ~2.2 ha, independent of PostGIS
    expect(b.overlaps).toHaveLength(1);
    expect(b.overlaps[0]).toMatchObject({ id: a.id, name: 'A' });
    expect(Math.abs(b.overlaps[0].overlapHa / strip - 1)).toBeLessThan(0.01);

    const res = await get(`/fields/${a.id}/overlaps`);
    expect(res.statusCode).toBe(200);
    const [overlap] = res.json().features;
    expect(overlap.id).toBe(b.id);
    expect(overlap.geometry.type).toBe('MultiPolygon');
    expect(overlap.properties.overlapHa).toBe(b.overlaps[0].overlapHa); // the same from both sides
    expect(overlap.properties.percentOfThis).toBeCloseTo((100 * strip) / a.properties.areaHa, 0);
  });

  it('a GPS-noise sliver along the boundary is not an overlap', async () => {
    await post('A', A);
    const b = await post('B', rect(+(34.56 - east(0.5)).toFixed(6), 49.59, 34.57, 49.6)); // 0.5 m x 1.1 km ≈ 550 m²

    expect(b.overlaps).toEqual([]);
  });

  it('a field inside another one is covered 100 %', async () => {
    const a = await post('A', A);
    const inner = await post('inner', rect(34.552, 49.592, 34.554, 49.594));

    const [overlap] = (await get(`/fields/${a.id}/overlaps`)).json().features;

    expect(overlap.id).toBe(inner.id);
    expect(overlap.properties.percentOfOther).toBe(100);
    expect(overlap.properties.overlapHa).toBe(inner.properties.areaHa);
  });

  it("ignores another organisation's fields and answers 404 for them", async () => {
    const a = await post('A', A);
    const theirs = await post('theirs', A, otherOrg);

    expect((await get(`/fields/${a.id}/overlaps`)).json().features).toEqual([]);
    expect((await get(`/fields/${theirs.id}/overlaps`)).statusCode).toBe(404);
  });

  it('the report lists every overlapping pair once, biggest first', async () => {
    const a = await post('A', A);
    const b = await post('B', rect(+(34.56 - east(20)).toFixed(6), 49.59, 34.57, 49.6)); // 20 m into A
    const c = await post('C', rect(+(34.57 - east(50)).toFixed(6), 49.59, 34.58, 49.6)); // 50 m into B
    await post('D', rect(34.6, 49.59, 34.61, 49.6)); // apart

    const res = await get('/fields/overlaps');

    expect(res.statusCode).toBe(200);
    const pairs = res.json().features.map((f: { properties: { a: { id: string }; b: { id: string } } }) =>
      [f.properties.a.id, f.properties.b.id].sort());
    expect(pairs).toEqual([[b.id, c.id].sort(), [a.id, b.id].sort()]); // B–C (50 m) before A–B (20 m), no B–A
    expect(res.json().truncated).toBe(false);
  });
});
