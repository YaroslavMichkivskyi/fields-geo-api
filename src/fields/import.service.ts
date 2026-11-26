import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BoundaryService } from '../geo/boundary.service';
import { fieldFeature, type FieldFeatureInput } from '../geo/geojson.schema';
import { SoilService } from '../soil/soil.service';
import type { ImportCollection, ImportQuery } from './import.schema';

const FK_VIOLATION = '23503';

export interface ImportError {
  /** position of the Feature in the uploaded `features` array */
  index: number;
  /** properties.name when it could be read, to find the Feature in the source file */
  name: string | null;
  /** 'schema' — shape of the GeoJSON; 'geometry' — PostGIS rejected the boundary */
  stage: 'schema' | 'geometry';
  messages: string[];
}

export interface ImportResult {
  mode: ImportQuery['mode'];
  received: number;
  imported: number;
  failed: number;
  fields: { index: number; id: string; name: string; warnings: string[] }[];
  errors: ImportError[];
  adoptedSamples: number;
}

/**
 * Bulk import of a FeatureCollection, in a fixed number of queries whatever
 * its size: one to check every boundary, one INSERT for all fields, one UPDATE
 * for the soil samples they adopt.
 */
@Injectable()
export class ImportService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly boundary: BoundaryService,
    private readonly soil: SoilService,
  ) {}

  async import(orgId: string, body: ImportCollection, { mode }: ImportQuery): Promise<ImportResult> {
    const errors: ImportError[] = [];
    const nameOf = (f: unknown): string | null => {
      const name = (f as { properties?: { name?: unknown } })?.properties?.name;
      return typeof name === 'string' ? name : null;
    };

    // 1. shape: each Feature on its own, so one bad Feature is one error line
    const valid: { index: number; feature: FieldFeatureInput }[] = [];
    body.features.forEach((raw, index) => {
      const parsed = fieldFeature.safeParse(raw);
      if (parsed.success) valid.push({ index, feature: parsed.data });
      else
        errors.push({
          index,
          name: nameOf(raw),
          stage: 'schema',
          messages: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
        });
    });

    // 2. geometry: every boundary checked and repaired by PostGIS in ONE query (M2 rules)
    const checked = await this.boundary.prepareMany(valid.map((v) => v.feature.geometry));
    const ready = valid.flatMap((v, k) => {
      const result = checked[k];
      if (result.ok) return [{ ...v, ewkb: result.ewkb, warnings: result.warnings }];
      errors.push({ index: v.index, name: v.feature.properties.name, stage: 'geometry', messages: [result.error] });
      return [];
    });
    errors.sort((a, b) => a.index - b.index);

    const result = (fields: ImportResult['fields'], adoptedSamples: number): ImportResult => ({
      mode,
      received: body.features.length,
      imported: fields.length,
      failed: errors.length,
      fields,
      errors,
      adoptedSamples,
    });

    // all or nothing: one error rejects the file, and the client gets every error at once
    if (mode === 'atomic' && errors.length > 0) {
      throw new UnprocessableEntityException({ statusCode: 422, message: 'import rejected', ...result([], 0) });
    }
    if (ready.length === 0) {
      throw new UnprocessableEntityException({ statusCode: 422, message: 'nothing to import', ...result([], 0) });
    }

    // 3. one INSERT for all fields; the batch is one JSON parameter, ids are generated
    //    up front so each stored row can be matched back to its position in the file
    const rows = ready.map((r) => ({
      i: r.index,
      name: r.feature.properties.name,
      crop: r.feature.properties.crop ?? null,
      season: r.feature.properties.season ?? null,
      ewkb: r.ewkb,
    }));
    try {
      return await this.db.transaction(async (m) => {
        const stored = await m.query<{ i: number; id: string }[]>(
          `WITH input AS (
             SELECT r.*, gen_random_uuid() AS id
               FROM json_to_recordset($2::json) AS r(i int, name text, crop text, season smallint, ewkb text)
           ),
           ins AS (
             INSERT INTO fields (id, org_id, name, crop, season, geom)
             SELECT id, $1, name, crop, season, ewkb::geometry FROM input
             RETURNING id
           )
           SELECT input.i, input.id FROM input JOIN ins USING (id) ORDER BY input.i`,
          [orgId, JSON.stringify(rows)],
        );
        const adopted = await this.soil.assignToFields(orgId, stored.map((s) => s.id), m);
        const byIndex = new Map(ready.map((r) => [r.index, r]));
        return result(
          stored.map((s) => ({
            index: s.i,
            id: s.id,
            name: byIndex.get(s.i)!.feature.properties.name,
            warnings: byIndex.get(s.i)!.warnings,
          })),
          adopted,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === FK_VIOLATION) throw new NotFoundException('organization not found');
      throw e;
    }
  }
}
