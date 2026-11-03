import { SetMetadata } from '@nestjs/common';
import type { ServerFeatureFlag } from './flags';

export const REQUIRED_FLAGS_KEY = 'flags:requiredFlags';

/** Declares feature flags that must be on for the route to exist; class and method merge. */
export function RequireFlag(...flags: ServerFeatureFlag[]): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_FLAGS_KEY, flags);
}
