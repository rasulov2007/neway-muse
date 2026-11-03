import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  ReplaceTemporaryPasswordRequestSchema,
  type AuthAccount,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type ReplaceTemporaryPasswordRequest,
  UpdatePreferencesRequestSchema,
  SwitchCompanyRequestSchema,
  type SwitchCompanyRequest,
  type Appearance,
  type UpdatePreferencesRequest,
} from '@neway/shared';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { AllowBeforeProfile, AllowTemporaryPassword, Public } from '../../common/auth/public.decorator';
import type { Principal } from '../../common/auth/principal';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AppError } from '../../common/errors/app-error';
import { AuthService } from './auth.service';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';

const pipe = {
  login: new ZodValidationPipe(LoginRequestSchema),
  changePassword: new ZodValidationPipe(ChangePasswordRequestSchema),
  replaceTemporary: new ZodValidationPipe(ReplaceTemporaryPasswordRequestSchema),
  preferences: new ZodValidationPipe(UpdatePreferencesRequestSchema),
} as const;

/** Bearer token off the request, or null. */
export function bearer(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const [scheme, token] = value.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Signing in.
 *
 * These routes are deliberately outside the guards: a person who is not signed in cannot hold a
 * permission, and asking "who am I" has to be answerable before the answer is known. Everything
 * else in the API is behind `AuthenticatedGuard`.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body(pipe.login) body: LoginRequest,
    @Req() req: FastifyRequest,
  ): Promise<LoginResponse> {
    return this.auth.login(body, {
      userAgent:
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      ip: req.ip,
    });
  }

  @Public()
  /** One login, several companies (owner, 2026-10-13): move this session to another of them. */
  @Post('switch-company')
  @HttpCode(200)
  async switchCompany(
    @CurrentPrincipal() principal: Principal,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(SwitchCompanyRequestSchema)) body: SwitchCompanyRequest,
  ): Promise<LoginResponse> {
    const token = bearer(req as unknown as { headers: Record<string, unknown> });
    if (!token || principal.signedIn !== true || !principal.userId) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Not signed in.' });
    }
    return this.auth.switchCompany(token, principal.userId, body.companyId, { userAgent: req.headers['user-agent'], ip: req.ip });
  }

  @AllowBeforeProfile()
  @SignedInOnly('ends the session of the caller')
  @Post('logout')
  async logout(@Req() req: FastifyRequest): Promise<{ ok: true }> {
    const token = bearer(req as unknown as { headers: Record<string, unknown> });
    if (token) await this.auth.logout(token);
    return { ok: true };
  }

  /**
   * Who the request is acting as.
   *
   * 401 when nobody is: this is the call the client uses to decide between the application and the
   * login screen, and a fabricated answer here is what let the product run for months with no way
   * to sign in.
   */
  @Public()
  @Get('me')
  async me(
    @CurrentPrincipal() principal: Principal,
  ): Promise<AuthAccount & { signedIn: boolean }> {
    // `CurrentPrincipal` raises 401 when the request proved nothing, which is the answer.
    const membershipId = principal.membershipId;
    if (!membershipId || principal.signedIn !== true) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Not signed in.' });
    }
    return { ...(await this.auth.account(membershipId)), signedIn: true };
  }

  /**
   * The worker's own Light / Dark / System choice. A person can only change their own value: the
   * user comes from the session, never from the body.
   */
  @SignedInOnly('own appearance only; the user comes from the session')
  @Patch('me/preferences')
  async updatePreferences(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.preferences) body: UpdatePreferencesRequest,
  ): Promise<{ appearance: Appearance }> {
    if (!principal.userId || principal.signedIn !== true) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Not signed in.' });
    }
    await this.auth.updatePreferences(principal.userId, body);
    return { appearance: body.appearance };
  }

  @AllowBeforeProfile()
  @SignedInOnly('own password only, current password required')
  @Post('password')
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.changePassword) body: ChangePasswordRequest,
    @Req() req: FastifyRequest,
  ): Promise<{ ok: true }> {
    if (!principal.signedIn) {
      throw new AppError({
        status: 401,
        title: 'Unauthorized',
        detail: 'Sign in before changing a password.',
      });
    }
    await this.auth.changeOwnPassword(
      principal.userId,
      body.currentPassword,
      body.newPassword,
      bearer(req as unknown as { headers: Record<string, unknown> }) ?? undefined,
    );
    return { ok: true };
  }

  /**
   * Replaces a temporary password with one the person chose.
   *
   * The only route that answers while `must_change_password` is set, which is what turns the
   * change screen from a suggestion into a gate.
   */
  @AllowTemporaryPassword()
  @AllowBeforeProfile()
  @SignedInOnly('own temporary password only')
  @Post('password/temporary')
  async replaceTemporaryPassword(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.replaceTemporary) body: ReplaceTemporaryPasswordRequest,
    @Req() req: FastifyRequest,
  ): Promise<{ ok: true }> {
    // The caller's own session is spared, so complying with the gate does not sign them out.
    await this.auth.replaceTemporaryPassword(
      principal.userId,
      body.newPassword,
      bearer(req as unknown as { headers: Record<string, unknown> }) ?? undefined,
    );
    return { ok: true };
  }
}
