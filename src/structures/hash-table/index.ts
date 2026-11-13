import { probeWidth } from '../../core/fit';
import { CELL_PAD, CHAR_W } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Compare, Decor, Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/HashTable.java?raw';
import python from './code/hash_table.py?raw';

/**
 * Hash table of integers with separate chaining.
 *
 * The bucket for a key is `key mod buckets`. Each bucket holds a chain of the
 * keys that hash to it, in the order they arrived. When an insert pushes the
 * load factor (keys / buckets) past 3/4, the array doubles and every key is
 * rehashed into it.
 */
export interface HashState {
  /** One chain per bucket, head first. */
  buckets: number[][];
  size: number;
  /** True once a key of three digits or more has been used. The drawing then leaves more room per node. */
  wide: boolean;
  /** Set only while a resize is being narrated, so the drawing can show keys that have not moved yet. */
  mig: Migration | null;
}

interface Migration {
  old: number[][];
  /** Old buckets before this one are fully rehashed. */
  bucket: number;
  /** Keys before this position in old bucket `bucket` are rehashed. */
  pos: number;
}

export const START_BUCKETS = 8;
/** Show a resize one key at a time up to this many keys, then bucket by bucket. */
const PER_KEY_LIMIT = 32;
const MAX_REHASH_FRAMES = 32;

const bid = (b: number) => `b${b}`;
const kid = (k: number) => `k${k}`;
/** The pointer that leads to a key, from its bucket or from the node before it. */
const eid = (k: number) => `e${k}`;

/** The table grows when keys / buckets passes 3/4. */
const overloaded = (size: number, buckets: number) => size * 4 > buckets * 3;
const ratio = (size: number, buckets: number) => (size / buckets).toFixed(2);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (verdict: string) => verdict.charAt(0).toUpperCase() + verdict.slice(1) + '.';

export function create(): HashState {
  return { buckets: Array.from({ length: START_BUCKETS }, () => []), size: 0, wide: false, mig: null };
}

export function has(s: HashState, key: number): boolean {
  return s.buckets[key % s.buckets.length].includes(key);
}

export function allKeys(s: HashState): number[] {
  return s.buckets.flat();
}

export function loadFactor(s: HashState): number {
  return s.size / s.buckets.length;
}

export function longestChain(s: HashState): number {
  let longest = 0;
  for (const chain of s.buckets) if (chain.length > longest) longest = chain.length;
  return longest;
}

/**
 * Hash the key, go to its bucket and walk the chain.
 * Returns the bucket and the key's position in the chain, or -1 if it is not there.
 */
/** How the listing's `prev` shows: the bucket's dummy head, or the key of the node at `i` in the chain. */
const prevName = (b: number, chain: number[], i: number): string | number => (i < 0 ? `head ${b}` : chain[i]);

function find(s: HashState, key: number, rec: Rec): { b: number; pos: number } {
  const n = s.buckets.length;
  const b = key % n;
  const chain = s.buckets[b];
  if (key > 99) s.wide = true;
  rec.count('reads');
  rec.vars();
  if (rec.recording) {
    rec.vars({ key, 'len(buckets)': n, prev: prevName(b, chain, -1), 'prev.next': chain.length ? chain[0] : null });
    rec.mark(bid(b), 'path');
    rec.line('bucket');
    rec.step(`Go straight to bucket ${b}. The hash says where ${key} must live, so no other bucket is read.`, {
      probe: { text: String(key), at: bid(b), place: 'left' },
      compare: { left: `${key} mod ${n}`, op: '=', right: b, verdict: `go straight to bucket ${b}` },
    });
  }
  for (let i = 0; i < chain.length; i++) {
    const k = chain[i];
    rec.count('reads');
    rec.markEdge(eid(k), 'path');
    rec.mark(kid(k), 'compare');
    const probe: Probe = { text: String(key), at: kid(k), place: 'left' };
    if (rec.recording) rec.vars({ key, 'len(buckets)': n, prev: prevName(b, chain, i - 1), 'prev.next': k });
    if (k === key) {
      rec.line('scan', 'hit');
      rec.compare(key, '=', k, 'match', { probe });
      return { b, pos: i };
    }
    rec.line('scan', 'next');
    rec.compare(key, '≠', k, i < chain.length - 1 ? 'a different key in the same bucket, follow the chain' : 'a different key, and the chain ends here', { probe });
    rec.mark(kid(k), 'path');
  }
  return { b, pos: -1 };
}

export function search(s: HashState, key: number, rec: Rec): boolean {
  const { b, pos } = find(s, key, rec);
  if (!rec.recording) return pos >= 0;
  const walked = pos >= 0 ? pos + 1 : s.buckets[b].length;
  rec.vars({ key, prev: prevName(b, s.buckets[b], (pos >= 0 ? pos : walked) - 1), 'prev.next': pos >= 0 ? key : null });
  rec.line('result');
  if (pos >= 0) {
    const others = s.size - walked;
    rec.mark(kid(key), 'ok');
    rec.step(
      `Found ${key} after reading one bucket and ${plural(walked, 'chain node')}.${others > 0 ? ` The other ${plural(others, 'key')} in the table ${others === 1 ? 'was' : 'were'} never looked at.` : ''}`,
      { probe: { text: String(key), at: kid(key), place: 'left' } },
    );
  } else if (walked === 0) {
    rec.mark(bid(b), 'bad');
    rec.step(`Bucket ${b} is empty, so ${key} is not in the table. One read was enough to know.`);
  } else {
    rec.mark(bid(b), 'bad');
    rec.step(`${key} is not in the table. Bucket ${b} is the only place it could be, and its chain of ${walked} has no match.`);
  }
  return pos >= 0;
}

export function insert(s: HashState, key: number, rec: Rec): boolean {
  const { b, pos } = find(s, key, rec);
  if (pos >= 0) {
    rec.mark(kid(key), 'ok');
    rec.line('duplicate');
    rec.step(`${key} is already stored. Nothing to do.`, { probe: { text: String(key), at: kid(key), place: 'left' } });
    return false;
  }
  const chain = s.buckets[b];
  chain.push(key);
  s.size++;
  rec.count('writes');
  if (rec.recording) {
    rec.vars({ key, prev: prevName(b, chain, chain.length - 2), 'prev.next': key, size: s.size });
    rec.clearMarks();
    rec.mark(bid(b), 'path');
    rec.mark(kid(key), 'key');
    rec.markEdge(eid(key), 'ok');
    rec.line('append');
    rec.step(
      chain.length === 1
        ? `Bucket ${b} is empty, so ${key} is new. Store it as the first node of the chain.`
        : `No match in the chain, so ${key} is new. Link it after ${chain[chain.length - 2]}: a collision, where different keys share a bucket.`,
    );
  }
  if (!overloaded(s.size, s.buckets.length)) {
    if (rec.recording) {
      rec.clearMarks();
      rec.mark(kid(key), 'key');
      const n = s.buckets.length;
      rec.vars({ key, size: s.size, 'len(buckets)': n });
      rec.line('load', 'done');
      rec.step(
        `${key} is stored in bucket ${b}. ${plural(s.size, 'key')} in ${n} buckets is a load factor of ${ratio(s.size, n)}` +
          (overloaded(s.size + 1, n) ? `. One more key will push it past 0.75 and force a resize.` : `, and the table grows when that passes 0.75.`),
      );
    }
    return true;
  }
  resize(s, rec, key);
  if (rec.recording) {
    const n = s.buckets.length;
    rec.vars({ key, size: s.size, 'len(buckets)': n });
    rec.clearMarks();
    rec.mark(kid(key), 'key');
    rec.line('done');
    rec.step(
      `${key} is stored in bucket ${key % n}. Rehashing all ${s.size} keys brought the load factor down to ${ratio(s.size, n)}, so chains stay short.`,
    );
  }
  return true;
}

/** Double the bucket array and rehash every key into it. `followed` is the key whose insert caused this. */
function resize(s: HashState, rec: Rec, followed: number): void {
  const old = s.buckets;
  const was = old.length;
  const n = was * 2;
  const fresh: number[][] = Array.from({ length: n }, () => []);
  const perKey = s.size <= PER_KEY_LIMIT;
  let mig: Migration | null = null;
  if (rec.recording) {
    rec.clearMarks();
    rec.mark(kid(followed), 'key');
    rec.vars({ key: followed, size: s.size, 'len(buckets)': was });
    rec.line('load');
    rec.step(
      `${plural(s.size, 'key')} in ${was} buckets is a load factor of ${ratio(s.size, was)}, past the limit of 0.75. The table has to grow before the chains get any longer.`,
    );
    mig = s.mig = { old, bucket: 0, pos: 0 };
  }
  s.buckets = fresh;
  if (mig) {
    rec.vars({ 'len(old)': was, 'len(buckets)': n });
    rec.line('grow');
    rec.step(
      `Double the array to ${n} buckets${n === START_BUCKETS * 2 ? ', drawn as a second column' : ''}. The hash is now key mod ${n}, so every key is hashed again: it stays put or moves up by exactly ${was}.` +
        (perKey ? '' : ` With this many keys, the moves are shown ${was > MAX_REHASH_FRAMES ? 'a few buckets' : 'a bucket'} at a time.`),
    );
  }

  // Every frame from here to the end of the resize is a key, or a batch of keys, being rehashed.
  rec.line('rehash');
  const chunk = Math.ceil(was / MAX_REHASH_FRAMES);
  let lastKey = -1;
  let lastBucket = -1;
  let batch: number[] = [];
  let done: number[] = [];
  let batchFrom = 0;
  for (let b = 0; b < was; b++) {
    const chain = old[b];
    rec.count('reads');
    for (let j = 0; j < chain.length; j++) {
      const k = chain[j];
      const nb = k % n;
      fresh[nb].push(k);
      rec.count('reads');
      rec.count('writes');
      rec.count('moved');
      if (!mig) continue;
      if (!perKey) {
        batch.push(k);
        continue;
      }
      mig.bucket = b;
      mig.pos = j + 1;
      rec.vars({ 'len(old)': was, 'len(buckets)': n, node: k, b: nb, after: j + 1 < chain.length ? chain[j + 1] : null });
      if (lastKey >= 0 && lastKey !== followed) rec.mark(kid(lastKey), 'path');
      if (lastBucket >= 0) rec.unmark(bid(lastBucket));
      if (k !== followed) rec.mark(kid(k), 'ok');
      rec.mark(bid(nb), 'ok');
      const verdict = nb === b ? `stays in bucket ${nb}` : `moves from bucket ${b} to bucket ${nb}`;
      const compare: Compare = { left: `${k} mod ${n}`, op: '=', right: nb, verdict };
      rec.step(k === followed ? `${k}, the key just inserted, ${verdict}.` : sentence(verdict), { compare });
      lastKey = k;
      lastBucket = nb;
    }
    if (mig && !perKey && ((b + 1) % chunk === 0 || b === was - 1)) {
      if (batch.length) {
        mig.bucket = b + 1;
        mig.pos = 0;
        for (const k of done) if (k !== followed) rec.mark(kid(k), 'path');
        let moved = 0;
        for (const k of batch) {
          if (k !== followed) rec.mark(kid(k), 'ok');
          if (k % n >= was) moved++;
        }
        const stayed = batch.length - moved;
        const last = batch[batch.length - 1];
        rec.vars({ 'len(old)': was, 'len(buckets)': n, node: last, b: last % n });
        rec.step(
          `${batchFrom === b ? `Bucket ${b}` : `Buckets ${batchFrom} to ${b}`}: ${plural(stayed, 'key')} ${stayed === 1 ? 'stays' : 'stay'}, ${moved} ${moved === 1 ? 'moves' : 'move'} up by ${was}.`,
        );
        done = batch;
        batch = [];
      }
      batchFrom = b + 1;
    }
  }
  s.mig = null;
}

export function remove(s: HashState, key: number, rec: Rec): boolean {
  const { b, pos } = find(s, key, rec);
  const chain = s.buckets[b];
  if (pos < 0) {
    rec.vars({ key, prev: prevName(b, chain, chain.length - 1), 'prev.next': null });
    rec.mark(bid(b), 'bad');
    rec.line('missing');
    rec.step(
      chain.length ? `${key} is not in the table, so there is nothing to delete.` : `Bucket ${b} is empty, so ${key} is not in the table. Nothing to delete.`,
    );
    return false;
  }
  if (rec.recording) {
    rec.mark(kid(key), 'bad');
    const before = pos === 0 ? `bucket ${b}` : `${chain[pos - 1]}`;
    const after = pos === chain.length - 1 ? `${before} now ends the chain` : `${before} now points to ${chain[pos + 1]}`;
    rec.vars({ key, prev: prevName(b, chain, pos - 1), 'prev.next': key, 'prev.next.next': pos + 1 < chain.length ? chain[pos + 1] : null, size: s.size });
    rec.line('unlink');
    rec.step(`Found ${key}. Unlink it by changing one pointer: ${after}.`, { probe: { text: String(key), at: kid(key), place: 'left' } });
  }
  const prevAt = prevName(b, chain, pos - 1);
  chain.splice(pos, 1);
  s.size--;
  rec.count('writes');
  if (rec.recording) {
    const n = s.buckets.length;
    rec.vars({ key, prev: prevAt, 'prev.next': pos < chain.length ? chain[pos] : null, size: s.size });
    rec.clearMarks();
    rec.mark(bid(b), 'path');
    rec.line('done');
    rec.step(`${key} is deleted, leaving ${plural(s.size, 'key')} in ${n} buckets (load factor ${ratio(s.size, n)}). This table grows but never shrinks.`);
  }
  return true;
}

// ---- drawing ----------------------------------------------------------------

/** Buckets are drawn in columns of eight, so a key's row is always key mod 8, whatever the table size. */
const ROWS = START_BUCKETS;
const ROW_PITCH = 44;
const BLOCKS_PER_BAND = 4;
const BAND_GAP = 30;
/** How far the renderer puts a probe chip from the node it points at, and the least room to leave beyond it. */
const CHIP_OFFSET = 10;
const CHIP_CLEAR = 8;

/** Width of the probe chip for a key of this many digits. Mirrors the renderer. */
export const chipWidth = (digits: number) => probeWidth('0'.repeat(digits));

export function layout(s: HashState): Scene {
  const n = s.buckets.length;
  const mig = s.mig;
  const bw = Math.max(44, Math.ceil(String(n - 1).length * CHAR_W) + CELL_PAD * 2);
  // Keys are two digits unless the reader has typed a longer one, so the tighter spacing is the usual one.
  const digits = s.wide ? 3 : 2;
  const keyW = Math.ceil(digits * CHAR_W) + CELL_PAD * 2;
  // The probe chip sits in the gap before a node, on the pointer the key is following, so the gap must hold it.
  const gap = Math.ceil(chipWidth(digits)) + CHIP_OFFSET + CHIP_CLEAR;
  const pitch = keyW + gap;
  const blockGap = gap + 10;

  // During a resize, keys that have not been rehashed yet are still drawn in their old bucket.
  const shown = (b: number): number[] => {
    const chain = s.buckets[b];
    if (!mig || b >= mig.old.length || b < mig.bucket) return chain;
    const waiting = b === mig.bucket ? mig.old[b].slice(mig.pos) : mig.old[b];
    return waiting.length ? chain.concat(waiting) : chain;
  };

  const chains: number[][] = [];
  const cols = Math.min(BLOCKS_PER_BAND, n / ROWS);
  // Each column of blocks is as wide as its longest chain, with room for two nodes at least.
  const span: number[] = new Array(cols).fill(2);
  for (let b = 0; b < n; b++) {
    const chain = shown(b);
    chains.push(chain);
    const col = Math.floor(b / ROWS) % BLOCKS_PER_BAND;
    if (chain.length > span[col]) span[col] = chain.length;
  }
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < cols; c++) {
    colX.push(x);
    x += bw + span[c] * pitch + blockGap;
  }

  const nodes: SceneNode[] = [];
  const keyNodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const decor: Decor[] = [
    { id: 'hash', type: 'label', x: 0, y: -42, text: `bucket = key mod ${n}`, strong: true },
    // The renderer only reserves probe space above nodes. This invisible label reserves it on the left.
    { id: 'probe-room', type: 'label', x: -gap, y: 0, text: ' ' },
    // Another marks the right-hand edge, so the view holds still while chains grow and shrink inside it.
    { id: 'right-edge', type: 'label', x: x - blockGap - gap, y: 0, text: ' ', anchor: 'end' },
  ];
  for (let b = 0; b < n; b++) {
    const block = Math.floor(b / ROWS);
    const left = colX[block % BLOCKS_PER_BAND];
    const y = Math.floor(block / BLOCKS_PER_BAND) * (ROWS * ROW_PITCH + BAND_GAP) + (b % ROWS) * ROW_PITCH;
    nodes.push({
      id: bid(b),
      x: left + bw / 2,
      y,
      cells: [{ text: String(b), w: bw }],
      hue: 5,
      // A bucket added by a resize grows out of the bucket whose keys it may take.
      from: mig && b >= mig.old.length ? bid(b - mig.old.length) : undefined,
    });
    const chain = chains[b];
    if (!chain.length) decor.push({ id: `empty${b}`, type: 'label', x: left + bw + 14, y, text: 'empty' });
    let prev = bid(b);
    for (let i = 0; i < chain.length; i++) {
      const k = chain[i];
      keyNodes.push({
        id: kid(k),
        x: left + bw + gap + i * pitch + keyW / 2,
        y,
        cells: [{ text: String(k), w: keyW }],
        from: bid(b),
      });
      edges.push({ id: eid(k), from: prev, to: kid(k), kind: 'side', arrow: true });
      prev = kid(k);
    }
  }
  return { nodes: nodes.concat(keyNodes), edges, decor };
}

// ---- definition -------------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: HashState): number {
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!has(s, k)) return k;
  }
  return randomInt(100, 999);
}

function presentKey(s: HashState): number {
  const keys = allKeys(s);
  return keys.length ? keys[randomInt(0, keys.length - 1)] : 42;
}

const def: StructureDef<HashState> = {
  id: 'hash-table',
  create: () => create(),
  // 42 and 50 both hash to bucket 2.
  seed: [16, 42, 50, 13, 87].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert', 'resize', 'find'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search', 'find'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete', 'find'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
  ],
  layout,
  source: { python, java },
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Buckets and nodes read' },
    { key: 'writes', label: 'Writes' },
    { key: 'moved', label: 'Keys rehashed' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Buckets', value: String(s.buckets.length) },
    { label: 'Load factor', value: ratio(s.size, s.buckets.length) },
    { label: 'Longest chain', value: String(longestChain(s)) },
  ],
  tour: [
    ['search', 50],
    ['insert', 21],
    ['search', 34],
    ['insert', 74],
    ['delete', 42],
  ],
  fill: (s) => ['insert', absentKey(s)],
  bench: { insert: 'insert', search: 'search' },
  info: {
    summary:
      'A hash table turns the key itself into an array index, so a lookup goes straight to one bucket instead of searching. Keys that land in the same bucket collide, and here they are chained together in a short list. Keep the array roomy and the chains stay short, which is where the constant-time lookup comes from.',
    watch: [
      'Every operation starts with arithmetic, not a search: key mod buckets names the one bucket the key can be in. Nothing else is read.',
      'A collision costs one extra comparison for each key ahead of yours in the chain. Watch the read counter follow the chain length, not the table size.',
      'When the load factor (keys divided by buckets) passes 0.75 the array doubles and every key is hashed again. Each key stays put or moves up by exactly the old bucket count.',
      'The hash here is key mod buckets so you can check it in your head. Real tables scramble the key first, so that a pattern in the keys (all multiples of 8, say) does not become a pattern in the buckets.',
      'After a resize the buckets are drawn in columns of eight. A key never changes row, because its row is key mod 8.',
    ],
    complexity: [
      {
        op: 'Search',
        average: 'O(1)',
        worst: 'O(n)',
        note: 'With the load factor capped, the expected chain length is a constant however many keys there are. If every key lands in one bucket, the table is a linked list.',
      },
      {
        op: 'Insert',
        average: 'O(1) amortised',
        worst: 'O(n)',
        note: 'A resize moves all n keys, but doubling means it only happens after about n cheap inserts, so the cost averages out to a constant each.',
      },
      { op: 'Delete', average: 'O(1)', worst: 'O(n)', note: 'Find the key, then change one pointer.' },
      { op: 'Range or sorted scan', average: 'O(n)', worst: 'O(n)', note: 'Keys are scattered on purpose, so there is no order to follow. Every key has to be checked.' },
    ],
    space: 'O(n). The array is kept at most three quarters full, and chaining adds a pointer to every key.',
    usedIn: [
      {
        name: 'Redis',
        how: 'The main dictionary from key name to value is a chained hash table. It rehashes incrementally: both arrays exist during a resize and each command moves a little, so no single command pays for the whole move.',
      },
      { name: 'Memcached', how: 'The whole cache is one chained hash table from key to item. When it grows, a background thread moves buckets across a few at a time.' },
      {
        name: 'Java HashMap',
        how: 'Chaining, a default load factor of 0.75 and doubling, as here. A chain that grows past 8 nodes is turned into a red-black tree, so a badly collided bucket is searched in O(log n) rather than O(n).',
      },
      { name: 'Go maps', how: 'The built-in map type is a hash table. Each map gets its own random hash seed, and iteration order is deliberately randomised so that code cannot rely on it.' },
      {
        name: 'Python dict',
        how: 'A hash table with open addressing instead of chains: a colliding key goes into another slot of the same array. Since Python 3.7 it also keeps keys in insertion order.',
      },
      {
        name: 'Database hash joins and hash indexes',
        how: 'A hash join builds a hash table on the smaller input and probes it once for each row of the larger one. PostgreSQL also offers hash indexes, which serve equality lookups only.',
      },
    ],
    reachFor: [
      'Exact-match lookups by key: caches, sessions, deduplication, counting, "have I seen this id before".',
      'The data fits in memory and you never need the keys in order.',
      'Joining or grouping two sets of rows on an equal key.',
    ],
    costs: [
      'No ordering. There are no range queries, no "next key after this one", no prefix search and no sorted iteration. Use a B+ tree or a skip list when you need any of those.',
      'A resize is a pause: one unlucky insert rehashes every key. Systems that care about worst-case latency rehash incrementally, as Redis does, spreading the move over many later operations.',
      'The O(1) relies on the hash spreading keys evenly. An attacker who can choose keys that all collide turns every operation into a walk down one long chain. This is called hash flooding. Python, Rust and Ruby defend against it by hashing strings with SipHash, keyed by a random seed.',
      'Memory is spent on purpose: spare buckets, plus a pointer per node. Chain nodes are scattered around the heap, so walking a chain tends to miss the CPU cache.',
    ],
    interview: [
      'State the cost with its conditions: O(1) on average, given a hash that spreads keys evenly and a bounded load factor, because the expected chain length is then a constant. The worst case is O(n), when everything collides.',
      'Resizing is amortised O(1). Doubling means the copies add up to 1 + 2 + 4 + ... + n, which is less than 2n, so n inserts cost O(n) in total. The single insert that triggers a resize is still O(n), and that matters for tail latency.',
      'Chaining keeps colliding keys in a list hanging off the bucket: simple, easy to delete from, and it still works when the table is crowded. Open addressing keeps every key in the array itself and probes other slots on a collision: kinder to the CPU cache, but it needs more empty space and more care over deletes.',
      'Against a B+ tree index: a hash index answers "id = 42" in about one probe where the tree reads a node per level, but it cannot do ranges, ORDER BY, prefix matches or "greater than". That is why databases default to B-trees for indexes and keep hashing for joins and grouping.',
      'If users control the keys, say that the hash must be keyed with a secret random seed. Otherwise an attacker can send keys chosen to collide and make every lookup O(n).',
      'For the distributed case, explain why hash mod N breaks when N changes. Going from 4 servers to 5 gives about 80% of keys a different server, so a cache fleet misses on nearly everything at once. Consistent hashing moves only about a fifth of them: the share the new server takes over.',
    ],
  },
};

export default def;
