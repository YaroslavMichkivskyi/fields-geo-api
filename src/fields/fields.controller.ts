import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { OrgId } from '../common/org-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { fieldFeature, FieldFeatureInput } from '../geo/geojson.schema';
import { viewportQuery, ViewportQuery } from '../geo/viewport';
import { CreatedFeature, Extent, Feature, FeatureCollection, FieldsService } from './fields.service';
import { Collection, FieldOverlap, OverlapPair, OverlapsService } from './overlaps.service';

/** RFC 7946 media type; clients that only know JSON parse it the same way. */
const GEOJSON = 'application/geo+json';

@Controller('fields')
export class FieldsController {
  constructor(
    private readonly fields: FieldsService,
    private readonly overlaps: OverlapsService,
  ) {}

  @Post()
  @Header('Content-Type', GEOJSON)
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(fieldFeature)) body: FieldFeatureInput,
  ): Promise<CreatedFeature> {
    return this.fields.create(orgId, body);
  }

  @Get()
  @Header('Content-Type', GEOJSON)
  list(
    @OrgId() orgId: string,
    @Query(new ZodValidationPipe(viewportQuery, 'Invalid query')) query: ViewportQuery,
  ): Promise<FeatureCollection> {
    return this.fields.list(orgId, query);
  }

  // declared before ':id' so that "extent" / "overlaps" are never read as an id
  @Get('extent')
  extent(@OrgId() orgId: string): Promise<Extent> {
    return this.fields.extent(orgId);
  }

  /** Every overlapping pair of the organisation once. */
  @Get('overlaps')
  @Header('Content-Type', GEOJSON)
  overlapReport(@OrgId() orgId: string): Promise<Collection<OverlapPair>> {
    return this.overlaps.report(orgId);
  }

  @Get(':id')
  @Header('Content-Type', GEOJSON)
  findOne(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string): Promise<Feature> {
    return this.fields.findOne(orgId, id);
  }

  @Get(':id/overlaps')
  @Header('Content-Type', GEOJSON)
  overlapsOf(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string): Promise<Collection<FieldOverlap>> {
    return this.overlaps.ofField(orgId, id);
  }
}
