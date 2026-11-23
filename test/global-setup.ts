import { execSync } from 'node:child_process';
import { config } from 'dotenv';

/** Brings the test database to the latest migration before any test runs. */
export default function globalSetup(): void {
  config({ quiet: true });
  execSync('npm run --silent migration:run', {
    stdio: 'inherit',
    env: { ...process.env, DB_NAME: process.env.DB_TEST_NAME ?? 'fields_test' },
  });
}
