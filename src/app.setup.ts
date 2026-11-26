import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Fastify refuses bodies over 1 MB by default (413). A bulk import of a few
 * thousand fields is several MB of GeoJSON; 20 MB still keeps a runaway
 * upload out of memory.
 */
export const BODY_LIMIT = 20 * 1024 * 1024;

export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({ bodyLimit: BODY_LIMIT });
}

/** Everything main.ts and the tests must configure the same way. */
export function configureApp(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  // accept bodies sent as application/geo+json, parsed by Fastify's own safe JSON parser
  fastify.addContentTypeParser(
    'application/geo+json',
    { parseAs: 'string' },
    fastify.getDefaultJsonParser('error', 'error'),
  );
}
