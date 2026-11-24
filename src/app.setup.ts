import type { NestFastifyApplication } from '@nestjs/platform-fastify';

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
