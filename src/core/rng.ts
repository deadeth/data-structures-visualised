/** Small seeded generator (mulberry32). Keep one in your state when randomness must replay identically. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(min: number, max: number, rnd: () => number = Math.random): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

export function pick<T>(items: readonly T[], rnd: () => number = Math.random): T {
  return items[Math.floor(rnd() * items.length)];
}
