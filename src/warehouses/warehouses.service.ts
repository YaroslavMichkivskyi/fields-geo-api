import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WarehouseFeatureInput } from '../geo/geojson.schema';

export interface WarehouseFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { name: string; createdAt: string };
}

const FK_VIOLATION = '23503';

@Injectable()
export class WarehousesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async create(orgId: string, input: WarehouseFeatureInput): Promise<WarehouseFeature> {
    const [lng, lat] = input.geometry.coordinates; // an altitude, if sent, is dropped
    try {
      const [row] = await this.db.query<{ feature: WarehouseFeature }[]>(
        `INSERT INTO warehouses (org_id, name, geom)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326))
         RETURNING json_build_object(
           'type', 'Feature',
           'id', id,
           'geometry', ST_AsGeoJSON(geom, 6)::json,
           'properties', json_build_object('name', name, 'createdAt', created_at)) AS feature`,
        [orgId, input.properties.name, lng, lat],
      );
      return row.feature;
    } catch (e) {
      if ((e as { code?: string }).code === FK_VIOLATION) {
        throw new NotFoundException('organization not found');
      }
      throw e;
    }
  }
}
