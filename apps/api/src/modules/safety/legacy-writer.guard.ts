import { type CanActivate, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { isFeatureEnabled } from '../../common/flags/flags';

/**
 * One writer per fact (docs/accidents/IMPLEMENTATION-PLAN.md §17, go-live 2026-10-22).
 *
 * Once Accident & Claims v2 is on (`accidents_v2`), accidents and claims are written by the v2 endpoints
 * (`/safety/accidents-v2`, `/safety/claims-v2`). The older Safety v2 endpoints that wrote the same facts stay readable
 * but refuse to write, so two screens can never disagree about one case. With the flag off they behave exactly as before.
 *
 * Not guarded on purpose (they have no v2 writer and work on the same rows): who is liable on a claim
 * (`POST /safety/claims/:id/liability`), driver charges and their notice, Accounting's review of claim money.
 */
@Injectable()
export class LegacyAccidentWriterGuard implements CanActivate {
  canActivate(): boolean {
    if (!isFeatureEnabled('accidents_v2')) return true;
    throw new AppError({
      status: 409,
      title: 'Read-only',
      type: '/problems/read-only-legacy-writer',
      detail: 'Accidents and claims are now written in the new Accidents and Claims pages. This older endpoint is read-only.',
    });
  }
}
