import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BoundaryService } from '../geo/boundary.service';
import type { FieldFeatureInput } from '../geo/geojson.schema';
import { toleranceForZoom } from '../geo/viewport';
import { OverlapsService } from './overlaps.service';

/** 6 decimals of a degree ~ 11 cm: more is noise from GPS and float maths. */
const PRECISION = 6;

/** At most this many Features per answer; a wider view needs vector tiles (M10). */
export const MAX_FEATURES = 5000;

/**
 * One field row → one GeoJSON Feature, built by Postgres itself.
 * ST_AsGeoJSON turns the geometry into GeoJSON text; ::json embeds it as an
 * object instead of a quoted string.
 *
 * `geometry` is the SQL expression drawn: the stored boundary or a simplified
 * one. Measurements always use the stored f.geom. Only constant SQL from this
 * file is passed here, never request data.
 */
const featureSql = (geometry = 'f.geom') => `
  json_build_object(
    'type', 'Feature',
    'id', f.id,
    'geometry', ST_AsGeoJSON(${geometry}, ${PRECISION})::json,
    'properties', json_build_object(
      'name', f.name,
      'crop', f.crop,
      'season', f.season,
      -- measured on the spheroid: geography gives metres, geometry in 4326 would give degrees
      'areaHa', f.area_ha,
      'perimeterM', round(ST_Perimeter(f.geom::geography)::numeric, 1),
      -- a point guaranteed to lie inside the field (the centroid of a C-shape does not)
      'labelPoint', ST_AsGeoJSON(ST_PointOnSurface(f.geom), ${PRECISION})::json -> 'coordinates',
      'createdAt', f.created_at
    )
  )`;

export interface Feature {
  type: 'Feature';
  id: string;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  properties: {
    name: string;
    crop: string | null;
    season: number | null;
    areaHa: number;
    perimeterM: number;
    /** [lng, lat] inside the field, for the map label */
    labelPoint: [number, number];
    createdAt: string;
  };
}

/**
 * POST answer: the stored Feature plus what was repaired on the way and which
 * existing fields it overlaps (RFC 7946 foreign members). An overlap is a
 * warning, not an error: two farms may really claim the same land.
 */
export interface CreatedFeature extends Feature {
  warnings: string[];
  overlaps: { id: string; name: string; overlapHa: number }[];
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
  /** true when more than MAX_FEATURES matched and the rest was cut off */
  truncated: boolean;
}

export interface Viewport {
  bbox?: [minLng: number, minLat: number, maxLng: number, maxLat: number];
  zoom?: number;
}

/** GeoJSON bbox order: [west, south, east, north]; null when there is nothing. */
export interface Extent {
  bbox: [number, number, number, number] | null;
}

const FK_VIOLATION = '23503';

@Injectable()
export class FieldsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly boundary: BoundaryService,
    private readonly overlaps: OverlapsService,
  ) {}

  async create(orgId: string, input: FieldFeatureInput): Promise<CreatedFeature> {
    const { name, crop, season } = input.properties;
    // validated, repaired if needed, MultiPolygon in WGS 84 — or a 422
    const { ewkb, warnings } = await this.boundary.prepare(input.geometry);
    try {
      const [row] = await this.db.query<{ id: string }[]>(
        `INSERT INTO fields (org_id, name, crop, season, geom)
         VALUES ($1, $2, $3, $4, $5::geometry)  -- hex EWKB -> geometry, SRID included
         RETURNING id`,
        [orgId, name, crop ?? null, season ?? null, ewkb],
      );
      const { features } = await this.overlaps.ofField(orgId, row.id);
      const overlaps = features.map(({ properties: p }) => ({ id: p.fieldId, name: p.name, overlapHa: p.overlapHa }));
      return { ...(await this.findOne(orgId, row.id)), warnings, overlaps };
    } catch (e) {
      if ((e as { code?: string }).code === FK_VIOLATION) {
        throw new NotFoundException('organization not found');
      }
      throw e;
    }
  }

  async findOne(orgId: string, id: string): Promise<Feature> {
    const [row] = await this.db.query<{ feature: Feature }[]>(
      `SELECT ${featureSql()} AS feature FROM fields f WHERE f.id = $1 AND f.org_id = $2`,
      [id, orgId],
    );
    // another organisation's field is "not found", not "forbidden": don't leak that it exists
    if (!row) throw new NotFoundException('field not found');
    return row.feature;
  }

  /**
   * Fields of the organisation, optionally only those in the map viewport and
   * simplified for its zoom. Aggregated in SQL: one row, no mapping loop in Node.
   */
  async list(orgId: string, view: Viewport = {}): Promise<FeatureCollection> {
    const params: unknown[] = [orgId];

    // `&&` = bounding boxes overlap: answered from the GiST index alone. For a
    // viewport that is exact enough — a field whose box touches the screen
    // edge is sent although its outline is just outside.
    let inView = '';
    if (view.bbox) {
      params.push(...view.bbox);
      inView = 'AND f.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)';
    }

    let drawn = 'f.geom';
    if (view.zoom !== undefined) {
      params.push(toleranceForZoom(view.zoom));
      // keeps every ring valid and every field present, only drops vertices;
      // it may hand back a single-part Polygon, ST_Multi keeps the answer's type stable
      drawn = `ST_Multi(ST_SimplifyPreserveTopology(f.geom, $${params.length}))`;
    }

    params.push(MAX_FEATURES + 1); // one extra row tells whether we cut anything off
    const limit = `$${params.length}`;

    const [row] = await this.db.query<{ collection: FeatureCollection }[]>(
      `SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(
                    json_agg(${featureSql(drawn)} ORDER BY f.created_at, f.id) FILTER (WHERE f.n <= ${MAX_FEATURES}),
                    '[]'::json),
                'truncated', count(*) > ${MAX_FEATURES}
              ) AS collection
         FROM (SELECT f.*, row_number() OVER (ORDER BY f.created_at, f.id) AS n
                 FROM fields f
                WHERE f.org_id = $1 ${inView}
                ORDER BY f.created_at, f.id
                LIMIT ${limit}) f`,
      params,
    );
    return row.collection;
  }

  /** The box around all fields of the organisation: "zoom to my fields". */
  async extent(orgId: string): Promise<Extent> {
    const [row] = await this.db.query<{ bbox: Extent['bbox'] }[]>(
      `SELECT CASE WHEN e IS NULL THEN NULL
                   ELSE json_build_array(round(ST_XMin(e)::numeric, ${PRECISION}), round(ST_YMin(e)::numeric, ${PRECISION}),
                                         round(ST_XMax(e)::numeric, ${PRECISION}), round(ST_YMax(e)::numeric, ${PRECISION}))
              END AS bbox
         FROM (SELECT ST_Extent(geom) AS e FROM fields WHERE org_id = $1) t`,
      [orgId],
    );
    return { bbox: row.bbox };
  }
}
