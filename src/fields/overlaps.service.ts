import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** 6 decimals of a degree ~ 11 cm, as everywhere in the API. */
const PRECISION = 6;

/** At most this many overlap Features in the organisation-wide report. */
export const MAX_OVERLAPS = 5000;

/**
 * Below either threshold an overlap is GPS noise or a drawing slip along a
 * shared boundary, not two claims on the same land: 10 m², and 0.5 % of the
 * smaller of the two fields (a 0.5 m sliver along a 1 km edge is 500 m²).
 */
export const MIN_OVERLAP_M2 = 10;
export const MIN_OVERLAP_SHARE = 0.005;

/**
 * Pairs (a, b) of fields of organisation $1 whose interiors overlap, with the
 * overlap geometry and its area in m². `narrow` picks the a side (one field or
 * all), `pair` is 'a.id <> b.id' (every neighbour of a) or 'a.id < b.id'
 * (every pair once). Only constant SQL from this file is passed in.
 */
const overlapPairsSql = (narrow: string, pair: string) => `
  SELECT a.id AS a_id, a.name AS a_name, a.area_ha AS a_ha,
         b.id AS b_id, b.name AS b_name, b.area_ha AS b_ha,
         o.geom, o.m2
    FROM fields a
    JOIN fields b
      ON b.org_id = a.org_id AND ${pair}
     -- any common point, boundary included; answered from the GiST index on b.geom
     AND ST_Intersects(a.geom, b.geom)
     -- ...minus the pairs that share only boundary: neighbours, not an overlap
     AND NOT ST_Touches(a.geom, b.geom)
   -- computed once per pair, then used for both the answer and the filter
   CROSS JOIN LATERAL (
     SELECT g AS geom, ST_Area(g::geography) AS m2
       -- the intersection may come back as a GeometryCollection (an area plus
       -- the bits of boundary the fields share): keep only the polygons
       FROM (SELECT ST_Multi(ST_CollectionExtract(ST_Intersection(a.geom, b.geom), 3)) AS g) i
   ) o
   WHERE a.org_id = $1 ${narrow}
     AND o.m2 > ${MIN_OVERLAP_M2}
     AND o.m2 > ${MIN_OVERLAP_SHARE} * least(a.area_ha, b.area_ha) * 10000`;

const ha = (m2: string) => `round((${m2} / 10000)::numeric, 4)`;
const pct = (part: string, wholeHa: string) => `round((100 * ${part} / (${wholeHa} * 10000))::numeric, 2)`;

/** The overlap between this field and another one, as a Feature. */
export interface FieldOverlap {
  type: 'Feature';
  id: string;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  properties: {
    fieldId: string;
    name: string;
    overlapHa: number;
    /** share of this field (the one in the URL) under the other one, % */
    percentOfThis: number;
    /** share of the other field under this one, % */
    percentOfOther: number;
  };
}

/** One overlapping pair of the organisation-wide report. */
export interface OverlapPair {
  type: 'Feature';
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  properties: {
    a: { id: string; name: string };
    b: { id: string; name: string };
    overlapHa: number;
  };
}

export interface Collection<F> {
  type: 'FeatureCollection';
  features: F[];
  truncated?: boolean;
}

@Injectable()
export class OverlapsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Fields of the organisation overlapping field `id`, biggest overlap first. */
  async ofField(orgId: string, id: string): Promise<Collection<FieldOverlap>> {
    const [row] = await this.db.query<{ found: boolean; features: FieldOverlap[] }[]>(
      `SELECT EXISTS (SELECT 1 FROM fields WHERE id = $2 AND org_id = $1) AS found,
              COALESCE(json_agg(json_build_object(
                'type', 'Feature',
                'id', p.b_id,
                'geometry', ST_AsGeoJSON(p.geom, ${PRECISION})::json,
                'properties', json_build_object(
                  'fieldId', p.b_id,
                  'name', p.b_name,
                  'overlapHa', ${ha('p.m2')},
                  'percentOfThis', ${pct('p.m2', 'p.a_ha')},
                  'percentOfOther', ${pct('p.m2', 'p.b_ha')})
              ) ORDER BY p.m2 DESC, p.b_id), '[]'::json) AS features
         FROM (${overlapPairsSql('AND a.id = $2', 'a.id <> b.id')}) p`,
      [orgId, id],
    );
    if (!row.found) throw new NotFoundException('field not found');
    return { type: 'FeatureCollection', features: row.features };
  }

  /**
   * Every overlapping pair of the organisation once — (A, B) but not (B, A) —
   * biggest first, at most MAX_OVERLAPS.
   */
  async report(orgId: string): Promise<Collection<OverlapPair>> {
    const [row] = await this.db.query<{ collection: Collection<OverlapPair> }[]>(
      `SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(json_agg(json_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(p.geom, ${PRECISION})::json,
                    'properties', json_build_object(
                      'a', json_build_object('id', p.a_id, 'name', p.a_name),
                      'b', json_build_object('id', p.b_id, 'name', p.b_name),
                      'overlapHa', ${ha('p.m2')})
                  ) ORDER BY p.n) FILTER (WHERE p.n <= ${MAX_OVERLAPS}), '[]'::json),
                'truncated', count(*) > ${MAX_OVERLAPS}
              ) AS collection
         FROM (SELECT q.*, row_number() OVER (ORDER BY q.m2 DESC, q.a_id, q.b_id) AS n
                 FROM (${overlapPairsSql('', 'a.id < b.id')}) q
                ORDER BY n
                LIMIT $2) p`,
      [orgId, MAX_OVERLAPS + 1],
    );
    return row.collection;
  }
}
