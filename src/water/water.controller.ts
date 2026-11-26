import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { OrgId } from '../common/org-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { waterBodyFeature, WaterBodyInput, waterZonesQuery, WaterZonesQuery } from './water.schema';
import { WaterService, WaterZones } from './water.service';

const GEOJSON = 'application/geo+json';

@Controller()
export class WaterController {
  constructor(private readonly water: WaterService) {}

  /**
   * Reference data shared by all organisations. Open here so the API can be
   * tried by hand; in production only an admin / import job writes it.
   */
  @Post('water-bodies')
  @Header('Content-Type', GEOJSON)
  create(@Body(new ZodValidationPipe(waterBodyFeature)) body: WaterBodyInput) {
    return this.water.create(body);
  }

  @Get('fields/:id/water-zones')
  @Header('Content-Type', GEOJSON)
  zones(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(waterZonesQuery, 'Invalid query')) query: WaterZonesQuery,
  ): Promise<WaterZones> {
    return this.water.zones(orgId, id, query.buffer_m);
  }
}
