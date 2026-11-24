/**
 * EXPLAIN ANALYZE of the viewport filter with and without the GiST index,
 * printed as markdown for docs/explain.md. Run after `npm run seed`.
 *
 *   npm run explain:viewport
 *
 * "Without" drops the index inside a transaction and rolls it back, so the
 * index is never really lost (dev database only: DROP INDEX locks the table).
 */
import { config } from 'dotenv';
import { Client } from 'pg';
import { DEMO_ORG_ID } from '../src/database/migrations/1795400001000-CreateFields';

config({ quiet: true });

const VIEWS: { name: string; bbox: number[] }[] = [
  { name: 'town-sized viewport (~6 x 6 km)', bbox: [34.50, 49.56, 34.58, 49.61] },
  { name: 'the whole region', bbox: [31.9, 48.6, 35.7, 50.7] },
];

const QUERY = `
  SELECT f.id
    FROM fields f
   WHERE f.org_id = $1
     AND f.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)`;

async function explain(db: Client, bbox: number[]): Promise<string> {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${QUERY}`, [DEMO_ORG_ID, ...bbox]);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function main(): Promise<void> {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM fields');
  console.log(`Table \`fields\`: ${n} rows.\n\n\`\`\`sql${QUERY}\n\`\`\`\n`);

  for (const { name, bbox } of VIEWS) {
    await explain(db, bbox); // warm the cache so both runs read from memory
    await db.query('BEGIN');
    await db.query('DROP INDEX fields_geom_gist');
    const without = await explain(db, bbox);
    await db.query('ROLLBACK');
    const withIndex = await explain(db, bbox);

    console.log(`### ${name}: bbox ${bbox.join(', ')}\n`);
    console.log(`Without the GiST index:\n\n\`\`\`\n${without}\n\`\`\`\n`);
    console.log(`With \`fields_geom_gist\`:\n\n\`\`\`\n${withIndex}\n\`\`\`\n`);
  }
  await db.end();
}

void main();
