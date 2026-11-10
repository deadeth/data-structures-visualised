import { CELL_GAP, CELL_H, tidyTree } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';

/**
 * Binary min-heap of integers, stored in an array.
 *
 * The array is read as a complete binary tree: the parent of index i is at
 * floor((i - 1) / 2) and its children are at 2i + 1 and 2i + 2. The only rule
 * is that no parent is larger than its children, which keeps the smallest key
 * at index 0. Equal keys are allowed, so every item carries a unique id. The
 * id is what lets the same item slide to its new place in both views.
 */
export interface Item {
  uid: number;
  key: number;
}

export interface HeapState {
  items: Item[];
  nextUid: number;
  /** Most items the heap will accept. The page uses 15, which is four full levels. */
  capacity: number;
}

/** Four full levels. Anything deeper is too small to read on the canvas. */
export const CAPACITY = 15;

export function create(capacity = CAPACITY): HeapState {
  return { items: [], nextUid: 1, capacity };
}

export const keys = (s: HeapState): number[] => s.items.map((it) => it.key);

/** Number of levels in the tree: 0 when empty, otherwise floor(log2 n) + 1. */
export const levels = (s: HeapState): number => 32 - Math.clz32(s.items.length);

const tid = (it: Item) => `t${it.uid}`;
const aid = (it: Item) => `a${it.uid}`;
const plural = (n: number, word: string) => (n === 0 ? `no ${word}s` : `${n} ${word}${n === 1 ? '' : 's'}`);

/** Colour the same item in the tree view and in the array view. */
function tone(rec: Rec, it: Item, t: Tone): void {
  rec.mark(tid(it), t);
  rec.mark(aid(it), t);
}

export function peek(s: HeapState, rec: Rec): number | undefined {
  if (s.items.length === 0) {
    rec.step(`The heap is empty, so there is no minimum to read.`);
    return undefined;
  }
  const top = s.items[0];
  tone(rec, top, 'ok');
  rec.step(`The minimum is always at index 0, the root: here ${top.key}. Reading it takes no comparisons and no search, so peek is O(1).`, {
    probe: { text: String(top.key), at: tid(top) },
  });
  return top.key;
}

export function insert(s: HeapState, key: number, rec: Rec): boolean {
  if (s.items.length >= s.capacity) {
    rec.step(
      `Sorry, the heap on this page stops at ${s.capacity} items so that every level stays readable, and it is full. Extract the minimum to make room, then try ${key} again.`,
    );
    return false;
  }
  const it: Item = { uid: s.nextUid++, key };
  let i = s.items.length;
  s.items.push(it);
  const probe: Probe = { text: String(key), at: tid(it) };
  tone(rec, it, 'key');
  if (i === 0) {
    rec.step(`The heap was empty, so ${key} goes in at index 0 and is the root. Nothing to compare.`, { probe });
    return true;
  }
  rec.step(`Append ${key} at the end of the array, index ${i}. In the tree that is the next free place on the bottom level, so the shape stays complete.`, {
    probe,
  });

  let comparisons = 0;
  let swaps = 0;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = s.items[p];
    tone(rec, parent, 'compare');
    rec.markEdge(`e${i}`, 'compare');
    const where =
      comparisons === 0
        ? `The parent of index i is at floor((i - 1) / 2), so the parent of ${i} is index ${p}, which holds ${parent.key}.`
        : `The parent of index ${i} is index ${p}, which holds ${parent.key}.`;
    comparisons++;
    if (key >= parent.key) {
      rec.compare(key, '≥', parent.key, `heap order holds, stop`, {
        probe,
        message: `${where} ${key} is not smaller, so heap order already holds and the sift up stops.`,
      });
      rec.unmark(tid(parent));
      rec.unmark(aid(parent));
      rec.markEdge(`e${i}`, 'idle');
      break;
    }
    rec.compare(key, '<', parent.key, `swap up`, {
      probe,
      message: `${where} A parent must not be larger than its child, so ${key} swaps up.`,
    });
    s.items[p] = it;
    s.items[i] = parent;
    rec.count('writes');
    swaps++;
    tone(rec, parent, 'path');
    rec.markEdge(`e${i}`, 'path');
    rec.step(
      p === 0
        ? `Swap: ${key} rises to index 0 and ${parent.key} drops to index ${i}. ${key} is at the root, so there is nothing above it to compare.`
        : swaps === 1
          ? `Swap: ${key} rises to index ${p} and ${parent.key} drops to index ${i}. The same two items trade places in the array below.`
          : `Swap: ${key} rises to index ${p} and ${parent.key} drops to index ${i}.`,
      { probe },
    );
    i = p;
  }

  rec.clearMarks();
  tone(rec, it, 'key');
  const n = s.items.length;
  if (swaps === 0) {
    rec.step(`${key} stays at index ${i}: 1 comparison and no swaps. A new key that is no smaller than its parent costs O(1), and with keys in random order the average insert is O(1) too.`);
  } else if (i === 0) {
    rec.step(
      `${key} is the new minimum. It climbed from the bottom to the root with ${plural(comparisons, 'comparison')} and ${plural(swaps, 'swap')}: the worst case, one of each per level above it.`,
    );
  } else {
    rec.step(
      `${key} settles at index ${i} after ${plural(comparisons, 'comparison')} and ${plural(swaps, 'swap')}. An insert never costs more than one of each per level, and ${n} items make ${levels(s)} levels.`,
    );
  }
  return true;
}

export function extractMin(s: HeapState, rec: Rec): number | undefined {
  const size = s.items.length;
  if (size === 0) {
    rec.step(`The heap is empty, so there is no minimum to extract.`);
    return undefined;
  }
  const top = s.items[0];
  tone(rec, top, 'bad');
  if (size === 1) {
    rec.step(`${top.key} is the only item, so it is the minimum. Take it out.`);
    s.items.pop();
    rec.clearMarks();
    rec.step(`Removed ${top.key} with no comparisons. The heap is now empty.`);
    return top.key;
  }

  const it = s.items[size - 1];
  const key = it.key;
  const probe: Probe = { text: String(key), at: tid(it) };
  tone(rec, it, 'key');
  rec.step(
    `The minimum is always at the root, index 0: here ${top.key}. Take it out, then fill the hole with the last item in the array, ${key}, so the tree keeps its shape.`,
    { probe },
  );
  s.items[0] = it;
  s.items.pop();
  rec.unmark(tid(top));
  rec.unmark(aid(top));
  rec.step(`${key} moves from index ${size - 1} to index 0. It came from the bottom level, so it is probably too large for the root and has to sift down.`, {
    probe,
  });

  const n = s.items.length;
  let i = 0;
  let comparisons = 0;
  let swaps = 0;
  let stopped = false;
  for (;;) {
    const l = 2 * i + 1;
    if (l >= n) break;
    const r = l + 1;
    let c = l;
    let lead: string;
    if (r < n) {
      const left = s.items[l];
      const right = s.items[r];
      tone(rec, left, 'compare');
      tone(rec, right, 'compare');
      rec.markEdge(`e${l}`, 'compare');
      rec.markEdge(`e${r}`, 'compare');
      const where =
        comparisons === 0
          ? `The children of index i are at 2i + 1 and 2i + 2, so the children of ${i} are at ${l} and ${r}.`
          : `The children of index ${i} are at ${l} and ${r}.`;
      comparisons++;
      if (right.key < left.key) {
        c = r;
        rec.compare(left.key, '>', right.key, `the right child, ${right.key}, is the smaller`, {
          probe,
          message: `${where} Compare them with each other first: only the smaller one, ${right.key}, could sit above the other.`,
        });
      } else if (right.key === left.key) {
        rec.compare(left.key, '=', right.key, `a tie, so take the left child`, {
          probe,
          message: `${where} They hold the same key, so either could sit above the other. Take the left one.`,
        });
      } else {
        rec.compare(left.key, '<', right.key, `the left child, ${left.key}, is the smaller`, {
          probe,
          message: `${where} Compare them with each other first: only the smaller one, ${left.key}, could sit above the other.`,
        });
      }
      const other = c === l ? right : left;
      rec.unmark(tid(other));
      rec.unmark(aid(other));
      rec.markEdge(`e${c === l ? r : l}`, 'idle');
      lead = `Now test ${key} against the smaller child.`;
    } else {
      tone(rec, s.items[l], 'compare');
      rec.markEdge(`e${l}`, 'compare');
      lead =
        comparisons === 0
          ? `The children of index i are at 2i + 1 and 2i + 2. Index ${i} has only one, at index ${l}, because ${r} is past the end of the array.`
          : `Index ${i} has only one child, at index ${l}, because ${r} is past the end of the array.`;
    }
    const child = s.items[c];
    comparisons++;
    if (key <= child.key) {
      rec.compare(key, '≤', child.key, `heap order holds, stop`, {
        probe,
        message: `${lead} ${key} is not larger than ${child.key}, so heap order holds and the sift down stops.`,
      });
      rec.unmark(tid(child));
      rec.unmark(aid(child));
      rec.markEdge(`e${c}`, 'idle');
      stopped = true;
      break;
    }
    rec.compare(key, '>', child.key, `swap down`, {
      probe,
      message: `${lead} ${key} is larger than ${child.key}, and a parent must not be larger than its child, so they swap.`,
    });
    s.items[i] = child;
    s.items[c] = it;
    rec.count('writes');
    swaps++;
    tone(rec, child, 'path');
    rec.markEdge(`e${c}`, 'path');
    rec.step(
      2 * c + 1 >= n
        ? `Swap: ${child.key} rises to index ${i} and ${key} drops to index ${c}. Index ${c} has no children, because ${2 * c + 1} is past the end of the array.`
        : swaps === 1
          ? `Swap: ${child.key} rises to index ${i} and ${key} drops to index ${c}. The same two items trade places in the array below.`
          : `Swap: ${child.key} rises to index ${i} and ${key} drops to index ${c}.`,
      { probe },
    );
    i = c;
  }

  rec.clearMarks();
  tone(rec, it, 'key');
  const cost = `${plural(comparisons, 'comparison')} and ${plural(swaps, 'swap')}`;
  if (n === 1) {
    rec.step(`Removed ${top.key}. ${key} is the only item left, so it is the new minimum and there was nothing to compare.`);
  } else if (swaps === 0) {
    rec.step(`Removed ${top.key}. ${key} was already no larger than its children, so it stays at the root as the new minimum: ${cost}.`);
  } else if (stopped) {
    rec.step(`Removed ${top.key}. ${key} settles at index ${i} after ${cost}, without reaching the bottom. The new minimum is ${s.items[0].key}.`);
  } else {
    rec.step(
      `Removed ${top.key}. ${key} sank to a leaf at index ${i}: ${cost}, with at most two comparisons and one swap per level. The new minimum is ${s.items[0].key}.`,
    );
  }
  return top.key;
}

// ---- layout ---------------------------------------------------------------

const R = 22;
const CELL_W = 44;
const GAP_Y = 72;
const PITCH = CELL_W + CELL_GAP;

/**
 * Where each array index sits in the tree view. The shape of a heap depends
 * only on how many items it holds, so the positions are fixed: index i is
 * always drawn in the same place and only the items move.
 */
const SLOTS: { x: number; y: number }[] = (() => {
  const pos = tidyTree<number>({
    root: 0,
    children: (i) => (2 * i + 2 < CAPACITY ? [2 * i + 1, 2 * i + 2] : []),
    width: () => R * 2,
    // Wide enough that the probe chip above a node clears the parent beside it.
    gapX: 54,
    gapY: GAP_Y,
  });
  const rootX = pos.get(0)!.x;
  return Array.from({ length: CAPACITY }, (_, i) => ({ x: pos.get(i)!.x - rootX, y: pos.get(i)!.y }));
})();

const ARRAY_Y = SLOTS[CAPACITY - 1].y + R + 74;
const arrayX = (i: number) => (i - (CAPACITY - 1) / 2) * PITCH;

/** Draws up to CAPACITY items. Larger heaps only ever run with recording off. */
export function layout(s: HeapState): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [];
  const n = Math.min(s.items.length, CAPACITY);

  for (let i = 0; i < n; i++) {
    const p = SLOTS[i];
    // A zero-size anchor per tree position. Edges join anchors, not items, so the
    // lines stay still while the items slide along them during a swap.
    nodes.push({ id: `p${i}`, x: p.x, y: p.y, shape: 'circle', r: 0, cells: [{ text: '' }] });
    if (i > 0) edges.push({ id: `e${i}`, from: `p${(i - 1) >> 1}`, to: `p${i}`, kind: 'line' });
  }
  for (let i = 0; i < n; i++) {
    const it = s.items[i];
    const p = SLOTS[i];
    nodes.push({ id: tid(it), x: p.x, y: p.y, shape: 'circle', r: R, cells: [{ text: String(it.key) }] });
    decor.push({ id: `ti${i}`, type: 'label', x: p.x, y: p.y + R + 12, text: String(i), anchor: 'middle' });
  }

  for (let i = 0; i < CAPACITY; i++) {
    const x = arrayX(i);
    if (i < n) {
      const it = s.items[i];
      nodes.push({ id: aid(it), x, y: ARRAY_Y, cells: [{ text: String(it.key), w: CELL_W }] });
    } else {
      nodes.push({ id: `s${i}`, x, y: ARRAY_Y, tone: 'dim', cells: [{ text: '', w: CELL_W }] });
    }
    decor.push({ id: `ai${i}`, type: 'label', x, y: ARRAY_Y + CELL_H / 2 + 13, text: String(i), anchor: 'middle' });
  }
  decor.push({
    id: 'array-title',
    type: 'label',
    x: arrayX(0) - CELL_W / 2,
    y: ARRAY_Y - CELL_H / 2 - 16,
    text: 'The same items in array order. The small numbers are indexes.',
    strong: true,
  });
  return { nodes, edges, decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

const def: StructureDef<HeapState> = {
  id: 'heap',
  create: () => create(),
  seed: [12, 30, 21, 47, 38, 90, 84].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: () => [randomInt(1, 99)] },
    { id: 'extractMin', label: 'Extract min', intent: 'danger', args: [], run: (s, _args, rec) => void extractMin(s, rec) },
    { id: 'peek', label: 'Peek', args: [], run: (s, _args, rec) => void peek(s, rec) },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'writes', label: 'Swaps' },
  ],
  status: (s) => [
    { label: 'Items', value: `${s.items.length} of ${s.capacity}` },
    { label: 'Levels', value: String(levels(s)) },
    { label: 'Minimum', value: s.items.length ? String(s.items[0].key) : 'none' },
  ],
  tour: [['peek'], ['insert', 5], ['extractMin'], ['insert', 70], ['extractMin']],
  fill: () => ['insert', randomInt(1, 99)],
  info: {
    summary:
      'A binary heap is a complete binary tree packed into a plain array, with one rule: no parent is larger than its children. That is enough to keep the smallest item at index 0 at all times, and it is much cheaper to maintain than full sorted order.',
    watch: [
      'The tree and the array are the same data. There are no pointers: the parent of index i is at floor((i - 1) / 2) and its children are at 2i + 1 and 2i + 2.',
      'An insert appends at the end and swaps upwards. It stops at the first parent that is not larger, which is often the first one it meets.',
      'Extract min moves the last item to the root and swaps it downwards. Each level costs two comparisons: one to pick the smaller child, one to test against it.',
      'Only the root is known to be in the right place. Siblings are in no particular order, so the array is not sorted, and finding any other key means scanning all of it.',
    ],
    complexity: [
      { op: 'Peek at the minimum', average: 'O(1)', worst: 'O(1)', note: 'Always index 0.' },
      { op: 'Insert', average: 'O(1)', worst: 'O(log n)', note: 'With keys in random order most inserts stop within a level or two of the bottom.' },
      { op: 'Extract min', average: 'O(log n)', worst: 'O(log n)', note: 'Up to two comparisons and one swap per level.' },
      { op: 'Find any other key', average: 'O(n)', worst: 'O(n)', note: 'Nothing steers a search. Keep a map from item to index if you need to remove or reprioritise items.' },
      { op: 'Build from n items', average: 'O(n)', worst: 'O(n)', note: 'Sift down every parent, starting from the last one. n separate inserts would be O(n log n) in the worst case.' },
    ],
    space: 'O(n): one array, with no pointers and no allocation per item.',
    usedIn: [
      { name: 'Java PriorityQueue', how: 'A binary heap in an array. ScheduledThreadPoolExecutor keeps its delayed tasks in a heap of the same kind, ordered by run time.' },
      { name: 'Python heapq', how: 'Functions that treat an ordinary list as a binary min-heap. asyncio keeps its scheduled callbacks in one.' },
      { name: 'C++ std::priority_queue', how: 'An adaptor over std::vector built on std::push_heap and std::pop_heap. It is a max-heap unless you pass a different comparison.' },
      { name: 'Go runtime timers', how: 'Kept in a 4-ary heap: the same idea with four children per node, which makes the tree shallower.' },
      { name: 'libuv (Node.js)', how: 'The event loop keeps its timers in a min-heap, so the next one due is always at the root.' },
      { name: 'RocksDB', how: 'Merges many sorted runs, for reads and for compaction, through a min-heap of iterators: take the smallest head, advance that run, sift it back in.' },
      { name: 'Dijkstra and A*', how: 'The frontier is a priority queue keyed by distance or estimated cost. Routing and pathfinding code pops the cheapest node next.' },
    ],
    reachFor: [
      'You only ever need the smallest (or largest) item next: job schedulers, retry queues ordered by time, the next timer to fire.',
      'Top K over a stream. Keep a min-heap of K items and let a new item in only if it beats the root. Memory is O(K) however long the stream runs.',
      'Merging K sorted inputs. A heap holding the head of each input gives the next item in O(log K).',
      'Memory is tight or cache behaviour matters. It is one contiguous array.',
    ],
    costs: [
      'No search. Finding or removing an arbitrary item is O(n) unless you keep a separate map from item to index and update it on every swap.',
      'No sorted iteration. To read items in order you pop them one at a time, which empties the heap. A balanced tree or skip list gives ordered scans and range queries.',
      'Equal priorities come out in no fixed order. Add a sequence number to the key if ties must be first in, first out.',
      'Changing a priority needs the item\'s index. Many Dijkstra implementations skip that and push a duplicate, then ignore stale entries as they come out.',
      'Every insert and extract works on the path to the root, so one shared heap under one lock becomes a bottleneck. Go keeps a separate timer heap per processor for this reason.',
    ],
    interview: [
      'For "top K trending", say: "Each aggregator keeps a min-heap of size K. A new count gets in only if it beats the root, so an update is O(log K) and memory is O(K), not O(n)." Explain why it is a min-heap for the K largest: the root is the weakest of the current top K, the one to evict.',
      'For merging sorted results from shards, say: "Each shard returns its results sorted. The coordinator keeps one head per shard in a heap, pops the smallest and refills from the same shard, so each item costs O(log K) for K shards." This is "merge K sorted lists" in a systems setting, and it is how LSM compaction and external sort merge runs.',
      'Heap or sorted structure? If you only ever need the extreme, a heap is cheaper: O(1) peek, O(n) to build, one array. If you also need range scans, rank or delete by key, pay for a balanced tree or a skip list. Redis sorted sets use a skip list for that reason.',
      'Heap or timing wheel for timers? A heap gives O(1) access to the next deadline and O(log n) to add a timer. With millions of timers that are mostly cancelled before they fire, such as connection timeouts, a hashed timing wheel makes add and cancel O(1) in exchange for coarser resolution. Netty and Kafka use timing wheels.',
      'Know the numbers: peek O(1), insert and extract O(log n), search O(n), build O(n). Build is linear because most items sit near the bottom and can only sink a level or two.',
      'A heap lives in one process. For a delayed job queue shared by many workers, the same idea usually becomes a Redis sorted set or a database index on the run time, because the queue has to be shared and survive a crash.',
    ],
  },
};

export default def;
