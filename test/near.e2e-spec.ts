import { lineString, point } from '@turf/helpers';
import pointToLineDistance from '@turf/point-to-line-distance';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

type Ring = number[][];

/** counter-clockwise rectangle [w, s, e, n] */
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/** Where we stand: Poltava. */
const P = [34.55, 49.59];

/**
 * Small fields around P. A degree of longitude here is ~72 km, of latitude
 * ~111 km: "east" is further in degrees than "north" (0.05° vs 0.04°) but
 * nearer in metres (~3.6 km vs ~4.4 km).
 */
const FIELDS: Record<string, Ring> = {
  home: rect(34.549, 49.589, 34.551, 49.591), // P is inside
  east: rect(34.6, 49.589, 34.602, 49.591),
  north: rect(34.549, 49.63, 34.551, 49.632),
  far: rect(34.8, 49.59, 34.802, 49.592), // ~18 km
};

describe('fields near a point (M6)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;
  let otherOrg: string;

  const post = (url: string, payload: object, orgId = org) =>
    app.inject({ method: 'POST', url, headers: { 'x-org-id': orgId }, payload });
  const near = (query: string) =>
    app.inject({ method: 'GET', url: `/fields/near?${query}`, headers: { 'x-org-id': org } });
  const names = (res: { json: () => { features: { properties: { name: string } }[] } }) =>
    res.json().features.map((f) => f.properties.name);

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name IN ('test near', 'test near other')`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test near') RETURNING id`);
    [{ id: otherOrg }] = await db.query(`INSERT INTO organizations (name) VALUES ('test near other') RETURNING id`);
    for (const [name, ring] of Object.entries(FIELDS)) {
      await post('/fields', { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id IN ($1, $2)', [org, otherOrg]);
    await app.close();
  });

  it('radius: every field within it, nearest first, 0 m when standing inside', async () => {
    const res = await near(`lng=${P[0]}&lat=${P[1]}&radius_km=5`);

    expect(res.statusCode).toBe(200);
    expect(names(res)).toEqual(['home', 'east', 'north']);
    expect(res.json().features[0].properties.distanceM).toBe(0);
    expect(res.json().truncated).toBe(false);
  });

  it('nearest N ranks by metres, not by degrees', async () => {
    expect(names(await near(`lng=${P[0]}&lat=${P[1]}&limit=2`))).toEqual(['home', 'east']);

    // the same KNN on geometry (degrees) gets it wrong: 0.04° north < 0.05° east
    const byDegrees = await db.query(
      `SELECT name FROM fields WHERE org_id = $1
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint($2, $3), 4326) LIMIT 2`,
      [org, ...P],
    );
    expect(byDegrees.map((r: { name: string }) => r.name)).toEqual(['home', 'north']);
  });

  it('distances match an independent computation (Turf, point to boundary)', async () => {
    const res = await near(`lng=${P[0]}&lat=${P[1]}&limit=10`);

    for (const f of res.json().features) {
      if (f.properties.name === 'home') continue; // inside: 0
      const turf = pointToLineDistance(point(P), lineString(FIELDS[f.properties.name]), { units: 'meters' });
      // Turf: a sphere; PostGIS: the WGS 84 spheroid — a few tenths of a percent apart
      expect(Math.abs(f.properties.distanceM / turf - 1)).toBeLessThan(0.005);
    }
    expect(names(res)).toEqual(['home', 'east', 'north', 'far']);
  });

  it('radius and limit together: the N nearest within the radius', async () => {
    expect(names(await near(`lng=34.53&lat=${P[1]}&radius_km=20&limit=1`))).toEqual(['home']);
    expect(names(await near(`lng=34.9&lat=49.7&radius_km=1`))).toEqual([]);
  });

  it('from a warehouse of the organisation', async () => {
    const created = await post('/warehouses', {
      type: 'Feature',
      properties: { name: 'Elevator' },
      geometry: { type: 'Point', coordinates: [34.601, 49.59] }, // inside "east"
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().geometry).toEqual({ type: 'Point', coordinates: [34.601, 49.59] });

    expect(names(await near(`warehouse=${created.json().id}&limit=2`))).toEqual(['east', 'home']);

    const theirs = await post(
      '/warehouses',
      { type: 'Feature', properties: { name: 'theirs' }, geometry: { type: 'Point', coordinates: P } },
      otherOrg,
    );
    expect((await near(`warehouse=${theirs.json().id}&limit=1`)).statusCode).toBe(404);
  });

  it('rejects a warehouse outside the service area (swapped lng / lat)', async () => {
    const res = await post('/warehouses', {
      type: 'Feature',
      properties: { name: 'swapped' },
      geometry: { type: 'Point', coordinates: [49.59, 34.55] },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/swapped/);
  });

  it.each([
    ['neither radius nor limit', 'lng=34.55&lat=49.59', /radius_km, limit/],
    ['lng without lat', 'lng=34.55&limit=1', /together/],
    ['a point and a warehouse', 'lng=34.55&lat=49.59&warehouse=00000000-0000-0000-0000-000000000001&limit=1', /either/],
    ['swapped lng / lat', 'lng=49.59&lat=34.55&limit=1', /swapped/],
    ['radius of 500 km', 'lng=34.55&lat=49.59&radius_km=500', /200/],
    ['limit of 1000', 'lng=34.55&lat=49.59&limit=1000', /100/],
  ])('400 for %s', async (_, query, message) => {
    const res = await near(query);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(message);
  });
});
