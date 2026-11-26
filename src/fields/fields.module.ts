import { Module } from '@nestjs/common';
import { BoundaryService } from '../geo/boundary.service';
import { SoilModule } from '../soil/soil.module';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';
import { OverlapsService } from './overlaps.service';

@Module({
  imports: [SoilModule],
  controllers: [FieldsController],
  providers: [FieldsService, BoundaryService, OverlapsService],
})
export class FieldsModule {}
