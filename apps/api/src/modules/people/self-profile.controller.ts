import { Body, Controller, Get, Put } from '@nestjs/common';
import { SelfProfileSchema, type SelfProfile } from '@neway/shared';
import type { z } from 'zod';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { AllowBeforeProfile } from '../../common/auth/public.decorator';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { SelfProfileService } from './self-profile.service';


/**
 * Complete your profile (owner, 2026-10-26): the caller's own employee information.
 *
 * Open to every signed-in member because it only ever touches the caller's own record, found from
 * the session membership - there is no id in the path or the body. The two routes stay open while
 * the profile gate holds the session; everything else is refused until PUT succeeds.
 */
@Controller('me/profile')
export class SelfProfileController {
  constructor(private readonly profiles: SelfProfileService) {}

  @AllowBeforeProfile()
  @SignedInOnly('own employee record only; the membership and record come from the session, never the request')
  @Get()
  read(@CurrentPrincipal() principal: Principal): Promise<SelfProfile> {
    return this.profiles.read(principal);
  }

  @AllowBeforeProfile()
  @SignedInOnly('own employee record only; personal fields only (no role, department, title or pay); version-checked and audited')
  @Put()
  submit(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(SelfProfileSchema)) body: z.output<typeof SelfProfileSchema>,
  ): Promise<SelfProfile> {
    return this.profiles.submit(principal, body);
  }
}
