import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  GiveAppAccessSchema,
  RegisterDeviceSchema,
  RevokeAppAccessSchema,
  type DriverAppAccess,
  type GiveAppAccessRequest,
  type GiveAppAccessResponse,
  type MobileDevice,
  type MobileNotificationsResponse,
  type RegisterDeviceRequest,
} from '@neway/shared';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AppAccessService } from './app-access.service';
import { MobileNotificationsService } from './mobile-notifications.service';

const OWN = 'own devices and own notifications only; the user and membership come from the session';

/** Devices and the notification inbox of whoever is signed in, driver or office (docs/mobile/API.md). */
@Controller('mobile')
export class MobileController {
  constructor(private readonly notifications: MobileNotificationsService) {}

  @Post('devices')
  @HttpCode(200)
  @SignedInOnly(OWN)
  register(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(RegisterDeviceSchema)) body: RegisterDeviceRequest): Promise<MobileDevice> {
    return this.notifications.registerDevice(principal, body);
  }

  @Get('devices')
  @SignedInOnly(OWN)
  @Header('Cache-Control', 'private, no-store')
  devices(@CurrentPrincipal() principal: Principal): Promise<MobileDevice[]> {
    return this.notifications.myDevices(principal);
  }

  @Post('devices/:id/revoke')
  @HttpCode(200)
  @SignedInOnly(OWN)
  revoke(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<MobileDevice> {
    return this.notifications.revokeDevice(principal, id);
  }

  @Get('notifications')
  @SignedInOnly(OWN)
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal, @Query('limit') limit?: string): Promise<MobileNotificationsResponse> {
    return this.notifications.list(principal, Number(limit) || 50);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  @SignedInOnly(OWN)
  read(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<{ ok: true }> {
    return this.notifications.markRead(principal, id);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @SignedInOnly(OWN)
  readAll(@CurrentPrincipal() principal: Principal): Promise<{ updated: number }> {
    return this.notifications.markAllRead(principal);
  }
}

/** Driver app access on the driver's profile (office side). */
@Controller('drivers')
export class AppAccessController {
  constructor(private readonly access: AppAccessService) {}

  @Get(':idOrNumber/app-access')
  @RequireAnyPermission('drivers.view', 'drivers.edit')
  @Header('Cache-Control', 'private, no-store')
  status(@CurrentPrincipal() principal: Principal, @Param('idOrNumber') idOrNumber: string): Promise<DriverAppAccess> {
    return this.access.status(principal, idOrNumber);
  }

  @Post(':idOrNumber/app-access')
  @HttpCode(200)
  @RequirePermission('drivers.edit')
  @Header('Cache-Control', 'private, no-store')
  give(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(new ZodValidationPipe(GiveAppAccessSchema)) body: GiveAppAccessRequest,
  ): Promise<GiveAppAccessResponse> {
    return this.access.give(principal, idOrNumber, body ?? {});
  }

  @Post(':idOrNumber/app-access/revoke')
  @HttpCode(200)
  @RequirePermission('drivers.edit')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('idOrNumber') idOrNumber: string,
    @Body(new ZodValidationPipe(RevokeAppAccessSchema)) body: { reason: string },
  ): Promise<DriverAppAccess> {
    return this.access.revoke(principal, idOrNumber, body.reason);
  }
}
