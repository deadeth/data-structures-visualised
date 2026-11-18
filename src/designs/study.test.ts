import { describe, expect, it } from 'vitest';
import { CATALOG } from '../catalog';
import { loadCourse } from '../course';
import { CONCEPTS, WALKTHROUGHS } from '../reading';
import { LOCKED_IDS } from '../locked/manifest';
import { DESIGNS } from './index';

/** Every study guide on a design page: its links lead somewhere, and nothing is listed twice. */
describe('design study guides', async () => {
  const course = await loadCourse();
  const designs = await Promise.all(DESIGNS.map(async (d) => ({ id: d.id, design: await d.load() })));
  const structures = new Set(CATALOG.map((c) => c.id));
  const concepts = new Map(CONCEPTS.map((c) => [c.id, new Set(c.sections.map((s) => s.id))]));
  const tours = new Map(designs.map((d) => [d.id, d.design.tour.length]));
  const stories = new Map(designs.map((d) => [d.id, new Map((d.design.stories ?? []).map((x) => [x.id, x.tour.length]))]));

  function problem(href: string): string | null {
    const parts = href.replace(/^#\//, '').split('/');
    if (!href.startsWith('#/')) return 'not a site address';
    const [kind, id, ...rest] = parts;
    if (kind === 's') return structures.has(id) && !rest.length ? null : `no structure page "${id}"`;
    if (kind === 'c') {
      const sections = concepts.get(id);
      if (!sections) return `no concept page "${id}"`;
      return !rest.length || sections.has(rest[0]) ? null : `no section "${rest[0]}" on concept page "${id}"`;
    }
    if (kind === 'd') {
      if (!tours.has(id)) return LOCKED_IDS.includes(id) ? null : `no design "${id}"`;
      if (!rest.length) return null;
      if (rest[0] === 'read') {
        const w = WALKTHROUGHS.get(id);
        if (!w) return `design "${id}" has no walkthrough`;
        return !rest[1] || w.sections.some((s) => s.id === rest[1]) ? null : `no section "${rest[1]}" in the walkthrough of "${id}"`;
      }
      if (rest[0] === 't') return Number(rest[1]) >= 1 && Number(rest[1]) <= tours.get(id)! ? null : `design "${id}" has no tour step ${rest[1]}`;
      if (rest[0] === 's') {
        const [sid, n] = (rest[1] ?? '').split('.');
        const len = stories.get(id)!.get(sid);
        if (len === undefined) return `design "${id}" has no story "${sid}"`;
        return Number(n) >= 1 && Number(n) <= len ? null : `story "${sid}" of "${id}" has no step ${n}`;
      }
      if (rest[0] === 'rehearse' || rest[0] === 'crib') return DESIGNS.find((d) => d.id === id)?.extras ? null : `design "${id}" has no ${rest[0]} page`;
      return `unknown design address "${href}"`;
    }
    if (kind === 'course') {
      if (!id) return null;
      const m = course?.modules.find((x) => x.id === id);
      if (!m) return `no course module "${id}"`;
      return !rest.length || m.items.some((i) => i.id === rest[0]) ? null : `no item "${rest[0]}" in course module "${id}"`;
    }
    return `unknown address "${href}"`;
  }

  it('at least the web crawler has one', () => {
    expect(designs.find((d) => d.id === 'web-crawler')?.design.study).toBeTruthy();
  });

  for (const { id, design } of designs) {
    const guide = design.study;
    if (!guide) continue;
    it(`${id}: every page exists, once, with a time and a reason`, () => {
      const problems: string[] = [];
      const seen = new Set<string>();
      expect(guide.intro.length).toBeGreaterThan(20);
      for (const g of guide.groups) {
        if (!g.items.length) problems.push(`group "${g.title}" is empty`);
        for (const item of g.items) {
          const p = problem(item.href);
          if (p) problems.push(`${item.label}: ${p}`);
          if (seen.has(item.href)) problems.push(`${item.label}: ${item.href} is listed twice`);
          seen.add(item.href);
          if (!(item.minutes > 0)) problems.push(`${item.label}: needs minutes`);
          if (item.take.length < 20) problems.push(`${item.label}: say what to take from it`);
        }
      }
      expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
    });
  }
});
