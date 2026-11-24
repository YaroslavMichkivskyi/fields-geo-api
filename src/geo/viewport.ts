import { z } from 'zod';

/**
 * Query of GET /fields: the map viewport and its zoom.
 *
 *   ?bbox=minLng,minLat,maxLng,maxLat   the visible area (GeoJSON bbox order)
 *   &zoom=0..22                         web-map zoom level, for simplification
 */
export const viewportQuery = z.object({
  bbox: z
    .string()
    .transform((s, ctx) => {
      const parts = s.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        ctx.addIssue({ code: 'custom', message: 'bbox is minLng,minLat,maxLng,maxLat - four numbers' });
        return z.NEVER;
      }
      const [minLng, minLat, maxLng, maxLat] = parts;
      if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
        ctx.addIssue({ code: 'custom', message: 'bbox is out of range (longitude ±180, latitude ±90)' });
        return z.NEVER;
      }
      if (minLng >= maxLng || minLat >= maxLat) {
        ctx.addIssue({ code: 'custom', message: 'bbox min must be below max (west,south,east,north)' });
        return z.NEVER;
      }
      return parts as [number, number, number, number];
    })
    .optional(),
  zoom: z.coerce.number().int().min(0).max(22).optional(),
});
export type ViewportQuery = z.infer<typeof viewportQuery>;

/**
 * Simplification tolerance in degrees for a zoom level: half a screen pixel.
 * A web map at zoom z is 256 * 2^z pixels wide for 360° of longitude, so
 * detail finer than half a pixel cannot be seen and is not worth sending.
 */
export function toleranceForZoom(zoom: number): number {
  return 360 / (256 * 2 ** zoom) / 2;
}
