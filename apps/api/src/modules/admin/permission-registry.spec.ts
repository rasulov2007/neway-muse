import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_CODES, SYSTEM_ROLES } from '@neway/shared';
import { describe, expect, it } from 'vitest';

/**
 * The registry's promise, checked against the source.
 *
 * `permissions.ts` says: *only permissions the backend actually enforces appear here*. The
 * converse matters just as much — every permission the backend enforces must appear there, or no
 * role can grant it and the capability is unreachable through the product.
 *
 * That converse was broken once. The reports module enforced `reports.view_people` and
 * `reports.view_safety`, neither of which was in the registry; the workforce and safety reports
 * worked only because a hardcoded demo permission list happened to contain the same strings. The
 * moment the principal started coming from the database, they 403'd. This test is why that cannot
 * happen again.
 */

const SOURCE_ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Every permission string this codebase checks at runtime. */
function enforcedPermissions(): { code: string; where: string }[] {
  const found: { code: string; where: string }[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const relative = file.slice(SOURCE_ROOT.length + 1).replace(/\\/g, '/');

    // @RequirePermission('a.b', 'c.d')
    for (const match of source.matchAll(/@Require(?:Any)?Permission\(([^)]*)\)/g)) {
      for (const literal of (match[1] ?? '').matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
        found.push({ code: literal[1] as string, where: relative });
      }
    }
    // principal.permissions.has('a.b')  /  hasPermission(principal, 'a.b')
    for (const match of source.matchAll(
      /permissions\.has\('([a-z_]+\.[a-z_]+)'\)|hasPermission\([^,]+,\s*'([a-z_]+\.[a-z_]+)'\)/g,
    )) {
      const code = match[1] ?? match[2];
      if (code) found.push({ code, where: relative });
    }
  }
  return found;
}

describe('permission registry', () => {
  it('defines every permission the API enforces', () => {
    const enforced = enforcedPermissions();
    // A sanity floor: if the scan finds nothing the assertion below is vacuous.
    expect(enforced.length).toBeGreaterThan(20);

    const missing = enforced.filter(({ code }) => !PERMISSION_CODES.includes(code));
    expect(
      missing.map(({ code, where }) => `${code} (enforced in ${where})`),
      'enforced but not grantable — no role can ever hold these',
    ).toEqual([]);
  });

  it('reaches the same conclusion for permissions the dashboard checks by constant', () => {
    // DASHBOARD_PERMISSIONS predates the registry and is referenced indirectly, so the scan above
    // cannot see it. Named here so it is covered rather than quietly exempt.
    for (const code of ['dashboard.view', 'dashboard.view_financial', 'dashboard.drilldown']) {
      expect(PERMISSION_CODES, code).toContain(code);
    }
  });
});

/**
 * The Dashboard is private to administrators (owner, 2026-10-02): every company's numbers in one
 * place. No other built-in role may hold a dashboard code; a company can still grant it to a role
 * of its own on purpose.
 */
describe('Dashboard access', () => {
  it('only the administrator role holds a dashboard permission', () => {
    const holders = SYSTEM_ROLES.filter((role) => role.permissions.some((code) => code.startsWith('dashboard.')));
    expect(holders.map((role) => role.code)).toEqual(['administrator']);
  });
});
