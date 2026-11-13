import { CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef, Tone } from '../../core/types';
import java from './code/MergeLists.java?raw';
import python from './code/merge_lists.py?raw';

/**
 * Merging sorted lists.
 *
 * The inputs are two to four sorted lists, named A to D. A two-way merge walks
 * A and B with one front pointer each and always takes the smaller front item;
 * on a tie it takes from A, which keeps the merge stable. A k-way merge keeps a
 * min-heap holding the front item of every list, ordered by value and then by
 * list, so the root is always the next item to write.
 *
 * The inputs are never changed by a merge: items already taken stay in place,
 * dimmed, so a merge can be run again. Every item carries a unique id, so equal
 * values stay separate items and each can slide from its list to the output.
 */
export interface Item {
  uid: number;
  key: number;
  /** Which list it came from: 0 for A, 1 for B, and so on. */
  list: number;
  /** Its position in that list. */
  idx: number;
}

export interface MergeState {
  lists: Item[][];
  /** Front pointer of each list: the index of its next item not yet written. */
  ptr: number[];
  out: Item[];
  /** The k-way merge's heap. null is the hole left when the root is written out. */
  heap: (Item | null)[];
  mode: 'idle' | 'two' | 'k';
  nextUid: number;
  /** Presses of each "load" button. The first press loads a hand-picked input, later ones a random one. */
  presses: Record<string, number>;
}

/** Most items one list may hold on the canvas, by the number of lists. Wider would not fit beside the step log. */
export const CAP: Record<number, number> = { 2: 8, 3: 4, 4: 3 };

export function create(): MergeState {
  return { lists: [[], []], ptr: [0, 0], out: [], heap: [], mode: 'idle', nextUid: 1, presses: {} };
}

export const letter = (l: number) => 'ABCD'[l];
export const values = (items: Item[]) => items.map((it) => it.key);
const iid = (it: Item) => `i${it.uid}`;
const hid = (it: Item) => `h${it.uid}`;
const oid = (it: Item) => `o${it.uid}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Replace every list. Values are sorted first, because a merge needs sorted input. */
export function setLists(s: MergeState, lists: number[][]): void {
  s.lists = lists.map((vals, l) => [...vals].sort((a, b) => a - b).map((key, idx) => ({ uid: s.nextUid++, key, list: l, idx })));
  reset(s, 'idle');
}

function reset(s: MergeState, mode: MergeState['mode']): void {
  s.ptr = s.lists.map(() => 0);
  s.out = [];
  s.heap = [];
  s.mode = mode;
}

/** The lists a merge in this mode reads: A and B for a two-way merge, all of them otherwise. */
function inMerge(s: MergeState, l: number): boolean {
  return s.mode !== 'two' || l < 2;
}

// ---- two-way merge ----------------------------------------------------------

export function mergeTwo(s: MergeState, rec: Rec): Item[] {
  rec.clearMarks();
  reset(s, 'two');
  const [a, b] = s.lists;
  const n = a.length + b.length;
  rec.line('start');
  const aside = s.lists.length > 2 ? ` A two-way merge reads two lists, so ${s.lists.length === 3 ? 'C waits' : 'C and D wait'}: Merge k takes them all.` : '';
  rec.step(
    `Merge A (${a.length}) and B (${b.length}) into one sorted list of ${n}. Pointer i starts at the front of A and j at the front of B. Both lists are sorted, so the smallest item left is always at one of the two fronts.${aside}`,
  );

  let i = 0;
  let j = 0;
  let ties = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    rec.mark(iid(x), 'compare');
    rec.mark(iid(y), 'compare');
    const probe: Probe = { text: String(x.key), at: iid(x) };
    if (x.key <= y.key) {
      rec.line('compare', 'take_a');
      if (x.key === y.key) {
        ties++;
        rec.compare(x.key, '=', y.key, 'a tie: take from A, the first list', {
          probe,
          message: `${x.key} in A and ${y.key} in B are equal. On a tie the merge takes from A, the first list. Equal items then come out in their input order, and that is what makes the merge stable.`,
        });
      } else {
        rec.compare(x.key, '<', y.key, 'take from A', {
          probe,
          message: `Compare the two fronts: ${x.key} in A and ${y.key} in B. ${x.key} is smaller, so it is the smallest item left anywhere.`,
        });
      }
      rec.unmark(iid(x));
      rec.unmark(iid(y));
      take(s, x, rec);
      i++;
      s.ptr[0] = i;
      rec.line('take_a');
      rec.step(
        i < a.length
          ? `Write ${x.key} to the output and move i on. A's front is now ${a[i].key}.`
          : `Write ${x.key} to the output and move i on. i is past the end of A: A has run out.`,
        { probe: { text: String(x.key), at: oid(x) } },
      );
    } else {
      rec.line('compare', 'take_b');
      rec.compare(x.key, '>', y.key, 'take from B', {
        probe,
        message: `Compare the two fronts: ${x.key} in A and ${y.key} in B. ${y.key} is smaller, so it is the smallest item left anywhere.`,
      });
      rec.unmark(iid(x));
      rec.unmark(iid(y));
      take(s, y, rec);
      j++;
      s.ptr[1] = j;
      rec.line('take_b');
      rec.step(
        j < b.length
          ? `Write ${y.key} to the output and move j on. B's front is now ${b[j].key}.`
          : `Write ${y.key} to the output and move j on. j is past the end of B: B has run out.`,
        { probe: { text: String(y.key), at: oid(y) } },
      );
    }
  }

  const compared = s.out.length;
  const ranOut = i >= a.length ? 'A' : 'B';
  const copy = (list: Item[], l: number, anchor: string) => {
    const other = letter(1 - l);
    let first = true;
    while (s.ptr[l] < list.length) {
      const it = list[s.ptr[l]];
      take(s, it, rec);
      s.ptr[l]++;
      rec.line(anchor);
      const left = list.length - s.ptr[l];
      rec.step(
        first
          ? compared === 0
            ? `${other} is empty, so there is nothing to compare. Copy ${letter(l)} straight across: ${it.key} first.`
            : `${other} has run out, so nothing is left to compare against. Every item still in ${letter(l)} is at least as large as everything written, so copy the rest without a single comparison: ${it.key} first.`
          : `Copy ${it.key}.${left ? '' : ` That was the last item in ${letter(l)}.`}`,
        { probe: { text: String(it.key), at: oid(it) } },
      );
      first = false;
    }
  };
  copy(a, 0, 'rest_a');
  copy(b, 1, 'rest_b');

  rec.clearMarks();
  rec.line('done');
  const copied = n - compared;
  if (n === 0) {
    rec.step('Both lists are empty, so the output is empty too.');
  } else {
    const ran = copied ? `, ${copied} copied after ${ranOut} ran out` : '';
    rec.step(
      `Done: ${n} items, ${plural(compared, 'comparison')}${ran}. Never more than n + m - 1 = ${Math.max(0, n - 1)}: O(n + m).${ties ? ` ${ties === 1 ? 'The tie' : 'Ties'} went to A, so equal items kept their order.` : ''}`,
    );
  }
  return s.out;
}

/** Write an item to the output. */
function take(s: MergeState, it: Item, rec: Rec): void {
  s.out.push(it);
  rec.count('writes');
}

// ---- k-way merge --------------------------------------------------------------

/** Smaller value first; on a tie, the earlier list first. That tie rule keeps the k-way merge stable. */
export const less = (x: Item, y: Item) => x.key < y.key || (x.key === y.key && x.list < y.list);

function heapOp(x: Item, y: Item): '<' | '>' | '=' {
  return x.key < y.key ? '<' : x.key > y.key ? '>' : '=';
}

export function mergeK(s: MergeState, rec: Rec): Item[] {
  rec.clearMarks();
  reset(s, 'k');
  const k = s.lists.length;
  const n = s.lists.reduce((t, l) => t + l.length, 0);
  rec.line('start_k');
  rec.step(
    `Merge all ${k} lists, ${n} items, at once. Comparing every front each time would cost k - 1 comparisons per item. Instead a min-heap holds one front item per list, so the smallest front is always at the root. The heap is drawn as its array: index 0 is the root, and the children of index i are at 2i + 1 and 2i + 2.`,
  );

  const heap = s.heap as Item[];
  const ctx = { cmp: 0 };
  for (let l = 0; l < k; l++) {
    const list = s.lists[l];
    if (!list.length) {
      rec.line('seed');
      rec.step(`List ${letter(l)} is empty, so it puts nothing in the heap.`);
      continue;
    }
    const it = list[0];
    heap.push(it);
    rec.mark(hid(it), 'key');
    rec.line('seed', 'push');
    const probe: Probe = { text: String(it.key), at: hid(it) };
    rec.step(
      heap.length === 1
        ? `Push A's front, ${it.key}, into the heap. It is the only entry, so it is the root.`
        : `Push ${letter(l)}'s front, ${it.key}, onto the end of the heap, at index ${heap.length - 1}. Then swap it up while it is smaller than its parent.`,
      { probe },
    );
    siftUp(s, heap.length - 1, rec, ctx);
    rec.unmark(hid(it));
  }

  while (heap.length) {
    const top = heap[0];
    const l = top.list;
    take(s, top, rec);
    s.heap[0] = null;
    rec.line('pop');
    rec.step(
      s.out.length === 1
        ? `The root, ${top.key} from ${letter(l)}, is the smallest front item of all, so it is the smallest item anywhere. Write it to the output.`
        : `Write the root, ${top.key} from ${letter(l)}, to the output.`,
      { probe: { text: String(top.key), at: oid(top) } },
    );
    s.ptr[l]++;
    const list = s.lists[l];
    if (s.ptr[l] < list.length) {
      const next = list[s.ptr[l]];
      heap[0] = next;
      rec.mark(hid(next), 'key');
      rec.line('refill', 'replace');
      rec.step(`${letter(l)} has more. Its next item, ${next.key}, goes into the root, where ${top.key} was. It may be too large there, so sift it down.`, {
        probe: { text: String(next.key), at: hid(next) },
      });
      siftDown(s, rec, ctx);
      rec.unmark(hid(next));
    } else if (heap.length > 1) {
      const last = heap.pop()!;
      heap[0] = last;
      rec.mark(hid(last), 'key');
      rec.line('drained', 'shrink');
      rec.step(
        `${letter(l)} has run out, so the heap shrinks by one. Its last entry, ${last.key} from ${letter(last.list)}, fills the hole at the root and sifts down.`,
        { probe: { text: String(last.key), at: hid(last) } },
      );
      siftDown(s, rec, ctx);
      rec.unmark(hid(last));
    } else {
      heap.pop();
      rec.line('drained', 'shrink');
      rec.step(`${letter(l)} has run out too. It was the last list with items left, so the heap is empty and the merge is over.`);
    }
  }

  rec.clearMarks();
  rec.line('done_k');
  rec.step(
    n === 0
      ? 'Every list is empty, so the output is empty too.'
      : `Done: ${n} items from ${k} lists, ${plural(ctx.cmp, 'comparison')}. Each item passed once through a heap of at most k = ${k}: O(n log k).`,
  );
  return s.out;
}

function siftUp(s: MergeState, start: number, rec: Rec, ctx: { cmp: number }): void {
  const heap = s.heap as Item[];
  let i = start;
  const it = heap[i];
  const probe: Probe = { text: String(it.key), at: hid(it) };
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = heap[p];
    rec.mark(hid(parent), 'compare');
    ctx.cmp++;
    const where = `The parent of index ${i} is index ${p}, ${parent.key} from ${letter(parent.list)}.`;
    if (!less(it, parent)) {
      rec.line('seed', 'up_test', 'up_stop');
      const op = heapOp(it, parent);
      rec.compare(it.key, op === '=' ? '=' : '≥', parent.key, op === '=' ? `a tie, and ${letter(parent.list)} is the earlier list, so stop` : 'heap order holds, stop', {
        probe,
        message:
          op === '='
            ? `${where} The values tie, so the earlier list counts as smaller: ${letter(parent.list)} before ${letter(it.list)}. ${it.key} stays where it is.`
            : `${where} ${it.key} is not smaller, so it stays where it is.`,
      });
      rec.unmark(hid(parent));
      return;
    }
    const op = heapOp(it, parent);
    rec.line('seed', 'up_test');
    rec.compare(it.key, op === '=' ? '=' : '<', parent.key, op === '=' ? `a tie, and ${letter(it.list)} is the earlier list, so swap up` : 'swap up', {
      probe,
      message:
        op === '='
          ? `${where} The values tie, so the earlier list counts as smaller: ${letter(it.list)} before ${letter(parent.list)}. Swap up.`
          : `${where} ${it.key} is smaller, so it swaps up.`,
    });
    heap[p] = it;
    heap[i] = parent;
    rec.unmark(hid(parent));
    rec.line('seed', 'up_swap');
    rec.step(`Swap: ${it.key} rises to index ${p} and ${parent.key} drops to index ${i}.`, { probe });
    i = p;
  }
}

function siftDown(s: MergeState, rec: Rec, ctx: { cmp: number }): void {
  const heap = s.heap as Item[];
  const size = heap.length;
  const it = heap[0];
  const probe: Probe = { text: String(it.key), at: hid(it) };
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= size) {
      if (i === 0) {
        rec.line('children', 'leaf');
        rec.step(`${it.key} is the only entry in the heap, so there is nothing to compare it with.`, { probe });
      }
      return;
    }
    const r = l + 1;
    let c = l;
    let lead: string;
    if (r < size) {
      const left = heap[l];
      const right = heap[r];
      rec.mark(hid(left), 'compare');
      rec.mark(hid(right), 'compare');
      const where = `The children of index ${i} are at ${l} and ${r}: ${left.key} from ${letter(left.list)} and ${right.key} from ${letter(right.list)}.`;
      const op = heapOp(left, right);
      ctx.cmp++;
      if (less(right, left)) {
        c = r;
        rec.line('children', 'pick', 'pick_right');
        rec.compare(left.key, op === '=' ? '=' : '>', right.key, op === '=' ? `a tie: ${letter(right.list)} is earlier, so the right child` : 'the right child is smaller', {
          probe,
          message: `${where} Find the smaller child first: only it could sit above the other.`,
        });
      } else {
        rec.line('children', 'pick');
        rec.compare(left.key, op === '=' ? '=' : '<', right.key, op === '=' ? `a tie: ${letter(left.list)} is earlier, so the left child` : 'the left child is smaller', {
          probe,
          message: `${where} Find the smaller child first: only it could sit above the other.`,
        });
      }
      rec.unmark(hid(c === l ? right : left));
      lead = `Now test ${it.key} against the smaller child, ${heap[c].key}.`;
    } else {
      rec.mark(hid(heap[l]), 'compare');
      lead = `Index ${i} has one child, at index ${l}: ${heap[l].key} from ${letter(heap[l].list)}.`;
    }
    const child = heap[c];
    const finding = r < size ? [] : ['children', 'pick'];
    const op = heapOp(it, child);
    ctx.cmp++;
    if (!less(child, it)) {
      rec.line(...finding, 'down_test', 'down_stop');
      rec.compare(it.key, op === '=' ? '=' : '≤', child.key, op === '=' ? `a tie, and ${letter(it.list)} is the earlier list, so stop` : 'heap order holds, stop', {
        probe,
        message:
          op === '='
            ? `${lead} The values tie, so the earlier list counts as smaller: ${letter(it.list)} before ${letter(child.list)}. ${it.key} stays at index ${i}.`
            : `${lead} ${it.key} is not larger, so it stays at index ${i}.`,
      });
      rec.unmark(hid(child));
      return;
    }
    rec.line(...finding, 'down_test');
    rec.compare(it.key, op === '=' ? '=' : '>', child.key, op === '=' ? `a tie, and ${letter(child.list)} is the earlier list, so swap down` : 'swap down', {
      probe,
      message:
        op === '='
          ? `${lead} The values tie, so the earlier list counts as smaller: ${letter(child.list)} before ${letter(it.list)}. Swap down.`
          : `${lead} ${it.key} is larger, so they swap.`,
    });
    heap[i] = child;
    heap[c] = it;
    rec.unmark(hid(child));
    rec.line('down_swap');
    rec.step(`Swap: ${child.key} rises to index ${i} and ${it.key} drops to index ${c}.`, { probe });
    i = c;
  }
}

// ---- loading inputs -----------------------------------------------------------

const sortedRandom = (count: number, lo: number, hi: number) =>
  Array.from({ length: count }, () => randomInt(lo, hi)).sort((a, b) => a - b);

interface Preset {
  first: number[][];
  random(): number[][];
  say: string;
}

export const PRESETS: Record<string, Preset> = {
  short: {
    first: [[5, 11], [3, 8, 14, 20, 27, 35, 42, 50]],
    random: () => {
      const short = sortedRandom(randomInt(1, 2), 1, 40);
      const long = sortedRandom(randomInt(6, 8), 1, 99);
      return Math.random() < 0.5 ? [short, long] : [long, short];
    },
    say: 'One list is much shorter, so it runs out early. From then on the merge copies the rest of the long list with no comparisons at all.',
  },
  ties: {
    first: [[3, 7, 7, 12, 20], [5, 7, 12, 12, 25]],
    random: () => [sortedRandom(randomInt(4, 6), 1, 9).map((v) => v * 5), sortedRandom(randomInt(4, 6), 1, 9).map((v) => v * 5)],
    say: 'Both lists share values. Watch every tie go to A: that rule is what makes the merge stable.',
  },
  interleaved: {
    first: [[10, 30, 50, 70, 90, 110], [20, 40, 60, 80, 100, 120]],
    random: () => {
      const all = [...new Set(sortedRandom(30, 1, 199))].slice(0, 12);
      return [all.filter((_, i) => i % 2 === 0), all.filter((_, i) => i % 2 === 1)];
    },
    say: 'The values alternate between the lists, so neither runs out until the very end. This is the worst case: one comparison for every item but the last.',
  },
  k: {
    first: [[8, 21, 40], [3, 21, 35], [12, 17, 50]],
    random: () => {
      const k = randomInt(3, 4);
      return Array.from({ length: k }, () => sortedRandom(randomInt(2, CAP[k]), 1, 99));
    },
    say: 'Several sorted lists, as a database has several sorted files to compact or a query has several sorted shards to combine. Use Merge k.',
  },
};

export function load(s: MergeState, name: string, rec: Rec): void {
  const preset = PRESETS[name];
  const n = s.presses[name] ?? 0;
  s.presses[name] = n + 1;
  setLists(s, n === 0 ? preset.first : preset.random());
  rec.clearMarks();
  rec.line('load');
  rec.step(`Loaded ${s.lists.map((l, i) => `${letter(i)}: ${values(l).join(' ') || 'empty'}`).join('; ')}. ${preset.say}`);
}

/** Parse "5 2 9 1", "5,2,9" and the like. */
export function parseNumbers(raw: string | number): number[] | null {
  const text = String(raw).trim();
  const parts = text.split(/[^0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => Math.min(999, Number(p)));
}

/**
 * Set list A or B from typed numbers. Unsorted input is sorted, with a sentence
 * saying so, because a merge only works on sorted lists. Lists C and D are
 * dropped: typing a list means a two-way merge.
 */
export function setList(s: MergeState, l: 0 | 1, raw: string | number, rec: Rec): void {
  rec.clearMarks();
  rec.line('load');
  const vals = parseNumbers(raw);
  if (!vals || !vals.length) {
    rec.step(`Type the numbers with spaces between them, such as 5 12 30.`);
    return;
  }
  const notes: string[] = [];
  const lists = s.lists.map(values);
  if (lists.length > 2) {
    notes.push(`Typing a list sets up a two-way merge, so ${lists.length === 3 ? 'list C was' : 'lists C and D were'} put away. Load: k lists brings several back.`);
    lists.length = 2;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  if (sorted.some((v, i) => v !== vals[i])) {
    notes.push(`${vals.join(' ')} is not in order, so it was sorted first: a merge only works on sorted lists. Merge two unsorted lists and the output is not sorted either.`);
  }
  if (sorted.length > CAP[2]) {
    notes.push(`The page shows at most ${CAP[2]} items in a list, so it kept the first ${CAP[2]}.`);
  }
  lists[l] = sorted.slice(0, CAP[2]);
  for (let i = 0; i < 2; i++) lists[i] = lists[i].slice(0, CAP[2]);
  setLists(s, lists);
  rec.step(`List ${letter(l)} is now ${values(s.lists[l]).join(' ')}. ${notes.join(' ')}`.trim());
}

/** A typed list worth trying: sorted, a few items, sharing one value with the other list so the merge meets a tie. */
function suggestList(s: MergeState, l: 0 | 1): string {
  const other = values(s.lists[1 - l] ?? []);
  const vals = sortedRandom(randomInt(2, 5), 1, 99);
  if (other.length) vals.push(other[randomInt(0, other.length - 1)]);
  return vals.sort((a, b) => a - b).join(' ');
}

// ---- layout -------------------------------------------------------------------

const CW = 44;
const P = CW + 3;
/** Extra room after each list: its pointer can sit one place past its end, and still clear the next list's pointer. */
const GAP = 70;
const LIST_Y = 0;
const TAG_Y = CELL_H / 2 + 6 + 13;
const NAME_Y = TAG_Y + 13 + 16;
/** Room above a row for the probe chip, clear of the labels of the row above. */
const ROW_STEP = 136;

function listX(s: MergeState): number[] {
  const xs: number[] = [];
  let x = 0;
  for (const list of s.lists) {
    xs.push(x);
    x += Math.max(list.length, 1) * P + GAP;
  }
  return xs;
}

export function layout(s: MergeState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const xs = listX(s);
  const showHeap = s.mode === 'k' || (s.mode === 'idle' && s.lists.length > 2);
  const tagText = (l: number) => (showHeap ? 'front' : l === 0 ? 'i' : 'j');

  s.lists.forEach((list, l) => {
    const x0 = xs[l];
    const active = inMerge(s, l);
    if (!list.length) nodes.push({ id: `le${l}`, x: x0, y: LIST_Y, cells: [{ text: '', w: CW }] });
    list.forEach((it, k) => {
      const taken = !active || k < s.ptr[l];
      const tone: Tone | undefined = taken ? 'dim' : undefined;
      nodes.push({ id: iid(it), x: x0 + k * P, y: LIST_Y, tone, cells: [{ text: String(it.key), w: CW }] });
    });
    if (active) {
      nodes.push({ id: `t${l}`, x: x0 + s.ptr[l] * P, y: TAG_Y, shape: 'tag', cells: [{ text: tagText(l) }] });
    }
    const name = `List ${letter(l)}${active ? '' : ', waits'}`;
    decor.push({ id: `name${l}`, type: 'label', x: x0 - CW / 2, y: NAME_Y, text: name, strong: true });
  });

  let y = LIST_Y + ROW_STEP;
  if (showHeap) {
    const k = s.lists.length;
    for (let i = 0; i < k; i++) {
      const h = s.heap[i];
      const x = i * P;
      if (h) {
        nodes.push({ id: hid(h), x, y, from: iid(h), cells: [{ text: String(h.key), w: CW, sub: letter(h.list), subValue: true }] });
      } else {
        nodes.push({ id: `hs${i}`, x, y, cells: [{ text: '', w: CW, sub: ' ' }] });
      }
    }
    decor.push({ id: 'heap-name', type: 'label', x: -CW / 2 - 12, y, text: 'Heap', anchor: 'end', strong: true });
    y += ROW_STEP;
  }

  const total = s.lists.reduce((t, list, l) => t + (inMerge(s, l) ? list.length : 0), 0);
  for (let p = 0; p < Math.max(total, 1); p++) {
    const it = s.out[p];
    const x = p * P;
    if (it) {
      const from = s.mode === 'k' ? hid(it) : iid(it);
      nodes.push({ id: oid(it), x, y, tone: 'ok', from, cells: [{ text: String(it.key), w: CW, sub: letter(it.list), subValue: true }] });
    } else {
      nodes.push({ id: `os${p}`, x, y, cells: [{ text: '', w: CW, sub: ' ' }] });
    }
  }
  decor.push({ id: 'out-name', type: 'label', x: -CW / 2 - 12, y, text: 'Output', anchor: 'end', strong: true });
  return { nodes, edges: [], decor };
}

// ---- definition ---------------------------------------------------------------

const NUMBERS = { name: 'numbers', label: 'Numbers', kind: 'ints', min: 0, max: 999, maxItems: CAP[2] } as const;

const loadOp = (id: string, label: string) => ({
  id: `load-${id}`,
  label,
  args: [],
  code: ['load'],
  run: (s: MergeState, _a: (number | string)[], rec: Rec) => load(s, id, rec),
});

const def: StructureDef<MergeState> = {
  id: 'merge-lists',
  create: () => create(),
  seed: [['setA', '4 9 15 22 31 38'], ['setB', '6 9 17 25']],
  ops: [
    { id: 'mergeTwo', label: 'Merge two', intent: 'primary', args: [], code: ['merge_two'], run: (s, _a, rec) => void mergeTwo(s, rec) },
    { id: 'mergeK', label: 'Merge k', intent: 'primary', args: [], code: ['merge_k', 'heap'], run: (s, _a, rec) => void mergeK(s, rec) },
    loadOp('short', 'Load: one runs out'),
    loadOp('ties', 'Load: ties'),
    loadOp('interleaved', 'Load: interleaved'),
    loadOp('k', 'Load: k lists'),
    { id: 'setA', label: 'Set list A', args: [NUMBERS], code: ['load'], run: (s, [nums], rec) => setList(s, 0, nums, rec), suggest: (s) => [suggestList(s, 0)] },
    { id: 'setB', label: 'Set list B', args: [NUMBERS], code: ['load'], run: (s, [nums], rec) => setList(s, 1, nums, rec), suggest: (s) => [suggestList(s, 1)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Items written' },
  ],
  status: (s) => [
    { label: 'Lists', value: s.lists.map((l, i) => `${letter(i)} ${l.length}`).join(', ') },
    { label: 'Output', value: `${s.out.length} items` },
    {
      label: 'Merge',
      value: s.mode === 'two' ? 'two-way' : s.mode === 'k' ? `${s.lists.length}-way, with a heap` : 'not run yet',
    },
  ],
  tour: [['mergeTwo'], ['load-short'], ['mergeTwo'], ['load-k'], ['mergeK']],
  source: { python, java },
  info: {
    summary:
      'Two sorted lists become one sorted list by looking only at their fronts: take the smaller front item, move that list on, repeat. Each item costs at most one comparison, so merging is linear. With k lists, a small heap of the k front items finds the smallest in O(log k).',
    watch: [
      'Only the two front items are ever compared. Everything behind a front is at least as large, so it cannot be next.',
      'On a tie the merge takes from A, the first list. The letter under each output item shows where it came from: equal values keep their input order. That is what "stable" means, and merge sort is stable because of this one rule.',
      'When one list runs out, the rest of the other is copied with no comparisons. A short list against a long one is cheap.',
      'Interleaved values are the worst case: one comparison for every item but the last, n + m - 1 in all.',
      'In the k-way merge the heap holds exactly one item per list. Write the root, refill it from the same list, sift down. The heap breaks ties by list, so it is stable too.',
    ],
    complexity: [
      { op: 'Merge two lists of n and m', average: 'O(n + m)', worst: 'O(n + m)', note: 'Each comparison writes one item, so at most n + m - 1 comparisons. As few as min(n, m) when one list is wholly smaller.' },
      { op: 'Copy the rest', average: 'O(rest)', worst: 'O(rest)', note: 'No comparisons. A linked list can splice the remaining tail on in O(1).' },
      { op: 'Merge k lists, n items, with a heap', average: 'O(n log k)', worst: 'O(n log k)', note: 'Every item enters and leaves a heap of at most k entries once, and each costs up to log k swaps.' },
      { op: 'Merge k by scanning every front', average: 'O(nk)', worst: 'O(nk)', note: 'k - 1 comparisons per item. Fine for k of 2 or 3, poor for 100 files.' },
      { op: 'Merge k in pairs, round by round', average: 'O(n log k)', worst: 'O(n log k)', note: 'log k rounds, each touching all n items. The same bound, but it writes the data log k times.' },
    ],
    space:
      'O(n + m) for the output array. The merge itself needs only the front pointers, and a k-way merge a heap of k entries, so streams and files can be merged with one buffer per input.',
    usedIn: [
      { name: 'Merge sort and Timsort', how: 'Merge sort splits, sorts each half and merges. Timsort, the sort in Python and in Java for objects, finds sorted runs in the data and merges them. Both are stable because a tie takes from the left run.' },
      { name: 'LSM-tree compaction (RocksDB, Cassandra)', how: 'Each SSTable is sorted by key. Compaction merges several of them into one, keeping the newest version of each key. RocksDB merges its inputs through a heap of iterators.' },
      { name: 'Sort-merge join', how: 'Sort both tables on the join key, then walk them together like this merge, matching equal keys. PostgreSQL calls the plan node Merge Join; Spark uses a sort-merge join for large tables.' },
      { name: 'External sort', how: 'Data too big for memory is sorted in chunks that fit, each written out as a sorted run, then the runs are merged k at a time with one buffer each. Unix sort does this for large files, and sort -m merges files that are already sorted.' },
      { name: 'Combining sorted shards', how: 'A search or database query sent to many shards gets a sorted page from each. The coordinator merges them and keeps the first page.' },
      { name: 'Python heapq.merge', how: 'Merges any number of sorted inputs lazily through a heap of their front items.' },
    ],
    reachFor: [
      'Two or more inputs that are already sorted. Merging is linear, and sorting the concatenation is not.',
      'Data that only streams: files, network responses, iterators. A merge reads each input once, front to back, and never needs random access.',
      'You need a stable result: equal keys must keep their input order.',
      'Inputs much larger than memory. Keep one buffer per input and the heap of fronts; everything else stays on disk.',
    ],
    costs: [
      'The inputs must be sorted. Merge two unsorted lists and the output is not sorted. Sorting first costs O(n log n).',
      'Merging arrays needs a second array for the output. In-place merging exists but is slow and complicated, which is why merge sort usually takes O(n) extra space.',
      'With k inputs the heap adds log k per item. For k = 2 the plain two-pointer merge is cheaper.',
      'A k-way merge from disk holds one buffer per input open at once. Very large k means small buffers and more seeks, so external sorts merge in several passes.',
    ],
    interview: [
      'Say the two-pointer loop out loud: "compare the fronts, take the smaller, move that pointer on; when one list runs out, copy the rest". Then say why it is O(n + m): every comparison writes an item.',
      'Say what makes it stable: "on a tie, take from the left list". Use < instead of <= and the merge, and so merge sort, stops being stable.',
      'For "merge k sorted lists", give the heap answer: a min-heap of the k fronts, pop the root, push the next item from the same list. O(n log k) time and O(k) extra space. Mention the pairwise alternative, also O(n log k).',
      'Tie it to systems: LSM compaction merges sorted SSTables, a sort-merge join merges two sorted tables, external sort merges sorted runs from disk, and a scatter-gather query merges sorted results from shards. All of them are this loop.',
      'For data bigger than memory, describe external sort: sort chunks that fit, write sorted runs, then k-way merge them with one buffer per run. The disk reads are sequential, which is why it is fast.',
    ],
  },
};

export default def;
