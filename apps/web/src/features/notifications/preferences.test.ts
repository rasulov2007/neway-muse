import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationKind } from '@/demo';
import {
  CATEGORIES,
  DEFAULT_PREFERENCES,
  DELIVERY_CHANNELS,
  PREFERENCES_STORAGE_KEY,
  categoryOfKind,
  readPreferences,
  writePreferences,
} from './preferences';

const ALL_KINDS: NotificationKind[] = [
  'load',
  'dispatch',
  'fleet',
  'maintenance',
  'driver',
  'finance',
  'document',
  'system',
  'comment',
  'report',
];

describe('notification preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('covers every event kind exactly once, so nothing is unreachable', () => {
    const mapped = CATEGORIES.flatMap((category) => category.kinds);
    expect([...mapped].sort()).toEqual([...ALL_KINDS].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const kind of ALL_KINDS) {
      expect(CATEGORIES.some((c) => c.key === categoryOfKind(kind))).toBe(true);
    }
  });

  it('defaults to everything on when storage is empty', () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips a saved choice', () => {
    const saved = {
      ...DEFAULT_PREFERENCES,
      categories: { ...DEFAULT_PREFERENCES.categories, finance: false },
    };
    writePreferences(saved);
    expect(readPreferences().categories.finance).toBe(false);
    expect(readPreferences().categories.loads).toBe(true);
  });

  it('falls back to defaults for malformed or partial stored values', () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, 'not json');
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);

    window.localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ categories: { finance: false, ghost: 'yes' } }),
    );
    const parsed = readPreferences();
    expect(parsed.categories.finance).toBe(false);
    expect(parsed.categories.documents).toBe(true);
    expect(parsed).not.toHaveProperty('categories.ghost');
  });

  it('never lets storage switch off a locked delivery channel', () => {
    const locked = DELIVERY_CHANNELS.filter((c) => c.locked).map((c) => c.key);
    expect(locked).toContain('in_app');
    window.localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({ channels: { in_app: false, telegram: true } }),
    );
    const parsed = readPreferences();
    expect(parsed.channels.in_app).toBe(true);
    expect(parsed.channels.telegram).toBe(true);
  });

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(() => writePreferences(DEFAULT_PREFERENCES)).not.toThrow();
  });
});
