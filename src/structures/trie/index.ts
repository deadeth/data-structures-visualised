import { tidyTree } from '../../core/geometry';
import { pick } from '../../core/rng';
import type { Probe, Rec, Scene, SceneEdge, SceneNode, StructureDef } from '../../core/types';
import java from './code/Trie.java?raw';
import python from './code/trie.py?raw';

/**
 * Trie of lowercase words.
 *
 * One character per node. The root stands for the empty string. A node is
 * marked `end` when the path from the root to it spells a stored word. After
 * every operation, each node other than the root leads to at least one word:
 * delete prunes the branches that no longer do.
 */
export interface TNode {
  id: number;
  /** The letter on the way into this node. Empty for the root. */
  ch: string;
  kids: Map<string, TNode>;
  end: boolean;
}

export interface TrieState {
  root: TNode;
  nextId: number;
  /** Stored words. */
  words: number;
  /** Nodes, counting the root. */
  nodes: number;
}

/** Most words a prefix query returns. */
export const PREFIX_LIMIT = 8;

const nid = (n: TNode) => `n${n.id}`;
const eid = (a: TNode, b: TNode) => `e${a.id}-${b.id}`;
const q = (text: string) => `"${text}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function create(): TrieState {
  return { root: { id: 0, ch: '', kids: new Map(), end: false }, nextId: 1, words: 0, nodes: 1 };
}

/** Children in alphabetical order. */
function sortedKids(n: TNode): TNode[] {
  if (n.kids.size < 2) return [...n.kids.values()];
  return [...n.kids.values()].sort((a, b) => (a.ch < b.ch ? -1 : 1));
}

/** Every stored word, in alphabetical order. For tests, suggestions and status, never for an operation. */
export function allWords(s: TrieState): string[] {
  const out: string[] = [];
  const stack: { node: TNode; text: string }[] = [{ node: s.root, text: '' }];
  while (stack.length) {
    const { node, text } = stack.pop()!;
    if (node.end) out.push(text);
    const kids = sortedKids(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], text: text + kids[i].ch });
  }
  return out;
}

/** Length of the longest stored word, which is also the depth of the trie. */
export function longest(s: TrieState): number {
  let best = 0;
  const stack: { node: TNode; depth: number }[] = [{ node: s.root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > best) best = depth;
    for (const kid of node.kids.values()) stack.push({ node: kid, depth: depth + 1 });
  }
  return best;
}

function valid(word: string, rec: Rec): boolean {
  if (/^[a-z]{1,12}$/.test(word)) return true;
  rec.line('call');
  rec.step(`Words here are 1 to 12 letters, a to z.`);
  return false;
}

/** The word with the letter being looked up in brackets: ca[r]d. */
function bracket(word: string, i: number): string {
  return `${word.slice(0, i)}[${word[i]}]${word.slice(i + 1)}`;
}

/** What a node has to offer when the wanted letter is missing. Only built while recording. */
function kidsLabel(n: TNode): string {
  return n.kids.size ? sortedKids(n).map((k) => k.ch).join(', ') : 'no children';
}

interface Walk {
  /** Nodes visited, root first. path[i] is reached after i letters. */
  path: TNode[];
  /** True if every letter of the word had a child to follow. */
  complete: boolean;
}

/**
 * Follow `word` down from the root, one child lookup per letter. Stops at the
 * first letter with no child. `missVerdict` says what that means to the caller.
 */
function walk(s: TrieState, word: string, rec: Rec, hitVerdict: string, missVerdict: (ch: string) => string): Walk {
  const at = (i: number, node: TNode): Probe | undefined => (rec.recording ? { text: bracket(word, i), at: nid(node) } : undefined);
  let node = s.root;
  const path = [node];
  rec.count('reads');
  rec.mark(nid(node), 'path');
  rec.line('start');
  rec.step(`Start at the root, which stands for the empty string. Each step down adds one letter.`, { probe: at(0, node) });
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const child = node.kids.get(ch);
    if (!child) {
      rec.mark(nid(node), 'compare');
      rec.line('lookup', 'miss');
      rec.compare(ch, '≠', rec.recording ? kidsLabel(node) : '', missVerdict(ch), { probe: at(i, node) });
      rec.mark(nid(node), 'path');
      return { path, complete: false };
    }
    rec.count('reads');
    rec.markEdge(eid(node, child), 'path');
    rec.mark(nid(child), 'compare');
    const verdict = `found child ${q(ch)}, ${hitVerdict}`;
    rec.line('lookup', 'down');
    rec.compare(ch, '=', child.ch, verdict, {
      probe: at(i, child),
      message:
        i === 0
          ? `Found child ${q(ch)}, ${hitVerdict}. A real trie finds the child with a map lookup or an array index, so this is one step however many children the node has.`
          : i === 1
            ? `Found child ${q(ch)}, ${hitVerdict}. Again one lookup, not a scan of the children.`
            : undefined,
    });
    rec.mark(nid(child), 'path');
    node = child;
    path.push(node);
  }
  return { path, complete: true };
}

export function search(s: TrieState, word: string, rec: Rec): boolean {
  if (!valid(word, rec)) return false;
  const { path, complete } = walk(s, word, rec, 'move down', (ch) => `no child for ${q(ch)}, so ${q(word)} is not stored`);
  const node = path[path.length - 1];
  const checked = path.length - 1;
  if (!complete) {
    rec.mark(nid(node), 'bad');
    rec.line('missing');
    const early = checked + 1 < word.length;
    rec.step(
      early
        ? `${q(word)} is not stored. The search stopped at letter ${checked + 1} of ${word.length}, the first one with no child, so the rest of the word was never looked at.`
        : `${q(word)} is not stored. Every letter but the last had a child to follow. ${plural(path.length, 'node')} read.`,
    );
    return false;
  }
  rec.line('result');
  if (!node.end) {
    rec.mark(nid(node), 'bad');
    rec.step(
      `All ${plural(word.length, 'letter')} matched, but this node is not marked as the end of a word. ${q(word)} is only a prefix of longer words, so it is not stored.`,
      { probe: { text: word, at: nid(node) } },
    );
    return false;
  }
  rec.mark(nid(node), 'ok');
  rec.step(
    `This node is marked as the end of a word, so ${q(word)} is stored. ${plural(word.length, 'letter')} checked, ${plural(path.length, 'node')} read. The cost follows the length of the word, not the ${plural(s.words, 'word')} stored.`,
    { probe: { text: word, at: nid(node) } },
  );
  return true;
}

export function insert(s: TrieState, word: string, rec: Rec): boolean {
  if (!valid(word, rec)) return false;
  let node = s.root;
  let reused = 0;
  let created = 0;
  const at = (i: number, n: TNode): Probe | undefined => (rec.recording ? { text: bracket(word, i), at: nid(n) } : undefined);
  rec.count('reads');
  rec.mark(nid(node), 'path');
  rec.line('start');
  rec.step(`Start at the root. Reuse the path for as long as it already spells the word, then add what is missing.`, { probe: at(0, node) });
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const last = i === word.length - 1;
    let child = node.kids.get(ch);
    if (child) {
      reused++;
      rec.count('reads');
      rec.markEdge(eid(node, child), 'path');
      rec.mark(nid(child), 'compare');
      rec.line('lookup', 'down');
      rec.compare(ch, '=', child.ch, `found child ${q(ch)}, reuse it`, {
        probe: at(i, child),
        message:
          reused === 1
            ? `Found child ${q(ch)}, reuse it. The lookup is a map or array index, so it is one step however many children the node has.`
            : undefined,
      });
      rec.mark(nid(child), 'path');
    } else {
      rec.mark(nid(node), 'compare');
      rec.line('lookup', 'absent');
      rec.compare(ch, '≠', rec.recording ? kidsLabel(node) : '', `no child for ${q(ch)}, so create one`, {
        probe: at(i, node),
        message:
          created === 1 ? `No child for ${q(ch)}, so create one. A new node starts with no children, so every remaining letter needs a node of its own.` : undefined,
      });
      rec.mark(nid(node), created ? 'ok' : 'path');
      child = { id: s.nextId++, ch, kids: new Map(), end: last };
      node.kids.set(ch, child);
      s.nodes++;
      created++;
      if (last) s.words++;
      rec.count('writes');
      rec.markEdge(eid(node, child), 'ok');
      rec.mark(nid(child), 'ok');
      // The listing sets the end mark after its loop; the picture shows it as the last node appears.
      if (last) rec.line('create', 'mark_end');
      else rec.line('create');
      rec.step(
        last
          ? `Create a node for ${q(ch)} and mark it as the end of a word.`
          : `Create a node for ${q(ch)}. ${plural(word.length - i - 1, 'letter')} still to place.`,
        { probe: at(i, child) },
      );
    }
    node = child;
  }
  const probe = { text: word, at: nid(node) };
  if (created === 0) {
    if (node.end) {
      rec.mark(nid(node), 'ok');
      rec.line('duplicate');
      rec.step(`${q(word)} is already stored. Nothing to do.`, { probe });
      return false;
    }
    node.end = true;
    s.words++;
    rec.count('writes');
    rec.mark(nid(node), 'ok');
    rec.line('mark_end');
    rec.step(`Every letter of ${q(word)} was already on a path, so no new node is needed. Mark this node as the end of a word.`, { probe });
  }
  rec.line('done');
  rec.step(
    `${q(word)} is stored: ${plural(word.length, 'letter')} checked, ${plural(reused, 'node')} reused, ${created} created. The trie holds ${plural(s.words, 'word')} in ${plural(s.nodes, 'node')}.`,
    { probe },
  );
  return true;
}

export function remove(s: TrieState, word: string, rec: Rec): boolean {
  if (!valid(word, rec)) return false;
  const { path, complete } = walk(s, word, rec, 'move down', (ch) => `no child for ${q(ch)}, so ${q(word)} is not stored`);
  const node = path[path.length - 1];
  if (!complete) {
    rec.mark(nid(node), 'bad');
    rec.line('missing');
    rec.step(`${q(word)} is not stored, so there is nothing to delete.`);
    return false;
  }
  if (!node.end) {
    rec.mark(nid(node), 'bad');
    rec.line('prefix_only');
    rec.step(`${q(word)} is a prefix of longer words but is not stored itself, so there is nothing to delete.`, { probe: { text: word, at: nid(node) } });
    return false;
  }
  rec.mark(nid(node), 'ok');
  rec.line('unmark');
  rec.step(`Found ${q(word)}: this node is marked as the end of a word. Clear the mark, then see which nodes are still needed.`, {
    probe: { text: word, at: nid(node) },
  });
  node.end = false;
  s.words--;

  // Prune from the bottom up: a node with no children that ends no word leads nowhere.
  let removed = 0;
  let i = path.length - 1;
  while (i > 0 && path[i].kids.size === 0 && !path[i].end) {
    const dead = path[i];
    const parent = path[i - 1];
    rec.mark(nid(dead), 'bad');
    rec.markEdge(eid(parent, dead), 'bad');
    rec.line('prune');
    rec.step(
      removed === 0
        ? `${q(dead.ch)} has no children and no longer ends a word, so it leads nowhere. Remove it.`
        : `That leaves ${q(dead.ch)} with no children, and it ends no word either. Remove it too.`,
      { probe: { text: word, at: nid(dead) } },
    );
    parent.kids.delete(dead.ch);
    s.nodes--;
    removed++;
    rec.count('writes');
    i--;
  }
  const kept = path[i];
  rec.clearMarks();
  // Above the root, the loop stopped at a node that is still needed.
  if (i > 0) rec.line('kept', 'done');
  else rec.line('done');
  if (removed === 0) {
    rec.count('writes');
    rec.mark(nid(kept), 'path');
    rec.step(
      `${q(word)} is deleted: ${plural(word.length, 'letter')} checked, no nodes removed. Longer words still pass through ${q(kept.ch)}, so every node stays and only the mark is cleared.`,
    );
    return true;
  }
  let why: string;
  if (i === 0) why = `Pruning reached the root, which always stays.`;
  else {
    rec.mark(nid(kept), 'path');
    why = kept.end
      ? `Pruning stopped at ${q(kept.ch)}, which ends the word ${q(word.slice(0, i))}.`
      : `Pruning stopped at ${q(kept.ch)}, which still leads to other words.`;
  }
  rec.step(`${q(word)} is deleted: ${plural(word.length, 'letter')} checked, ${plural(removed, 'node')} removed. ${why}`);
  return true;
}

/** Up to PREFIX_LIMIT stored words that start with `pre`, in alphabetical order. */
export function prefix(s: TrieState, pre: string, rec: Rec): string[] {
  if (!valid(pre, rec)) return [];
  const { path, complete } = walk(s, pre, rec, 'move down', (ch) => `no child for ${q(ch)}, so no word starts with ${q(pre)}`);
  const top = path[path.length - 1];
  if (!complete) {
    rec.mark(nid(top), 'bad');
    rec.line('none');
    rec.step(`No stored word starts with ${q(pre)}. The walk stopped at letter ${path.length} of ${pre.length}, so no subtree was read.`);
    return [];
  }
  const out: string[] = [];
  let walked = 0;
  let capped = false;
  // Pre-order, children in alphabetical order: a word comes out before the longer words that extend it.
  const stack: { node: TNode; text: string; parent: TNode | null }[] = [{ node: top, text: pre, parent: null }];
  while (stack.length) {
    const { node, text, parent } = stack.pop()!;
    if (parent) {
      rec.count('reads');
      walked++;
      rec.markEdge(eid(parent, node), 'path');
    }
    if (node.end) out.push(text);
    if (rec.recording) {
      const probe = { text, at: nid(node) };
      rec.mark(nid(node), node.end ? 'ok' : 'path');
      const collect = `Collect it, ${out.length} of up to ${PREFIX_LIMIT}.`;
      rec.line(node.end ? 'collect' : 'visit');
      if (!parent) {
        rec.step(
          node.end
            ? `This node spells ${q(pre)}, and it ends a word. ${collect} Every other match is in the subtree below, so walk it in alphabetical order.`
            : `This node spells ${q(pre)}. Every word that starts with ${q(pre)} is in the subtree below it, so walk that subtree in alphabetical order.`,
          { probe },
        );
      } else {
        rec.step(node.end ? `${q(text)} ends a word. ${collect}` : `${q(text)} is not a word. Keep going down.`, { probe });
      }
    }
    if (out.length === PREFIX_LIMIT) {
      // Every node leads to a word, so anything left unvisited means there were more matches.
      capped = stack.length > 0 || node.kids.size > 0;
      break;
    }
    const kids = sortedKids(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], text: text + kids[i].ch, parent: node });
  }
  if (out.length === PREFIX_LIMIT) rec.line('limit', 'done');
  else rec.line('done');
  rec.step(
    `${plural(out.length, 'word starts', 'words start')} with ${q(pre)}: ${out.join(', ')}. ${plural(pre.length, 'letter')} to reach the prefix, then ${plural(walked, 'more node')} read in the subtree. ${
      capped ? `Stopped at the limit of ${PREFIX_LIMIT}.` : `The cost grows with the subtree, not with the whole trie.`
    }`,
  );
  return out;
}

const R = 20;
const ROOT_R = 9;
const END_HUE = 1;
const ROOT_HUE = 5;
/** Rough width of caption text, so long words under neighbouring leaves do not collide. */
const captionWidth = (text: string) => text.length * 7.2 + 8;

export function layout(s: TrieState): Scene {
  // The word a node spells is only needed for leaf captions; build it on the way down.
  const spelt = new Map<TNode, string>([[s.root, '']]);
  const parentOf = new Map<TNode, TNode>();
  const pos = tidyTree<TNode>({
    root: s.root,
    children: (n) => {
      const kids = sortedKids(n);
      const base = spelt.get(n) ?? '';
      for (const k of kids) {
        spelt.set(k, base + k.ch);
        parentOf.set(k, n);
      }
      return kids;
    },
    width: (n) => (n === s.root ? ROOT_R * 2 : n.kids.size === 0 ? Math.max(R * 2, captionWidth(spelt.get(n) ?? '')) : R * 2),
    gapX: 18,
    gapY: 84,
  });
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  for (const [n, p] of pos) {
    const parent = parentOf.get(n);
    if (!parent) {
      // The root holds no letter. A small slate dot keeps it from reading as a missing character.
      nodes.push({ id: nid(n), x: p.x, y: p.y, shape: 'circle', r: ROOT_R, hue: ROOT_HUE, cells: [{ text: '' }] });
      continue;
    }
    nodes.push({
      id: nid(n),
      x: p.x,
      y: p.y,
      shape: 'circle',
      r: R,
      cells: [{ text: n.ch }],
      // A tint, not a state tone, marks the end of a word. Leaves have room underneath to spell the word out.
      hue: n.end ? END_HUE : undefined,
      caption: n.end && n.kids.size === 0 ? spelt.get(n) : undefined,
      from: nid(parent),
    });
    edges.push({ id: eid(parent, n), from: nid(parent), to: nid(n), kind: 'tree' });
  }
  return { nodes, edges };
}

/** About forty short words that share plenty of prefixes, for the fill button and for suggestions. */
export const WORDS = [
  'an', 'and', 'ant', 'arm', 'art', 'at',
  'bad', 'bag', 'bat', 'be', 'bed', 'bee',
  'cab', 'can', 'cap', 'car', 'card', 'care', 'cart', 'cat', 'cod', 'cot', 'cow',
  'den', 'dip', 'do', 'doe', 'dog', 'dot',
  'in', 'inn', 'it',
  'tan', 'tap', 'tea', 'tee', 'ten', 'to', 'toe', 'ton', 'top',
] as const;

function has(s: TrieState, word: string): boolean {
  let node: TNode | undefined = s.root;
  for (const ch of word) {
    node = node.kids.get(ch);
    if (!node) return false;
  }
  return node.end;
}

function absentWord(s: TrieState): string {
  const free = WORDS.filter((w) => !has(s, w));
  if (free.length) return pick(free);
  // Every built-in word is stored: make one up.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (;;) {
    const word = pick([...letters]) + pick([...'aeiou']) + pick([...letters]);
    if (!has(s, word)) return word;
  }
}

function presentWord(s: TrieState): string {
  const words = allWords(s);
  return words.length ? pick(words) : 'cat';
}

const WORD = { name: 'word', label: 'Word', kind: 'word' } as const;

const def: StructureDef<TrieState> = {
  id: 'trie',
  create: () => create(),
  seed: ['car', 'card', 'care', 'cat', 'do', 'dog', 'dot', 'tea', 'ten', 'top'].map((w) => ['insert', w] as [string, string]),
  ops: [
    { id: 'insert', label: 'Insert', intent: 'primary', args: [WORD], code: ['insert'], run: (s, [w], rec) => void insert(s, String(w), rec), suggest: (s) => [absentWord(s)] },
    { id: 'search', label: 'Search', args: [WORD], code: ['search', 'walk'], run: (s, [w], rec) => void search(s, String(w), rec), suggest: (s) => [presentWord(s)] },
    {
      id: 'prefix',
      label: 'Words with prefix',
      args: [{ name: 'prefix', label: 'Prefix', kind: 'word' }],
      code: ['prefix', 'walk'],
      run: (s, [w], rec) => void prefix(s, String(w), rec),
      suggest: (s) => {
        const word = presentWord(s);
        return [word.slice(0, Math.min(2, Math.max(1, word.length - 1)))];
      },
    },
    { id: 'delete', label: 'Delete', intent: 'danger', args: [WORD], code: ['delete', 'walk'], run: (s, [w], rec) => void remove(s, String(w), rec), suggest: (s) => [presentWord(s)] },
  ],
  layout,
  source: { python, java },
  counters: [
    { key: 'comparisons', label: 'Letters checked' },
    { key: 'reads', label: 'Nodes visited' },
    { key: 'writes', label: 'Node writes' },
  ],
  status: (s) => {
    const depth = longest(s);
    return [
      { label: 'Words', value: String(s.words) },
      { label: 'Nodes', value: String(s.nodes) },
      { label: 'Longest word', value: plural(depth, 'letter') },
    ];
  },
  tour: [
    ['search', 'card'],
    ['prefix', 'ca'],
    ['insert', 'cart'],
    ['search', 'cabin'],
    ['delete', 'top'],
  ],
  fill: (s) => ['insert', absentWord(s)],
  info: {
    summary:
      'A trie stores strings one character per node. Words that share a prefix share the same path from the root, so a lookup follows one pointer per character. The cost depends on the length of the key, not on how many keys are stored.',
    watch: [
      'Each step down is one child lookup by map or array index, not a scan. The count of letters checked never exceeds the length of the word, however large the trie gets.',
      'Tinted nodes end a word. "car" is a word and also the start of "card", so an end mark can sit in the middle of a path.',
      'A failed search stops at the first letter with no child, often before the end of the word.',
      'A prefix query has two parts: a short walk down to the prefix node, then a visit to every node below it. The second part is the expensive one.',
      'Delete removes only the nodes that no other word passes through. Pruning stops at the first node that still has a child or ends a word.',
    ],
    complexity: [
      { op: 'Search', average: 'O(k)', worst: 'O(k)', note: 'k is the length of the key. The number of keys stored does not appear.' },
      { op: 'Insert', average: 'O(k)', worst: 'O(k)', note: 'Creates at most k nodes, fewer when a prefix is already there.' },
      { op: 'Delete', average: 'O(k)', worst: 'O(k)', note: 'Prunes at most k nodes on the way back up.' },
      { op: 'Prefix query', average: 'O(p + s)', worst: 'O(p + s)', note: 'p is the prefix length, s the number of nodes visited below it. Listing every match visits the whole subtree.' },
    ],
    space:
      'At most one node per character stored, fewer when prefixes are shared. Each node also carries its child pointers, so a plain trie often takes more memory than the strings themselves.',
    usedIn: [
      {
        name: 'Linux kernel routing',
        how: 'The IPv4 forwarding table is an LC-trie, a trie over the bits of the address, compressed so that one node can consume several bits. A lookup returns the longest prefix that matches the destination.',
      },
      { name: 'Redis', how: 'Its radix tree, rax, holds the entries of a stream in ID order, along with the consumer groups that read from it.' },
      {
        name: 'HTTP routers',
        how: "Go's httprouter, and Gin which builds on it, match URL paths against a radix tree of route patterns, so routing cost follows the path length rather than the number of routes.",
      },
      {
        name: 'Lucene',
        how: 'The index over its term dictionary is a finite state transducer, a related automaton that shares suffixes as well as prefixes. Elasticsearch and Solr inherit it.',
      },
      {
        name: 'Ethereum',
        how: 'Account state lives in a Merkle Patricia trie. Each node is addressed by its hash, so the root hash commits to the whole state.',
      },
    ],
    reachFor: [
      'Prefix queries, such as autocomplete or "every key that starts with this".',
      'Longest-prefix match, as in IP routing or URL routing, where the most specific stored prefix wins.',
      'String keys that repeat long prefixes, such as URLs, file paths or namespaced keys, when you also want them back in sorted order.',
    ],
    costs: [
      'A node per character costs memory. Every node needs child pointers, and following them jumps around the heap, which is hard on the CPU cache.',
      'For exact-match lookups only, a hash table is simpler and usually faster.',
      'Most production tries are compressed. A radix tree, also called a Patricia trie, merges each chain of single-child nodes into one node that holds several characters.',
      'On disk, a B-tree answers prefix queries from its sort order with far fewer page reads than a pointer-per-character structure.',
    ],
    interview: [
      'Lookup is O(k) in the length of the key and does not depend on the number of keys. A hash table is O(k) too, because it has to hash the whole key, but it cannot answer prefix queries or return keys in order.',
      'For autocomplete, do not walk the subtree on every keystroke. Store the top few suggestions at each node, so a keystroke is one step down and one read. You pay on the write side: when a score changes, the lists on that path need updating, which is why they are often rebuilt offline.',
      'When asked about memory, say radix tree. Merging single-child chains takes the node count from one per character to at most about twice the number of keys.',
      'Against a sorted index such as a B-tree or a sorted array: both answer prefix queries, the index by seeking to the prefix and scanning. The index costs O(log n) string comparisons and suits disk. The trie costs O(k) and suits memory.',
      'Longest-prefix match is the query a trie answers and the alternatives do badly. Walk down the bits of the address and remember the last node that held a route. A hash table would need one probe per possible prefix length.',
      'The children container is a real design choice. An array per node is the fastest and the largest, a map is smaller and slower, and an adaptive radix tree switches layout by how many children a node has.',
    ],
  },
};

export default def;
