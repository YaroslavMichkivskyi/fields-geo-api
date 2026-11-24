import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AreaGeometry } from './geojson.schema';

/** Smaller than this is a drawing slip, not a field (100 m² = 0.01 ha). */
export const MIN_AREA_M2 = 100;

/**
 * Validity problems ST_MakeValid fixes the way a person meant it: a boundary
 * that crosses itself becomes the parts it encloses. Everything else (a hole
 * outside the shell, nested shells, ...) would be "repaired" into land the
 * user wanted excluded, so it is rejected instead.
 */
const REPAIRABLE = ['Self-intersection', 'Ring Self-intersection'];

export interface PreparedBoundary {
  /** The geometry to store, as hex EWKB: lossless, SRID included. */
  ewkb: string;
  /** What was changed on the way, for the client to show. */
  warnings: string[];
}

interface CheckRow {
  valid: boolean;
  reason: string;
  removed_points: number;
  empty: boolean;
  parts: number;
  area_m2: number;
  ewkb: string;
}

/**
 * One round trip: parse → drop repeated points → validate → repair if needed
 * → normalise ring orientation → measure. The rules are applied in Node.
 */
const CHECK_SQL = `
  WITH input AS (
    SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS raw
  ), cleaned AS (
    SELECT raw, ST_RemoveRepeatedPoints(raw) AS geom FROM input
  ), checked AS (
    SELECT raw, geom, ST_IsValid(geom) AS valid, ST_IsValidReason(geom) AS reason FROM cleaned
  ), repaired AS (
    SELECT *,
           ST_ForcePolygonCCW(ST_Multi(
             CASE WHEN valid THEN geom
                  ELSE ST_CollectionExtract(ST_MakeValid(geom), 3)  -- 3 = polygons only
             END)) AS fixed
      FROM checked
  )
  SELECT valid,
         reason,
         ST_NPoints(raw) - ST_NPoints(geom) AS removed_points,
         ST_IsEmpty(fixed)                  AS empty,
         ST_NumGeometries(fixed)            AS parts,
         ST_Area(fixed::geography)          AS area_m2,
         ST_AsHEXEWKB(fixed)                AS ewkb
    FROM repaired`;

@Injectable()
export class BoundaryService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async prepare(geometry: AreaGeometry): Promise<PreparedBoundary> {
    const [row] = await this.db.query<CheckRow[]>(CHECK_SQL, [JSON.stringify(geometry)]);
    const problem = row.reason.split('[')[0]; // "Self-intersection[34.555 49.595]" → "Self-intersection"
    const warnings: string[] = [];

    if (row.removed_points > 0) {
      warnings.push(`removed ${row.removed_points} repeated point(s)`);
    }
    if (!row.valid) {
      if (!REPAIRABLE.includes(problem)) {
        throw this.reject(`invalid boundary: ${row.reason}`);
      }
      if (row.empty) {
        throw this.reject(`invalid boundary: ${row.reason}; it encloses no area`);
      }
      warnings.push(`invalid boundary (${row.reason}) was repaired into ${row.parts} part(s)`);
    }
    if (row.area_m2 < MIN_AREA_M2) {
      throw this.reject(`boundary area ${row.area_m2.toFixed(1)} m² is below the minimum of ${MIN_AREA_M2} m²`);
    }
    return { ewkb: row.ewkb, warnings };
  }

  private reject(message: string): UnprocessableEntityException {
    return new UnprocessableEntityException({ statusCode: 422, error: 'Unprocessable Entity', message });
  }
}
