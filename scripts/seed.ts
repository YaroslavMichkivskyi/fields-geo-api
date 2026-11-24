/**
 * Synthetic fields for the "Demo farm" organisation across the Poltava region:
 * round-ish fields of 7–110 ha (65 vertices each), many of them overlapping.
 * Enough rows to make the spatial index matter.
 *
 *   npm run seed            # 50 000 fields
 *   npm run seed -- 5000    # another count
 *
 * Re-running replaces the previous seed; hand-made fields are kept.
 */
import { config } from 'dotenv';
import { Client } from 'pg';
import { DEMO_ORG_ID } from '../src/database/migrations/1795400001000-CreateFields';

config({ quiet: true });

const count = Number(process.argv[2] ?? 50_000);

async function main(): Promise<void> {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  const started = Date.now();

  await db.query('BEGIN');
  await db.query(`DELETE FROM fields WHERE org_id = $1 AND name LIKE 'seed #%'`, [DEMO_ORG_ID]);
  await db.query('SELECT setseed(0.42)'); // the same "random" fields on every run
  await db.query(
    `INSERT INTO fields (org_id, name, crop, season, geom)
     SELECT $1,
            'seed #' || i,
            (ARRAY['wheat', 'sunflower', 'corn', 'soy', 'rapeseed', 'barley'])[1 + i % 6],
            2026,
            -- a circle of 150–600 m radius around a random point: buffer on geography
            -- takes metres; quad_segs=16 gives 64 segments, a realistic vertex count
            ST_Multi(ST_ForcePolygonCCW(
              ST_Buffer(
                ST_SetSRID(ST_MakePoint(32.0 + random() * 3.6, 48.7 + random() * 1.9), 4326)::geography,
                150 + random() * 450,
                'quad_segs=16')::geometry))
       FROM generate_series(1, $2) AS i`,
    [DEMO_ORG_ID, count],
  );
  await db.query('COMMIT');
  // planner statistics: without them it guesses row counts and may skip the index
  await db.query('ANALYZE fields');

  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS fields, round(sum(area_ha)) AS ha FROM fields WHERE org_id = $1`,
    [DEMO_ORG_ID],
  );
  console.log(`seeded ${count} fields in ${Date.now() - started} ms; Demo farm now has ${r.fields} fields, ${r.ha} ha`);
  await db.end();
}

void main();
