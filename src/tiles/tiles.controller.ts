import { createHash } from 'node:crypto';
import { Controller, Get, Header, Headers, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OrgId } from '../common/org-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MAP_PAGE } from './map.page';
import { tileParams, TileParams } from './tiles.schema';
import { TilesService } from './tiles.service';

export const MVT = 'application/vnd.mapbox-vector-tile';

@Controller()
export class TilesController {
  constructor(private readonly tiles: TilesService) {}

  /**
   * One vector tile. Empty → 204 (MapLibre draws nothing and does not retry).
   * The tiles of an organisation are private (`x-org-id`) and change when a
   * field is drawn, so: `private`, a short max-age, and an ETag — a map
   * panning back over the same tiles revalidates with If-None-Match and gets
   * 304 without the body.
   */
  @Get('tiles/:z/:x/:y.mvt')
  async tile(
    @OrgId() orgId: string,
    @Param(new ZodValidationPipe(tileParams, 'Invalid tile')) params: TileParams,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer | undefined> {
    const tile = await this.tiles.tile(orgId, params);
    reply.header('Cache-Control', 'private, max-age=60');
    if (tile.length === 0) {
      reply.status(204);
      return undefined;
    }
    const etag = `"${createHash('sha1').update(tile).digest('base64url')}"`;
    reply.header('ETag', etag);
    if (ifNoneMatch === etag) {
      reply.status(304);
      return undefined;
    }
    reply.header('Content-Type', MVT);
    return tile;
  }

  /** A MapLibre page over the tiles, for trying them by hand: /map?org=<uuid>. */
  @Get('map')
  @Header('Content-Type', 'text/html; charset=utf-8')
  map(): string {
    return MAP_PAGE;
  }
}
