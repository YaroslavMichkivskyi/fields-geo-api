import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { MAX_POINTS } from '../src/geo/geojson.schema';
import { createTestApp } from './app';

type Ring = number[][];

/** A ~0.7 x 1.1 km square near Poltava, counter-clockwise. */
const SQUARE: Ring = [[34.55, 49.59], [34.56, 49.59], [34.56, 49.60], [34.55, 49.60], [34.55, 49.59]];

describe('boundary validation and repair (M2)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;

  const create = (rings: Ring[]) =>
    app.inject({
      method: 'POST',
      url: '/fields',
      headers: { 'x-org-id': org },
      payload: { type: 'Feature', properties: { name: 'f' }, geometry: { type: 'Polygon', coordinates: rings } },
    });

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name = 'test boundary'`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test boundary') RETURNING id`);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id = $1', [org]);
    await app.close();
  });

  it('stores a valid boundary as is, with no warnings', async () => {
    const res = await create([SQUARE]);

    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual([]);
    expect(res.json().geometry.coordinates).toEqual([[SQUARE]]);
  });

  it('repairs a self-intersecting "bow tie" into its two triangles', async () => {
    // corners visited in the wrong order: the outline crosses itself in the middle
    const bowTie: Ring = [[34.55, 49.59], [34.56, 49.60], [34.56, 49.59], [34.55, 49.60], [34.55, 49.59]];

    const res = await create([bowTie]);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.warnings).toEqual([expect.stringMatching(/Self-intersection.*repaired into 2 part/)]);
    expect(body.geometry.type).toBe('MultiPolygon');
    expect(body.geometry.coordinates).toHaveLength(2);
  });

  it('cuts off a spike that goes out and back along the same line', async () => {
    const spike: Ring = [[34.55, 49.59], [34.56, 49.59], [34.56, 49.60], [34.57, 49.60], [34.56, 49.60], [34.55, 49.60], [34.55, 49.59]];

    const res = await create([spike]);

    expect(res.statusCode).toBe(201);
    const [[ring]] = res.json().geometry.coordinates;
    expect(ring).not.toContainEqual([34.57, 49.60]);
  });

  it('drops repeated points and says so', async () => {
    const doubled: Ring = [SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[2], SQUARE[3], SQUARE[4]];

    const res = await create([doubled]);

    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual(['removed 1 repeated point(s)']);
    expect(res.json().geometry.coordinates).toEqual([[SQUARE]]);
  });

  it('turns a clockwise outer ring counter-clockwise (RFC 7946 right-hand rule)', async () => {
    const clockwise = [...SQUARE].reverse();

    const res = await create([clockwise]);

    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual([]); // orientation is normalised silently
    expect(res.json().geometry.coordinates).toEqual([[SQUARE]]);
  });

  it('422 for a hole outside the shell (repairing it would add land)', async () => {
    const hole: Ring = [[34.57, 49.59], [34.57, 49.595], [34.575, 49.595], [34.575, 49.59], [34.57, 49.59]];

    const res = await create([SQUARE, hole]);

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/Hole lies outside shell/);
  });

  it('422 for points on one line: nothing is enclosed', async () => {
    const line: Ring = [[34.55, 49.59], [34.56, 49.59], [34.57, 49.59], [34.55, 49.59]];

    const res = await create([line]);

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/encloses no area/);
  });

  it('422 for a field smaller than 100 m²', async () => {
    // ~7 x 11 m
    const tiny: Ring = [[34.55, 49.59], [34.5501, 49.59], [34.5501, 49.5901], [34.55, 49.5901], [34.55, 49.59]];

    const res = await create([tiny]);

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/below the minimum/);
  });

  it(`400 for more than ${MAX_POINTS} points`, async () => {
    const many: Ring = Array.from({ length: MAX_POINTS + 1 }, (_, i) => {
      const a = (2 * Math.PI * i) / MAX_POINTS;
      return [34.55 + 0.01 * Math.cos(a), 49.59 + 0.01 * Math.sin(a)];
    });
    many.push(many[0]);

    const res = await create([many]);

    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toMatch(/at most/);
  });

  it('the database itself refuses an invalid boundary (CHECK constraint)', async () => {
    const insert = db.query(
      `INSERT INTO fields (org_id, name, geom)
       VALUES ($1, 'bypass', ST_Multi('SRID=4326;POLYGON((34.55 49.59,34.56 49.60,34.56 49.59,34.55 49.60,34.55 49.59))'::geometry))`,
      [org],
    );

    await expect(insert).rejects.toMatchObject({ code: '23514', constraint: 'fields_geom_valid' });
  });
});
