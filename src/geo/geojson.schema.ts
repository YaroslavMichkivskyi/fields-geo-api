import { z } from 'zod';
import { inServiceArea } from './service-area';

/*
 * GeoJSON (RFC 7946) as accepted by the API.
 *
 *   Position         [lng, lat] or [lng, lat, altitude] — longitude FIRST
 *   LinearRing       closed list of >= 4 positions (first == last)
 *   Polygon          [outer ring, ...holes]
 *   MultiPolygon     [polygon, polygon, ...]
 *   Feature          { type, geometry, properties, id? }
 *
 * Shape only. Whether a ring crosses itself is a question for PostGIS (M2).
 */

export const position = z
  .array(z.number().finite())
  .min(2, 'a position is [longitude, latitude]')
  .max(3, 'a position has at most 3 numbers: [longitude, latitude, altitude]')
  .superRefine(([lng, lat], ctx) => {
    if (lng < -180 || lng > 180) {
      ctx.addIssue({ code: 'custom', message: 'longitude must be within -180..180 (order is [lng, lat])' });
    }
    if (lat < -90 || lat > 90) {
      ctx.addIssue({ code: 'custom', message: 'latitude must be within -90..90 (order is [lng, lat])' });
    }
  });

export const linearRing = z
  .array(position)
  .min(4, 'a linear ring needs at least 4 positions (a triangle plus the closing one)')
  .refine((ring) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first.length === last.length && first.every((v, i) => v === last[i]);
  }, 'a linear ring must be closed: the last position equals the first');

export const polygonCoordinates = z.array(linearRing).min(1, 'a polygon needs an outer ring');

export const polygonGeometry = z.object({
  type: z.literal('Polygon'),
  coordinates: polygonCoordinates,
});

export const multiPolygonGeometry = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(polygonCoordinates).min(1, 'a multipolygon needs at least one polygon'),
});

/** A field boundary: Polygon or MultiPolygon, nothing else. */
export const areaGeometry = z.discriminatedUnion('type', [polygonGeometry, multiPolygonGeometry], {
  errorMap: () => ({ message: 'geometry type must be Polygon or MultiPolygon' }),
});
export type AreaGeometry = z.infer<typeof areaGeometry>;

function* positionsOf(geometry: AreaGeometry): Generator<number[]> {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) yield* ring;
}

/** POST /fields body: a Feature whose properties describe the field. */
export const fieldFeature = z
  .object({
    type: z.literal('Feature'),
    geometry: areaGeometry,
    properties: z.object({
      name: z.string().trim().min(1).max(200),
      crop: z.string().trim().min(1).max(100).optional(),
      season: z.number().int().min(2000).max(2100).optional(),
    }),
  })
  .passthrough()
  .superRefine((feature, ctx) => {
    // pre-2016 GeoJSON could name another coordinate system; RFC 7946 is always WGS 84
    if ('crs' in feature) {
      ctx.addIssue({
        code: 'custom',
        path: ['crs'],
        message: '"crs" is not supported: GeoJSON coordinates are always WGS 84 longitude/latitude',
      });
    }
    for (const [lng, lat] of positionsOf(feature.geometry)) {
      if (!inServiceArea(lng, lat)) {
        ctx.addIssue({
          code: 'custom',
          path: ['geometry', 'coordinates'],
          message: `position [${lng}, ${lat}] is outside the service area (Ukraine); GeoJSON order is [longitude, latitude] - were they swapped?`,
        });
        return; // one message is enough
      }
    }
  });
export type FieldFeatureInput = z.infer<typeof fieldFeature>;
