import { Body, Controller, Header, Post } from '@nestjs/common';
import { OrgId } from '../common/org-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { warehouseFeature, WarehouseFeatureInput } from '../geo/geojson.schema';
import { WarehouseFeature, WarehousesService } from './warehouses.service';

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Post()
  @Header('Content-Type', 'application/geo+json')
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(warehouseFeature)) body: WarehouseFeatureInput,
  ): Promise<WarehouseFeature> {
    return this.warehouses.create(orgId, body);
  }
}
