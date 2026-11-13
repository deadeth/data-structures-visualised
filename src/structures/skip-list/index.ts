import { makeRng, randomInt } from '../../core/rng';
import type { Decor, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/SkipList.java?raw';
import python from './code/skip_list.py?raw';
import { info } from './info';

/**
 * Skip list of integers.
 *
 * Every key sits in the bottom list (level 1). A coin flip decides whether a
 * key is also linked into the level above, and so on, up to MAX_LEVEL. A node
 * is a "tower": next[i] is its pointer on level i + 1. The head is a sentinel
 * tower of full height that holds no key.
 *
 * The generator lives in the state, so the same operations always produce the
 * same towers and the tour replays identically.
 */
export const MAX_LEVEL = 5;
export const P = 0.5;
/** Chosen so the seed keys give a clear express lane and the tour's insert flips heads twice. */
export const DEFAULT_SEED = 2995;

export interface SNode {
  key: number;
  /** next[i] is the pointer on level i + 1. The length is the tower's height. */
  next: (SNode | null)[];
}

export interface SkipState {
  head: SNode;
  /** Tallest a tower may grow. The page keeps this small so the lanes fit on screen. */
  maxLevel: number;
  /** Levels in use, 1..maxLevel. */
  level: number;
  size: number;
  /** Total height of all towers, kept so the status line needs no scan. */
  pointers: number;
  rnd: () => number;
  /** A key that has a place and a height but is not linked in yet. Only set while an insert is being recorded. */
  pending: { key: number; height: number } | null;
}

export function create(seed: number = DEFAULT_SEED, maxLevel: number = MAX_LEVEL): SkipState {
  return {
    head: { key: -1, next: new Array<SNode | null>(maxLevel).fill(null) },
    maxLevel,
    level: 1,
    size: 0,
    pointers: 0,
    rnd: makeRng(seed),
    pending: null,
  };
}

export function allKeys(s: SkipState): number[] {
  const out: number[] = [];
  for (let n = s.head.next[0]; n; n = n.next[0]) out.push(n.key);
  return out;
}

/** Height of every tower, in key order. */
export function heights(s: SkipState): number[] {
  const out: number[] = [];
  for (let n = s.head.next[0]; n; n = n.next[0]) out.push(n.next.length);
  return out;
}

/** Plain lookup with no narration. */
export function has(s: SkipState, key: number): boolean {
  let x = s.head;
  for (let i = s.level - 1; i >= 0; i--) {
    for (let n = x.next[i]; n && n.key <= key; n = x.next[i]) {
      if (n.key === key) return true;
      x = n;
    }
  }
  return false;
}

// ---- ids ------------------------------------------------------------------
// Levels in ids are 1-based, to match the narration: k42:2 is the level 2 box of key 42.

const col = (n: SNode) => (n.key < 0 ? 'head' : `k${n.key}`);
/** Box of node n on level index i. */
const bid = (n: SNode, i: number) => `${col(n)}:${i + 1}`;
/** The pointer that leaves node n on level index i. The id stays the same when the pointer is aimed elsewhere. */
const pid = (n: SNode, i: number) => `p:${col(n)}:${i + 1}`;
/** The line that joins node n's box on level index i to the box below it. */
const tid = (n: SNode, i: number) => `t:${col(n)}:${i + 1}`;
const nilId = (i: number) => `nil:${i + 1}`;

const name = (n: SNode | null) => (n === null ? 'nil' : n.key < 0 ? 'the head' : String(n.key));
/** A node as the Variables strip shows it: its key, 'head' for the sentinel, null for nil. */
const val = (n: SNode | null | undefined) => (n == null ? null : n.key < 0 ? 'head' : n.key);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a missing key would sit on the bottom level. */
function gap(pred: SNode, succ: SNode | null): string {
  if (pred.key < 0 && !succ) return 'straight after the head';
  if (pred.key < 0) return `at the front, before ${succ!.key}`;
  if (!succ) return `at the end, after ${pred.key}`;
  return `between ${pred.key} and ${succ.key}`;
}

// ---- the walk --------------------------------------------------------------

type Mode = 'search' | 'insert' | 'delete';

interface Walk {
  /** update[i] is the last node visited on level index i: the node whose pointer would change. */
  update: SNode[];
  hit: SNode | null;
  /** Highest level index on which the key was seen. */
  hitLevel: number;
  comparisons: number;
}

/**
 * Walk from the head's top level towards `key`: right while the next key is
 * smaller, down when it is not. A search stops at the first match. An insert
 * stops there too, because the key is a duplicate. A delete carries on down,
 * because it needs the node before the key on every level of its tower.
 */
function descend(s: SkipState, key: number, rec: Rec, mode: Mode): Walk {
  const update = new Array<SNode>(s.level);
  const text = String(key);
  let x = s.head;
  let hit: SNode | null = null;
  let hitLevel = -1;
  let comparisons = 0;
  /** The node that sent the walk down a level. The level below often leads to it again. */
  let over: SNode | null = null;
  /** The listing's update list: insert starts it full of the head, delete full of None. Search has none. */
  const updates = () =>
    mode === 'search'
      ? undefined
      : Array.from({ length: mode === 'insert' ? s.maxLevel : s.level }, (_, j) => (update[j] ? val(update[j]) : mode === 'insert' ? 'head' : null));
  const watch = (i: number, nxt: SNode | null) => rec.vars({ key, i, node: val(x), 'node.next[i]': val(nxt), update: updates() });

  rec.count('reads');
  if (rec.recording) {
    const top = s.level - 1;
    rec.vars({ key, node: val(x), update: updates() });
    rec.mark(bid(x, top), 'path');
    rec.line('start');
    rec.step(
      s.level === 1
        ? `Start at the head. Only level 1 is in use, so this is a plain walk along a linked list.`
        : `Start at the head on level ${s.level}, the highest level in use. Upper levels hold fewer keys, so each hop there covers more ground.`,
      { probe: { text, at: bid(x, top) } },
    );
  }

  for (let i = s.level - 1; i >= 0; i--) {
    const lv = i + 1;
    for (;;) {
      const nxt = x.next[i];
      if (nxt === null) {
        if (rec.recording) {
          watch(i, nxt);
          rec.line(i > 0 ? 'down' : 'bottom');
          rec.step(
            i > 0
              ? `Level ${lv} ends here: the next pointer is nil. Drop down to level ${i}.`
              : mode === 'insert'
                ? `The bottom level ends here, so ${key} goes at the end.`
                : `The bottom level ends here, so ${key} cannot be in the list.`,
            { probe: { text, at: nilId(i) } },
          );
        }
        break;
      }
      comparisons++;
      if (!rec.recording) {
        // Same moves as below, with no narration.
        rec.count('comparisons');
        if (nxt.key < key) {
          x = nxt;
          rec.count('reads');
          continue;
        }
        if (nxt.key === key) {
          hit = nxt;
          if (hitLevel < 0) hitLevel = i;
          if (mode === 'search') rec.count('reads');
        }
        break;
      }

      const on = bid(nxt, i);
      const probe = { text, at: on };
      watch(i, nxt);
      rec.mark(on, 'compare');
      if (nxt.key < key) {
        rec.line('right');
        let skipped = 0;
        for (let n = x.next[0]; n && n !== nxt; n = n.next[0]) skipped++;
        rec.compare(key, '>', nxt.key, `move right to ${nxt.key}`, {
          probe,
          message:
            skipped > 0
              ? `${nxt.key} is smaller than ${key}, so move right. This level ${lv} pointer hops over ${plural(skipped, 'key')} in one go.`
              : `${nxt.key} is smaller than ${key}, so move right along level ${lv}.`,
        });
        rec.mark(on, 'path');
        rec.markEdge(pid(x, i), 'path');
        x = nxt;
        rec.count('reads');
        continue;
      }
      if (nxt.key === key) {
        const first = hitLevel < 0;
        hit = nxt;
        if (first) hitLevel = i;
        // A delete keeps walking: the match is one more pointer to remember.
        rec.line(mode === 'delete' ? 'hit' : 'match');
        if (mode === 'search') {
          rec.compare(key, '=', nxt.key, `match, move right onto ${key}`, {
            probe,
            message: `Match. Move right onto ${key}: the search ends here, on level ${lv}.`,
          });
          rec.mark(on, 'ok');
          rec.markEdge(pid(x, i), 'path');
          rec.count('reads');
        } else if (mode === 'insert') {
          rec.compare(key, '=', nxt.key, `already stored`, { probe, message: `${key} is already here, so there is nothing to insert.` });
          rec.mark(on, 'ok');
        } else {
          rec.compare(key, '=', nxt.key, !first ? `another pointer into ${key}` : i === 0 ? `found ${key}` : `found the top of ${key}’s tower`, {
            probe,
            message:
              i === 0 && first
                ? `This is ${key}. Its tower is one level tall, so the pointer from ${name(x)} is the only one to change.`
                : first
                  ? `This is ${key}, at the top of its tower. Remember that ${name(x)} points to it on level ${lv}, then drop down to find the pointers below.`
                  : `On level ${lv} the pointer into ${key} comes from ${name(x)}. Remember that one too.`,
          });
          rec.mark(on, 'bad');
        }
        break;
      }
      // The next key is too big: this level cannot take us any closer.
      rec.line(i > 0 ? 'down' : 'bottom');
      if (i > 0) {
        if (nxt === over) {
          rec.compare(key, '<', nxt.key, `still too far, drop down to level ${i}`, {
            probe,
            message: `Level ${lv} leads to ${nxt.key} as well, which is still too far. Drop down to level ${i}.`,
          });
        } else {
          rec.compare(key, '<', nxt.key, `too far, drop down to level ${i}`, {
            probe,
            message: `${nxt.key} is past ${key}, so this hop would overshoot. Drop down to level ${i}, where the hops are shorter.`,
          });
        }
      } else if (mode === 'insert') {
        rec.compare(key, '<', nxt.key, `${key} goes just before ${nxt.key}`, {
          probe,
          message: `${nxt.key} is past ${key} and this is the bottom level, so this is the place: ${key} goes just before ${nxt.key}.`,
        });
      } else {
        rec.compare(key, '<', nxt.key, `too far, and there is no level below`, {
          probe,
          message: `${nxt.key} is past ${key} and this is the bottom level, so ${key} cannot be in the list.`,
        });
      }
      rec.unmark(on);
      over = nxt;
      break;
    }
    update[i] = x;
    if (hit && mode !== 'delete') break;
    if (i > 0 && rec.recording) {
      rec.markEdge(tid(x, i), 'path');
      rec.mark(bid(x, i - 1), 'path');
    }
  }
  return { update, hit, hitLevel, comparisons };
}

// ---- operations ------------------------------------------------------------

export function search(s: SkipState, key: number, rec: Rec): boolean {
  rec.vars();
  const w = descend(s, key, rec, 'search');
  if (!rec.recording) return w.hit !== null;
  if (w.hit) {
    const node = w.hit;
    for (let i = 0; i < node.next.length; i++) rec.mark(bid(node, i), 'ok');
    let rank = 0;
    for (let n = s.head.next[0]; n; n = n.next[0]) {
      rank++;
      if (n === node) break;
    }
    const cost = plural(w.comparisons, 'comparison');
    rec.vars({ key, i: w.hitLevel, node: val(w.update[w.hitLevel]), 'node.next[i]': val(node) });
    rec.line('found');
    rec.step(
      w.comparisons < rank
        ? `Found ${key} after ${cost}. Walking the bottom level alone would have taken ${rank}: the upper levels skipped the rest.`
        : `Found ${key} after ${cost}. It sits near the front, so there was little for the upper levels to skip.`,
      { probe: { text: String(key), at: bid(node, w.hitLevel) } },
    );
    return true;
  }
  const pred = w.update[0];
  rec.markEdge(pid(pred, 0), 'bad');
  rec.vars({ key, i: 0, node: val(pred), 'node.next[i]': val(pred.next[0]) });
  rec.line('miss');
  rec.step(
    s.size === 0
      ? `The list is empty, so ${key} is not in it.`
      : `${key} is not in the list: on level 1, ${name(pred)} points straight to ${name(pred.next[0])}. The miss took ${plural(w.comparisons, 'comparison')}.`,
  );
  return false;
}

export function insert(s: SkipState, key: number, rec: Rec): boolean {
  rec.vars();
  const w = descend(s, key, rec, 'insert');
  if (w.hit) {
    rec.line('duplicate');
    if (rec.recording) rec.step(`${key} is already in the list. A set keeps each key once, so nothing changes.`, { probe: { text: String(key), at: bid(w.hit, w.hitLevel) } });
    return false;
  }
  const text = String(key);
  const ghost = (lv: number) => `k${key}:${lv}`;

  if (rec.recording) {
    s.pending = { key, height: 1 };
    rec.vars({ key, update: Array.from({ length: s.maxLevel }, (_, j) => (w.update[j] ? val(w.update[j]) : 'head')) });
    rec.line('place');
    rec.step(
      `${key} belongs ${gap(w.update[0], w.update[0].next[0])}. The last node visited on each level is remembered: its pointer changes if the coin flips take the tower that high.`,
      { probe: { text, at: ghost(1) } },
    );
  }

  // Flip until tails. Each heads promotes the key one level.
  let h = 1;
  while (h < s.maxLevel) {
    if (s.rnd() >= P) {
      if (rec.recording) {
        rec.vars({ height: h });
        rec.line('tails');
        rec.step(
          h === 1
            ? `Flip: tails. ${key} stays on level 1 only, as half of all keys do.`
            : `Flip: tails. The tower for ${key} stops at ${h} levels.`,
          { probe: { text, at: ghost(h) } },
        );
      }
      break;
    }
    h++;
    if (rec.recording) {
      s.pending!.height = h;
      rec.vars({ height: h });
      rec.line('heads');
      rec.step(
        h === s.maxLevel
          ? `Flip: heads, so ${key} also gets a level ${h} pointer. That is the tallest a tower can be here, so the flipping stops.`
          : `Flip: heads, so ${key} also gets a level ${h} pointer. Flip again.`,
        { probe: { text, at: ghost(h) } },
      );
    }
  }

  // Splice in, bottom level first, so the key is reachable as soon as its level 1 link is in.
  const node: SNode = { key, next: [] };
  for (let i = 0; i < h; i++) {
    const fresh = i >= s.level;
    const pred = fresh ? s.head : w.update[i];
    if (fresh) s.level = i + 1;
    const succ = pred.next[i];
    node.next.push(succ);
    pred.next[i] = node;
    rec.count('writes', 2);
    if (rec.recording) {
      rec.mark(bid(node, i), 'key');
      rec.markEdge(pid(pred, i), 'ok');
      rec.markEdge(pid(node, i), 'ok');
      rec.vars({ key, height: h, level: s.level, i, 'update[i]': val(pred), 'fresh.next[i]': val(succ) });
      if (fresh) rec.line('grow', 'splice');
      else rec.line('splice');
      rec.step(
        fresh
          ? `Level ${i + 1} was empty until now. The head points to ${key} there, and ${key} points to nil.`
          : `Splice level ${i + 1}: ${key} takes over the pointer to ${name(succ)}, then ${name(pred)} points to ${key}. Two pointers written.`,
        { probe: { text, at: bid(node, i) } },
      );
    }
  }
  s.size++;
  s.pointers += h;
  s.pending = null;
  if (rec.recording) {
    rec.vars({ key, height: h, level: s.level });
    rec.line('done');
    rec.step(
      `${key} is stored with a tower ${plural(h, 'level')} tall. That took ${plural(w.comparisons, 'comparison')} and ${2 * h} pointer writes, and nothing was rebalanced.`,
      { probe: { text, at: bid(node, h - 1) } },
    );
  }
  return true;
}

export function remove(s: SkipState, key: number, rec: Rec): boolean {
  rec.vars();
  const w = descend(s, key, rec, 'delete');
  const node = w.hit;
  if (!node) {
    if (rec.recording) {
      const pred = w.update[0];
      rec.markEdge(pid(pred, 0), 'bad');
      rec.vars({ key, target: val(pred.next[0]), update: w.update.map(val) });
      rec.line('missing');
      rec.step(
        s.size === 0
          ? `The list is empty, so there is nothing to delete.`
          : `${key} is not in the list, so there is nothing to delete. On level 1, ${name(pred)} points straight to ${name(pred.next[0])}.`,
      );
    }
    return false;
  }
  const text = String(key);
  const h = node.next.length;
  rec.count('reads');
  if (rec.recording) {
    rec.vars({ key, target: key, 'len(target.next)': h, update: w.update.map(val) });
    rec.line('found');
    rec.step(
      h === 1
        ? `Found ${key}. One pointer leads to it, so one pointer has to change.`
        : `Found ${key}. Its tower is ${h} levels tall, so ${h} pointers lead to it, and each one must be rerouted around it.`,
      { probe: { text, at: bid(node, h - 1) } },
    );
  }
  for (let i = h - 1; i >= 0; i--) {
    const pred = w.update[i];
    const succ = node.next[i];
    pred.next[i] = succ;
    node.next.pop();
    rec.count('writes');
    // A level with nothing left on it drops out of use.
    const emptied = i > 0 && i === s.level - 1 && s.head.next[i] === null;
    if (emptied) s.level--;
    if (rec.recording) {
      rec.markEdge(pid(pred, i), 'ok');
      rec.vars({ key, target: key, i, 'update[i]': val(pred), 'target.next[i]': val(succ), level: s.level });
      if (emptied) rec.line('unlink', 'shrink');
      else rec.line('unlink');
      rec.step(
        `Level ${i + 1}: ${name(pred)} now points past ${key} to ${name(succ)}.` +
          (emptied ? ` Level ${i + 1} has no keys left, so it drops out of use.` : i === 0 ? ` Nothing points to ${key} any more.` : ''),
        i > 0 ? { probe: { text, at: bid(node, i - 1) } } : undefined,
      );
    }
  }
  s.size--;
  s.pointers -= h;
  if (rec.recording) {
    rec.vars({ key, level: s.level });
    rec.line('done');
    rec.step(
      `${key} is deleted: ${plural(h, 'pointer')} rewritten after ${plural(w.comparisons, 'comparison')}, with no rebalancing. The list holds ${plural(s.size, 'key')} on ${plural(s.level, 'level')}.`,
    );
  }
  return true;
}

// ---- layout ---------------------------------------------------------------

const KEY_W = 40;
const HEAD_W = 54;
const GAP = 13;
/** Tall enough for the probe chip to sit between a box and the box above it. */
const ROW = 76;

export function layout(s: SkipState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  const p = s.pending;
  const rows = Math.max(s.level, p ? p.height : 0);
  const y = (lv: number) => -(lv - 1) * ROW;

  /** One column: `real` linked boxes, then ghost boxes up to `tall` for a tower that is not linked in yet. */
  const tower = (id: string, x: number, label: string, w: number, real: number, tall: number) => {
    for (let lv = 1; lv <= tall; lv++) {
      const isGhost = lv > real;
      nodes.push({
        id: `${id}:${lv}`,
        x,
        y: y(lv),
        cells: [{ text: label, w }],
        tone: isGhost ? 'dim' : undefined,
        from: lv > 1 ? `${id}:${lv - 1}` : undefined,
      });
      if (lv > 1) edges.push({ id: `t:${id}:${lv}`, from: `${id}:${lv}`, to: `${id}:${lv - 1}`, kind: 'tree', tone: isGhost ? 'dim' : undefined });
    }
  };
  const pointers = (n: SNode) => {
    for (let i = 0; i < n.next.length && i < s.level; i++) {
      const to = n.next[i];
      edges.push({ id: pid(n, i), from: bid(n, i), to: to ? bid(to, i) : nilId(i), kind: 'side', arrow: true });
    }
  };

  tower('head', 0, 'head', HEAD_W, s.level, s.level);
  pointers(s.head);
  let x = HEAD_W / 2 + GAP + KEY_W / 2;
  let placed = p === null;
  for (let n = s.head.next[0]; n; n = n.next[0]) {
    if (!placed && n.key > p!.key) {
      tower(`k${p!.key}`, x, String(p!.key), KEY_W, 0, p!.height);
      x += KEY_W + GAP;
      placed = true;
    }
    const mine = !placed && n.key === p!.key;
    tower(col(n), x, String(n.key), KEY_W, n.next.length, mine ? Math.max(n.next.length, p!.height) : n.next.length);
    if (mine) placed = true;
    pointers(n);
    x += KEY_W + GAP;
  }
  if (!placed) {
    tower(`k${p!.key}`, x, String(p!.key), KEY_W, 0, p!.height);
    x += KEY_W + GAP;
  }
  for (let lv = 1; lv <= s.level; lv++) nodes.push({ id: `nil:${lv}`, x, y: y(lv), cells: [{ text: 'nil', w: KEY_W }], tone: 'dim' });
  for (let lv = 1; lv <= rows; lv++) decor.push({ id: `level${lv}`, type: 'label', x: -HEAD_W / 2 - 14, y: y(lv), text: `Level ${lv}`, anchor: 'end' });
  return { nodes, edges, decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: SkipState): number {
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!has(s, k)) return k;
  }
  for (let i = 0; i < 200; i++) {
    const k = randomInt(100, 999);
    if (!has(s, k)) return k;
  }
  return randomInt(0, 999);
}

/** A stored key, taken from the far half when there is one, so the search has something to skip. */
function presentKey(s: SkipState): number {
  const keys = allKeys(s);
  if (!keys.length) return 42;
  return keys[randomInt(Math.floor(keys.length / 2), keys.length - 1)];
}

const def: StructureDef<SkipState> = {
  id: 'skip-list',
  create: (p) => create(DEFAULT_SEED, p.maxLevel ?? MAX_LEVEL),
  seed: [8, 15, 23, 31, 38, 46, 54, 61, 69, 77, 85, 93].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert', 'random_height'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'writes', label: 'Pointers changed' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Levels in use', value: `${s.level} of ${s.maxLevel}` },
    { label: 'Pointers per key', value: s.size ? (s.pointers / s.size).toFixed(2) : '0' },
  ],
  tour: [
    ['search', 85],
    ['insert', 20],
    ['insert', 65],
    ['search', 30],
    ['delete', 54],
  ],
  fill: (s) => ['insert', absentKey(s)],
  // Five levels suit a dozen keys on screen but would cripple a list of thousands,
  // so the head-to-head run lifts the cap, as a real skip list would.
  bench: { insert: 'insert', search: 'search', variants: [{ label: 'Skip list', params: { maxLevel: 24 } }] },
  source: { python, java },
  info,
};

export default def;
