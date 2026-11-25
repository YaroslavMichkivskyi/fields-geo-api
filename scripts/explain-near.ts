/**
 * EXPLAIN ANALYZE of "fields within 5 km of a point" and "the 5 nearest
 * fields", written several ways, printed as markdown for docs/explain.md.
 * Run after `npm run seed`.
 *
 *   npm run explain:near
 *
 * The variants without the geography index and with a stored geography column
 * are run inside a transaction that is rolled back (dev database only: the
 * DDL locks the table).
 */
import { config } from 'dotenv';
import { Client } from 'pg';
import { DEMO_ORG_ID } from '../src/database/migrations/1795400001000-CreateFields';

config({ quiet: true });

const HERE = 'ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography';
const PARAMS = [DEMO_ORG_ID, 34.55, 49.59];

const DISTANCE_LT = `SELECT f.id FROM fields f
 WHERE f.org_id = $1 AND ST_Distance(f.geom::geography, ${HERE}) < 5000`;
const DWITHIN = `SELECT f.id FROM fields f
 WHERE f.org_id = $1 AND ST_DWithin(f.geom::geography, ${HERE}, 5000)`;
const DWITHIN_COLUMN = `SELECT f.id FROM fields f
 WHERE f.org_id = $1 AND ST_DWithin(f.geog, ${HERE}, 5000)`;
const KNN = `SELECT f.id FROM fields f
 WHERE f.org_id = $1
 ORDER BY f.geom::geography <-> ${HERE} LIMIT 5`;

async function explain(db: Client, sql: string): Promise<string> {
  await db.query(sql, PARAMS); // warm the cache
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`, PARAMS);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

const size = async (db: Client, what: string) =>
  (await db.query(`SELECT pg_size_pretty(${what}) AS s`)).rows[0].s as string;

function print(title: string, sql: string, plan: string): void {
  console.log(`### ${title}\n\n\`\`\`sql\n${sql}\n\`\`\`\n\n\`\`\`\n${plan}\n\`\`\`\n`);
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
  console.log(`Table \`fields\`: ${n} rows, point (34.55, 49.59), radius 5 km.\n`);

  print('ST_Distance < 5000', DISTANCE_LT, await explain(db, DISTANCE_LT));

  await db.query('BEGIN');
  await db.query('DROP INDEX fields_geog_gist');
  print('ST_DWithin, only the geometry index', DWITHIN, await explain(db, DWITHIN));
  await db.query('ROLLBACK');

  print('ST_DWithin, expression index fields_geog_gist', DWITHIN, await explain(db, DWITHIN));
  print('KNN: the 5 nearest', KNN, await explain(db, KNN));

  const table = await size(db, `pg_table_size('fields')`);
  const exprIndex = await size(db, `pg_relation_size('fields_geog_gist')`);
  await db.query('BEGIN');
  await db.query('DROP INDEX fields_geog_gist');
  await db.query(`ALTER TABLE fields ADD COLUMN geog geography(MultiPolygon, 4326)
                    GENERATED ALWAYS AS (geom::geography) STORED`);
  await db.query('CREATE INDEX fields_geog_col_gist ON fields USING GIST (geog)');
  await db.query('ANALYZE fields');
  print('ST_DWithin on a stored geography column', DWITHIN_COLUMN, await explain(db, DWITHIN_COLUMN));
  const tableWithColumn = await size(db, `pg_table_size('fields')`);
  const columnIndex = await size(db, `pg_relation_size('fields_geog_col_gist')`);
  await db.query('ROLLBACK');
  await db.query('ANALYZE fields');

  console.log('| | table | geography index |\n|---|---|---|');
  console.log(`| expression index | ${table} | ${exprIndex} |`);
  console.log(`| stored column + index | ${tableWithColumn} | ${columnIndex} |`);
  await db.end();
}

void main();
