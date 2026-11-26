import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { SoilSampleCollectionInput } from './soil.schema';

/** 6 decimals of a degree ~ 11 cm, as everywhere in the API. */
const PRECISION = 6;
/** At most this many samples in the "outside every field" list. */
export const MAX_UNASSIGNED = 5000;

/**
 * Which field of the organisation a point lies in — or none.
 *
 * ST_Covers, not ST_Contains: a sample taken right on the boundary (on the
 * track between two fields) is still in the field. ST_Contains would leave a
 * point on the boundary out (DE-9IM: it must touch the interior).
 *
 * A point may be covered by two fields: on the boundary they share, or where
 * two fields overlap (allowed, M5). Deterministic choice: a field that has the
 * point strictly inside wins over one that only has it on its edge; then the
 * oldest field.
 *
 * `point` is a constant SQL expression from this file; the organisation is $1.
 */
const fieldOfPointSql = (point: string) => `
  SELECT f.id, f.name
    FROM fields f
   WHERE f.org_id = $1
     AND ST_Covers(f.geom, ${point})                 -- GiST on fields.geom finds the candidates
   ORDER BY ST_Contains(f.geom, ${point}) DESC,      -- strictly inside first
            f.created_at, f.id
   LIMIT 1`;

const sampleFeatureSql = (s: string, fieldId: string, fieldName: string) => `
  json_build_object(
    'type', 'Feature',
    'id', ${s}.id,
    'geometry', ST_AsGeoJSON(${s}.geom, ${PRECISION})::json,
    'properties', json_build_object(
      'fieldId', ${fieldId},
      'fieldName', ${fieldName},
      'takenAt', ${s}.taken_at,
      'ph', ${s}.ph,
      'humus', ${s}.humus))`;

export interface SampleFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { fieldId: string | null; fieldName: string | null; takenAt: string; ph: number | null; humus: number | null };
}

export interface CreatedSamples {
  type: 'FeatureCollection';
  features: SampleFeature[];
  /** how many of them lie in no field */
  unassigned: number;
}

export interface UnassignedSample {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    takenAt: string;
    ph: number | null;
    humus: number | null;
    /** the field it most likely belongs to, and how far outside it is */
    nearestField: { id: string; name: string; distanceM: number } | null;
  };
}

export interface SoilStats {
  fieldId: string;
  samples: number;
  ph: { avg: number; min: number; max: number } | null;
  humus: { avg: number; min: number; max: number } | null;
  /** samples per 10 ha: agronomists aim at about one per 5–10 ha */
  densityPer10Ha: number;
  takenFrom: string | null;
  takenTo: string | null;
}

@Injectable()
export class SoilService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * Stores a batch of samples in one statement and assigns each to its field.
   * The batch travels as one JSON parameter and is unpacked by Postgres
   * (json_to_recordset): one round trip, no SQL built from data.
   */
  async create(orgId: string, input: SoilSampleCollectionInput): Promise<CreatedSamples> {
    const rows = input.features.map((f, i) => ({
      i,
      lng: f.geometry.coordinates[0], // an altitude, if sent, is dropped
      lat: f.geometry.coordinates[1],
      taken_at: f.properties.takenAt,
      ph: f.properties.ph ?? null,
      humus: f.properties.humus ?? null,
    }));

    const [row] = await this.db.query<{ features: SampleFeature[] }[]>(
      `WITH input AS (
         SELECT r.*, gen_random_uuid() AS id, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326) AS geom
           FROM json_to_recordset($2::json)
             AS r(i int, lng float8, lat float8, taken_at timestamptz, ph numeric, humus numeric)
       ),
       placed AS (
         -- for every sample, the one field that covers it (or NULL): the point-in-polygon join
         SELECT input.*, fld.id AS field_id, fld.name AS field_name
           FROM input
           LEFT JOIN LATERAL (${fieldOfPointSql('input.geom')}) fld ON true
       ),
       stored AS (
         INSERT INTO soil_samples (id, org_id, field_id, taken_at, ph, humus, geom)
         SELECT id, $1, field_id, taken_at, ph, humus, geom FROM placed
         RETURNING *                 -- the stored values: ph numeric(3,1) is rounded to 0.1
       )
       -- back in the order of the upload: features[i] answers input feature i
       SELECT json_agg(${sampleFeatureSql('s', 's.field_id', 'p.field_name')} ORDER BY p.i) AS features
         FROM stored s
         JOIN placed p USING (id)`,
      [orgId, JSON.stringify(rows)],
    );
    const features = row.features;
    return {
      type: 'FeatureCollection',
      features,
      unassigned: features.filter((f) => f.properties.fieldId === null).length,
    };
  }

  /**
   * A field was just drawn: adopt the samples taken inside it that had no
   * field yet. UPDATE … FROM joins the table being updated with another one.
   * Runs in the caller's transaction when one is passed.
   */
  async assignToField(orgId: string, fieldId: string, manager: EntityManager = this.db.manager): Promise<number> {
    // TypeORM answers an UPDATE with [rows, affected count]
    const [, adopted] = await manager.query<[unknown[], number]>(
      `UPDATE soil_samples s
          SET field_id = f.id
         FROM fields f
        WHERE f.id = $2 AND f.org_id = $1
          AND s.org_id = $1
          AND s.field_id IS NULL                      -- never steal a sample from another field
          AND ST_Covers(f.geom, s.geom)`,             // partial GiST index on unassigned samples
      [orgId, fieldId],
    );
    return adopted;
  }

  /** Aggregates of the samples inside one field. */
  async stats(orgId: string, fieldId: string): Promise<SoilStats> {
    const [row] = await this.db.query<SoilStats[]>(
      `SELECT f.id AS "fieldId",
              count(s.id)::int AS samples,
              CASE WHEN count(s.ph) = 0 THEN NULL ELSE json_build_object(
                'avg', round(avg(s.ph), 2), 'min', min(s.ph), 'max', max(s.ph)) END AS ph,
              CASE WHEN count(s.humus) = 0 THEN NULL ELSE json_build_object(
                'avg', round(avg(s.humus), 2), 'min', min(s.humus), 'max', max(s.humus)) END AS humus,
              round(10 * count(s.id) / f.area_ha, 2)::float8 AS "densityPer10Ha",
              min(s.taken_at) AS "takenFrom",
              max(s.taken_at) AS "takenTo"
         FROM fields f
         LEFT JOIN soil_samples s ON s.field_id = f.id
        WHERE f.id = $2 AND f.org_id = $1
        GROUP BY f.id`,
      [orgId, fieldId],
    );
    if (!row) throw new NotFoundException('field not found');
    return row;
  }

  /**
   * Samples that fell in no field, each with the nearest field and how far
   * outside it is: 8 m away is a boundary drawn too tight, 3 km is a GPS slip.
   */
  async unassigned(orgId: string): Promise<{ type: 'FeatureCollection'; features: UnassignedSample[]; truncated: boolean }> {
    const rows = await this.db.query<{ feature: UnassignedSample }[]>(
      `SELECT json_build_object(
                'type', 'Feature',
                'id', s.id,
                'geometry', ST_AsGeoJSON(s.geom, ${PRECISION})::json,
                'properties', json_build_object(
                  'takenAt', s.taken_at, 'ph', s.ph, 'humus', s.humus,
                  'nearestField', CASE WHEN n.id IS NULL THEN NULL ELSE json_build_object(
                    'id', n.id, 'name', n.name, 'distanceM', round(n.m::numeric, 1)) END)
              ) AS feature
         FROM soil_samples s
         LEFT JOIN LATERAL (
           -- KNN on the geography index of M6: nearest field first, stop after one
           SELECT f.id, f.name, ST_Distance(f.geom::geography, s.geom::geography) AS m
             FROM fields f
            WHERE f.org_id = s.org_id
            ORDER BY f.geom::geography <-> s.geom::geography
            LIMIT 1) n ON true
        WHERE s.org_id = $1 AND s.field_id IS NULL
        ORDER BY s.taken_at, s.id
        LIMIT $2`,
      [orgId, MAX_UNASSIGNED + 1],
    );
    return {
      type: 'FeatureCollection',
      features: rows.slice(0, MAX_UNASSIGNED).map((r) => r.feature),
      truncated: rows.length > MAX_UNASSIGNED,
    };
  }
}
