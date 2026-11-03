import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@neway/shared';
import { APP_VERSION } from '../../config/version';
import { Public } from '../../common/auth/public.decorator';

@Controller('health')
export class HealthController {
  /** Liveness probe. Deliberately has no database dependency in Phase 0. */
  @Public()
  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
