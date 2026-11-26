import { Module } from '@nestjs/common';
import { SoilController } from './soil.controller';
import { SoilService } from './soil.service';

@Module({
  controllers: [SoilController],
  providers: [SoilService],
  exports: [SoilService], // FieldsService adopts orphan samples when a field is drawn
})
export class SoilModule {}
