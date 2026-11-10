import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { PREFIX_LIMIT, WORDS, allWords, create, insert, layout, longest, prefix, remove, search, type TNode, type TrieState } from './index';

const quiet = (s: TrieState) => new Recorder(s, layout, false);
const loud = (s: TrieState) => new Recorder(s, layout, true);

/** Throws if any trie invariant is broken. */
function check(s: TrieState): void {
  let nodes = 0;
  let words = 0;
  const ids = new Set<number>();
  const walk = (n: TNode, depth: number) => {
    nodes++;
    expect(ids.has(n.id)).toBe(false);
    ids.add(n.id);
    if (n.end) words++;
    expect(depth).toBeLessThanOrEqual(12);
    if (n === s.root) {
      expect(n.ch).toBe('');
      expect(n.end).toBe(false);
    } else {
      expect(n.ch).toMatch(/^[a-z]$/);
      // No dead branches: a node without children must end a word.
      if (n.kids.size === 0) expect(n.end).toBe(true);
    }
    for (const [ch, kid] of n.kids) {
      expect(kid.ch).toBe(ch);
      walk(kid, depth + 1);
    }
  };
  walk(s.root, 0);
  expect(s.nodes).toBe(nodes);
  expect(s.words).toBe(words);
}

function frameIntegrity(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const edgeIds = new Set(f.scene.edges.map((e) => e.id));
    expect(edgeIds.size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    expect(f.message).not.toMatch(/undefined|NaN|—/);
  }
}

/** Short words over a tiny alphabet, so prefixes collide all the time. */
function randomWord(rnd: () => number, letters = 'abc', maxLen = 6): string {
  const len = 1 + Math.floor(rnd() * maxLen);
  let w = '';
  for (let i = 0; i < len; i++) w += letters[Math.floor(rnd() * letters.length)];
  return w;
}

describe('trie', () => {
  for (const seed of [1, 2, 3]) {
    it(`matches a Set through random inserts, deletes, searches and prefix queries (seed ${seed})`, () => {
      const rnd = makeRng(seed * 104729);
      const s = create();
      const model = new Set<string>();
      for (let i = 0; i < 4000; i++) {
        const w = randomWord(rnd);
        const roll = rnd();
        if (roll < 0.45) {
          expect(insert(s, w, quiet(s))).toBe(!model.has(w));
          model.add(w);
        } else if (roll < 0.75) {
          expect(remove(s, w, quiet(s))).toBe(model.has(w));
          model.delete(w);
        } else if (roll < 0.9) {
          expect(search(s, w, quiet(s))).toBe(model.has(w));
        } else {
          const want = [...model].filter((m) => m.startsWith(w)).sort().slice(0, PREFIX_LIMIT);
          expect(prefix(s, w, quiet(s))).toEqual(want);
        }
        if (i % 40 === 0) check(s);
      }
      check(s);
      expect(allWords(s)).toEqual([...model].sort());
      expect(longest(s)).toBe(Math.max(0, ...[...model].map((m) => m.length)));
      // Empty it completely: only the root should be left.
      for (const w of [...model]) expect(remove(s, w, quiet(s))).toBe(true);
      check(s);
      expect(s.words).toBe(0);
      expect(s.nodes).toBe(1);
      expect(s.root.kids.size).toBe(0);
    });
  }

  it('counts the same with recording on and off, and keeps every frame consistent', () => {
    const rnd = makeRng(4242);
    const a = create();
    const b = create();
    for (let i = 0; i < 600; i++) {
      const w = randomWord(rnd, 'abcd', 5);
      const roll = rnd();
      const op = roll < 0.4 ? insert : roll < 0.65 ? remove : roll < 0.85 ? search : prefix;
      const on = loud(a);
      const off = quiet(b);
      const ra = op(a, w, on);
      const rb = op(b, w, off);
      expect(ra).toEqual(rb);
      expect(on.counters).toEqual(off.counters);
      expect(off.frames.length).toBe(0);
      expect(on.frames.length).toBeGreaterThan(1);
      frameIntegrity(on.frames);
      expect(on.frames[on.frames.length - 1].counters).toEqual(on.counters);
      // Each comparison is its own frame.
      expect(on.frames.filter((f) => f.compare).length).toBe(on.counters.comparisons ?? 0);
    }
    check(a);
    expect(allWords(a)).toEqual(allWords(b));
  });

  it('search checks one letter per level, whatever else is stored', () => {
    const s = create();
    for (const w of WORDS) insert(s, w, quiet(s));
    const hit = quiet(s);
    expect(search(s, 'card', hit)).toBe(true);
    expect(hit.counters).toEqual({ reads: 5, comparisons: 4 });
    // A miss stops at the first letter with no child.
    const miss = quiet(s);
    expect(search(s, 'cxyz', miss)).toBe(false);
    expect(miss.counters).toEqual({ reads: 2, comparisons: 2 });
    // A prefix of a stored word is not itself stored.
    expect(search(s, 'ca', quiet(s))).toBe(false);
    expect(search(s, 'cards', quiet(s))).toBe(false);
  });

  it('insert reuses shared prefixes and writes only the missing nodes', () => {
    const s = create();
    const first = quiet(s);
    insert(s, 'card', first);
    expect(first.counters).toEqual({ reads: 1, comparisons: 4, writes: 4 });
    const second = quiet(s);
    insert(s, 'cart', second);
    expect(second.counters).toEqual({ reads: 4, comparisons: 4, writes: 1 });
    expect(s.nodes).toBe(6);
    // A word that is already a path only needs its end mark.
    const third = quiet(s);
    expect(insert(s, 'car', third)).toBe(true);
    expect(third.counters.writes).toBe(1);
    expect(s.nodes).toBe(6);
    // Sets, not multisets.
    const again = quiet(s);
    expect(insert(s, 'car', again)).toBe(false);
    expect(again.counters.writes).toBeUndefined();
    expect(s.words).toBe(3);
  });

  it('delete prunes exactly the nodes no other word needs', () => {
    const s = create();
    for (const w of ['tea', 'ten', 'top', 'to']) insert(s, w, quiet(s));
    expect(s.nodes).toBe(7);
    // "p" goes; "o" stays because it ends "to".
    const one = quiet(s);
    expect(remove(s, 'top', one)).toBe(true);
    expect(one.counters.writes).toBe(1);
    expect(s.nodes).toBe(6);
    // "o" goes; "t" stays because "tea" and "ten" pass through it.
    remove(s, 'to', quiet(s));
    expect(s.nodes).toBe(5);
    // A word in the middle of a path keeps every node.
    insert(s, 'te', quiet(s));
    const mid = quiet(s);
    expect(remove(s, 'te', mid)).toBe(true);
    expect(mid.counters.writes).toBe(1);
    expect(s.nodes).toBe(5);
    expect(remove(s, 'te', quiet(s))).toBe(false);
    expect(remove(s, 'tex', quiet(s))).toBe(false);
    expect(allWords(s)).toEqual(['tea', 'ten']);
    check(s);
  });

  it('prefix query returns words in alphabetical order and stops at the limit', () => {
    const s = create();
    for (const w of WORDS) insert(s, w, quiet(s));
    expect(prefix(s, 'ca', quiet(s))).toEqual(['cab', 'can', 'cap', 'car', 'card', 'care', 'cart', 'cat']);
    expect(prefix(s, 'do', quiet(s))).toEqual(['do', 'doe', 'dog', 'dot']);
    expect(prefix(s, 'x', quiet(s))).toEqual([]);
    expect(prefix(s, 'cards', quiet(s))).toEqual([]);
    const capped = loud(s);
    expect(prefix(s, 'c', capped)).toEqual(['cab', 'can', 'cap', 'car', 'card', 'care', 'cart', 'cat']);
    expect(capped.frames[capped.frames.length - 1].message).toContain('limit');
    const open = loud(s);
    expect(prefix(s, 'ca', open)).toHaveLength(8);
    expect(open.frames[open.frames.length - 1].message).not.toContain('limit');
  });

  it('the probe shows the word with the current letter bracketed, on the node being examined', () => {
    const s = create();
    for (const w of ['car', 'card', 'cat']) insert(s, w, quiet(s));
    const rec = loud(s);
    search(s, 'card', rec);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.map((f) => f.probe?.text)).toEqual(['[c]ard', 'c[a]rd', 'ca[r]d', 'car[d]']);
    for (const f of compares) {
      const node = f.scene.nodes.find((n) => n.id === f.probe!.at)!;
      expect(node.cells[0].text).toBe(String(f.compare!.right));
      expect(node.tone).toBe('compare');
      expect(f.compare!.op).toBe('=');
    }
    // A miss compares against the children on offer and leaves the probe on the parent.
    const miss = loud(s);
    search(s, 'cab', miss);
    const last = miss.frames.filter((f) => f.compare).pop()!;
    expect(last.compare).toMatchObject({ left: 'b', op: '≠', right: 'r, t' });
    expect(last.probe?.text).toBe('ca[b]');
    expect(last.scene.nodes.find((n) => n.id === last.probe!.at)!.cells[0].text).toBe('a');
  });

  it('end-of-word nodes look different at rest without a state tone', () => {
    const s = create();
    for (const w of ['car', 'card', 'do']) insert(s, w, quiet(s));
    const scene = layout(s);
    const byText = (t: string) => scene.nodes.filter((n) => n.cells[0].text === t);
    for (const n of scene.nodes) expect(n.tone).toBeUndefined();
    expect(byText('r')[0].hue).toBeDefined();
    expect(byText('d').find((n) => n.caption === 'card')?.hue).toBeDefined();
    expect(byText('o')[0].caption).toBe('do');
    expect(byText('a')[0].hue).toBeUndefined();
    expect(byText('c')[0].hue).toBeUndefined();
  });

  it('layout keeps nodes apart and children in alphabetical order', () => {
    const s = create();
    for (const w of [...WORDS, 'abcdefghijkl', 'abcdefghijkm']) insert(s, w, quiet(s));
    const scene = layout(s);
    const boxes = scene.nodes.map((n) => ({ n, ...nodeSize(n) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apartX = Math.abs(a.n.x - b.n.x) >= (a.w + b.w) / 2 + 4;
        const apartY = Math.abs(a.n.y - b.n.y) >= (a.h + b.h) / 2 + 4;
        expect(apartX || apartY).toBe(true);
      }
    }
    const at = new Map(scene.nodes.map((n) => [n.id, n]));
    const kidsOf = new Map<string, string[]>();
    for (const e of scene.edges) kidsOf.set(e.from, [...(kidsOf.get(e.from) ?? []), e.to]);
    for (const kids of kidsOf.values()) {
      const inOrder = [...kids].sort((x, y) => at.get(x)!.x - at.get(y)!.x).map((id) => at.get(id)!.cells[0].text);
      expect(inOrder).toEqual([...inOrder].sort());
    }
  });

  it('seed and tour run cleanly through the definition', () => {
    expect(def.id).toBe('trie');
    const s = def.create({});
    const run = (id: string, args: (number | string)[], recording: boolean) => {
      const op = def.ops.find((o) => o.id === id)!;
      const rec = new Recorder(s, def.layout, recording);
      op.run(s, args, rec);
      return rec;
    };
    for (const [id, ...args] of def.seed) run(id, args, false);
    check(s);
    expect(s.words).toBe(def.seed.length);
    const rest = def.layout(s);
    const xs = rest.nodes.map((n) => n.x);
    const ys = rest.nodes.map((n) => n.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(380);

    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const nodesBefore = s.nodes;
    const recs = def.tour.map(([id, ...args]) => {
      const rec = run(id, args, true);
      expect(rec.frames.length).toBeGreaterThan(2);
      frameIntegrity(rec.frames);
      check(s);
      return rec;
    });
    // The insert reuses a long prefix and adds one node; the delete prunes two.
    expect(recs[2].counters.writes).toBe(1);
    expect(recs[4].counters.writes).toBe(2);
    expect(s.nodes).toBe(nodesBefore + 1 - 2);
    // The failed search stops part-way.
    expect(recs[3].counters.comparisons).toBe(3);
    expect(allWords(s)).toEqual(['car', 'card', 'care', 'cart', 'cat', 'do', 'dog', 'dot', 'tea', 'ten']);

    for (const st of def.status!(s)) expect(st.value).not.toMatch(/undefined|NaN/);
    for (const op of def.ops) {
      const args = op.suggest!(s);
      expect(String(args[0])).toMatch(/^[a-z]{1,12}$/);
    }
    for (let i = 0; i < 60; i++) {
      const [id, ...args] = def.fill!(s);
      run(id, args, false);
    }
    check(s);
    expect(s.words).toBe(70);
  });

  it('rejects anything that is not 1 to 12 lowercase letters', () => {
    const s = create();
    for (const bad of ['', 'Cat', 'a1', 'abcdefghijklm']) {
      expect(insert(s, bad, quiet(s))).toBe(false);
      expect(search(s, bad, quiet(s))).toBe(false);
      expect(remove(s, bad, quiet(s))).toBe(false);
      expect(prefix(s, bad, quiet(s))).toEqual([]);
    }
    expect(s.nodes).toBe(1);
  });
});
