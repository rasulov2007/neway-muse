import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_CODES, SYSTEM_ROLES } from '@neway/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { listRoutes, routesWithoutPolicy, type RouteEntry } from '../../src/common/auth/route-policy';
import { controllerFileCount, loadAllControllers } from './all-controllers';
import { ROLES, admissionFixture, moduleOf, policyText, rolesAdmitted, rolesAdmittedBefore, routeMatrixCsv, stateKeyCsv, unsure } from './matrix';

/**
 * Deny by default, checked in CI without a database (owner brief, 2026-10-25).
 *
 *   1. Every controller route declares a policy: @Public, @RequirePermission / @RequireAnyPermission,
 *      or a reviewed @SignedInOnly(reason). A route without one fails this suite (and the API refuses
 *      to boot - RoutePolicyCheck).
 *   2. Every code a policy names is in the permission registry, so some role can hold it.
 *   3. Every route x every built-in role resolves exactly as `route-matrix.fixture.json` says. A
 *      change to who may call a route is therefore a reviewed diff of the fixture, never a side
 *      effect. Regenerate it with AUTHZ_UPDATE_FIXTURE=1 after an intended change.
 *
 * With AUTHZ_MATRIX_OUT=<dir> it also writes the Role x Endpoint matrix (CSV + Markdown).
 */
const FIXTURE = join(__dirname, 'route-matrix.fixture.json');

let routes: RouteEntry[] = [];

beforeAll(async () => {
  routes = listRoutes(await loadAllControllers());
}, 120_000);

describe('route policies', () => {
  it('found every controller', () => {
    expect(controllerFileCount()).toBeGreaterThan(40);
    expect(routes.length).toBeGreaterThan(800);
  });

  it('every route declares an access policy', () => {
    expect(routesWithoutPolicy(routes).map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`)).toEqual([]);
  });

  it('every signed-in-only route says why', () => {
    const silent = routes.filter((r) => r.policy.kind === 'signed-in' && (r.policy.reason ?? '').trim().length < 8);
    expect(silent.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('every permission a policy names is grantable', () => {
    const named = new Set(routes.flatMap((r) => [...r.policy.all, ...r.policy.any]));
    expect([...named].filter((code) => !PERMISSION_CODES.includes(code))).toEqual([]);
  });

  it('the public routes are the reviewed list', () => {
    const publicRoutes = routes.filter((r) => r.policy.kind === 'public').map((r) => `${r.method} ${r.path}`);
    for (const route of publicRoutes) {
      expect(route, 'a public route outside auth, health, public/* and the signed file link').toMatch(
        /^(GET|POST|PUT|PATCH|OPTIONS) \/(auth\/(login|me|switch-company)|health|public\/.+|files\/signed)$/,
      );
    }
  });

  it('every route x every built-in role resolves as the matrix fixture says', () => {
    const actual = admissionFixture(routes);
    if (process.env.AUTHZ_UPDATE_FIXTURE === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 1) + '\n');
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>;
    expect(Object.keys(actual).length).toBe(routes.length);
    expect(actual).toEqual(expected);
  });

  it('the administrator reaches every non-public route through its policy', () => {
    const admin = routes.filter((r) => r.policy.kind !== 'public' && !rolesAdmitted(r).includes('administrator'));
    expect(admin.map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(SYSTEM_ROLES.find((r) => r.code === 'administrator')?.permissions).toContain('files.manage');
  });

  it('writes the Role x Endpoint matrix when AUTHZ_MATRIX_OUT is set', () => {
    const out = process.env.AUTHZ_MATRIX_OUT;
    if (!out) return;
    mkdirSync(out, { recursive: true });
    // "Before" comes from a route dump of the code production ran (AUTHZ_BEFORE), matched by route.
    const beforePath = process.env.AUTHZ_BEFORE;
    const beforeRoutes: RouteEntry[] = beforePath && existsSync(beforePath) ? (JSON.parse(readFileSync(beforePath, 'utf8')) as RouteEntry[]) : [];
    const beforeOf = (r: RouteEntry) => beforeRoutes.find((b) => b.method === r.method && b.path === r.path && b.handler === r.handler);
    const merged = routes.map((r) => ({ now: r, before: beforeOf(r) ?? r }));
    // The CSV's "before" columns use the old route's metadata.
    const csv = routeMatrixCsv(routes);
    const rows = csv.trimEnd().split('\n');
    const header = rows[0]!.split(',');
    const fixed = [rows[0]!];
    merged.forEach(({ before }, i) => {
      const cells = splitCsv(rows[i + 1]!);
      const admittedBefore = new Set(rolesAdmittedBefore(before));
      ROLES.forEach((role) => {
        cells[header.indexOf(`${role}:before`)] = admittedBefore.has(role) ? 'Y' : '-';
      });
      cells[header.indexOf('policy_before')] = csvQuote(
        before.policy.kind === 'public'
          ? 'public'
          : before.guards.includes('PermissionGuard') && before.policy.kind === 'permission'
            ? policyText(before)
            : before.policy.kind === 'permission'
              ? `NOT ENFORCED (${policyText(before)})`
              : 'signed-in only (no check)',
      );
      fixed.push(cells.join(','));
    });
    writeFileSync(join(out, 'routes-by-role.csv'), fixed.join('\n') + '\n');
    writeFileSync(join(out, 'state-keys-by-role.csv'), stateKeyCsv());
    writeFileSync(join(out, 'README.md'), summary(merged));
  });
});

function csvQuote(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(csvQuote(cur)); cur = ''; }
    else cur += ch;
  }
  out.push(csvQuote(cur));
  return out;
}

function summary(merged: { now: RouteEntry; before: RouteEntry }[]): string {
  const byModule = new Map<string, { now: RouteEntry; before: RouteEntry }[]>();
  for (const m of merged) byModule.set(moduleOf(m.now.path), [...(byModule.get(moduleOf(m.now.path)) ?? []), m]);
  const lines: string[] = [];
  lines.push('# Role x Endpoint matrix (generated from code)', '');
  lines.push(`${merged.length} routes. Generated by apps/api/test/authz/route-policy.spec.ts from route metadata and SYSTEM_ROLES.`, '');
  lines.push('Files: `routes-by-role.csv` (every route; per role `:before` = admitted on production code cbb918ba, `:now` = admitted by the new policy; `narrowing` = what the handler narrows further; `unsure` = needs an owner decision), `state-keys-by-role.csv` (every /state key: R read, W write).', '');
  lines.push('## Routes per module: how many each role reaches, before -> now', '');
  lines.push(`| module | routes | ${ROLES.join(' | ')} |`);
  lines.push(`|---|---|${ROLES.map(() => '---').join('|')}|`);
  for (const [mod, list] of [...byModule.entries()].sort()) {
    const cells = ROLES.map((role) => {
      const b = list.filter((m) => rolesAdmittedBefore(m.before).includes(role)).length;
      const n = list.filter((m) => rolesAdmitted(m.now).includes(role)).length;
      return b === n ? `${n}` : `${b}->${n}`;
    });
    lines.push(`| ${mod} | ${list.length} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Routes whose access changed', '');
  lines.push('| method | path | before | now | roles that lose | roles that gain |', '|---|---|---|---|---|---|');
  for (const m of merged) {
    const b = new Set(rolesAdmittedBefore(m.before));
    const n = new Set(rolesAdmitted(m.now));
    const lose = ROLES.filter((r) => b.has(r) && !n.has(r));
    const gain = ROLES.filter((r) => !b.has(r) && n.has(r));
    if (lose.length === 0 && gain.length === 0) continue;
    lines.push(`| ${m.now.method} | \`${m.now.path}\` | ${b.size === ROLES.length ? 'every role' : [...b].join(', ') || 'nobody'} | ${policyText(m.now).replace(/\|/g, '/')} | ${lose.join(', ') || '-'} | ${gain.join(', ') || '-'} |`);
  }
  lines.push('', '## Rows marked unsure (owner decision)', '');
  for (const m of merged) {
    const why = unsure(m.now);
    if (why) lines.push(`- ${m.now.method} \`${m.now.path}\` - ${why}`);
  }
  lines.push('', 'Signed-in-only routes (open to any signed-in member, narrowed as stated):', '');
  for (const m of merged.filter((x) => x.now.policy.kind === 'signed-in')) lines.push(`- ${m.now.method} \`${m.now.path}\` - ${m.now.policy.reason}`);
  lines.push('', 'State keys marked unsure: see `state-keys-by-role.csv` column `unsure`.', '');
  return lines.join('\n') + '\n';
}
