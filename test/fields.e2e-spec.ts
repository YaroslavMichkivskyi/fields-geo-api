import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { createTestApp } from './app';

/**
 * A ~25 ha field near Poltava, [lng, lat], exterior ring counter-clockwise
 * and closed (the last position repeats the first).
 */
const POLTAVA_FIELD = [
  [
    [34.55, 49.59],
    [34.559, 49.59],
    [34.559, 49.5935],
    [34.55, 49.5935],
    [34.55, 49.59],
  ],
];

const feature = (geometry: unknown, properties: object = { name: 'North field' }) => ({
  type: 'Feature',
  geometry,
  properties,
});

describe('fields: GeoJSON in / out', () => {
  let app: NestFastifyApplication;
  let db: DataSource;
  let orgA: string;
  let orgB: string;

  const post = (body: unknown, org = orgA, contentType = 'application/json') =>
    app.inject({
      method: 'POST',
      url: '/fields',
      headers: { 'x-org-id': org, 'content-type': contentType },
      payload: JSON.stringify(body),
    });
  const get = (url: string, org = orgA) =>
    app.inject({ method: 'GET', url, headers: { 'x-org-id': org } });

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    await db.query(`DELETE FROM organizations WHERE name LIKE 'test %'`);
    [{ id: orgA }, { id: orgB }] = await db.query(
      `INSERT INTO organizations (name) VALUES ('test A'), ('test B') RETURNING id`,
    );
  });

  beforeEach(async () => {
    await db.query('DELETE FROM fields WHERE org_id = ANY($1)', [[orgA, orgB]]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgA, orgB]]);
    await app.close();
  });

  describe('POST /fields', () => {
    it('stores a Polygon and returns it as a MultiPolygon Feature', async () => {
      const res = await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }, { name: 'North field', crop: 'wheat', season: 2026 }));

      expect(res.statusCode).toBe(201);
      expect(res.headers['content-type']).toMatch(/^application\/geo\+json/);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: [POLTAVA_FIELD] },
        properties: { name: 'North field', crop: 'wheat', season: 2026 },
      });
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('keeps a MultiPolygon with a hole as it is (round trip, 6 decimals)', async () => {
      const outer = [[34.6, 49.6], [34.61, 49.6], [34.61, 49.61], [34.6, 49.61], [34.6, 49.6]];
      const hole = [[34.603, 49.603], [34.603, 49.605], [34.605, 49.605], [34.605, 49.603], [34.603, 49.603]];
      const second = [[[34.123456, 49.7], [34.13, 49.7], [34.13, 49.71], [34.123456, 49.7]]];
      const geometry = { type: 'MultiPolygon', coordinates: [[outer, hole], second] };

      const res = await post(feature(geometry));

      expect(res.statusCode).toBe(201);
      expect(res.json().geometry).toEqual(geometry);
    });

    it('rounds coordinates to 6 decimals (~11 cm)', async () => {
      const precise = [[[34.551234567, 49.59], [34.559, 49.59], [34.559, 49.5935], [34.551234567, 49.59]]];

      const res = await post(feature({ type: 'Polygon', coordinates: precise }));

      expect(res.json().geometry.coordinates[0][0][0]).toEqual([34.551235, 49.59]);
    });

    it('accepts the application/geo+json media type', async () => {
      const res = await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }), orgA, 'application/geo+json');
      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['swapped [lat, lng]', { type: 'Polygon', coordinates: [POLTAVA_FIELD[0].map(([lng, lat]) => [lat, lng])] }, /swapped/],
      ['latitude beyond 90', { type: 'Polygon', coordinates: [[[34.5, 95], [34.6, 49.6], [34.6, 49.7], [34.5, 95]]] }, /latitude/],
      ['ring not closed', { type: 'Polygon', coordinates: [POLTAVA_FIELD[0].slice(0, 4)] }, /closed/],
      ['ring with 3 positions', { type: 'Polygon', coordinates: [[[34.5, 49.5], [34.6, 49.6], [34.5, 49.5]]] }, /at least 4/],
      ['a Point is not a field', { type: 'Point', coordinates: [34.55, 49.59] }, /Polygon or MultiPolygon/],
      ['coordinates as strings', { type: 'Polygon', coordinates: [[['34.5', '49.5']]] }, /number/],
    ])('400 for %s', async (_, geometry, message) => {
      const res = await post(feature(geometry));

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json().issues)).toMatch(message);
    });

    it('400 for a legacy "crs" member', async () => {
      const res = await post({
        ...feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }),
        crs: { type: 'name', properties: { name: 'EPSG:3857' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0]).toMatchObject({ path: 'crs' });
    });

    it('400 for a bare geometry instead of a Feature', async () => {
      const res = await post({ type: 'Polygon', coordinates: POLTAVA_FIELD });
      expect(res.statusCode).toBe(400);
    });

    it('400 without x-org-id, 404 for an unknown organisation', async () => {
      const body = feature({ type: 'Polygon', coordinates: POLTAVA_FIELD });

      const noHeader = await app.inject({ method: 'POST', url: '/fields', payload: body });
      const unknown = await post(body, '11111111-1111-1111-1111-111111111111');

      expect(noHeader.statusCode).toBe(400);
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe('GET /fields/:id and GET /fields', () => {
    it('reads one field back as a Feature', async () => {
      const { warnings, overlaps, adoptedSamples, ...created } = (await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }))).json();

      const res = await get(`/fields/${created.id}`);

      expect(warnings).toEqual([]);
      expect(overlaps).toEqual([]);
      expect(adoptedSamples).toBe(0);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(created);
    });

    it("hides another organisation's field (404, not 403)", async () => {
      const created = (await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }))).json();

      expect((await get(`/fields/${created.id}`, orgB)).statusCode).toBe(404);
      expect((await get('/fields/not-a-uuid')).statusCode).toBe(400);
    });

    it('lists the organisation fields as a FeatureCollection', async () => {
      await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }, { name: 'one' }));
      await post(feature({ type: 'Polygon', coordinates: POLTAVA_FIELD }, { name: 'two' }));

      const mine = (await get('/fields')).json();
      const theirs = (await get('/fields', orgB)).json();

      expect(mine.type).toBe('FeatureCollection');
      expect(mine.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(['one', 'two']);
      expect(theirs).toEqual({ type: 'FeatureCollection', features: [], truncated: false });
    });
  });
});
