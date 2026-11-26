import { z } from 'zod';
import { position } from '../geo/geojson.schema';
import { inServiceArea } from '../geo/service-area';

/** The widest protection strip of the Water Code (large rivers) — the default search radius. */
export const MAX_ZONE_M = 100;

const lineCoordinates = z.array(position).min(2, 'a line needs at least 2 positions');

const lineGeometry = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('LineString'), coordinates: lineCoordinates }),
    z.object({ type: z.literal('MultiLineString'), coordinates: z.array(lineCoordinates).min(1) }),
  ],
  { errorMap: () => ({ message: 'geometry type must be LineString or MultiLineString' }) },
);

/** POST /water-bodies body: a river / stream / canal as a line. */
export const waterBodyFeature = z
  .object({
    type: z.literal('Feature'),
    geometry: lineGeometry,
    properties: z.object({
      name: z.string().trim().min(1).max(200),
      size: z.enum(['small', 'medium', 'large']),
    }),
  })
  .passthrough()
  .superRefine((f, ctx) => {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const [lng, lat] of lines.flat()) {
      if (!inServiceArea(lng, lat)) {
        ctx.addIssue({
          code: 'custom',
          path: ['geometry', 'coordinates'],
          message: `position [${lng}, ${lat}] is outside the service area (Ukraine) - lng and lat swapped?`,
        });
        return;
      }
    }
  });
export type WaterBodyInput = z.infer<typeof waterBodyFeature>;

/** GET /fields/:id/water-zones?buffer_m= — overrides the strip width of every water body. */
export const waterZonesQuery = z.object({
  buffer_m: z.coerce.number().int().min(1).max(500).optional(),
});
export type WaterZonesQuery = z.infer<typeof waterZonesQuery>;
