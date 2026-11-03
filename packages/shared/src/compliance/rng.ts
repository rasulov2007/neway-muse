/**
 * A seeded random source (mulberry32).
 *
 * Every seed in this product is deterministic: the same seed always yields the same fleet, the
 * same qualification file and the same pipeline, so a test can assert an exact number and a
 * screenshot can be compared against yesterday's. Shared so the API seed and the web test fixture
 * cannot drift apart by using two generators.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`rng: ${what}`);
  return value;
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(min = 0, max = 1): number {
    return min + (max - min) * this.next();
  }

  /** Inclusive integer range. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return must(items[Math.floor(this.next() * items.length)], 'pick from empty list');
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = must(out[i], 'shuffle');
      out[i] = must(out[j], 'shuffle');
      out[j] = tmp;
    }
    return out;
  }

  digits(count: number): string {
    let out = '';
    for (let i = 0; i < count; i += 1) out += String(this.int(0, 9));
    return out;
  }

  chars(count: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < count; i += 1) out += alphabet.charAt(this.int(0, alphabet.length - 1));
    return out;
  }
}
