import { Module } from '@nestjs/common';
import { BoundaryService } from '../geo/boundary.service';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';
import { OverlapsService } from './overlaps.service';

@Module({
  controllers: [FieldsController],
  providers: [FieldsService, BoundaryService, OverlapsService],
})
export class FieldsModule {}
