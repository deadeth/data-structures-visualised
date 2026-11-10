import { boxWidth, tidyTree } from '../../core/geometry';
import { randomInt } from '../../core/rng';
import type { Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/BPlusTree.java?raw';
import python from './code/b_plus_tree.py?raw';

/**
 * B+ tree of integers.
 *
 * `order` is the maximum number of children an internal node may have. Every
 * node holds at most order - 1 keys. Internal keys are separators: child i
 * holds keys smaller than keys[i], child i + 1 holds keys greater or equal.
 * All keys live in the leaves, which are chained left to right.
 */
export interface BNode {
  id: number;
  leaf: boolean;
  keys: number[];
  kids: BNode[];
  next: BNode | null;
  /** Node this one split away from. Only used to animate its arrival. */
  origin?: number;
}

export interface BPlusState {
  root: BNode;
  order: number;
  nextId: number;
  size: number;
}

const nid = (n: BNode) => `n${n.id}`;
const eid = (a: BNode, b: BNode) => `e${a.id}-${b.id}`;
const maxKeys = (s: BPlusState) => s.order - 1;
const minLeafKeys = (s: BPlusState) => Math.ceil((s.order - 1) / 2);
const minInnerKeys = (s: BPlusState) => Math.ceil(s.order / 2) - 1;

function newNode(s: BPlusState, leaf: boolean): BNode {
  return { id: s.nextId++, leaf, keys: [], kids: [], next: null };
}

export function create(order: number): BPlusState {
  const s: BPlusState = { root: null as unknown as BNode, order, nextId: 1, size: 0 };
  s.root = newNode(s, true);
  return s;
}

export function height(s: BPlusState): number {
  let h = 1;
  for (let n = s.root; !n.leaf; n = n.kids[0]) h++;
  return h;
}

export function firstLeaf(s: BPlusState): BNode {
  let n = s.root;
  while (!n.leaf) n = n.kids[0];
  return n;
}

export function allKeys(s: BPlusState): number[] {
  const out: number[] = [];
  for (let n: BNode | null = firstLeaf(s); n; n = n.next) out.push(...n.keys);
  return out;
}

interface Step {
  node: BNode;
  /** Index of the child we followed out of `node`. */
  idx: number;
}

/** Walk from the root to the leaf that would hold `key`, narrating every comparison. */
function descend(s: BPlusState, key: number, rec: Rec, label = String(key)): { leaf: BNode; path: Step[] } {
  const path: Step[] = [];
  let node = s.root;
  rec.count('reads');
  rec.mark(nid(node), 'path');
  rec.line('start');
  rec.step(
    node.leaf
      ? `The tree is a single leaf. Read it.`
      : `Start at the root. Internal nodes hold no data, only separator keys that say which way to go.`,
    { probe: { text: label, at: nid(node) } },
  );
  while (!node.leaf) {
    let i = 0;
    for (; i < node.keys.length; i++) {
      const k = node.keys[i];
      const probe = { text: label, at: nid(node), cell: i };
      rec.markCell(nid(node), i, 'compare');
      rec.line('separator');
      if (key < k) {
        rec.compare(key, '<', k, `take the pointer to the left of ${k}`, { probe });
        rec.markCell(nid(node), i, 'path');
        break;
      }
      const last = i === node.keys.length - 1;
      rec.compare(key, '≥', k, last ? `past the last separator, take the rightmost pointer` : `keep scanning right`, { probe });
      rec.markCell(nid(node), i, 'idle');
    }
    path.push({ node, idx: i });
    const child = node.kids[i];
    rec.markEdge(eid(node, child), 'path');
    node = child;
    rec.count('reads');
    rec.mark(nid(node), 'path');
    rec.line('down');
    rec.step(
      node.leaf ? `Reached a leaf. Leaves hold the real keys, in sorted order.` : `Follow the pointer down one level and read that node.`,
      { probe: { text: label, at: nid(node) } },
    );
  }
  return { leaf: node, path };
}

/** Scan a leaf for `key`. Returns where it is, or where it would go. */
function scanLeaf(leaf: BNode, key: number, rec: Rec): { found: boolean; pos: number } {
  for (let i = 0; i < leaf.keys.length; i++) {
    const k = leaf.keys[i];
    const probe = { text: String(key), at: nid(leaf), cell: i };
    rec.markCell(nid(leaf), i, 'compare');
    rec.line('scan');
    if (key === k) {
      rec.compare(key, '=', k, `match`, { probe });
      return { found: true, pos: i };
    }
    if (key < k) {
      rec.compare(key, '<', k, `${key} would sit before ${k}, so it is not in this leaf`, { probe });
      rec.markCell(nid(leaf), i, 'idle');
      return { found: false, pos: i };
    }
    rec.compare(key, '>', k, `keep scanning right`, { probe });
    rec.markCell(nid(leaf), i, 'idle');
  }
  return { found: false, pos: leaf.keys.length };
}

/** Highlight the cell that holds `key`, wherever it ended up. */
function markKey(s: BPlusState, key: number, rec: Rec): void {
  if (!rec.recording) return;
  for (let n: BNode | null = firstLeaf(s); n; n = n.next) {
    const i = n.keys.indexOf(key);
    if (i >= 0) {
      rec.markCell(nid(n), i, 'key');
      return;
    }
  }
}

export function search(s: BPlusState, key: number, rec: Rec): boolean {
  const { leaf } = descend(s, key, rec);
  const { found, pos } = scanLeaf(leaf, key, rec);
  rec.line('result');
  if (found) {
    rec.markCell(nid(leaf), pos, 'ok');
    rec.mark(nid(leaf), 'ok');
    rec.step(`Found ${key}. The search read ${height(s)} ${height(s) === 1 ? 'node' : 'nodes'}, one per level, however many keys the tree holds.`, {
      probe: { text: String(key), at: nid(leaf), cell: pos },
    });
  } else {
    rec.mark(nid(leaf), 'bad');
    rec.step(`${key} is not in the tree. This leaf is the only place it could be.`);
  }
  return found;
}

export function insert(s: BPlusState, key: number, rec: Rec): boolean {
  const { leaf, path } = descend(s, key, rec);
  const { found, pos } = scanLeaf(leaf, key, rec);
  if (found) {
    rec.markCell(nid(leaf), pos, 'ok');
    rec.line('duplicate');
    rec.step(`${key} is already stored. Nothing to do.`);
    return false;
  }
  leaf.keys.splice(pos, 0, key);
  s.size++;
  rec.count('writes');
  rec.clearMarks();
  rec.mark(nid(leaf), 'ok');
  rec.markCell(nid(leaf), pos, 'key');
  rec.line('place');
  rec.step(`Slot ${key} into the leaf, keeping the keys sorted.`);

  let node = leaf;
  while (node.keys.length > maxKeys(s)) {
    const right = newNode(s, node.leaf);
    right.origin = node.id;
    let sep: number;
    let why: string;
    const how = node.leaf ? 'split_leaf' : 'split_inner';
    if (node.leaf) {
      const mid = Math.ceil(node.keys.length / 2);
      right.keys = node.keys.splice(mid);
      right.next = node.next;
      node.next = right;
      sep = right.keys[0];
      why = `The leaf holds ${maxKeys(s) + 1} keys, one over its limit of ${maxKeys(s)}, so it splits in two. ${sep} is copied up as the separator between the halves.`;
    } else {
      const mid = Math.floor(node.keys.length / 2);
      sep = node.keys[mid];
      right.keys = node.keys.splice(mid + 1);
      node.keys.pop();
      right.kids = node.kids.splice(mid + 1);
      why = `The parent is now over its limit too, so it splits. ${sep} moves up; internal nodes do not keep a copy.`;
    }
    rec.count('writes', 2);
    rec.count('splits');
    rec.clearMarks();
    rec.mark(nid(node), 'ok');
    rec.mark(nid(right), 'ok');
    const up = path.pop();
    if (!up) {
      const root = newNode(s, false);
      root.keys = [sep];
      root.kids = [node, right];
      root.origin = node.id;
      s.root = root;
      rec.count('writes');
      rec.mark(nid(root), 'ok');
      markKey(s, key, rec);
      rec.line(how, 'new_root');
      rec.step(`${why} There was no parent, so a new root is created. This is the only way the tree grows taller, which keeps every leaf at the same depth.`);
      break;
    }
    up.node.keys.splice(up.idx, 0, sep);
    up.node.kids.splice(up.idx + 1, 0, right);
    rec.count('writes');
    rec.markCell(nid(up.node), up.idx, 'ok');
    markKey(s, key, rec);
    rec.line(how, 'push_up');
    rec.step(why);
    node = up.node;
  }
  rec.clearMarks();
  markKey(s, key, rec);
  rec.line('done');
  rec.step(`${key} is stored. The tree is ${height(s)} ${height(s) === 1 ? 'level' : 'levels'} deep and holds ${s.size} keys.`);
  return true;
}

export function remove(s: BPlusState, key: number, rec: Rec): boolean {
  const { leaf, path } = descend(s, key, rec);
  const { found, pos } = scanLeaf(leaf, key, rec);
  if (!found) {
    rec.mark(nid(leaf), 'bad');
    rec.line('missing');
    rec.step(`${key} is not in the tree, so there is nothing to delete.`);
    return false;
  }
  rec.markCell(nid(leaf), pos, 'bad');
  rec.line('remove');
  rec.step(`Found ${key}. Remove it from the leaf.`, { probe: { text: String(key), at: nid(leaf), cell: pos } });
  leaf.keys.splice(pos, 1);
  s.size--;
  rec.count('writes');
  rec.clearMarks();
  rec.mark(nid(leaf), 'path');
  rec.step(`${key} is gone. Now check the leaf still holds enough keys.`);

  let node = leaf;
  for (;;) {
    const up = path.pop();
    if (!up) {
      if (!node.leaf && node.keys.length === 0) {
        s.root = node.kids[0];
        rec.clearMarks();
        rec.mark(nid(s.root), 'ok');
        rec.line('shrink');
        rec.step(`The root has no separators left and a single child, so that child becomes the root. The tree is one level shorter.`);
      }
      break;
    }
    const min = node.leaf ? minLeafKeys(s) : minInnerKeys(s);
    if (node.keys.length >= min) break;
    const p = up.node;
    const idx = up.idx;
    const left = idx > 0 ? p.kids[idx - 1] : null;
    const right = idx < p.kids.length - 1 ? p.kids[idx + 1] : null;
    rec.clearMarks();
    rec.mark(nid(node), 'bad');
    rec.line('underfull');
    rec.step(
      `This node has ${node.keys.length} ${node.keys.length === 1 ? 'key' : 'keys'}, below the minimum of ${min}. It must borrow from a sibling, or merge with one.`,
    );
    if (left && left.keys.length > min) {
      rec.count('reads');
      let moved: number;
      if (node.leaf) {
        moved = left.keys.pop()!;
        node.keys.unshift(moved);
        p.keys[idx - 1] = moved;
      } else {
        moved = left.keys.pop()!;
        node.keys.unshift(p.keys[idx - 1]);
        p.keys[idx - 1] = moved;
        node.kids.unshift(left.kids.pop()!);
      }
      rec.count('writes', 3);
      rec.clearMarks();
      rec.mark(nid(node), 'ok');
      rec.mark(nid(left), 'path');
      rec.markCell(nid(p), idx - 1, 'ok');
      rec.line('borrow_left');
      rec.step(
        node.leaf
          ? `The left sibling has a key to spare. Borrow ${moved} and update the separator in the parent to ${moved}.`
          : `The left sibling has a key to spare. Rotate through the parent: the separator comes down, ${moved} goes up.`,
      );
      break;
    }
    if (right && right.keys.length > min) {
      rec.count('reads');
      let moved: number;
      if (node.leaf) {
        moved = right.keys.shift()!;
        node.keys.push(moved);
        p.keys[idx] = right.keys[0];
      } else {
        moved = right.keys.shift()!;
        node.keys.push(p.keys[idx]);
        p.keys[idx] = moved;
        node.kids.push(right.kids.shift()!);
      }
      rec.count('writes', 3);
      rec.clearMarks();
      rec.mark(nid(node), 'ok');
      rec.mark(nid(right), 'path');
      rec.markCell(nid(p), idx, 'ok');
      rec.line('borrow_right');
      rec.step(
        node.leaf
          ? `The right sibling has a key to spare. Borrow ${moved} and update the separator in the parent to ${p.keys[idx]}.`
          : `The right sibling has a key to spare. Rotate through the parent: the separator comes down, ${moved} goes up.`,
      );
      break;
    }
    // Neither sibling can spare a key: merge. Always fold the right-hand node into the left-hand one.
    const into = left ?? node;
    const gone = left ? node : right!;
    const sepIdx = left ? idx - 1 : idx;
    const sep = p.keys[sepIdx];
    rec.count('reads');
    if (into.leaf) {
      into.keys.push(...gone.keys);
      into.next = gone.next;
    } else {
      into.keys.push(sep, ...gone.keys);
      into.kids.push(...gone.kids);
    }
    p.keys.splice(sepIdx, 1);
    p.kids.splice(sepIdx + 1, 1);
    rec.count('writes', 2);
    rec.count('merges');
    rec.clearMarks();
    rec.mark(nid(into), 'ok');
    rec.line('merge');
    rec.step(
      into.leaf
        ? `Neither sibling can spare a key, so the two leaves merge. The separator ${sep} is removed from the parent.`
        : `Neither sibling can spare a key, so the two nodes merge and pull the separator ${sep} down between them.`,
    );
    node = p;
  }
  rec.clearMarks();
  rec.line('done');
  rec.step(`${key} is deleted. The tree is ${height(s)} ${height(s) === 1 ? 'level' : 'levels'} deep and holds ${s.size} keys.`);
  return true;
}

export function range(s: BPlusState, a: number, b: number, rec: Rec): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const label = `${lo}..${hi}`;
  const { leaf } = descend(s, lo, rec, label);
  const out: number[] = [];
  let node: BNode | null = leaf;
  let leaves = 1;
  scan: while (node) {
    for (let i = 0; i < node.keys.length; i++) {
      const k = node.keys[i];
      const probe = { text: label, at: nid(node), cell: i };
      if (k < lo) {
        rec.markCell(nid(node), i, 'compare');
        rec.line('before');
        rec.compare(lo, '>', k, `${k} is before the range, skip it`, { probe });
        rec.markCell(nid(node), i, 'dim');
        continue;
      }
      rec.markCell(nid(node), i, 'compare');
      if (k > hi) {
        rec.line('past');
        rec.compare(hi, '<', k, `${k} is past the end of the range, stop`, { probe });
        rec.markCell(nid(node), i, 'idle');
        break scan;
      }
      // The test that let it through, with the line it leads to.
      rec.line('past', 'collect');
      rec.compare(hi, '≥', k, `${k} is in the range, collect it`, { probe });
      rec.markCell(nid(node), i, 'ok');
      out.push(k);
    }
    const next: BNode | null = node.next;
    if (!next) break;
    rec.markEdge(`l${node.id}-${next.id}`, 'path');
    rec.count('reads');
    rec.mark(nid(next), 'path');
    leaves++;
    rec.line('next_leaf');
    rec.step(`End of this leaf. Follow its next pointer to the neighbouring leaf. No need to go back up the tree.`, {
      probe: { text: label, at: nid(next) },
    });
    node = next;
  }
  rec.line('done');
  rec.step(
    out.length
      ? `Range ${lo} to ${hi} returned ${out.length} ${out.length === 1 ? 'key' : 'keys'}: ${out.join(', ')}. One trip down the tree, then ${leaves} ${leaves === 1 ? 'leaf' : 'leaves'} read in order.`
      : `No keys between ${lo} and ${hi}.`,
  );
  return out;
}

export function layout(s: BPlusState): Scene {
  const pos = tidyTree<BNode>({
    root: s.root,
    children: (n) => n.kids,
    width: (n) => boxWidth(n.keys),
    gapX: 30,
    gapY: 96,
  });
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  for (const [n, p] of pos) {
    nodes.push({
      id: nid(n),
      x: p.x,
      y: p.y,
      cells: n.keys.length ? n.keys.map((k) => ({ text: String(k) })) : [{ text: '' }],
      from: n.origin != null ? `n${n.origin}` : undefined,
    });
    n.kids.forEach((c, i) => edges.push({ id: eid(n, c), from: nid(n), to: nid(c), kind: 'tree', fromSlot: i }));
    if (n.leaf && n.next) edges.push({ id: `l${n.id}-${n.next.id}`, from: nid(n), to: nid(n.next), kind: 'side', dashed: true, arrow: true });
  }
  return { nodes, edges };
}

const KEY = { name: 'key', label: 'Key', kind: 'int', min: 0, max: 999 } as const;

function absentKey(s: BPlusState): number {
  const have = new Set(allKeys(s));
  for (let i = 0; i < 50; i++) {
    const k = randomInt(1, 99);
    if (!have.has(k)) return k;
  }
  return randomInt(100, 999);
}

function presentKey(s: BPlusState): number {
  const keys = allKeys(s);
  return keys.length ? keys[randomInt(0, keys.length - 1)] : 42;
}

const def: StructureDef<BPlusState> = {
  id: 'b-plus-tree',
  params: [
    {
      id: 'order',
      label: 'Max children per node',
      default: 4,
      options: [3, 4, 5, 6].map((v) => ({ value: v, label: String(v) })),
    },
  ],
  create: (params) => create(params.order ?? 4),
  seed: [12, 27, 35, 41, 48, 56, 63, 70, 84, 91].map((k) => ['insert', k] as [string, number]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [KEY], code: ['insert', 'split', 'find_leaf', 'position'], run: (s, [k], rec) => void insert(s, Number(k), rec), suggest: (s) => [absentKey(s)] },
    { id: 'search', label: 'Search', args: [KEY], code: ['search', 'find_leaf', 'position'], run: (s, [k], rec) => void search(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [KEY], code: ['delete', 'rebalance', 'find_leaf', 'position'], run: (s, [k], rec) => void remove(s, Number(k), rec), suggest: (s) => [presentKey(s)] },
    {
      id: 'range',
      label: 'Range scan',
      args: [
        { name: 'from', label: 'From', kind: 'int', min: 0, max: 999 },
        { name: 'to', label: 'To', kind: 'int', min: 0, max: 999 },
      ],
      code: ['range', 'find_leaf'],
      run: (s, [a, b], rec) => void range(s, Number(a), Number(b), rec),
      suggest: (s) => {
        const keys = allKeys(s);
        if (keys.length < 4) return [10, 60];
        const i = randomInt(0, Math.max(0, keys.length - 5));
        return [keys[i], keys[Math.min(keys.length - 1, i + 4)]];
      },
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Node reads' },
    { key: 'writes', label: 'Node writes' },
  ],
  status: (s) => [
    { label: 'Keys', value: String(s.size) },
    { label: 'Levels', value: String(height(s)) },
    { label: 'Keys per node', value: `${minLeafKeys(s)} to ${maxKeys(s)}` },
  ],
  tour: [
    ['search', 63],
    ['insert', 52],
    ['insert', 58],
    ['range', 30, 60],
    ['delete', 12],
  ],
  fill: (s) => ['insert', absentKey(s)],
  bench: {
    insert: 'insert',
    search: 'search',
    variants: [
      { label: 'B+ tree, 4 children per node', params: { order: 4 } },
      { label: 'B+ tree, 64 children per node', params: { order: 64 } },
    ],
  },
  source: { python, java },
  info: {
    summary:
      'A B+ tree keeps keys sorted in wide, shallow nodes. Internal nodes only steer the search; every key lives in a leaf, and the leaves are chained together. Wide nodes mean few levels, and few levels mean few disk reads.',
    watch: [
      'Count node reads, not comparisons. On disk each node is one page, and reading a page costs far more than comparing keys inside it.',
      'When a leaf overflows it splits and copies its middle key up. A new root is the only way the tree gets taller, so every leaf stays at the same depth.',
      'A range scan goes down the tree once, then walks sideways along the leaf chain.',
      'Real engines binary-search inside a node. The scan here is linear so you can see each comparison.',
    ],
    complexity: [
      { op: 'Point lookup', average: 'O(log_B n) page reads', worst: 'O(log_B n)', note: 'B is the fan-out, often a few hundred.' },
      { op: 'Insert', average: 'O(log_B n)', worst: 'O(log_B n)', note: 'A split touches one extra page per level, and is rare.' },
      { op: 'Delete', average: 'O(log_B n)', worst: 'O(log_B n)', note: 'Borrow or merge on underflow. Many engines skip merging and leave pages sparse.' },
      { op: 'Range scan of k keys', average: 'O(log_B n + k/B)', worst: 'O(log_B n + k/B)', note: 'One descent, then sequential leaf reads.' },
    ],
    space: 'O(n). Pages sit about two thirds full on average under random inserts.',
    usedIn: [
      { name: 'PostgreSQL', how: 'The default index type. Every primary key and most secondary indexes are B-trees with linked leaves.' },
      { name: 'MySQL InnoDB', how: 'The table itself is a B+ tree keyed by primary key (a clustered index). Secondary indexes point back to it.' },
      { name: 'SQLite', how: 'Tables and indexes are both B-trees inside a single file.' },
      { name: 'MongoDB (WiredTiger)', how: 'Collections and indexes are stored as B-trees.' },
      { name: 'File systems', how: 'NTFS, XFS, APFS and Btrfs index directories and extents with B-tree variants.' },
    ],
    reachFor: [
      'Read-heavy data that is larger than memory.',
      'Range queries, ORDER BY, prefix matches, or "next 20 rows after this id" pagination.',
      'You need predictable read latency: every lookup costs the same number of page reads.',
    ],
    costs: [
      'Writes update pages in place, so each insert is a random write plus a write-ahead log entry. An LSM tree takes writes faster.',
      'Random keys such as UUIDv4 land in a different leaf every time, causing splits and half-empty pages. Time-ordered keys (UUIDv7, Snowflake ids) append at the right-hand edge.',
      'Every secondary index is another tree to update on each write.',
      'No help for exact-match-only workloads that fit in memory; a hash table is simpler and faster there.',
    ],
    interview: [
      'Do the fan-out sum out loud: with about 400 keys per page, four levels cover 400⁴ ≈ 25 billion rows. The top levels stay cached, so a lookup is one or two disk reads.',
      'Why not a binary tree? The cost that matters is page reads. A wide node gets hundreds of comparisons out of a single read.',
      'Why not a hash index? Sorted keys give range scans, ordering and prefix search. A hash gives none of them.',
      'Why B+ instead of a plain B-tree? Keeping data out of internal nodes raises the fan-out, and the linked leaves make range scans sequential.',
      'Against an LSM tree: B+ trees update in place and favour reads; LSM trees append and favour writes. Name the workload before you pick.',
      'Mention the composite index rule: an index on (a, b) serves queries on a, or on a and b, but not on b alone, because that is how the keys are sorted.',
    ],
  },
};

export default def;
