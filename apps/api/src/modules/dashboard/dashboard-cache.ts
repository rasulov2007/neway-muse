import { Injectable } from '@nestjs/common';

export interface CacheOptions {
  /** Maximum entries kept; the least recently used one is evicted beyond it. */
  maxEntries: number;
  /** Time to live in milliseconds. */
  ttlMs: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** Small in-memory LRU with TTL. Keys must embed the company id (docs/DASHBOARD.md §11). */
export class LruCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(
    private readonly options: CacheOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The cached value, or `undefined` when absent or expired. Refreshes recency on hit. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores a value, evicting the least recently used entry when full. */
  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Returns the cached value or computes, stores and returns it. */
  async getOrCreate(key: string, create: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await create();
    this.set(key, value);
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Builds the cache key for one company and range; the company id is always part of it. */
export function periodCacheKey(
  companyId: string,
  range: { from: string; to: string },
  sourceKind: string,
): string {
  return `${companyId}|${range.from}|${range.to}|${sourceKind}`;
}

export const DASHBOARD_CACHE_OPTIONS: CacheOptions = { maxEntries: 50, ttlMs: 60_000 };

/** Injectable cache holder so every service instance shares one LRU per process. */
@Injectable()
export class DashboardCache<V = unknown> extends LruCache<V> {
  constructor() {
    super(DASHBOARD_CACHE_OPTIONS);
  }
}
