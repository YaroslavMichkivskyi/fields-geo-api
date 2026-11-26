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

/** prepareMany: per geometry, either the boundary to store or why it was rejected. */
export type BoundaryResult = ({ ok: true } & PreparedBoundary) | { ok: false; error: string };

interface CheckRow {
  i: number;
  valid: boolean;
  reason: string;
  removed_points: number;
  empty: boolean;
  parts: number;
  area_m2: number;
  ewkb: string;
}

/**
 * One round trip for any number of geometries: parse → drop repeated points →
 * validate → repair if needed → normalise ring orientation → measure. The
 * geometries travel as one JSON array; WITH ORDINALITY numbers them so every
 * answer row says which input it belongs to. The rules are applied in Node.
 */
const CHECK_SQL = `
  WITH input AS (
    SELECT (t.ord - 1)::int AS i, ST_SetSRID(ST_GeomFromGeoJSON(t.g::text), 4326) AS raw
      FROM json_array_elements($1::json) WITH ORDINALITY AS t(g, ord)
  ), cleaned AS (
    SELECT i, raw, ST_RemoveRepeatedPoints(raw) AS geom FROM input
  ), checked AS (
    SELECT i, raw, geom, ST_IsValid(geom) AS valid, ST_IsValidReason(geom) AS reason FROM cleaned
  ), repaired AS (
    SELECT *,
           ST_ForcePolygonCCW(ST_Multi(
             CASE WHEN valid THEN geom
                  ELSE ST_CollectionExtract(ST_MakeValid(geom), 3)  -- 3 = polygons only
             END)) AS fixed
      FROM checked
  )
  SELECT i,
         valid,
         reason,
         ST_NPoints(raw) - ST_NPoints(geom) AS removed_points,
         ST_IsEmpty(fixed)                  AS empty,
         ST_NumGeometries(fixed)            AS parts,
         ST_Area(fixed::geography)          AS area_m2,
         ST_AsHEXEWKB(fixed)                AS ewkb
    FROM repaired
   ORDER BY i`;

@Injectable()
export class BoundaryService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** One boundary (POST /fields): the prepared geometry, or a 422. */
  async prepare(geometry: AreaGeometry): Promise<PreparedBoundary> {
    const [result] = await this.prepareMany([geometry]);
    if (!result.ok) {
      throw new UnprocessableEntityException({ statusCode: 422, error: 'Unprocessable Entity', message: result.error });
    }
    return { ewkb: result.ewkb, warnings: result.warnings };
  }

  /** Many boundaries in one query (bulk import): a result per geometry, in input order. */
  async prepareMany(geometries: AreaGeometry[]): Promise<BoundaryResult[]> {
    if (geometries.length === 0) return [];
    const rows = await this.db.query<CheckRow[]>(CHECK_SQL, [JSON.stringify(geometries)]);
    return rows.map((row) => this.judge(row));
  }

  private judge(row: CheckRow): BoundaryResult {
    const problem = row.reason.split('[')[0]; // "Self-intersection[34.555 49.595]" → "Self-intersection"
    const warnings: string[] = [];

    if (row.removed_points > 0) {
      warnings.push(`removed ${row.removed_points} repeated point(s)`);
    }
    if (!row.valid) {
      if (!REPAIRABLE.includes(problem)) {
        return { ok: false, error: `invalid boundary: ${row.reason}` };
      }
      if (row.empty) {
        return { ok: false, error: `invalid boundary: ${row.reason}; it encloses no area` };
      }
      warnings.push(`invalid boundary (${row.reason}) was repaired into ${row.parts} part(s)`);
    }
    if (row.area_m2 < MIN_AREA_M2) {
      return { ok: false, error: `boundary area ${row.area_m2.toFixed(1)} m² is below the minimum of ${MIN_AREA_M2} m²` };
    }
    return { ok: true, ewkb: row.ewkb, warnings };
  }
}
