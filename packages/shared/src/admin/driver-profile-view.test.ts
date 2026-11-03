import { describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from './permissions.js';
import {
  DRIVER_PROFILE_FULL_PERMISSION,
  isRestrictedDriverProfileViewer,
  readsDriverCdlDocuments,
} from './driver-profile-view.js';

// Production roles in co_northwind (2026-10-26).
const DISPATCHER = ['board_claims.view', 'board_daily.view', 'dispatch.edit', 'dispatch.view', 'drivers.edit', 'drivers.view', 'drivers.view_contact'];
const DISPATCH_LEAD = [...DISPATCHER, 'dispatch.manage', 'dispatch_pay.view', 'drivers.create', 'board_weekly.view', 'board_performance.view'];
const SAFETY = ['safety.view', 'compliance.view', 'compliance_sensitive.view', 'drivers.view', 'drivers.view_licence'];
const MAINTENANCE = ['maintenance.view', 'trucks.view', 'drivers.view'];
const HR = ['employees.view', 'recruiting.manage', 'drivers.view'];
const ACCOUNTING = ['accounting.view', 'drivers.view', 'drivers.view_pay'];

describe('restricted driver profile (owner, 2026-10-26)', () => {
  it('everybody who opens a driver without drivers.view_pay gets the restricted view', () => {
    for (const role of [DISPATCHER, DISPATCH_LEAD, SAFETY, MAINTENANCE, HR]) {
      expect(isRestrictedDriverProfileViewer(role)).toBe(true);
    }
  });

  it('drivers.view_pay (Accounting, Administrator) keeps the full profile', () => {
    expect(isRestrictedDriverProfileViewer(ACCOUNTING)).toBe(false);
    expect(isRestrictedDriverProfileViewer([...DISPATCHER, DRIVER_PROFILE_FULL_PERMISSION])).toBe(false);
  });

  it('without drivers.view there is no profile to restrict, and no CDL to read', () => {
    expect(isRestrictedDriverProfileViewer(['dispatch.view'])).toBe(false);
    expect(readsDriverCdlDocuments(['dispatch.view'])).toBe(false);
    expect(readsDriverCdlDocuments(DISPATCHER)).toBe(true);
  });

  it('the gate is a real permission', () => {
    expect(PERMISSION_CODES).toContain(DRIVER_PROFILE_FULL_PERMISSION);
  });
});
