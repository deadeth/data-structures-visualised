import { randomInt } from '../../core/rng';
import type { StructureDef } from '../../core/types';
import { info } from './info';
import { layout } from './layout';
import { MEM_CAP, compact, create, flush, get, liveKeys, put, remove, writeAmp, type LsmState } from './lsm';

export * from './lsm';
export { layout } from './layout';

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: LsmState): number {
  const have = new Set(liveKeys(s));
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!have.has(k)) return k;
  }
  for (let i = 0; i < 200; i++) {
    const k = randomInt(100, 999);
    if (!have.has(k)) return k;
  }
  return randomInt(0, 999);
}

function presentKey(s: LsmState): number {
  const keys = liveKeys(s);
  return keys.length ? keys[randomInt(0, keys.length - 1)] : 42;
}

/** A stored key whose newest copy sits as deep as possible, so the get has to work for it. */
function deepKey(s: LsmState): number {
  const seen = new Set<number>(s.mem.map((e) => e.k));
  let deepest: number[] = [];
  for (const level of s.levels) {
    const here: number[] = [];
    for (const t of level) {
      for (const e of t.entries) {
        if (seen.has(e.k)) continue;
        seen.add(e.k);
        if (!e.del) here.push(e.k);
      }
    }
    if (here.length) deepest = here;
  }
  return deepest.length ? deepest[randomInt(0, deepest.length - 1)] : presentKey(s);
}

const puts = (...keys: number[]) => keys.map((k) => ['put', k] as [string, number]);

const def: StructureDef<LsmState> = {
  id: 'lsm-tree',
  create: () => create(),
  // Oldest data first. Each line leaves the tree one step closer to the starting picture.
  seed: [
    ...puts(5, 14, 23, 31, 42, 58, 67, 76), // two flushes
    ['compact'], // L0 to L1
    ['compact'], // L1 to L2
    ...puts(9, 18, 27, 36, 45, 54, 72, 90),
    ['compact'], // L0 to L1
    ...puts(12, 33, 61),
    ['flush'],
    ...puts(20, 27),
    ['delete', 54],
    ['flush'],
    ...puts(16, 39, 64),
  ],
  ops: [
    { id: 'put', label: 'Put', intent: 'primary', args: [KEY], run: (s, [k], rec) => put(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'get', label: 'Get', args: [KEY], run: (s, [k], rec) => void get(s, Number(k), rec), suggest: (s) => [deepKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], run: (s, [k], rec) => remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'flush', label: 'Flush memtable', args: [], run: (s, _args, rec) => flush(s, rec) },
    { id: 'compact', label: 'Compact', args: [], run: (s, _args, rec) => compact(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Tables read' },
    { key: 'writes', label: 'Entries written to disk' },
  ],
  status: (s) => [
    { label: 'Memtable', value: `${s.mem.length} of ${MEM_CAP}` },
    { label: 'Tables per level', value: s.levels.map((l, i) => `L${i}: ${l.length}`).join(', ') },
    { label: 'Live keys', value: String(liveKeys(s).length) },
    { label: 'Write amplification', value: s.userWrites ? `${writeAmp(s).toFixed(1)}×` : 'none yet' },
  ],
  tour: [
    ['get', 39],
    ['get', 58],
    ['put', 50],
    ['compact'],
    ['delete', 23],
    ['get', 23],
  ],
  fill: (s) => ['put', absentKey(s)],
  bench: { insert: 'put', search: 'get' },
  info,
};

export default def;
