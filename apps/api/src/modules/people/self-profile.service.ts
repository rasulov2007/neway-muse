import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  SelfProfileSchema,
  ageOn,
  placementForRoles,
  splitFullName,
  type SelfProfile,
} from '@neway/shared';
import type { z } from 'zod';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { linkedEmployeeId, profileStatusFor } from '../../common/auth/profile-gate';
import { DatabaseService } from '../../database/database.service';
import { memberships, users } from '../../database/schema/admin';
import { employees, type EmployeeRow } from '../../database/schema/people';
import { easternToday } from '../roster/driver-archive.data';
import { AuditService, type AuditChange } from './audit.service';
import { EmployeesService } from './employees.service';

type SelfProfileInput = z.output<typeof SelfProfileSchema>;

/** The fields a person may write about themselves. Nothing else on the row is touched. */
const SELF_FIELDS = [
  'firstName',
  'lastName',
  'preferredName',
  'dateOfBirth',
  'idNumber',
  'homeAddress',
  'phone',
  'secondaryPhone',
  'shiftTime',
  'location',
] as const;

/**
 * Complete your profile (owner, 2026-10-26).
 *
 * Everything here is keyed on the session: the membership comes from the principal and the
 * employee record from that membership (or `employees.user_id`, or - the first time - an unlinked
 * record in the same company with the account's email). No id is ever read from the request, so a
 * person can only ever read or write their own record. Department, title, role, status, hire date
 * and pay are not writable here; a new record takes its department and title from the role the
 * administrator assigned, and its pay type from the department, with no amount.
 */
@Injectable()
export class SelfProfileService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async me(principal: Principal) {
    if (!principal.membershipId || principal.signedIn !== true) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Not signed in.' });
    }
    const [row] = await this.db
      .select({
        membershipId: memberships.id,
        companyId: memberships.companyId,
        userId: memberships.userId,
        employeeId: memberships.employeeId,
        isOwner: memberships.isOwner,
        completedAt: memberships.profileCompletedAt,
        email: users.email,
        isPlatformAdmin: users.isPlatformAdmin,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.id, principal.membershipId),
          eq(memberships.companyId, principal.companyId),
          eq(memberships.userId, principal.userId),
        ),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such account' });
    return row;
  }

  /** The caller's own employee row, by the session's links; or an unlinked one with their email. */
  private async target(me: Awaited<ReturnType<SelfProfileService['me']>>): Promise<EmployeeRow | null> {
    const linked = await linkedEmployeeId(this.db, me);
    if (linked) {
      const [row] = await this.db
        .select()
        .from(employees)
        .where(and(eq(employees.companyId, me.companyId), eq(employees.id, linked)))
        .limit(1);
      return row ?? null;
    }
    const [byEmail] = await this.db
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.companyId, me.companyId),
          sql`lower(${employees.workEmail}) = ${me.email.toLowerCase()}`,
          or(isNull(employees.userId), eq(employees.userId, me.userId)),
          sql`not exists (select 1 from ${memberships} m where m.employee_id = ${employees.id})`,
        ),
      )
      .limit(1);
    return byEmail ?? null;
  }

  async read(principal: Principal): Promise<SelfProfile> {
    const me = await this.me(principal);
    const row = await this.target(me);
    const status = await profileStatusFor(this.db, {
      companyId: me.companyId,
      userId: me.userId,
      roles: principal.roles,
      isOwner: me.isOwner,
      isPlatformAdmin: me.isPlatformAdmin,
      employeeId: me.employeeId,
      completedAt: me.completedAt,
    });
    return {
      required: status === 'pending',
      completedAt: me.completedAt?.toISOString() ?? null,
      email: me.email,
      // The caller's own personal data, unmasked: it is theirs. Never pay, role or department.
      employee: row
        ? {
            fullName: `${row.firstName} ${row.lastName}`.trim(),
            nickname: row.preferredName,
            dateOfBirth: row.dateOfBirth,
            idNumber: row.idNumber,
            homeAddress: row.homeAddress,
            phone: row.phone,
            secondaryPhone: row.secondaryPhone,
            shiftTime: row.shiftTime,
            location: row.location,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null,
    };
  }

  async submit(principal: Principal, input: SelfProfileInput): Promise<SelfProfile> {
    const me = await this.me(principal);
    const { firstName, lastName } = splitFullName(input.fullName);
    if (firstName.length > 40 || lastName.length > 40) {
      throw unprocessable('First and last name may be at most 40 characters each.');
    }
    if (input.dateOfBirth) {
      const today = easternToday(new Date());
      const age = ageOn(input.dateOfBirth, today);
      if (input.dateOfBirth > today) throw unprocessable('Date of birth cannot be in the future.');
      if (age === null || age < 16 || age > 100) throw unprocessable('Check the year of your date of birth.');
    }
    const next = {
      firstName,
      lastName,
      preferredName: input.nickname || null,
      dateOfBirth: input.dateOfBirth,
      idNumber: input.idNumber || null,
      homeAddress: input.homeAddress || null,
      phone: input.phone,
      secondaryPhone: input.secondaryPhone || null,
      shiftTime: input.shiftTime,
      location: input.location || null,
    };

    const existing = await this.target(me);
    let employeeId: string;
    let created = false;
    let changes: AuditChange[] = [];

    if (existing) {
      // Version check: the form must have been filled from this exact version of the record.
      if (input.expectedUpdatedAt !== existing.updatedAt.toISOString()) {
        throw conflict();
      }
      changes = SELF_FIELDS.flatMap((field) => {
        const before = (existing[field] ?? null) as string | null;
        const after = (next[field] ?? null) as string | null;
        return before === after ? [] : [{ field, old: before, new: after }];
      });
      const updated = await this.db
        .update(employees)
        .set({ ...next, userId: me.userId, updatedAt: new Date() })
        .where(
          and(
            eq(employees.companyId, me.companyId),
            eq(employees.id, existing.id),
            // Millisecond precision: the version the client holds is an ISO string.
            sql`date_trunc('milliseconds', ${employees.updatedAt}) = ${existing.updatedAt.toISOString()}::timestamptz`,
          ),
        )
        .returning({ id: employees.id });
      if (updated.length === 0) throw conflict();
      employeeId = existing.id;
    } else {
      if (input.expectedUpdatedAt !== null) throw conflict();
      const placement = placementForRoles(principal.roles);
      const record = await this.employees.create(principal, {
        firstName,
        middleName: null,
        lastName,
        preferredName: next.preferredName,
        workEmail: me.email,
        personalEmail: null,
        phone: next.phone,
        secondaryPhone: next.secondaryPhone,
        department: placement.department,
        position: placement.title,
        managerEmployeeId: null,
        location: next.location,
        hireDate: easternToday(new Date()),
        employmentType: 'full_time',
        payType: placement.payType,
        // No amount: HR fills it in. The person never sets their own pay.
        payRate: null,
        timezone: 'America/New_York',
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelationship: null,
        notes: placement.mapped ? null : 'Department and title to be set by HR (no mapping for the assigned role).',
        dateOfBirth: next.dateOfBirth,
        idNumber: next.idNumber,
        homeAddress: next.homeAddress,
        shiftTime: next.shiftTime,
      });
      employeeId = record.id;
      created = true;
      await this.db
        .update(employees)
        .set({ userId: me.userId })
        .where(and(eq(employees.companyId, me.companyId), eq(employees.id, employeeId)));
    }

    // Link the membership (one account per employee) and record that the form was submitted.
    const linked = await this.db
      .update(memberships)
      .set({
        employeeId,
        profileCompletedAt: me.completedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memberships.id, me.membershipId),
          eq(memberships.companyId, me.companyId),
          or(isNull(memberships.employeeId), eq(memberships.employeeId, employeeId)),
        ),
      )
      .returning({ id: memberships.id });
    if (linked.length === 0) throw conflict();

    const label = `${firstName} ${lastName}`.trim();
    await this.audit.write(principal, {
      action: created ? 'create' : 'update',
      entityType: 'employee',
      entityId: employeeId,
      entityLabel: label,
      summary: created
        ? `${label} completed their own profile; employee record created from the account`
        : `${label} updated their own profile (${changes.length} field${changes.length === 1 ? '' : 's'})`,
      changes: created
        ? SELF_FIELDS.flatMap((field) => (next[field] ? [{ field, old: null, new: String(next[field]) }] : []))
        : changes,
      reason: 'Self-service: Complete your profile',
    });
    if (!me.completedAt) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'user',
        entityId: me.membershipId,
        entityLabel: label,
        summary: 'Completed their own profile at first sign-in',
        changes: [
          { field: 'profileCompletedAt', old: null, new: new Date().toISOString() },
          { field: 'employeeId', old: me.employeeId, new: employeeId },
        ],
      });
    }

    return this.read({ ...principal, profileRequired: false });
  }
}

function unprocessable(detail: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', detail });
}

function conflict(): AppError {
  return new AppError({
    status: 409,
    title: 'Conflict',
    detail: 'Your profile was changed somewhere else. Reload the page and try again.',
  });
}
