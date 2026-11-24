import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BoundaryService } from '../geo/boundary.service';
import type { FieldFeatureInput } from '../geo/geojson.schema';

/** 6 decimals of a degree ~ 11 cm: more is noise from GPS and float maths. */
const PRECISION = 6;

/**
 * One field row → one GeoJSON Feature, built by Postgres itself.
 * ST_AsGeoJSON turns the geometry into GeoJSON text; ::json embeds it as an
 * object instead of a quoted string.
 */
const FEATURE_SQL = `
  json_build_object(
    'type', 'Feature',
    'id', f.id,
    'geometry', ST_AsGeoJSON(f.geom, ${PRECISION})::json,
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

/** POST answer: the stored Feature plus what was repaired on the way (RFC 7946 foreign member). */
export interface CreatedFeature extends Feature {
  warnings: string[];
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

const FK_VIOLATION = '23503';

@Injectable()
export class FieldsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly boundary: BoundaryService,
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
      return { ...(await this.findOne(orgId, row.id)), warnings };
    } catch (e) {
      if ((e as { code?: string }).code === FK_VIOLATION) {
        throw new NotFoundException('organization not found');
      }
      throw e;
    }
  }

  async findOne(orgId: string, id: string): Promise<Feature> {
    const [row] = await this.db.query<{ feature: Feature }[]>(
      `SELECT ${FEATURE_SQL} AS feature FROM fields f WHERE f.id = $1 AND f.org_id = $2`,
      [id, orgId],
    );
    // another organisation's field is "not found", not "forbidden": don't leak that it exists
    if (!row) throw new NotFoundException('field not found');
    return row.feature;
  }

  /** The whole collection is aggregated in SQL: one row, no mapping loop in Node. */
  async list(orgId: string): Promise<FeatureCollection> {
    const [row] = await this.db.query<{ collection: FeatureCollection }[]>(
      `SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(json_agg(${FEATURE_SQL} ORDER BY f.created_at, f.id), '[]'::json)
              ) AS collection
         FROM fields f
        WHERE f.org_id = $1`,
      [orgId],
    );
    return row.collection;
  }
}
