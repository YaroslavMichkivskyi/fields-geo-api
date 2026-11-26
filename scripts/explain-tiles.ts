/**
 * Size and time of one vector tile per zoom, as polygons and as clusters,
 * printed as markdown for docs/explain.md; then the plan of a street-level
 * tile. Run after `npm run seed`.
 *
 *   npm run explain:tiles
 */
import { gzipSync } from 'node:zlib';
import { config } from 'dotenv';
import { Client } from 'pg';
import { DEMO_ORG_ID } from '../src/database/migrations/1795400001000-CreateFields';

config({ quiet: true });

/** the middle of the seeded area (Poltava region) */
const LNG = 34.55;
const LAT = 49.59;
const EXTENT = 4096;
const WORLD_M = 40075016.68557849;

const BOUNDS = `b AS (SELECT ST_TileEnvelope($2, $3, $4) AS env,
                      ST_Transform(ST_TileEnvelope($2, $3, $4, margin => $5), 4326) AS q)`;
const POLYGONS = `WITH ${BOUNDS},
  t AS (SELECT f.id, f.name, f.crop, f.season, f.area_ha::float8 AS "areaHa",
               ST_AsMVTGeom(ST_Transform(f.geom, 3857), b.env, ${EXTENT}, 64, true) AS geom
          FROM fields f, b WHERE f.org_id = $1 AND f.geom && b.q)
  SELECT ST_AsMVT(t.*, 'fields', ${EXTENT}, 'geom') AS tile, count(*)::int AS n FROM t WHERE t.geom IS NOT NULL`;
const CLUSTERS = `WITH ${BOUNDS},
  c AS (SELECT ST_Transform(ST_Centroid(f.geom), 3857) AS p, f.area_ha
          FROM fields f, b WHERE f.org_id = $1 AND f.geom && b.q),
  g AS (SELECT count(*)::int AS count, round(sum(c.area_ha), 1)::float8 AS "areaHa",
               ST_AsMVTGeom(ST_Centroid(ST_Collect(c.p)), b.env, ${EXTENT}, 0, true) AS geom
          FROM c, b GROUP BY ST_SnapToGrid(c.p, $6::float8 / 2, $6::float8 / 2, $6::float8, $6::float8), b.env)
  SELECT ST_AsMVT(g.*, 'clusters', ${EXTENT}, 'geom') AS tile, count(*)::int AS n FROM g WHERE g.geom IS NOT NULL`;

function tileOf(z: number): [number, number] {
  const n = 2 ** z;
  const r = (LAT * Math.PI) / 180;
  return [Math.floor(((LNG + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)];
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 100 * 1024 ? 1 : 0)} KB`);

async function measure(db: Client, sql: string, params: unknown[]) {
  await db.query(sql, params); // warm
  const runs: number[] = [];
  let row: { tile: Buffer | null; n: number } = { tile: null, n: 0 };
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    [row] = (await db.query(sql, params)).rows;
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const tile = row.tile ?? Buffer.alloc(0);
  return { n: row.n, bytes: tile.length, gz: gzipSync(tile).length, ms: Math.min(...runs) };
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
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM fields WHERE org_id = $1', [DEMO_ORG_ID]);
  console.log(`Demo farm: ${n} fields. One tile around ${LNG}, ${LAT}, best of 3 runs.\n`);
  console.log('| zoom | tile | polygons: features | size | gzip | time | clusters: points | size | gzip | time |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const z of [6, 7, 8, 9, 10, 11, 12, 14, 16]) {
    const [x, y] = tileOf(z);
    const p = await measure(db, POLYGONS, [DEMO_ORG_ID, z, x, y, 64 / EXTENT]);
    const c = await measure(db, CLUSTERS, [DEMO_ORG_ID, z, x, y, 0, WORLD_M / 2 ** z / 32]);
    console.log(
      `| ${z} | ${x}/${y} | ${p.n} | ${kb(p.bytes)} | ${kb(p.gz)} | ${p.ms.toFixed(1)} ms ` +
        `| ${c.n} | ${kb(c.bytes)} | ${kb(c.gz)} | ${c.ms.toFixed(1)} ms |`,
    );
  }
  const [x, y] = tileOf(14);
  const { rows } = await db.query(`EXPLAIN (ANALYZE, COSTS OFF) ${POLYGONS}`, [DEMO_ORG_ID, 14, x, y, 64 / EXTENT]);
  console.log(`\nPlan of the zoom 14 tile:\n\n\`\`\`\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n\`\`\``);
  await db.end();
}

void main();
