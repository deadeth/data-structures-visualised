import { CELL_H } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Decor, Probe, Rec, Scene, SceneNode, StructureDef } from '../../core/types';

/**
 * Bloom filter over integer keys 0 to 999.
 *
 * The filter itself is `bits`: m cells that are 0 or 1. Adding a key sets the
 * K bits its hash functions point at. Checking a key reads those same bits:
 * any 0 proves the key was never added, all 1s means "probably".
 *
 * `added` and `setBy` are not part of the filter. They are the page's own
 * record of the truth, kept so a check can be labelled honestly as a real hit
 * or a false positive.
 */
export interface BloomState {
  /** Number of bits. */
  m: number;
  bits: number[];
  /** How many bits are 1. */
  ones: number;
  /** Hidden truth: the keys that were really added, in the order they arrived. */
  added: Set<number>;
  /** Hidden truth: the key that first set each bit, or -1. */
  setBy: number[];
  /** Checks that answered "probably present" for a key that was never added. */
  falsePositives: number;
}

/** Number of hash functions. */
export const K = 3;
/** A prime just above the largest key. */
export const PRIME = 1009;
/** h(x) = (a * x + b) mod PRIME mod m, one [a, b] pair per hash function. */
export const HASHES: readonly (readonly [number, number])[] = [
  [7, 3],
  [31, 5],
  [53, 8],
];

export function hash(i: number, key: number, m: number): number {
  const [a, b] = HASHES[i];
  return ((a * key + b) % PRIME) % m;
}

export function positions(key: number, m: number): number[] {
  return HASHES.map((_, i) => hash(i, key, m));
}

export function create(m: number): BloomState {
  return { m, bits: new Array<number>(m).fill(0), ones: 0, added: new Set(), setBy: new Array<number>(m).fill(-1), falsePositives: 0 };
}

/** Expected false positive rate for n keys in m bits with K hashes: (1 - e^(-Kn/m))^K. */
export function estimatedRate(n: number, m: number): number {
  return Math.pow(1 - Math.exp((-K * n) / m), K);
}

const bid = (bit: number) => `b${bit}`;

/** The sum written out with real numbers, so it can be checked by hand. */
function working(i: number, key: number, m: number): string {
  const [a, b] = HASHES[i];
  const raw = a * key + b;
  const mid = raw % PRIME;
  return `h${i + 1}(${key}): ${a} × ${key} + ${b} = ${raw}, ${raw} mod ${PRIME} = ${mid}, ${mid} mod ${m} = ${mid % m}.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Add a key. Returns how many bits changed from 0 to 1. */
export function add(s: BloomState, key: number, rec: Rec): number {
  const label = String(key);
  rec.step(`Add ${key}. The filter does not store the key. Each of its ${K} hash functions turns ${key} into a bit position, and that bit is set to 1.`);
  const mine: number[] = [];
  let fresh = 0;
  let probe: Probe | undefined;
  for (let i = 0; i < K; i++) {
    const bit = hash(i, key, s.m);
    probe = { text: label, at: bid(bit) };
    const again = mine.includes(bit);
    if (rec.recording) {
      if (!again) rec.mark(bid(bit), 'path');
      rec.step(`${working(i, key, s.m)} Move to bit ${bit}.`, { probe });
    }
    if (s.bits[bit] === 0) {
      s.bits[bit] = 1;
      s.setBy[bit] = key;
      s.ones++;
      fresh++;
      mine.push(bit);
      rec.count('writes');
      rec.mark(bid(bit), 'ok');
      rec.step(`Bit ${bit} was 0. Set it to 1.`, { probe });
    } else if (again) {
      rec.step(`Bit ${bit} is already 1. Another of this key's own hashes set it a moment ago, so there is nothing to write.`, { probe });
    } else {
      rec.step(
        s.setBy[bit] === key
          ? `Bit ${bit} is already 1, from the first time ${key} was added. Nothing to write.`
          : `Bit ${bit} is already 1, set earlier by ${s.setBy[bit]}. Nothing to write. From now on this bit stands for both keys.`,
        { probe },
      );
    }
  }
  const repeat = s.added.has(key);
  s.added.add(key);
  if (rec.recording) {
    const cost = `Cost: ${K} hashes and ${plural(fresh, 'bit write', 'bit writes')}, however many keys are in the filter.`;
    const fill = `${s.ones} of ${s.m} bits are 1.`;
    rec.step(
      repeat
        ? `${key} was added before, so all ${K} bits were already 1 and nothing changed. ${cost}`
        : fresh === 0
          ? `${key} is added, but every one of its bits was already 1, so the filter looks exactly as it did before. ${fill} ${cost}`
          : `${key} is added: ${plural(fresh, 'bit', 'bits')} newly set, ${K - fresh} already set. ${fill} ${cost}`,
      { probe },
    );
  }
  return fresh;
}

/** Check a key. Returns false for "definitely not in the set", true for "probably present". */
export function check(s: BloomState, key: number, rec: Rec): boolean {
  const label = String(key);
  rec.step(`Check ${key}. Hash it the same ${K} ways and read those bits. A single 0 proves ${key} was never added.`);
  const seen: number[] = [];
  let probe: Probe | undefined;
  for (let i = 0; i < K; i++) {
    const bit = hash(i, key, s.m);
    probe = { text: label, at: bid(bit) };
    if (rec.recording) {
      rec.mark(bid(bit), 'compare');
      rec.step(`${working(i, key, s.m)} Look at bit ${bit}.`, { probe });
    }
    if (s.bits[bit] === 0) {
      rec.compare(`bit ${bit}`, '=', 0, `not set, so stop`, {
        probe,
        message: `Bit ${bit} is 0. Adding ${key} would have set it, so ${key} was never added. No need to read any more bits.`,
      });
      if (rec.recording) {
        rec.mark(bid(bit), 'bad');
        rec.step(
          `${key} is definitely not in the set. One 0 was enough: the check read ${plural(i + 1, 'bit', 'bits')} out of ${K} and stopped. A "no" from a Bloom filter is never wrong.`,
          { probe },
        );
      }
      return false;
    }
    const last = i === K - 1;
    rec.compare(`bit ${bit}`, '=', 1, last ? `set, all ${K} bits match` : `set, keep checking`, {
      probe,
      message: last
        ? `Bit ${bit} is 1 as well. All ${K} bits match.`
        : `Bit ${bit} is 1. That fits, but another key could have set it, so keep checking.`,
    });
    rec.mark(bid(bit), 'path');
    if (!seen.includes(bit)) seen.push(bit);
  }
  if (s.added.has(key)) {
    if (rec.recording) {
      for (const bit of seen) rec.mark(bid(bit), 'ok');
      rec.step(
        `All ${K} bits are 1, so the filter answers "probably present", and it is: ${key} was added. The filter cannot be sure, only this page can. Cost: ${K} bits read, however many keys are stored.`,
        { probe },
      );
    }
    return true;
  }
  s.falsePositives++;
  rec.count('falsePositives');
  if (rec.recording) {
    for (const bit of seen) rec.mark(bid(bit), 'bad');
    const who = seen.map((bit) => `bit ${bit} by ${s.setBy[bit]}`);
    const list = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}` : who[0];
    rec.step(
      `False positive: all ${K} bits were set by other keys, ${list}. ${key} was never added, so the caller pays for a lookup that finds nothing.`,
      { probe },
    );
  }
  return true;
}

// ---- layout ---------------------------------------------------------------

const COLS = 16;
/** Narrower than the default cell so 16 bits to a row stay readable on a phone. */
const CELL_W = 34;
const PITCH_X = CELL_W + 3;
/** Row spacing: cell, index label, then room for the probe chip above the next row. */
const PITCH_Y = 92;
const ROW_W = COLS * PITCH_X - 3;
/** Tint for bits that are 1. A grouping colour, not a state. */
const SET_HUE = 1;
const KEYS_SHOWN = 10;

export function layout(s: BloomState): Scene {
  const nodes: SceneNode[] = [];
  const decor: Decor[] = [];
  const rows = Math.ceil(s.m / COLS);
  for (let r = 0; r < rows; r++) {
    decor.push({ id: `tray${r}`, type: 'band', x: -5, y: r * PITCH_Y - CELL_H / 2 - 5, w: ROW_W + 10, h: CELL_H + 10 });
  }
  for (let i = 0; i < s.m; i++) {
    nodes.push({
      id: bid(i),
      x: (i % COLS) * PITCH_X + CELL_W / 2,
      y: Math.floor(i / COLS) * PITCH_Y,
      cells: [{ text: String(s.bits[i]), sub: String(i), w: CELL_W }],
      hue: s.bits[i] ? SET_HUE : undefined,
    });
  }

  const keys = [...s.added];
  const hidden = Math.max(0, keys.length - KEYS_SHOWN);
  const shown = keys.slice(hidden).join(', ');
  const keyLine =
    keys.length === 0
      ? 'Keys added: none yet'
      : hidden
        ? `Keys added (${keys.length}): ${hidden} earlier, then ${shown}`
        : `Keys added (${keys.length}): ${shown}`;
  decor.push({ id: 'keys', type: 'label', x: -5, y: -91, text: keyLine, strong: true });
  decor.push({ id: 'keys-note', type: 'label', x: -5, y: -71, text: 'Only this page remembers that list. The filter itself is just the bits below.' });

  const below = (rows - 1) * PITCH_Y + CELL_H / 2 + 40;
  // One line for all three, so the shared "mod" tail is said once and the line fits at a readable size.
  const formula = (i: number) => `h${i + 1} = (${HASHES[i][0]}x + ${HASHES[i][1]})`;
  decor.push({ id: 'hashes', type: 'label', x: -5, y: below, text: `${formula(0)}, ${formula(1)}, ${formula(2)}, each then mod ${PRIME} mod ${s.m}`, anchor: 'start' });

  return { nodes, edges: [], decor };
}

// ---- definition -----------------------------------------------------------

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: BloomState): number {
  for (let i = 0; i < 50; i++) {
    const k = randomInt(0, 999);
    if (!s.added.has(k)) return k;
  }
  return randomInt(0, 999);
}

function presentKey(s: BloomState): number {
  const keys = [...s.added];
  return keys.length ? keys[randomInt(0, keys.length - 1)] : absentKey(s);
}

/** A key that was never added but whose bits are all set, if there is one. */
function falsePositiveKey(s: BloomState): number | null {
  const start = randomInt(0, 999);
  for (let i = 0; i < 1000; i++) {
    const k = (start + i) % 1000;
    if (!s.added.has(k) && positions(k, s.m).every((bit) => s.bits[bit] === 1)) return k;
  }
  return null;
}

/** Rotate between a real hit, a false positive and a clean miss so each click shows something different. */
function suggestCheck(s: BloomState): number {
  const roll = randomInt(0, 2);
  if (roll === 0) return presentKey(s);
  if (roll === 1) return falsePositiveKey(s) ?? absentKey(s);
  return absentKey(s);
}

const percent = (p: number) => `${(p * 100).toFixed(p < 0.0995 ? 1 : 0)}%`;

/** Seed keys, and the keys the tour uses. Chosen for 32 bits; see the test that pins the false positive. */
export const SEED_KEYS = [11, 265, 540, 686, 798];
export const TOUR_PRESENT = 540;
export const TOUR_ABSENT = 313;
export const TOUR_ADD = 374;

const def: StructureDef<BloomState> = {
  id: 'bloom-filter',
  params: [
    {
      id: 'bits',
      label: 'Bits in the filter',
      default: 32,
      options: [16, 32, 64].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.bits ?? 32),
  seed: SEED_KEYS.map((k) => ['add', k] as [string, number]),
  ops: [
    { id: 'add', label: 'Add', intent: 'primary', args: [KEY], run: (s, [k], rec) => void add(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'check', label: 'Check', args: [KEY], run: (s, [k], rec) => void check(s, Number(k), rec), suggest: (s) => [suggestCheck(s)] },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Bits checked' },
    { key: 'writes', label: 'Bits newly set' },
    { key: 'falsePositives', label: 'False positives' },
  ],
  status: (s) => [
    { label: 'Keys added', value: String(s.added.size) },
    { label: 'Bits set', value: `${s.ones} of ${s.m}` },
    { label: 'Estimated false positive rate', value: percent(estimatedRate(s.added.size, s.m)) },
    { label: 'False positives so far', value: String(s.falsePositives) },
  ],
  tour: [
    ['check', TOUR_PRESENT],
    ['check', TOUR_ABSENT],
    ['add', TOUR_ADD],
    ['check', TOUR_ABSENT],
  ],
  fill: (s) => ['add', absentKey(s)],
  info: {
    summary:
      'A Bloom filter is a row of bits and a few hash functions. Adding a key sets the bits its hashes point at, and checking a key reads those same bits. Any 0 proves the key was never added. All 1s only means "probably", because other keys may have set them.',
    watch: [
      'The array holds 0s and 1s and nothing else. The list of keys above it is the page keeping score, so it can tell you when the filter is wrong. The filter could not print that list.',
      'A check stops at the first 0, and that answer is always right. There are no false negatives.',
      'In the tour, 313 is definitely absent. Then 374 is added, which happens to set bit 19, and 313 turns into a false positive. Nothing about 313 changed.',
      'Watch the estimated false positive rate climb as the bits fill up. Rebuild with 16 bits and add a few keys to see a filter that says "probably" to almost everything.',
      'Each hash is (a·x + b) mod 1009 mod m, so you can check the sums by hand. 1009 is a prime just above the largest key. Without that step, two keys that are m apart would always land on the same three bits. Real filters use fast general-purpose hashes such as MurmurHash or xxHash.',
    ],
    complexity: [
      { op: 'Add', average: 'O(k)', worst: 'O(k)', note: 'k hashes and at most k bit writes. The number of keys already stored makes no difference.' },
      { op: 'Check', average: 'O(k)', worst: 'O(k)', note: 'Stops at the first 0, so a miss often reads fewer than k bits.' },
      { op: 'Delete', average: 'Not supported', worst: 'Not supported', note: 'Clearing a bit could also remove every other key that shares it.' },
      { op: 'List the keys', average: 'Not supported', worst: 'Not supported', note: 'The keys are never stored, only the bits they set.' },
    ],
    space:
      'm bits, fixed when the filter is created. For n keys and a target false positive rate p, m = -n·ln p / (ln 2)², which is about 1.44·log_2(1/p) bits per key, however large the keys are.',
    usedIn: [
      { name: 'RocksDB and LevelDB', how: 'With a filter policy set, each SSTable file stores Bloom filter data for its keys. A read asks the filter first and skips the file on a "no", which saves a disk read. Ten bits per key is a common setting.' },
      { name: 'Apache Cassandra', how: 'Keeps a Bloom filter in memory for every SSTable, so a read only touches the files that might hold the partition. The table option bloom_filter_fp_chance sets the target false positive rate.' },
      { name: 'Apache HBase', how: 'A store file can include a Bloom filter on the row key, or on row plus column, so a get skips files that cannot contain the row.' },
      { name: 'Google Bigtable', how: 'The Bigtable paper describes Bloom filters on SSTables to avoid disk seeks for rows and columns that do not exist.' },
      { name: 'PostgreSQL', how: 'The bloom extension adds an index type built on Bloom filters. One index answers equality tests on any mix of its columns, and matches are rechecked against the table to remove false positives.' },
      { name: 'Akamai', how: 'Its CDN caches an object on the second request, not the first, and uses a Bloom filter to remember what has been requested once. Akamai measured that about three quarters of objects were requested only once, so these one-hit wonders stay off disk.' },
      { name: 'Google Chrome', how: 'Early versions kept the Safe Browsing list of malicious URLs as a local Bloom filter and only asked the server when the filter said "probably".' },
    ],
    reachFor: [
      'A cheap test in front of an expensive lookup that usually misses: a disk read, a network call, a database query.',
      'You can accept a small share of wasted lookups, but never a wrong "no".',
      'The set is too large to hold in memory as real keys, and membership is all you need.',
    ],
    costs: [
      'False positives. The rate depends on bits per key and number of hashes, and it climbs fast once the filter holds more keys than it was sized for.',
      'No deletes. A counting Bloom filter swaps each bit for a small counter and a cuckoo filter stores short fingerprints; both can delete, and both use more space or more care.',
      'No listing and no exact count. The filter does not hold the keys.',
      'It must be sized up front. To grow, you rebuild from the original keys or use a scalable Bloom filter, which adds a new, larger filter each time the last one fills.',
      'If the set fits in memory and you need exact answers, a hash set is simpler and never wrong.',
    ],
    interview: [
      'Say where it goes: in front of a disk or network lookup that usually misses. If most lookups hit, the filter saves nothing, because every "probably" still does the real lookup.',
      'Say what a false positive costs in that spot: one wasted read, never a wrong answer. A "no" is always correct, so the filter cannot break correctness, only waste a little work.',
      'Do the sizing sum out loud: m = -n·ln p / (ln 2)² bits and k = (m/n)·ln 2 hashes. For 1% that is about 10 bits per key and 7 hashes, so 100 million keys need roughly 120 MB. Each further tenfold cut in the rate costs about 4.8 more bits per key.',
      'Against a hash set: the set stores every key, so its size grows with the keys. The filter costs about 10 bits per key whatever the key length, and pays for it with false positives, no deletes and no listing.',
      'Deletes: say you would rebuild the filter, or use a counting Bloom filter or a cuckoo filter. LSM stores avoid the question because an SSTable never changes, so its filter is built once when the file is written.',
      'It cannot grow in place. Size it for the expected number of keys, and name scalable Bloom filters if that number is unknown.',
    ],
  },
};

export default def;
