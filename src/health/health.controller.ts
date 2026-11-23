import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface Health {
  status: 'ok';
  db: 'ok';
  postgis: string;
}

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get()
  async check(): Promise<Health> {
    // fails (500) if the database is down or the extension was never created
    const [row] = await this.db.query<{ version: string }[]>(
      'SELECT postgis_full_version() AS version',
    );
    return { status: 'ok', db: 'ok', postgis: row.version };
  }
}
