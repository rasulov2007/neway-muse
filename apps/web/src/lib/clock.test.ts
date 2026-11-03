// This test reads the source tree, so it needs Node's types; the app itself has none.
/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clockSkewMs,
  companyDateOf,
  now,
  nowIso,
  setClockForTests,
  syncClockFromHeader,
  today,
} from './clock';

afterEach(() => {
  setClockForTests(null);
  syncClockFromHeader(new Date().toUTCString());
});

describe('clock', () => {
  it('reads today in the company timezone, not the browser one', () => {
    // 11:30pm on the 16th in New York (Eastern, since 2026-09-25) is 3:30am on the 17th in UTC.
    // The company's books say the 16th, and a driver in Los Angeles filing at 8:30pm is too.
    setClockForTests('2026-09-17T03:30:00Z');
    expect(today()).toBe('2026-09-16');
  });

  it('uses the winter offset in winter', () => {
    // The constant this replaced was pinned to the summer offset (UTC−4) all year. In January
    // New York is UTC−5, so 4:30am UTC is still the previous evening there.
    expect(companyDateOf('2026-01-15T04:30:00Z')).toBe('2026-01-14');
    expect(companyDateOf('2026-07-15T03:30:00Z')).toBe('2026-07-14');
  });

  it('follows the server clock once a response has been seen', () => {
    const ahead = new Date(Date.now() + 90 * 60_000);
    syncClockFromHeader(ahead.toUTCString());
    expect(clockSkewMs()).toBeGreaterThan(80 * 60_000);
    expect(now().getTime()).toBeGreaterThan(Date.now() + 80 * 60_000);
  });

  it('treats a sub-second difference as rounding, not drift', () => {
    syncClockFromHeader(new Date(Date.now() + 400).toUTCString());
    expect(clockSkewMs()).toBe(0);
  });

  it('ignores a header it cannot read', () => {
    syncClockFromHeader('not a date');
    syncClockFromHeader(null);
    expect(Number.isFinite(clockSkewMs())).toBe(true);
  });

  it('can be frozen and released', () => {
    setClockForTests('2026-09-16T08:10:00-05:00');
    expect(nowIso()).toBe('2026-09-16T13:10:00.000Z');
    setClockForTests(null);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);
  });
});

/**
 * The regression that matters more than any single screen (acceptance test A5).
 *
 * Every module used to answer "what day is it" for itself, and most of them answered with a
 * constant pinned to September 6, 2026. One clock only holds if nothing reaches around it, so this
 * test walks the source and fails the build if a screen imports the fixture's anchor again.
 */
describe('one clock', () => {
  // Vitest runs from apps/web.
  const SRC = join(process.cwd(), 'src');
  /** The fixture owns its own anchor, and the gallery is a fixture viewer. */
  const ALLOWED = ['demo\\data.ts', 'demo/data.ts', 'demo\\index.ts', 'demo/index.ts', 'gallery'];

  function sources(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sources(path, found);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
    }
    return found;
  }

  it('no screen reads the demo anchor as "now"', () => {
    const offenders = sources(SRC)
      .filter((path) => !ALLOWED.some((allow) => path.includes(allow)))
      .filter((path) => /\bDEMO_NOW(_ISO)?\b/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
