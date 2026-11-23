import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { dbOptions } from './db-options';

// variables already set in the environment win over .env (tests pass DB_NAME)
config({ quiet: true });

/** Read by the TypeORM CLI: `npm run migration:run`. */
export default new DataSource(dbOptions());
