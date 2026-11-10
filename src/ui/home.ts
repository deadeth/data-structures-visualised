import { CATALOG, GROUPS, isReady, loadStructure } from '../catalog';
import { h, scrollRegion } from '../core/dom';
import { Recorder } from '../core/recorder';
import type { OpDef } from '../core/types';
import { Stage } from './stage';
import { legend } from './structure-page';

/** "O(1) amortised": the big-O never breaks across lines; the qualifier is set in the text face and may wrap. */
function cost(text: string): (HTMLElement | string)[] {
  const m = /^(O\([^)]*\),?)\s*(.*)$/.exec(text);
  // A cost that is not a big-O ("Not supported") is words, so it is set in the text face.
  if (!m) return [h('span.words', null, text)];
  return m[2] ? [h('span.big-o', null, m[1]), ' ', h('span.qualifier', null, m[2])] : [h('span.big-o', null, m[1])];
}

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
          h('td.num', { 'data-label': 'Lookup' }, cost(c.cheat.lookup)),
          h('td.num', { 'data-label': 'Insert' }, cost(c.cheat.insert)),
          h('td.num', { 'data-label': 'Delete' }, cost(c.cheat.remove)),
          h('td', { 'data-label': 'Keeps order' }, c.cheat.ordered),
          h('td', { 'data-label': 'Reach for it when' }, c.cheat.pick),
        ),
      );
    }
    table.append(body);
  }
  page.append(
    h(
      'section.cheat-section', null,
      h('h2', null, 'Cheat sheet'),
      h('p', null, 'Costs are for n stored keys. Open a structure to see where the numbers come from.'),
      scrollRegion(h('div.table-wrap', null, table), 'Cheat sheet'),
    ),
  );

  return () => {
    alive = false;
    stage?.destroy();
    page.remove();
  };
}
