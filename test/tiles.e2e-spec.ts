import { VectorTile } from '@mapbox/vector-tile';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Pbf from 'pbf';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

type Ring = number[][];
const rect = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];

/** The tile containing a position (XYZ scheme), as a map client computes it. */
function tileOf(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}
/** Longitude of the western edge of tile column x at zoom z. */
const tileWest = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

const decode = (body: Buffer) => new VectorTile(new Pbf(body));

/** A: ~720 x 1110 m, ~80 ha */
const A = rect(34.55, 49.59, 34.56, 49.6);

describe('vector tiles (M10)', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let org: string;
  let otherOrg: string;

  const field = (ring: Ring, name = 'A', orgId = org) =>
    app.inject({
      method: 'POST',
      url: '/fields',
      headers: { 'x-org-id': orgId },
      payload: { type: 'Feature', properties: { name, crop: 'wheat' }, geometry: { type: 'Polygon', coordinates: [ring] } },
    });
  const tile = (z: number, x: number, y: number, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/tiles/${z}/${x}/${y}.mvt`, headers: { 'x-org-id': org, ...headers } });
  const tileAt = (lng: number, lat: number, z: number) => {
    const { x, y } = tileOf(lng, lat, z);
    return tile(z, x, y);
  };

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name IN ('test tiles', 'test tiles other')`);
    [{ id: org }] = await db.query(`INSERT INTO organizations (name) VALUES ('test tiles') RETURNING id`);
    [{ id: otherOrg }] = await db.query(`INSERT INTO organizations (name) VALUES ('test tiles other') RETURNING id`);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM fields WHERE org_id IN ($1, $2)', [org, otherOrg]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id IN ($1, $2)', [org, otherOrg]);
    await app.close();
  });

  it('a field tile at zoom 14 is MVT with the field polygon and its properties', async () => {
    const { id, properties } = (await field(A)).json();
    const res = await tileAt(34.555, 49.595, 14);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.mapbox-vector-tile');
    expect(res.headers['cache-control']).toBe('private, max-age=60');

    const vt = decode(res.rawPayload);
    expect(Object.keys(vt.layers)).toEqual(['fields']);
    const layer = vt.layers.fields;
    expect(layer.extent).toBe(4096);
    expect(layer.length).toBe(1);
    const f = layer.feature(0);
    expect(f.type).toBe(3); // polygon
    expect(f.properties).toMatchObject({ id, name: 'A', crop: 'wheat' });
    expect(f.properties.areaHa).toBe(properties.areaHa);
  });

  it('decoded back to longitude / latitude, the outline is the stored one within a tile grid cell', async () => {
    await field(A);
    // z 16: the field (0.01 deg) spans several tiles; at z 13 it is whole in one
    const z = 13;
    const { x, y } = tileOf(34.555, 49.595, z);
    const geo = decode((await tile(z, x, y)).rawPayload).layers.fields.feature(0).toGeoJSON(x, y, z);
    const ring = (geo.geometry as { coordinates: number[][][] }).coordinates[0];
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    // one cell of the 4096 grid at z 13: 360 / 2^13 / 4096 ~ 1.1e-5 deg of longitude
    const cell = 360 / 2 ** z / 4096;
    expect(Math.min(...lngs)).toBeCloseTo(34.55, 4);
    expect(Math.abs(Math.min(...lngs) - 34.55)).toBeLessThan(cell);
    expect(Math.abs(Math.max(...lngs) - 34.56)).toBeLessThan(cell);
    expect(Math.abs(Math.min(...lats) - 49.59)).toBeLessThan(cell);
    expect(Math.abs(Math.max(...lats) - 49.6)).toBeLessThan(cell);
  });

  it('a field across a tile edge is in both tiles, clipped to the tile plus its 64-unit buffer', async () => {
    const z = 15;
    const { x } = tileOf(34.555, 49.595, z);
    const edge = tileWest(x + 1, z); // the border between columns x and x + 1
    await field(rect(edge - 0.003, 49.594, edge + 0.003, 49.596), 'across');

    for (const lng of [edge - 0.001, edge + 0.001]) {
      const { x: tx, y: ty } = tileOf(lng, 49.595, z);
      const f = decode((await tile(z, tx, ty)).rawPayload).layers.fields.feature(0);
      expect(f.properties.name).toBe('across');
      const xs = f.loadGeometry().flat().map((p) => p.x);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-64);
      expect(Math.max(...xs)).toBeLessThanOrEqual(4096 + 64);
    }
  });

  it('below zoom 10 the tile has clusters: field counts and hectares, each field counted once', async () => {
    const created = [
      await field(rect(34.55, 49.59, 34.56, 49.6), 'A'),
      await field(rect(34.561, 49.59, 34.57, 49.6), 'B'),
      await field(rect(34.55, 49.601, 34.56, 49.61), 'C'),
    ];
    const totalHa = created.reduce((s, r) => s + r.json().properties.areaHa, 0);

    const res = await tileAt(34.56, 49.6, 8);
    expect(res.statusCode).toBe(200);
    const vt = decode(res.rawPayload);
    expect(Object.keys(vt.layers)).toEqual(['clusters']);
    const clusters = Array.from({ length: vt.layers.clusters.length }, (_, i) => vt.layers.clusters.feature(i));
    expect(clusters.every((c) => c.type === 1)).toBe(true); // points
    expect(clusters.reduce((s, c) => s + Number(c.properties.count), 0)).toBe(3);
    expect(clusters.reduce((s, c) => s + Number(c.properties.areaHa), 0)).toBeCloseTo(totalHa, 0);

    // the same fields over the 4 tiles of zoom 9 inside that z 8 tile: still 3 in total
    const { x, y } = tileOf(34.56, 49.6, 8);
    let total = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const r = await tile(9, 2 * x + dx, 2 * y + dy);
      if (r.statusCode === 204) continue;
      const l = decode(r.rawPayload).layers.clusters;
      for (let i = 0; i < l.length; i++) total += Number(l.feature(i).properties.count);
    }
    expect(total).toBe(3);
  });

  it('an empty tile is 204; fields of another organisation are not in the tile', async () => {
    await field(A, 'theirs', otherOrg);
    const res = await tileAt(34.555, 49.595, 14);
    expect(res.statusCode).toBe(204);
    expect(res.rawPayload.length).toBe(0);
  });

  it('If-None-Match with the ETag answers 304; a new field changes the ETag', async () => {
    await field(A);
    const { x, y } = tileOf(34.555, 49.595, 12);
    const first = await tile(12, x, y);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await tile(12, x, y, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);

    await field(rect(34.57, 49.59, 34.575, 49.595), 'new');
    const changed = await tile(12, x, y, { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('rejects a tile outside the zoom pyramid and a request without an organisation', async () => {
    expect((await tile(23, 0, 0)).statusCode).toBe(400);
    expect((await tile(2, 4, 0)).statusCode).toBe(400); // zoom 2 has x 0..3
    expect((await tile(2, 0, -1)).statusCode).toBe(400);
    expect((await tile(2, 1.5 as unknown as number, 0)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/tiles/14/0/0.mvt' })).statusCode).toBe(400);
  });

  it('serves the MapLibre page', async () => {
    const res = await app.inject({ method: 'GET', url: '/map' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain("/tiles/{z}/{x}/{y}.mvt");
  });
});
