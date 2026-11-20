import { CATALOG, GROUPS, isReady, loadStructure } from '../catalog';
import { costHtml, h, scrollRegion, tableRoles } from '../core/dom';
import { Recorder } from '../core/recorder';
import type { OpDef } from '../core/types';
import { DESIGNS } from '../designs';
import { CONCEPTS, WALKTHROUGHS, plain } from '../reading';
import { PRACTICES } from '../practice';
import { Stage } from './stage';
import { courseCard } from './course-card';
import { legend } from './structure-page';

/** Home: a live demo, then the cheat sheet. */
export async function mountHome(host: HTMLElement): Promise<() => void> {
  const stageHost = h('div.hero-stage');
  const page = h(
    'article.home', null,
    h(
      'header.hero', null,
      h('h1', null, 'Follow one key through the structure.'),
      h(
        'p.lede', null,
        'Each page runs the real algorithm one step at a time. The key you are following is always magenta, every comparison is written out as it happens, and you set the pace: slow it to a quarter speed, step backwards, or drag through the steps.',
      ),
    ),
    stageHost,
    legend(),
  );
  host.append(page);

  let alive = true;
  let stage: Stage | null = null;

  // The demo is the B+ tree running its own tour on a loop.
  void (async () => {
    const def = await loadStructure('b-plus-tree');
    if (!alive) return;
    // The demo is never a live region, and it does not start itself for readers who asked for less motion.
    stage = new Stage(stageHost, { compact: true, counters: def.counters, name: 'B+ tree', live: false });
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (;;) {
      const params: Record<string, number> = {};
      for (const p of def.params ?? []) params[p.id] = p.default;
      const state = def.create(params);
      const find = (id: string) => def.ops.find((o) => o.id === id) as OpDef<unknown>;
      for (const [id, ...args] of def.seed) find(id).run(state, args, new Recorder(state, def.layout, false));
      for (const [id, ...args] of def.tour) {
        const rec = new Recorder(state, def.layout, true);
        find(id).run(state, args, rec);
        if (still) {
          stage.cue(rec.frames);
          return;
        }
        await stage.play(rec.frames);
        if (!alive) return;
        await new Promise((r) => setTimeout(r, 1400));
        if (!alive) return;
      }
    }
  })();

  const table = h(
    'table.cheat.stack', null,
    h(
      'thead', null,
      h('tr', null, ['Structure', 'Lookup', 'Insert', 'Delete', 'Keeps order', 'Reach for it when'].map((t) => h('th', { scope: 'col' }, t))),
    ),
  );
  for (const group of GROUPS) {
    const body = h('tbody', null, h('tr.group-row', null, h('th', { colSpan: 6, scope: 'colgroup' }, group)));
    for (const c of CATALOG.filter((e) => e.group === group)) {
      const name = isReady(c.id) ? h('a', { href: `#/s/${c.id}` }, c.name) : h('span.soon', null, c.name);
      body.append(
        h(
          'tr', null,
          h('th', { scope: 'row' }, name),
          h('td.num', { 'data-label': 'Lookup', html: costHtml(c.cheat.lookup) }),
          h('td.num', { 'data-label': 'Insert', html: costHtml(c.cheat.insert) }),
          h('td.num', { 'data-label': 'Delete', html: costHtml(c.cheat.remove) }),
          h('td.inline', { 'data-label': 'Keeps order' }, c.cheat.ordered),
          h('td', { 'data-label': 'Reach for it when' }, c.cheat.pick),
        ),
      );
    }
    table.append(body);
  }
  // The course, with the reader's progress: filled in once the course has loaded.
  const course = courseCard();
  page.append(course.el);
  // Reading pages, when any are written: concept pages first, then design walkthroughs.
  const reads = [
    ...CONCEPTS.map((c) => ({ kind: c.group, title: c.title, summary: c.summary, minutes: c.minutes, href: `#/c/${c.id}` })),
    ...DESIGNS.filter((d) => WALKTHROUGHS.has(d.id)).map((d) => {
      const w = WALKTHROUGHS.get(d.id)!;
      return { kind: 'Walkthrough', title: w.title, summary: w.summary, minutes: w.minutes, href: `#/d/${d.id}/read` };
    }),
  ];
  if (reads.length) {
    page.append(
      h(
        'section.reading-section', { 'aria-labelledby': 'home-reading' },
        h('h2', { id: 'home-reading' }, 'Read: system design patterns'),
        h('p', null, 'Prose with diagrams, for a laptop or a phone. Each explains a pattern, what it costs and what breaks, and links to the animated pages for the mechanics.'),
        h(
          'ul.reading-list', null,
          reads.map((r) => h('li', null, h('a', { href: r.href, title: r.summary }, h('span.reading-title', null, r.title), h('span.reading-kind', null, `${r.kind} · ${r.minutes} min`)))),
        ),
      ),
    );
  }
  // Pairing practice pages, when any are written: small coding tasks in Java, a stage at a time.
  if (PRACTICES.length) {
    page.append(
      h(
        'section.reading-section', { 'aria-labelledby': 'home-practice' },
        h('h2', { id: 'home-practice' }, 'Practise: pairing tasks in Java'),
        h('p', null, 'Small coding tasks of the kind set in a pair-programming interview. Paste the starter into an editor, start the clock and build it a stage at a time. ', h('a', { href: '#/p' }, 'How to use these'), '.'),
        h(
          'ul.reading-list', null,
          PRACTICES.map((e) => h('li', null, h('a', { href: `#/p/${e.id}`, title: plain(e.page.summary) }, h('span.reading-title', null, e.page.title), h('span.reading-kind', null, `About ${e.page.minutes} min to stage ${e.page.core} · ${e.page.parts.length} stages`)))),
        ),
      ),
    );
  }
  page.append(
    h(
      'section.cheat-section', null,
      h('h2', null, 'Cheat sheet'),
      h('p', null, 'Costs are for n stored keys. Open a structure to see where the numbers come from.'),
      scrollRegion(h('div.table-wrap', null, tableRoles(table)), 'Cheat sheet'),
    ),
  );

  return () => {
    course.off();
    alive = false;
    stage?.destroy();
    page.remove();
  };
}
