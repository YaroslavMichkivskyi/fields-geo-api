import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { POLYGON_MIN_ZOOM, TileParams } from './tiles.schema';

/** Tile coordinate space: geometry is quantised to a 4096 x 4096 grid (the MVT default). */
const EXTENT = 4096;
/** Polygons are kept this far outside the tile, so outlines do not show seams at tile edges. */
const BUFFER = 64;
/** Below POLYGON_MIN_ZOOM fields are counted in a CELLS x CELLS grid per tile. */
const CELLS = 32;
/** Width of the Web Mercator world in metres (2 * pi * 6378137). */
const WORLD_M = 40075016.68557849;

/**
 * Bounds of the tile: `env` in Web Mercator (SRID 3857), what ST_AsMVTGeom
 * maps onto the 0..4096 grid; `q` the same box (plus the buffer) in WGS 84
 * for the `&&` filter, so the GiST index on `fields.geom` answers it. The
 * edges of a Mercator tile are meridians and parallels, so the box is exact
 * in 4326 too.
 */
const BOUNDS = `
  b AS (SELECT ST_TileEnvelope($2, $3, $4) AS env,
               ST_Transform(ST_TileEnvelope($2, $3, $4, margin => $5), 4326) AS q)`;

/**
 * One field per feature: the outline clipped to the tile (+ buffer) and
 * snapped to the tile grid, which is also the simplification: detail finer
 * than 1/4096 of a tile cannot be drawn. Outlines that collapse below one
 * grid cell come back NULL and are skipped.
 */
const POLYGONS_SQL = `
  WITH ${BOUNDS},
  t AS (
    SELECT f.id, f.name, f.crop, f.season, f.area_ha::float8 AS "areaHa",
           ST_AsMVTGeom(ST_Transform(f.geom, 3857), b.env, ${EXTENT}, ${BUFFER}, true) AS geom
      FROM fields f, b
     WHERE f.org_id = $1 AND f.geom && b.q)
  SELECT ST_AsMVT(t.*, 'fields', ${EXTENT}, 'geom') AS tile FROM t WHERE t.geom IS NOT NULL`;

/**
 * Fields counted per grid cell: every field goes to the cell of its
 * centroid, one point per non-empty cell at the mean position of those
 * centroids. The grid is anchored at a cell corner (origin = half a cell)
 * and a tile is exactly CELLS cells wide, so cells never straddle tiles and
 * a field is counted in exactly one tile of a zoom level, even when its
 * outline crosses a tile edge.
 */
const CLUSTERS_SQL = `
  WITH ${BOUNDS},
  c AS (
    SELECT ST_Transform(ST_Centroid(f.geom), 3857) AS p, f.area_ha
      FROM fields f, b
     WHERE f.org_id = $1 AND f.geom && b.q),
  g AS (
    SELECT count(*)::int AS count, round(sum(c.area_ha), 1)::float8 AS "areaHa",
           ST_AsMVTGeom(ST_Centroid(ST_Collect(c.p)), b.env, ${EXTENT}, 0, true) AS geom
      FROM c, b
     GROUP BY ST_SnapToGrid(c.p, $6::float8 / 2, $6::float8 / 2, $6::float8, $6::float8), b.env)
  SELECT ST_AsMVT(g.*, 'clusters', ${EXTENT}, 'geom') AS tile FROM g WHERE g.geom IS NOT NULL`;

@Injectable()
export class TilesService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /**
   * A Mapbox Vector Tile (protobuf) of the organisation's fields: layer
   * `fields` (polygons with id, name, crop, season, areaHa) from zoom
   * POLYGON_MIN_ZOOM, layer `clusters` (points with count, areaHa) below.
   * An empty Buffer when the tile has nothing.
   */
  async tile(orgId: string, { z, x, y }: TileParams): Promise<Buffer> {
    const polygons = z >= POLYGON_MIN_ZOOM;
    const params: unknown[] = [orgId, z, x, y, polygons ? BUFFER / EXTENT : 0];
    if (!polygons) params.push(WORLD_M / 2 ** z / CELLS);
    const [row] = await this.db.query<{ tile: Buffer | null }[]>(polygons ? POLYGONS_SQL : CLUSTERS_SQL, params);
    return row?.tile ?? Buffer.alloc(0);
  }
}
