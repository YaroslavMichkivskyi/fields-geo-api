import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { OrgId } from '../common/org-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { soilSampleCollection, SoilSampleCollectionInput } from './soil.schema';
import { CreatedSamples, SoilService, SoilStats } from './soil.service';

const GEOJSON = 'application/geo+json';

@Controller()
export class SoilController {
  constructor(private readonly soil: SoilService) {}

  /** A batch of samples; each is placed in the field that covers it. */
  @Post('soil-samples')
  @Header('Content-Type', GEOJSON)
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(soilSampleCollection)) body: SoilSampleCollectionInput,
  ): Promise<CreatedSamples> {
    return this.soil.create(orgId, body);
  }

  /** Samples that fell in no field, with the nearest one. */
  @Get('soil-samples/unassigned')
  @Header('Content-Type', GEOJSON)
  unassigned(@OrgId() orgId: string) {
    return this.soil.unassigned(orgId);
  }

  @Get('fields/:id/soil-stats')
  stats(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string): Promise<SoilStats> {
    return this.soil.stats(orgId, id);
  }
}
