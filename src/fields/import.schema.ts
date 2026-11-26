import { z } from 'zod';

/** One import = one farm's fields, not a country: a bigger file is split by the client. */
export const MAX_IMPORT = 5000;

/**
 * The envelope only. Every Feature is validated on its own later (fieldFeature),
 * so that one broken Feature produces one error line, not a 400 for the file.
 */
export const importCollection = z.object({
  type: z.literal('FeatureCollection', { message: 'expected a GeoJSON FeatureCollection' }),
  features: z
    .array(z.unknown())
    .min(1, 'the collection has no features')
    .max(MAX_IMPORT, `at most ${MAX_IMPORT} features per import`),
});
export type ImportCollection = z.infer<typeof importCollection>;

/**
 *   partial (default) — import every valid Feature, report the rest;
 *   atomic            — any error rejects the whole file, nothing is stored.
 */
export const importQuery = z.object({
  mode: z.enum(['partial', 'atomic']).default('partial'),
});
export type ImportQuery = z.infer<typeof importQuery>;
