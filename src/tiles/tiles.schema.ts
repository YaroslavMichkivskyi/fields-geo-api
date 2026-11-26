import { z } from 'zod';

/** Deepest zoom served. A tile at z 22 is ~10 m wide; nothing on a field needs more. */
export const MAX_TILE_ZOOM = 22;

/** From this zoom up a tile carries the field polygons; below it, clusters (see TilesService). */
export const POLYGON_MIN_ZOOM = 10;

const int = z.coerce.number().int().min(0);

/**
 * Path of GET /tiles/:z/:x/:y.mvt — the XYZ ("slippy map") scheme used by
 * MapLibre / Leaflet / OpenLayers: at zoom z the world is 2^z x 2^z tiles,
 * x from the antimeridian eastwards, y from the north pole southwards.
 */
export const tileParams = z
  .object({ z: int.max(MAX_TILE_ZOOM), x: int, y: int })
  .superRefine((t, ctx) => {
    const n = 2 ** t.z;
    if (t.x >= n || t.y >= n) {
      ctx.addIssue({ code: 'custom', message: `at zoom ${t.z} x and y are 0..${n - 1}` });
    }
  });
export type TileParams = z.infer<typeof tileParams>;
