import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { MAX_SAMPLES } from '../src/soil/soil.schema';
import { createTestApp } from './app';

type Ring = number[][];

/** counter-clockwise rectangle [w, s, e, n] */
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];

const A = rect(34.55, 49.59, 34.56, 49.6);

const sample = (lng: number, lat: number, props: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { takenAt: '2026-04-15T09:00:00Z', ...props },
});

describe('soil samples (M7)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;
  let otherOrg: string;

  const post = (url: string, payload: object, orgId = org) =>
    app.inject({ method: 'POST', url, headers: { 'x-org-id': orgId }, payload });
  const field = async (name: string, ring: Ring, orgId = org) =>
    (await post('/fields', { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } }, orgId)).json();
  const samples = (features: object[], orgId = org) => post('/soil-samples', { type: 'FeatureCollection', features }, orgId);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-org-id': org } });
  const fieldIds = (res: { json: () => { features: { properties: { fieldId: string | null } }[] } }) =>
    res.json().features.map((f) => f.properties.fieldId);

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name IN ('test soil', 'test soil other')`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test soil') RETURNING id`);
    [{ id: otherOrg }] = await db.query(`INSERT INTO organizations (name) VALUES ('test soil other') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM soil_samples WHERE org_id IN ($1, $2)', [org, otherOrg]);
    await db.query('DELETE FROM fields WHERE org_id IN ($1, $2)', [org, otherOrg]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id IN ($1, $2)', [org, otherOrg]);
    await app.close();
  });

  it('places each sample in the field that covers it, in the order sent', async () => {
    const a = await field('A', A);

    const res = await samples([
      sample(34.555, 49.595, { ph: 6.55 }), // inside
      sample(34.552, 49.59), // exactly on the south boundary
      sample(34.7, 49.7), // in no field
    ]);

    expect(res.statusCode).toBe(201);
    expect(fieldIds(res)).toEqual([a.id, a.id, null]);
    expect(res.json().unassigned).toBe(1);
    expect(res.json().features[0].properties).toMatchObject({ fieldName: 'A', ph: 6.6 }); // numeric(3,1)
  });

  it('ST_Covers counts a point on the boundary, ST_Contains does not', async () => {
    const [r] = await db.query(
      `WITH a AS (SELECT ST_GeomFromGeoJSON($1) AS g), p AS (SELECT ST_SetSRID(ST_MakePoint(34.552, 49.59), 4326) AS g)
       SELECT ST_Covers(a.g, p.g) AS covers, ST_Contains(a.g, p.g) AS contains FROM a, p`,
      [JSON.stringify({ type: 'Polygon', coordinates: [A], crs: { type: 'name', properties: { name: 'EPSG:4326' } } })],
    );

    expect(r).toEqual({ covers: true, contains: false });
  });

  it('a point covered by two fields goes to the one that has it inside, else to the older one', async () => {
    await field('A', A);
    const b = await field('B', rect(34.555, 49.59, 34.565, 49.6)); // overlaps A
    const d = await field('D', rect(34.6, 49.59, 34.61, 49.6));
    await field('E', rect(34.61, 49.59, 34.62, 49.6)); // shares D's east edge

    const res = await samples([
      sample(34.56, 49.595), // on A's edge, inside B
      sample(34.61, 49.595), // on the edge D and E share
    ]);

    expect(fieldIds(res)).toEqual([b.id, d.id]);
  });

  it('stats: aggregates of the samples in the field', async () => {
    const a = await field('A', A);
    const empty = await field('empty', rect(34.6, 49.59, 34.61, 49.6));
    await samples([
      sample(34.551, 49.591, { ph: 6.0, humus: 3.5, takenAt: '2026-04-01T08:00:00Z' }),
      sample(34.559, 49.599, { ph: 7.0, humus: 4.5, takenAt: '2026-04-03T08:00:00Z' }),
      sample(34.555, 49.595, { takenAt: '2026-04-02T08:00:00Z' }), // not analysed yet
    ]);

    const res = await get(`/fields/${a.id}/soil-stats`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      fieldId: a.id,
      samples: 3,
      ph: { avg: 6.5, min: 6, max: 7 },
      humus: { avg: 4, min: 3.5, max: 4.5 },
    });
    expect(new Date(res.json().takenFrom)).toEqual(new Date('2026-04-01T08:00:00Z'));
    expect(new Date(res.json().takenTo)).toEqual(new Date('2026-04-03T08:00:00Z'));
    expect(res.json().densityPer10Ha).toBeCloseTo((10 * 3) / a.properties.areaHa, 2);

    expect((await get(`/fields/${empty.id}/soil-stats`)).json()).toMatchObject({ samples: 0, ph: null, humus: null });
  });

  it('a field drawn later adopts the samples taken inside it, and only those without a field', async () => {
    const other = await field('other', rect(34.556, 49.59, 34.565, 49.6));
    await samples([
      sample(34.552, 49.595), // orphan, will be inside A
      sample(34.553, 49.596), // orphan, will be inside A
      sample(34.558, 49.595), // already in "other"; A will overlap it
      sample(34.7, 49.7), // stays an orphan
    ]);

    const a = await field('A', A);

    expect(a.adoptedSamples).toBe(2);
    expect((await get(`/fields/${a.id}/soil-stats`)).json().samples).toBe(2);
    expect((await get(`/fields/${other.id}/soil-stats`)).json().samples).toBe(1); // not stolen
  });

  it('lists samples in no field with the nearest field and the distance to it', async () => {
    await field('A', A);
    await field('far', rect(34.7, 49.59, 34.71, 49.6));
    await samples([sample(34.561, 49.595), sample(34.555, 49.595)]); // 0.001° east of A ≈ 72 m; inside A

    const res = await get('/soil-samples/unassigned');

    expect(res.statusCode).toBe(200);
    const [orphan, ...rest] = res.json().features;
    expect(rest).toEqual([]);
    expect(orphan.properties.nearestField.name).toBe('A');
    expect(orphan.properties.nearestField.distanceM).toBeGreaterThan(65);
    expect(orphan.properties.nearestField.distanceM).toBeLessThan(80);
  });

  it("never places a sample in another organisation's field, and answers 404 for its stats", async () => {
    const theirs = await field('theirs', A, otherOrg);

    expect(fieldIds(await samples([sample(34.555, 49.595)]))).toEqual([null]);
    expect((await get(`/fields/${theirs.id}/soil-stats`)).statusCode).toBe(404);
  });

  it.each([
    ['swapped lng / lat', [sample(49.595, 34.555)], /swapped/],
    ['pH 15', [sample(34.555, 49.595, { ph: 15 })], /14/],
    ['a date that is not ISO 8601', [sample(34.555, 49.595, { takenAt: '15.04.2026' })], /ISO 8601/],
    ['a polygon instead of a point', [{ ...sample(34.555, 49.595), geometry: { type: 'Polygon', coordinates: [A] } }], /Point/],
    ['no samples', [], /no samples/],
    [`more than ${MAX_SAMPLES}`, Array.from({ length: MAX_SAMPLES + 1 }, () => sample(34.555, 49.595)), /at most/],
  ])('400 for %s', async (_, features, message) => {
    const res = await samples(features);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(message);
  });
});
