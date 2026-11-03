import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSIONS_KEY = 'auth:requiredPermissions';

/** Declares permissions the principal must hold; class and method declarations are merged. */
export function RequirePermission(...permissions: string[]): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
}

export const REQUIRED_ANY_PERMISSION_KEY = 'auth:requiredAnyPermission';

/**
 * Passes when the principal holds at least one of the codes. For a page that several roles reach
 * by different grants - the Weekly Board by `dispatch.view` or by `board_weekly.view`.
 */
export function RequireAnyPermission(...permissions: string[]): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_ANY_PERMISSION_KEY, permissions);
}
