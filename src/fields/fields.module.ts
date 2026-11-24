import { Module } from '@nestjs/common';
import { BoundaryService } from '../geo/boundary.service';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';

@Module({
  controllers: [FieldsController],
  providers: [FieldsService, BoundaryService],
})
export class FieldsModule {}
