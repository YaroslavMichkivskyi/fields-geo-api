import { z } from 'zod';
import { inServiceArea } from './service-area';

/** Wider than this is not "near" but a region: use the viewport query. */
export const MAX_RADIUS_KM = 200;
/** Nearest-N is for "the closest few", not for paging through every field. */
export const MAX_NEAREST = 100;

/**
 * Query of GET /fields/near.
 *
 *   from:  ?lng=&lat=            a point                       — one of the two
 *          ?warehouse=<uuid>     a warehouse of the organisation
 *   what:  &radius_km=           every field within the radius — at least one;
 *          &limit=               the N nearest                   both = N nearest within the radius
 */
export const nearQuery = z
  .object({
    lng: z.coerce.number().min(-180).max(180).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    warehouse: z.string().uuid().optional(),
    radius_km: z.coerce.number().positive().max(MAX_RADIUS_KM).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_NEAREST).optional(),
  })
  .superRefine((q, ctx) => {
    const point = q.lng !== undefined || q.lat !== undefined;
    if (point && (q.lng === undefined || q.lat === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'lng and lat go together' });
    }
    if (point === (q.warehouse !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give either lng & lat or warehouse' });
    }
    if (q.lng !== undefined && q.lat !== undefined && !inServiceArea(q.lng, q.lat)) {
      ctx.addIssue({ code: 'custom', message: `[${q.lng}, ${q.lat}] is outside the service area (Ukraine) - lng and lat swapped?` });
    }
    if (q.radius_km === undefined && q.limit === undefined) {
      ctx.addIssue({ code: 'custom', message: 'give radius_km, limit or both' });
    }
  })
  .transform((q) => ({
    from: q.warehouse !== undefined ? { warehouse: q.warehouse } : { lng: q.lng!, lat: q.lat! },
    radiusM: q.radius_km !== undefined ? q.radius_km * 1000 : undefined,
    limit: q.limit,
  }));
export type NearQuery = z.infer<typeof nearQuery>;
