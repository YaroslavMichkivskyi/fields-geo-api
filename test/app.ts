import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp, createAdapter } from '../src/app.setup';

/** The real app on the test database, ready for Fastify `inject` (no port opened). */
export async function createTestApp(): Promise<{ app: NestFastifyApplication; db: DataSource }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, db: app.get(DataSource) };
}
