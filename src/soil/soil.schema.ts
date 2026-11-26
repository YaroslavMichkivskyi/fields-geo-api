import { z } from 'zod';
import { position } from '../geo/geojson.schema';
import { inServiceArea } from '../geo/service-area';

/** One upload is one trip to the fields, not an archive: bigger files go through bulk import. */
export const MAX_SAMPLES = 1000;

const soilSample = z
  .object({
    type: z.literal('Feature'),
    geometry: z.object({ type: z.literal('Point', { message: 'geometry type must be Point' }), coordinates: position }),
    properties: z.object({
      takenAt: z.string().datetime({ offset: true, message: 'takenAt is an ISO 8601 date-time' }),
      ph: z.number().min(0).max(14).optional(),
      humus: z.number().min(0).max(100).optional(),
    }),
  })
  .passthrough();

/** POST /soil-samples body: a FeatureCollection of Points with lab results. */
export const soilSampleCollection = z
  .object({
    type: z.literal('FeatureCollection'),
    features: z.array(soilSample).min(1, 'no samples').max(MAX_SAMPLES, `at most ${MAX_SAMPLES} samples per upload`),
  })
  .superRefine((fc, ctx) => {
    fc.features.forEach((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      if (!inServiceArea(lng, lat)) {
        ctx.addIssue({
          code: 'custom',
          path: ['features', i, 'geometry', 'coordinates'],
          message: `position [${lng}, ${lat}] is outside the service area (Ukraine) - lng and lat swapped?`,
        });
      }
    });
  });
export type SoilSampleCollectionInput = z.infer<typeof soilSampleCollection>;
