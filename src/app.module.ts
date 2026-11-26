import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dbOptions } from './database/db-options';
import { FieldsModule } from './fields/fields.module';
import { HealthController } from './health/health.controller';
import { TilesModule } from './tiles/tiles.module';
import { WarehousesModule } from './warehouses/warehouses.module';
import { WaterModule } from './water/water.module';

@Module({
  imports: [
    // loads .env into process.env; variables already set win
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => dbOptions(process.env),
    }),
    FieldsModule,
    WarehousesModule,
    WaterModule,
    TilesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
