import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AuthorizationGuard } from './common/auth/authorization.guard';
import { CompanyScopeGuard } from './common/auth/company-scope.guard';
import { RoutePolicyCheck } from './common/auth/route-policy.check';
import { AuthenticatedGuard } from './common/auth/authenticated.guard';
import { DemoPrincipalMiddleware } from './common/auth/demo-principal.middleware';
import { LoggingModule } from './common/logging/logging.module';
import { DatabaseModule } from './database/database.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClockModule } from './modules/clock/clock.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { FleetModule } from './modules/fleet/fleet.module';
import { FleetExpensesModule } from './modules/fleet-expenses/fleet-expenses.module';
import { PmModule } from './modules/pm/pm.module';
import { FilesModule } from './modules/files/files.module';
import { HiringModule } from './modules/hiring/hiring.module';
import { EmailModule } from './modules/email/email.module';
import { DotApplicationModule } from './modules/dot-application/dot-application.module';
import { StateModule } from './modules/state/state.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { HrModule } from './modules/hr/hr.module';
import { LoadsModule } from './modules/loads/loads.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { DispatchBoardModule } from './modules/dispatch-board/dispatch-board.module';
import { PeopleModule } from './modules/people/people.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RosterModule } from './modules/roster/roster.module';
import { CompanyProfileModule } from './modules/company-profile/company-profile.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { PlatformModule } from './modules/platform/platform.module';
import { SafetyModule } from './modules/safety/safety.module';
import { AccidentsV2Module } from './modules/safety/accidents-v2/accidents-v2.module';
import { DriverRelationsModule } from './modules/driver-relations/driver-relations.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { MessagesModule } from './modules/messages/messages.module';
import { OfficeModule } from './modules/mobile-office/office.module';

@Module({
  imports: [DiscoveryModule, LoggingModule, ClockModule, DatabaseModule, EmailModule, AuthModule, HealthModule, DashboardModule, RosterModule, PeopleModule, HrModule, ReportsModule, AdminModule, ComplianceModule, HiringModule, StateModule, FleetModule, FleetExpensesModule, PmModule, FilesModule, LoadsModule, DispatchBoardModule, AccountingModule, PlatformModule, SafetyModule, AccidentsV2Module, DriverRelationsModule, CompanyProfileModule, AiAssistantModule, DotApplicationModule, MobileModule, MessagesModule, OfficeModule],
  // Every route requires a session unless it says otherwise, every route declares its access
  // policy (deny by default, owner 2026-10-25), and no request may pick its company. Registered
  // globally, in this order, so protection is the default rather than something each controller
  // has to remember. RoutePolicyCheck refuses to boot while any route lacks a policy.
  providers: [
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
    { provide: APP_GUARD, useClass: CompanyScopeGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
    RoutePolicyCheck,
  ],
})
export class AppModule implements NestModule {
  /**
   * The principal is attached to EVERY request, in one place.
   *
   * It used to be applied per module, per controller, which meant a new module was unauthenticated
   * until somebody remembered to register the middleware - and `StateModule` did not. Its routes
   * therefore had no principal at all and answered 401 to a perfectly valid bearer token, which the
   * browser read as an expired session: it cleared the token it had just been given and bounced
   * back to the login screen, so signing in appeared to do nothing. Protection is only "by
   * existing" if identity resolution is global too.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DemoPrincipalMiddleware).forRoutes('*');
  }
}
