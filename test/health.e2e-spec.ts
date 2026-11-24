import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './app';

describe('GET /health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the database and the PostGIS version', async () => {
    // Fastify inject: no real port, no supertest
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.postgis).toMatch(/^POSTGIS="3\.5/);
  });
});
