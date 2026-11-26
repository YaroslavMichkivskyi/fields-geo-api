import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { MAX_IMPORT } from '../src/fields/import.schema';
import { createTestApp } from './app';

type Ring = number[][];

const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const feature = (name: string | undefined, rings: Ring[]) => ({
  type: 'Feature',
  properties: name === undefined ? {} : { name },
  geometry: { type: 'Polygon', coordinates: rings },
});
/** a round field of 64 vertices, ~1 ha per 0.0006° of radius… roughly; just a realistic boundary */
const circle = (lng: number, lat: number, r = 0.002, n = 64): Ring => {
  const ring = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [+(lng + r * Math.cos(a)).toFixed(6), +(lat + r * 0.65 * Math.sin(a)).toFixed(6)];
  });
  return [...ring, ring[0]];
};

const GOOD = feature('good', [rect(34.55, 49.59, 34.56, 49.6)]);
const BOW_TIE = feature('bow tie', [[[34.57, 49.59], [34.58, 49.6], [34.58, 49.59], [34.57, 49.6], [34.57, 49.59]]]);
const HOLE_OUTSIDE = feature('hole outside', [rect(34.6, 49.59, 34.61, 49.6), rect(34.62, 49.59, 34.625, 49.595)]);
const NO_NAME = feature(undefined, [rect(34.63, 49.59, 34.64, 49.6)]);
const SWAPPED = feature('swapped', [[[49.59, 34.65], [49.59, 34.66], [49.6, 34.66], [49.6, 34.65], [49.59, 34.65]]]);

describe('bulk import (M9)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;

  const upload = (features: unknown[], query = '') =>
    app.inject({
      method: 'POST',
      url: `/fields/import${query}`,
      headers: { 'x-org-id': org },
      payload: { type: 'FeatureCollection', features },
    });
  const count = async () => (await db.query('SELECT count(*)::int AS n FROM fields WHERE org_id = $1', [org]))[0].n;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name = 'test import'`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test import') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM soil_samples WHERE org_id = $1', [org]);
    await db.query('DELETE FROM fields WHERE org_id = $1', [org]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id = $1', [org]);
    await app.close();
  });

  it('partial: imports the valid Features and reports every other one with its index and reason', async () => {
    const res = await upload([GOOD, BOW_TIE, HOLE_OUTSIDE, NO_NAME, SWAPPED]);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ mode: 'partial', received: 5, imported: 2, failed: 3 });
    expect(body.fields.map((f: { index: number; name: string }) => [f.index, f.name])).toEqual([[0, 'good'], [1, 'bow tie']]);
    expect(body.fields[1].warnings.join()).toMatch(/repaired into 2 part/);
    expect(body.errors.map((e: { index: number; stage: string; name: string | null }) => [e.index, e.stage, e.name])).toEqual([
      [2, 'geometry', 'hole outside'],
      [3, 'schema', null],
      [4, 'schema', 'swapped'],
    ]);
    expect(body.errors[0].messages.join()).toMatch(/Hole lies outside shell/);
    expect(body.errors[1].messages.join()).toMatch(/properties\.name/);
    expect(body.errors[2].messages.join()).toMatch(/swapped/);
    expect(await count()).toBe(2);

    // the stored fields are ordinary fields: readable with their measurements
    const stored = (await app.inject({ method: 'GET', url: `/fields/${body.fields[0].id}`, headers: { 'x-org-id': org } })).json();
    expect(stored.properties.areaHa).toBeGreaterThan(70);
  });

  it('atomic: one bad Feature rejects the file, nothing is stored, all errors are listed', async () => {
    const res = await upload([GOOD, HOLE_OUTSIDE, NO_NAME], '?mode=atomic');

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ mode: 'atomic', received: 3, imported: 0, failed: 2 });
    expect(await count()).toBe(0);
  });

  it('atomic: a clean file is imported whole', async () => {
    const res = await upload([GOOD, BOW_TIE], '?mode=atomic');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imported: 2, failed: 0 });
  });

  it('nothing valid → 422, envelope errors → 400', async () => {
    expect((await upload([HOLE_OUTSIDE, NO_NAME])).statusCode).toBe(422);
    expect((await upload([])).statusCode).toBe(400);
    expect((await upload([GOOD], '?mode=sometimes')).statusCode).toBe(400);
    const notACollection = await app.inject({
      method: 'POST', url: '/fields/import', headers: { 'x-org-id': org }, payload: GOOD,
    });
    expect(notACollection.statusCode).toBe(400);
  });

  it('adopts the soil samples taken inside the imported fields', async () => {
    await app.inject({
      method: 'POST', url: '/soil-samples', headers: { 'x-org-id': org },
      payload: { type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [34.555, 49.595] }, properties: { takenAt: '2026-04-01T08:00:00Z' } },
      ] },
    });

    expect((await upload([GOOD])).json().adoptedSamples).toBe(1);
  });

  it(`imports ${MAX_IMPORT} fields in one request (several MB of GeoJSON)`, async () => {
    const features = Array.from({ length: MAX_IMPORT }, (_, i) =>
      feature(`bulk ${i}`, [circle(32.5 + (i % 100) * 0.03, 48.8 + Math.floor(i / 100) * 0.03)]),
    );
    const bytes = JSON.stringify({ type: 'FeatureCollection', features }).length;

    const started = Date.now();
    const res = await upload(features);
    const ms = Date.now() - started;

    expect(bytes).toBeGreaterThan(1024 * 1024); // over Fastify's default body limit
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imported: MAX_IMPORT, failed: 0 });
    expect(await count()).toBe(MAX_IMPORT);
    console.log(`import of ${MAX_IMPORT} fields, ${(bytes / 1024 / 1024).toFixed(1)} MB: ${ms} ms`);

    expect((await upload([...features, GOOD])).statusCode).toBe(400); // one over the limit
  }, 60_000);
});
