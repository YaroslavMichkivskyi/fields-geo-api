import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

/**
 * One place that turns environment variables into TypeORM options, shared by
 * the Nest app and the migration CLI (`src/database/data-source.ts`).
 */
export function dbOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5433),
    username: env.DB_USER ?? 'fields',
    password: env.DB_PASSWORD ?? 'fields',
    database: env.DB_NAME ?? 'fields',
    // the schema changes only through migrations, never from entity classes
    synchronize: false,
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  };
}
