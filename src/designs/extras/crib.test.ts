import { describe, expect, it } from 'vitest';
import type { Extras } from './types';

/** Every extras file that carries a hand-written cheat sheet. */
const files = import.meta.glob<{ extras: Extras }>('./*.ts', { eager: true });
const sheets = Object.entries(files)
  .filter(([path, m]) => !path.endsWith('.test.ts') && m.extras?.crib)
  .map(([path, m]) => ({ id: path.replace(/^\.\/|\.ts$/g, ''), extras: m.extras, crib: m.extras.crib! }));

describe('cheat sheets', () => {
  it('the web crawler has one', () => {
    expect(sheets.map((s) => s.id)).toContain('web-crawler');
  });

  for (const { id, extras, crib } of sheets) {
    describe(id, () => {
      const lines = [crib.idea, ...(crib.late ? [crib.late] : []), ...crib.hour.flatMap((s) => [s.title, ...s.lines]), ...crib.numbers.flatMap((n) => [n.figure, n.what]), ...crib.remember, ...crib.asked.flatMap((g) => [g.about, ...g.items.flatMap((x) => [x.q, x.a])])];

      it('the hour starts at 0, has no gaps and ends when the rehearsal does', () => {
        let at = 0;
        for (const s of crib.hour) {
          if (s.when === 'Any time') continue;
          const m = /^(\d+) to (\d+)$/.exec(s.when);
          expect(m, s.when).not.toBeNull();
          expect(Number(m![1]), s.when).toBe(at);
          expect(Number(m![2]), s.when).toBeGreaterThan(at);
          at = Number(m![2]);
        }
        expect(at).toBe(extras.rehearsal.reduce((n, r) => n + r.minutes, 0));
      });

      it('every line is short enough to read in a glance, and whole', () => {
        for (const t of crib.hour.flatMap((s) => s.lines).concat(crib.remember)) expect(t.length, t).toBeLessThanOrEqual(100);
        for (const x of crib.asked.flatMap((g) => g.items)) expect(x.a.length, x.a).toBeLessThanOrEqual(140);
        expect(crib.idea.length).toBeLessThanOrEqual(210);
        for (const t of lines) {
          expect(t.trim(), t).toBe(t);
          expect(t, t).not.toMatch(/…|\.\.\.$/);
        }
      });

      it('nothing is said twice', () => {
        expect(new Set(lines).size).toBe(lines.length);
      });
    });
  }
});
