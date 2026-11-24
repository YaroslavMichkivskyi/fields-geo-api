/**
 * Same polygons, five ways to measure their area — prints a markdown table
 * for docs/measurements.md. Needs the dev database (docker compose up).
 *
 *   npm run compare:area
 */
import turfArea from '@turf/area';
import { polygon } from '@turf/helpers';
import { config } from 'dotenv';
import { Client } from 'pg';

config({ quiet: true });

const SAMPLES: { name: string; ring: number[][] }[] = [
  { name: 'Poltava, 0.01° square', ring: [[34.55, 49.59], [34.56, 49.59], [34.56, 49.6], [34.55, 49.6], [34.55, 49.59]] },
  { name: 'Poltava, ~10 x 10 km', ring: [[34.4, 49.5], [34.5385, 49.5], [34.5385, 49.59], [34.4, 49.59], [34.4, 49.5]] },
  { name: 'Lviv, 0.01° square', ring: [[24.0, 49.8], [24.01, 49.8], [24.01, 49.81], [24.0, 49.81], [24.0, 49.8]] },
  { name: 'Odesa, 0.01° square', ring: [[30.7, 46.4], [30.71, 46.4], [30.71, 46.41], [30.7, 46.41], [30.7, 46.4]] },
];

const SQL = `
  WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g)
  SELECT ST_Area(g::geography)               / 1e4 AS spheroid,
         ST_Area(g::geography, false)        / 1e4 AS sphere,
         ST_Area(ST_Transform(g, 32635))     / 1e4 AS utm35,
         ST_Area(ST_Transform(g, 32636))     / 1e4 AS utm36,
         ST_Area(ST_Transform(g, 3857))      / 1e4 AS mercator,
         ST_Area(g)                                AS degrees
    FROM g`;

async function main(): Promise<void> {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  const ha = (v: number) => v.toFixed(4);
  const diff = (v: number, ref: number) => `${(((v - ref) / ref) * 100).toFixed(2)}%`;

  console.log('| polygon | spheroid (ha) | sphere | Turf | UTM 35N | UTM 36N | Web Mercator | ST_Area(geometry) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const { name, ring } of SAMPLES) {
    const geometry = { type: 'Polygon', coordinates: [ring] };
    const { rows: [r] } = await db.query(SQL, [JSON.stringify(geometry)]);
    const turf = turfArea(polygon([ring])) / 1e4;
    const ref = r.spheroid;
    console.log(
      `| ${name} | **${ha(ref)}** | ${ha(r.sphere)} (${diff(r.sphere, ref)}) | ${ha(turf)} (${diff(turf, ref)})` +
        ` | ${ha(r.utm35)} (${diff(r.utm35, ref)}) | ${ha(r.utm36)} (${diff(r.utm36, ref)})` +
        ` | ${r.mercator.toFixed(1)} (${diff(r.mercator, ref)}) | ${r.degrees} "deg²" |`,
    );
  }
  await db.end();
}

void main();
