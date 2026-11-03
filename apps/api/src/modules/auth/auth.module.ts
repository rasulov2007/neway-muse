import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DemoPrincipalMiddleware } from '../../common/auth/demo-principal.middleware';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Authentication.
 *
 * Global because the principal middleware - applied once, in AppModule, for every route - has to
 * be able to turn a bearer token into an account, and there is exactly one way to do that.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, DemoPrincipalMiddleware],
  exports: [AuthService],
})
export class AuthModule {}
