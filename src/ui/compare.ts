import { CATALOG, isReady, loadStructure } from '../catalog';
import { h } from '../core/dom';
import { Recorder } from '../core/recorder';
import { makeRng } from '../core/rng';
import type { OpDef, StructureDef } from '../core/types';

interface Row {
  id: string;
  name: string;
  lookupCmp: number;
  lookupReads: number;
  insertCmp: number;
}

const LOOKUPS = 200;

function measure(def: StructureDef, name: string, keys: number[], probes: number[]): Row {
  const params: Record<string, number> = {};
  for (const p of def.params ?? []) params[p.id] = p.default;
  const state = def.create(params);
  const insert = def.ops.find((o) => o.id === def.bench!.insert) as OpDef<unknown>;
  const search = def.ops.find((o) => o.id === def.bench!.search) as OpDef<unknown>;
  const ins = new Recorder(state, def.layout, false);
  for (const k of keys) insert.run(state, [k], ins);
  const look = new Recorder(state, def.layout, false);
  for (const k of probes) search.run(state, [k], look);
  return {
    id: def.id,
    name,
    lookupCmp: (look.counters.comparisons ?? 0) / probes.length,
    lookupReads: (look.counters.reads ?? 0) / probes.length,
    insertCmp: (ins.counters.comparisons ?? 0) / keys.length,
  };
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-GB') : n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** Head to head: the same keys and the same lookups, run through every structure that can take them. */
export async function mountCompare(host: HTMLElement): Promise<() => void> {
  const sizeSel = h('select', null, [100, 1000, 5000].map((n) => h('option', { value: String(n), selected: n === 1000 }, n.toLocaleString('en-GB'))));
  const orderSel = h('select', null, h('option', { value: 'random' }, 'Random order'), h('option', { value: 'sorted' }, 'Sorted order'));
  const out = h('div.compare-out');
  const runBtn = h('button.btn.primary', { type: 'button' }, 'Run the workload');
  const page = h(
    'article.compare', null,
    h(
      'header.page-head', null,
      h('h1', null, 'Head to head'),
      h(
        'p.lede', null,
        `Insert the same keys into each structure, then look up ${LOOKUPS} of them. The table counts the work each lookup took. Try sorted order to see which structures fall apart.`,
      ),
    ),
    h('div.controls', null, h('div.ops', null, h('div.op-group', null, h('label.field', null, h('span', null, 'Keys to insert'), sizeSel), h('label.field', null, h('span', null, 'Arrival order'), orderSel), h('div.op-buttons', null, runBtn)))),
    out,
  );
  host.append(page);

  let alive = true;
  const defs: { def: StructureDef; name: string }[] = [];
  for (const c of CATALOG) {
    if (!isReady(c.id)) continue;
    const def = await loadStructure(c.id);
    if (def.bench) defs.push({ def, name: c.name });
  }

  const run = async () => {
    runBtn.disabled = true;
    out.replaceChildren(h('p.muted', null, 'Running…'));
    await new Promise((r) => setTimeout(r, 30));
    const n = Number(sizeSel.value);
    const rnd = makeRng(20261110 + n);
    const all = Array.from({ length: n }, (_, i) => i + 1);
    const keys = [...all];
    if (orderSel.value === 'random') {
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
    }
    const probes = Array.from({ length: LOOKUPS }, () => all[Math.floor(rnd() * n)]);
    const rows: Row[] = [];
    for (const { def, name } of defs) {
      rows.push(measure(def, name, keys, probes));
      await new Promise((r) => setTimeout(r, 0));
      if (!alive) return;
    }
    rows.sort((a, b) => a.lookupCmp - b.lookupCmp);
    const max = Math.max(...rows.map((r) => r.lookupCmp), 1);
    const table = h(
      'table.results', null,
      h('caption', null, `${n.toLocaleString('en-GB')} keys inserted in ${orderSel.value} order, then ${LOOKUPS} lookups. Averages per operation; log₂ of ${n.toLocaleString('en-GB')} is ${Math.log2(n).toFixed(1)}.`),
      h('thead', null, h('tr', null, ['Structure', 'Comparisons per lookup', '', 'Nodes read per lookup', 'Comparisons per insert'].map((t) => h('th', { scope: 'col' }, t)))),
      h(
        'tbody', null,
        rows.map((r) =>
          h(
            'tr', null,
            h('th', { scope: 'row' }, h('a', { href: `#/s/${r.id}` }, r.name)),
            h('td.num', null, fmt(r.lookupCmp)),
            // Square-root scale so the O(n) rows do not flatten everything else to nothing.
            h('td.bar-cell', null, h('span.bar', { style: `width:${Math.max(0.6, Math.sqrt(r.lookupCmp / max) * 100).toFixed(1)}%` })),
            h('td.num', null, fmt(r.lookupReads)),
            h('td.num', null, fmt(r.insertCmp)),
          ),
        ),
      ),
    );
    out.replaceChildren(
      h('div.table-wrap', null, table),
      h('p.muted', null, 'Bar length uses a square-root scale. Comparisons are not the whole story: a B+ tree does more comparisons than a balanced binary tree but reads far fewer nodes, and on disk the node reads are what you pay for.'),
    );
    runBtn.disabled = false;
  };
  runBtn.addEventListener('click', () => void run());
  void run();

  return () => {
    alive = false;
    page.remove();
  };
}
