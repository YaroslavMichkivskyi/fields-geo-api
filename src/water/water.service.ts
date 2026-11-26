import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MAX_ZONE_M, WaterBodyInput } from './water.schema';

/** 6 decimals of a degree ~ 11 cm, as everywhere in the API. */
const PRECISION = 6;

const ha = (geom: string) => `round((ST_Area(${geom}::geography) / 10000)::numeric, 4)`;

type MultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };

export interface WaterZones {
  type: 'FeatureCollection';
  /** the part under the protection strip, the sprayable rest, and the water nearby — layers for the map */
  features: (
    | { type: 'Feature'; id: 'restricted' | 'sprayable'; geometry: MultiPolygon; properties: { part: string; areaHa: number } }
    | {
        type: 'Feature';
        id: string;
        geometry: { type: 'MultiLineString'; coordinates: number[][][] };
        properties: { part: 'water'; name: string; size: string; zoneM: number; distanceM: number };
      }
  )[];
  fieldId: string;
  fieldAreaHa: number;
  restrictedHa: number;
  sprayableHa: number;
  restrictedPercent: number;
}

@Injectable()
export class WaterService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async create(input: WaterBodyInput) {
    const [row] = await this.db.query<{ feature: object }[]>(
      `INSERT INTO water_bodies (name, size, geom)
       VALUES ($1, $2, ST_Multi(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))))
       RETURNING json_build_object(
         'type', 'Feature', 'id', id,
         'geometry', ST_AsGeoJSON(geom, ${PRECISION})::json,
         'properties', json_build_object('name', name, 'size', size, 'zoneM', zone_m)) AS feature`,
      [input.properties.name, input.properties.size, JSON.stringify(input.geometry)],
    );
    return row.feature;
  }

  /**
   * Splits a field into the part inside the protection strips of nearby water
   * (no spraying) and the rest, with their areas.
   *
   * The strip is a buffer in METRES around the river line: ST_Buffer on
   * geography. On geometry in SRID 4326 the distance would be degrees, and a
   * degree of longitude here is 72 km while a degree of latitude is 111 km —
   * a "50 m" buffer would be 50 m wide to the north and 32 m to the east.
   */
  async zones(orgId: string, fieldId: string, bufferM?: number): Promise<WaterZones> {
    const [row] = await this.db.query<{ result: WaterZones }[]>(
      `WITH f AS (
         SELECT id, geom, area_ha FROM fields WHERE id = $2 AND org_id = $1
       ),
       near AS (
         -- candidates within the widest strip that can apply: a constant distance,
         -- so the GiST index on water_bodies (geom::geography) can answer it
         SELECT w.id, w.name, w.size, w.geom,
                COALESCE($3::int, w.zone_m) AS zone_m,
                ST_Distance(w.geom::geography, f.geom::geography) AS distance_m
           FROM water_bodies w, f
          WHERE ST_DWithin(w.geom::geography, f.geom::geography, $4)
       ),
       zone AS (
         -- one shape for all strips that reach the field; ST_Union of no rows is NULL
         SELECT ST_Union(ST_Buffer(n.geom::geography, n.zone_m)::geometry) AS g
           FROM near n
          WHERE n.distance_m <= n.zone_m
       ),
       parts AS (
         SELECT f.id, f.area_ha,
                CASE WHEN z.g IS NULL THEN ST_GeomFromText('MULTIPOLYGON EMPTY', 4326)
                     ELSE ST_Multi(ST_CollectionExtract(ST_Intersection(f.geom, z.g), 3)) END AS restricted,
                CASE WHEN z.g IS NULL THEN f.geom
                     ELSE ST_Multi(ST_CollectionExtract(ST_Difference(f.geom, z.g), 3)) END AS sprayable
           FROM f, zone z
       )
       SELECT json_build_object(
                'type', 'FeatureCollection',
                'features',
                  json_build_array(
                    json_build_object('type', 'Feature', 'id', 'restricted',
                      'geometry', ST_AsGeoJSON(p.restricted, ${PRECISION})::json,
                      'properties', json_build_object('part', 'restricted', 'areaHa', ${ha('p.restricted')})),
                    json_build_object('type', 'Feature', 'id', 'sprayable',
                      'geometry', ST_AsGeoJSON(p.sprayable, ${PRECISION})::json,
                      'properties', json_build_object('part', 'sprayable', 'areaHa', ${ha('p.sprayable')})))::jsonb
                  || COALESCE((SELECT jsonb_agg(jsonb_build_object('type', 'Feature', 'id', n.id,
                        'geometry', ST_AsGeoJSON(n.geom, ${PRECISION})::jsonb,
                        'properties', jsonb_build_object('part', 'water', 'name', n.name, 'size', n.size,
                                                         'zoneM', n.zone_m, 'distanceM', round(n.distance_m::numeric, 1)))
                        ORDER BY n.distance_m) FROM near n), '[]'::jsonb),
                'fieldId', p.id,
                'fieldAreaHa', p.area_ha,
                'restrictedHa', ${ha('p.restricted')},
                'sprayableHa', ${ha('p.sprayable')},
                'restrictedPercent', round((100 * ST_Area(p.restricted::geography) / (p.area_ha * 10000))::numeric, 2)
              ) AS result
         FROM parts p`,
      [orgId, fieldId, bufferM ?? null, bufferM ?? MAX_ZONE_M],
    );
    if (!row) throw new NotFoundException('field not found');
    return row.result;
  }
}
