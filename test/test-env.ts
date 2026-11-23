import { config } from 'dotenv';

// every test talks to the test database, never to the dev one
config({ quiet: true });
process.env.DB_NAME = process.env.DB_TEST_NAME ?? 'fields_test';
