import { describe, expect, it } from 'vitest';
import { nodeSize } from '../../core/geometry';
import { Recorder } from '../../core/recorder';
import { makeRng } from '../../core/rng';
import type { Frame } from '../../core/types';
import def, { NAMES, bfs, create, dfs, dijkstra, fewestHops, layout, nodeIndex, type GraphState } from './index';

const N = NAMES.length;
const ix = (letter: string) => NAMES.indexOf(letter);
const letters = (nodes: number[]) => nodes.map((i) => NAMES[i]).join('');
const quiet = (s: GraphState) => new Recorder(s, layout, false);
const loud = (s: GraphState) => new Recorder(s, layout, true);

/** Run an op through the definition, the way the page does. */
function runOp(s: GraphState, id: string, args: (number | string)[], recording: boolean): Recorder<GraphState> {
  const op = def.ops.find((o) => o.id === id)!;
  const rec = new Recorder(s, def.layout, recording);
  op.run(s, args, rec);
  return rec;
}

// ---- simple models -----------------------------------------------------------

function modelBfs(s: GraphState, start: number): number[] {
  const seen = new Set([start]);
  const out: number[] = [];
  const queue = [start];
  while (queue.length) {
    const u = queue.shift()!;
    out.push(u);
    for (const { to } of s.adj[u]) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return out;
}

/** Recursive DFS: the order the explicit stack has to reproduce. */
function modelDfs(s: GraphState, start: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const visit = (u: number) => {
    seen.add(u);
    out.push(u);
    for (const { to } of s.adj[u]) if (!seen.has(to)) visit(to);
  };
  visit(start);
  return out;
}

function floydWarshall(s: GraphState): number[][] {
  const d = NAMES.map((_, i) => NAMES.map((__, j) => (i === j ? 0 : Infinity)));
  for (const e of s.edges) d[e.a][e.b] = d[e.b][e.a] = Math.min(d[e.a][e.b], e.w);
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
  return d;
}

/** Every simple path from a to b, as [edges used, total weight]. */
function allSimplePaths(s: GraphState, a: number, b: number): { hops: number; cost: number }[] {
  const out: { hops: number; cost: number }[] = [];
  const used = new Set<number>([a]);
  const walk = (u: number, hops: number, cost: number) => {
    if (u === b) {
      out.push({ hops, cost });
      return;
    }
    for (const { to, w } of s.adj[u]) {
      if (used.has(to)) continue;
      used.add(to);
      walk(to, hops + 1, cost + w);
      used.delete(to);
    }
  };
  walk(a, 0, 0);
  return out;
}

function pathWeight(s: GraphState, path: number[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const link = s.adj[path[i - 1]].find((l) => l.to === path[i]);
    expect(link, `${NAMES[path[i - 1]]} and ${NAMES[path[i]]} are joined`).toBeDefined();
    total += link!.w;
  }
  return total;
}

/** Unique ids, edges with both ends present, a probe that points at a real node, and no overlapping nodes. */
function checkFrames(frames: Frame[]): void {
  for (const f of frames) {
    const ids = new Set(f.scene.nodes.map((n) => n.id));
    expect(ids.size).toBe(f.scene.nodes.length);
    const edgeIds = new Set(f.scene.edges.map((e) => e.id));
    expect(edgeIds.size).toBe(f.scene.edges.length);
    for (const e of f.scene.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    if (f.probe) expect(ids.has(f.probe.at)).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
    // Narration is one or two sentences.
    expect(f.message.split(/[.?!]\s+(?=[A-Z"])/).length, f.message).toBeLessThanOrEqual(2);
    const boxes = f.scene.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, x1: n.x - w / 2, x2: n.x + w / 2, y1: n.y - h / 2, y2: n.y + h / 2 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const apart = a.x2 + 8 <= b.x1 || b.x2 + 8 <= a.x1 || a.y2 + 8 <= b.y1 || b.y2 + 8 <= a.y1;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
    // The whole scene stays inside the width the page is designed for.
    expect(Math.min(...boxes.map((b) => b.x1))).toBeGreaterThanOrEqual(-20);
    expect(Math.max(...boxes.map((b) => b.x2))).toBeLessThanOrEqual(1000);
  }
}

// ---- tests -------------------------------------------------------------------

describe('graph: the fixed graph', () => {
  const s = create();

  it('has 8 nodes named A to H and 11 or 12 edges with weights from 1 to 9', () => {
    expect(s.names).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(s.edges.length).toBeGreaterThanOrEqual(11);
    expect(s.edges.length).toBeLessThanOrEqual(12);
    const pairs = new Set<string>();
    for (const e of s.edges) {
      expect(Number.isInteger(e.w) && e.w >= 1 && e.w <= 9).toBe(true);
      expect(e.a).not.toBe(e.b);
      pairs.add(`${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`);
    }
    expect(pairs.size).toBe(s.edges.length);
  });

  it('has a symmetric adjacency list in alphabetical order', () => {
    let ends = 0;
    for (let u = 0; u < N; u++) {
      for (let i = 1; i < s.adj[u].length; i++) expect(s.adj[u][i - 1].to).toBeLessThan(s.adj[u][i].to);
      for (const link of s.adj[u]) {
        ends++;
        const back = s.adj[link.to].find((l) => l.to === u);
        expect(back?.w).toBe(link.w);
        expect(back?.edge).toBe(link.edge);
      }
    }
    expect(ends).toBe(2 * s.edges.length);
  });

  it('is drawn with no crossing edges', () => {
    const scene = layout(s);
    const at = new Map(scene.nodes.map((n) => [n.id, n]));
    const segs = scene.edges.map((e) => ({ e, p: at.get(e.from)!, q: at.get(e.to)! }));
    const side = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i];
        const b = segs[j];
        const shared = [a.e.from, a.e.to].some((id) => id === b.e.from || id === b.e.to);
        if (shared) continue;
        const crosses =
          side(a.p.x, a.p.y, a.q.x, a.q.y, b.p.x, b.p.y) !== side(a.p.x, a.p.y, a.q.x, a.q.y, b.q.x, b.q.y) &&
          side(b.p.x, b.p.y, b.q.x, b.q.y, a.p.x, a.p.y) !== side(b.p.x, b.p.y, b.q.x, b.q.y, a.q.x, a.q.y);
        expect(crosses, `${a.e.id} crosses ${b.e.id}`).toBe(false);
      }
    }
  });

  it('reads node letters in either case and rejects everything else', () => {
    expect(nodeIndex(s, 'a')).toBe(0);
    expect(nodeIndex(s, 'H')).toBe(7);
    expect(nodeIndex(s, ' d ')).toBe(3);
    for (const bad of ['', 'i', 'z', 'ab', 'hello', 3, '1']) expect(nodeIndex(s, bad)).toBe(-1);
  });
});

describe('graph: breadth-first and depth-first search', () => {
  it('BFS visits in the hand-written order', () => {
    const s = create();
    expect(letters(bfs(s, ix('A'), quiet(s)))).toBe('ABCDEFGH');
    expect(letters(bfs(s, ix('D'), quiet(s)))).toBe('DBCEFAGH');
    expect(letters(bfs(s, ix('H'), quiet(s)))).toBe('HGEFBDCA');
  });

  it('DFS visits in the hand-written order', () => {
    const s = create();
    expect(letters(dfs(s, ix('A'), quiet(s)))).toBe('ABDCFGEH');
    expect(letters(dfs(s, ix('D'), quiet(s)))).toBe('DBACFGEH');
    expect(letters(dfs(s, ix('H'), quiet(s)))).toBe('HGEBACDF');
  });

  it('BFS and DFS from A give different orders, so the tour has something to compare', () => {
    const s = create();
    expect(letters(bfs(s, 0, quiet(s)))).not.toBe(letters(dfs(s, 0, quiet(s))));
  });

  it('every start visits every node exactly once and matches the model', () => {
    const s = create();
    for (let start = 0; start < N; start++) {
      for (const [go, model] of [
        [bfs, modelBfs],
        [dfs, modelDfs],
      ] as const) {
        const order = go(s, start, quiet(s)).slice();
        expect(order).toEqual(model(s, start));
        expect(order.length).toBe(N);
        expect(new Set(order).size).toBe(N);
        expect(order[0]).toBe(start);
        // The tree edges join all the nodes: n - 1 of them, each into a different node.
        const run = s.run!;
        expect(run.done).toBe(true);
        expect(run.parent[start]).toBe(-1);
        expect(run.parentEdge.filter((e) => e >= 0).length).toBe(N - 1);
      }
    }
  });

  it('BFS records the fewest hops to every node', () => {
    const s = create();
    for (let start = 0; start < N; start++) {
      bfs(s, start, quiet(s));
      const hops = s.run!.dist.slice();
      for (let to = 0; to < N; to++) {
        expect(hops[to]).toBe(Math.min(...allSimplePaths(s, start, to).map((p) => p.hops)));
        expect(hops[to]).toBe(fewestHops(s, start, to).hops);
      }
    }
  });

  it('a full traversal expands each node once and checks each edge from both ends', () => {
    const s = create();
    for (let start = 0; start < N; start++) {
      const b = quiet(s);
      bfs(s, start, b);
      expect(b.counters.reads).toBe(N);
      expect(b.counters.edges).toBe(2 * s.edges.length);
      expect(b.counters.comparisons).toBe(2 * s.edges.length);
      const d = quiet(s);
      dfs(s, start, d);
      expect(d.counters.reads).toBe(N);
      expect(d.counters.edges).toBe(2 * s.edges.length);
      // DFS also asks "already visited?" each time it pops.
      expect(d.counters.comparisons).toBeGreaterThanOrEqual(2 * s.edges.length + N);
    }
  });
});

describe('graph: Dijkstra', () => {
  it('matches Floyd-Warshall for every pair, and returns a real path of that weight', () => {
    const s = create();
    const fw = floydWarshall(s);
    for (let from = 0; from < N; from++) {
      for (let to = 0; to < N; to++) {
        const { path, cost } = dijkstra(s, from, to, quiet(s));
        expect(cost).toBe(fw[from][to]);
        expect(path[0]).toBe(from);
        expect(path[path.length - 1]).toBe(to);
        expect(new Set(path).size).toBe(path.length);
        expect(pathWeight(s, path)).toBe(cost);
        // Every settled node has its true distance, and they were settled nearest first.
        const run = s.run!;
        for (const v of run.order) expect(run.dist[v]).toBe(fw[from][v]);
        for (let i = 1; i < run.order.length; i++) expect(run.dist[run.order[i - 1]]).toBeLessThanOrEqual(run.dist[run.order[i]]);
        // Tentative distances are never below the truth.
        for (let v = 0; v < N; v++) expect(run.dist[v]).toBeGreaterThanOrEqual(fw[from][v]);
      }
    }
  });

  it('agrees with brute force over every simple path', () => {
    const s = create();
    for (let from = 0; from < N; from++) {
      for (let to = 0; to < N; to++) {
        const best = Math.min(...allSimplePaths(s, from, to).map((p) => p.cost));
        expect(dijkstra(s, from, to, quiet(s)).cost).toBe(best);
      }
    }
  });

  it('tour: H is the node furthest from A, and the route with the fewest hops is not the cheapest', () => {
    const s = create();
    const fw = floydWarshall(s);
    const A = ix('A');
    const H = ix('H');
    for (let v = 0; v < N; v++) if (v !== H) expect(fw[A][v]).toBeLessThan(fw[A][H]);
    expect(def.tour[def.tour.length - 1]).toEqual(['dijkstra', 'A', 'H']);

    const { path, cost } = dijkstra(s, A, H, quiet(s));
    expect(letters(path)).toBe('ACDEGH');
    expect(cost).toBe(16);

    const paths = allSimplePaths(s, A, H);
    const fewest = Math.min(...paths.map((p) => p.hops));
    const cheapestOfFewest = Math.min(...paths.filter((p) => p.hops === fewest).map((p) => p.cost));
    expect(fewest).toBe(4);
    expect(path.length - 1).toBeGreaterThan(fewest);
    expect(cheapestOfFewest).toBeGreaterThan(cost);
    // No route with that few hops matches the cheapest one, and the cheapest one is unique.
    expect(paths.filter((p) => p.cost === cost).length).toBe(1);
    const few = fewestHops(s, A, H);
    expect(few.hops).toBe(fewest);
    expect(few.cost).toBe(cheapestOfFewest);
    expect(letters(few.path)).toBe('ABEGH');
    expect(pathWeight(s, few.path)).toBe(18);

    // The path BFS itself finds (its tree edges back from H) is one of the dearer ones.
    bfs(s, A, quiet(s));
    const viaBfs: number[] = [];
    for (let v = H; v !== -1; v = s.run!.parent[v]) viaBfs.unshift(v);
    expect(viaBfs.length - 1).toBe(fewest);
    expect(pathWeight(s, viaBfs)).toBeGreaterThan(cost);
  });

  it('tour: a tentative distance is improved and its old queue entry is discarded later', () => {
    const s = create();
    const rec = loud(s);
    dijkstra(s, ix('A'), ix('H'), rec);
    const improved = rec.frames.filter((f) => f.compare?.op === '<' && f.compare.right !== '∞');
    expect(improved.length).toBeGreaterThanOrEqual(1);
    expect(rec.frames.some((f) => /out of date/.test(f.message))).toBe(true);
  });

  it('tour: the short run from A to D improves a distance and stops before the whole graph is settled', () => {
    const s = create();
    expect(def.tour[def.tour.length - 2]).toEqual(['dijkstra', 'A', 'D']);
    const rec = loud(s);
    const { path, cost } = dijkstra(s, ix('A'), ix('D'), rec);
    expect(letters(path)).toBe('ACD');
    expect(cost).toBe(7);
    // D is first reached through B at 9, then improved through C to 7.
    const improved = rec.frames.filter((f) => f.compare?.op === '<' && f.compare.right !== '∞').map((f) => f.compare);
    expect(improved).toEqual([{ left: 'D via C: 7', op: '<', right: 9, verdict: 'shorter, update' }]);
    // Four nodes are settled, and G and H are never even reached.
    expect(letters(s.run!.order)).toBe('ABCD');
    expect(rec.counters.reads).toBe(4);
    expect(s.run!.dist[ix('G')]).toBe(Infinity);
    expect(s.run!.dist[ix('H')]).toBe(Infinity);
    const last = rec.frames[rec.frames.length - 1];
    expect(last.message).toContain('A → C → D');
    expect(last.message).toContain('4 of 8 nodes');
    expect(last.message).toMatch(/stopped as soon as D was settled/);
    expect(last.probe).toEqual({ text: 'D 7', at: 'nD' });
  });

  it('shows each relaxation as a comparison, with distances under the nodes and the probe on the expanded node', () => {
    const s = create();
    const rec = loud(s);
    dijkstra(s, ix('A'), ix('H'), rec);
    const compares = rec.frames.filter((f) => f.compare);
    expect(compares.length).toBe(rec.counters.comparisons);
    expect(rec.counters.comparisons).toBe(rec.counters.edges);
    for (const f of compares) {
      const c = f.compare!;
      expect(['<', '≥']).toContain(c.op);
      expect(c.verdict).toBe(c.op === '<' ? 'shorter, update' : 'no better, skip');
      // The neutral pill names whose distance it is: "E via B: 12".
      const m = /^([A-H]) via ([A-H]): (\d+)$/.exec(String(c.left));
      expect(m).not.toBeNull();
      const right = c.right === '∞' ? Infinity : Number(c.right);
      const cand = Number(m![3]);
      expect(c.op === '<' ? cand < right : cand >= right).toBe(true);
      // The node being expanded is the probe's node.
      expect(f.probe!.text.startsWith(m![2])).toBe(true);
      // The probe names the node being expanded and its distance, such as "C 5".
      expect(f.probe?.text).toMatch(/^[A-H] \d+$/);
      // Exactly one neighbour and one edge are being examined.
      expect(f.scene.nodes.filter((n) => n.tone === 'compare').length).toBe(1);
      expect(f.scene.edges.filter((e) => e.tone === 'compare').length).toBe(1);
    }
    const first = rec.frames[0];
    const sub = (f: Frame, letter: string) => f.scene.nodes.find((n) => n.id === `n${letter}`)!.cells[0].sub;
    expect(sub(first, 'A')).toBe('0');
    expect(sub(first, 'H')).toBe('∞');
    const last = rec.frames[rec.frames.length - 1];
    expect(sub(last, 'H')).toBe('16');
    expect(last.message).toContain('A → C → D → E → G → H');
    expect(last.message).toContain('16');
    // The answer is green: six nodes and the five edges between them.
    expect(
      last.scene.nodes
        .filter((n) => n.shape === 'circle' && n.tone === 'ok')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['nA', 'nC', 'nD', 'nE', 'nG', 'nH']);
    expect(
      last.scene.edges
        .filter((e) => e.tone === 'ok')
        .map((e) => e.id)
        .sort(),
    ).toEqual(['eAC', 'eCD', 'eDE', 'eEG', 'eGH']);
    // At rest the picture is the same as the last frame.
    expect(layout(s)).toEqual(last.scene);
  });

  it('handles the start being the target', () => {
    const s = create();
    const rec = loud(s);
    expect(dijkstra(s, 2, 2, rec)).toEqual({ path: [2], cost: 0 });
    expect(rec.frames.length).toBeGreaterThan(1);
    checkFrames(rec.frames);
  });
});

describe('graph: frames, counters and the definition', () => {
  it('shows the frontier on every step, with a title that says which end comes out next', () => {
    const s = create();
    for (const [id, args, title] of [
      ['bfs', ['A'], /^Queue: the left end/],
      ['dfs', ['A'], /^Stack: the right end/],
      ['dijkstra', ['A', 'H'], /^Priority queue: smallest/],
    ] as const) {
      const rec = runOp(s, id, [...args], true);
      for (const f of rec.frames) {
        const frontier = f.scene.nodes.find((n) => n.id === 'frontier')!;
        expect(frontier.title).toMatch(title);
        expect(frontier.cells.length).toBeGreaterThan(0);
        expect(f.scene.nodes.some((n) => n.id === 'order')).toBe(true);
      }
    }
  });

  it('BFS and DFS show every "already seen?" check as a comparison with the probe on the expanded node', () => {
    const s = create();
    for (const id of ['bfs', 'dfs']) {
      const rec = runOp(s, id, ['A'], true);
      const compares = rec.frames.filter((f) => f.compare);
      expect(compares.length).toBe(rec.counters.comparisons);
      for (const f of compares) {
        expect(f.probe?.text).toMatch(/^[A-H]$/);
        expect(f.probe?.at).toBe(`n${f.probe?.text}`);
      }
      const last = rec.frames[rec.frames.length - 1];
      expect(last.message).toContain(id === 'bfs' ? 'A, B, C, D, E, F, G, H' : 'A, B, D, C, F, G, E, H');
      // Seven tree edges are kept, the other four are ruled out.
      expect(last.scene.edges.filter((e) => e.tone === 'path').length).toBe(N - 1);
      expect(last.scene.edges.filter((e) => e.tone === 'dim').length).toBe(s.edges.length - (N - 1));
      expect(layout(s)).toEqual(last.scene);
    }
  });

  it('keeps every frame well formed for every start and every pair', () => {
    const s = create();
    checkFrames([{ scene: layout(s), message: 'rest', counters: {} }]);
    for (let a = 0; a < N; a++) {
      for (const id of ['bfs', 'dfs']) {
        const rec = runOp(s, id, [NAMES[a]], true);
        expect(rec.frames.length).toBeGreaterThan(10);
        checkFrames(rec.frames);
        expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      }
      for (let b = 0; b < N; b++) {
        const rec = runOp(s, 'dijkstra', [NAMES[a], NAMES[b].toLowerCase()], true);
        checkFrames(rec.frames);
        expect(rec.frames[rec.frames.length - 1].counters).toEqual(rec.counters);
      }
    }
  });

  it('counts the same with recording on and off, and records nothing when off', () => {
    const on = create();
    const off = create();
    const check = (id: string, args: string[]) => {
      const a = runOp(on, id, args, true);
      const b = runOp(off, id, args, false);
      expect(b.frames.length).toBe(0);
      expect(b.counters).toEqual(a.counters);
      expect(off.run).toEqual(on.run);
    };
    for (const start of NAMES) {
      check('bfs', [start]);
      check('dfs', [start]);
      for (const to of NAMES) check('dijkstra', [start, to]);
    }
  });

  it('narrates politely when the argument is not a node, and leaves the last result alone', () => {
    const s = create();
    runOp(s, 'bfs', ['c'], false);
    const before = JSON.stringify(s.run);
    for (const [id, args] of [
      ['bfs', ['z']],
      ['dfs', ['hello']],
      ['dijkstra', ['a', 'q']],
      ['dijkstra', ['x', 'a']],
    ] as [string, string[]][]) {
      const rec = runOp(s, id, args, true);
      expect(rec.frames.length).toBe(1);
      expect(rec.frames[0].message).toMatch(/not a node/);
      expect(rec.frames[0].message).toMatch(/Please/);
      expect(rec.counters).toEqual({});
      expect(JSON.stringify(s.run)).toBe(before);
      checkFrames(rec.frames);
    }
  });

  it('stays correct through a few thousand random runs, and never changes the graph', () => {
    const s = create();
    const pristine = JSON.stringify({ names: s.names, edges: s.edges, adj: s.adj });
    const fw = floydWarshall(s);
    const rnd = makeRng(20241);
    const anyCase = (i: number) => (rnd() < 0.5 ? NAMES[i] : NAMES[i].toLowerCase());
    for (let i = 0; i < 3000; i++) {
      const a = Math.floor(rnd() * N);
      const b = Math.floor(rnd() * N);
      const kind = rnd();
      const recording = i % 25 === 0;
      if (kind < 0.05) {
        const had = s.run;
        runOp(s, 'bfs', ['q'], recording);
        expect(s.run).toBe(had);
      } else if (kind < 0.35) {
        runOp(s, 'bfs', [anyCase(a)], recording);
        expect(s.run!.order).toEqual(modelBfs(s, a));
      } else if (kind < 0.65) {
        runOp(s, 'dfs', [anyCase(a)], recording);
        expect(s.run!.order).toEqual(modelDfs(s, a));
      } else {
        runOp(s, 'dijkstra', [anyCase(a), anyCase(b)], recording);
        expect(s.run!.cost).toBe(fw[a][b]);
        expect(pathWeight(s, s.run!.path)).toBe(fw[a][b]);
      }
      expect(s.run?.done ?? true).toBe(true);
    }
    expect(JSON.stringify({ names: s.names, edges: s.edges, adj: s.adj })).toBe(pristine);
  });

  it('seed and tour run cleanly through the definition', () => {
    expect(def.id).toBe('graph');
    expect(def.bench).toBeUndefined();
    expect(def.fill).toBeUndefined();
    const s = def.create({});
    for (const [id, ...args] of def.seed) runOp(s, id, args, false);
    expect(def.status!(s).map((f) => f.value)).toEqual(['8', '11', 'None yet']);
    expect(def.tour.map((t) => t[0])).toEqual(['bfs', 'dfs', 'dijkstra', 'dijkstra']);
    expect(def.tour.length).toBeGreaterThanOrEqual(4);
    expect(def.tour.length).toBeLessThanOrEqual(6);
    const results: string[] = [];
    for (const [id, ...args] of def.tour) {
      const rec = runOp(s, id, args, true);
      expect(rec.frames.length).toBeGreaterThan(10);
      checkFrames(rec.frames);
      results.push(def.status!(s)[2].value);
    }
    expect(results).toEqual(['BFS from A: A B C D E F G H', 'DFS from A: A B D C F G E H', 'A → C → D, cost 7', 'A → C → D → E → G → H, cost 16']);
    for (const op of def.ops) {
      const args = op.suggest!(s);
      expect(args.length).toBe(op.args.length);
      for (const a of args) expect(nodeIndex(s, a)).toBeGreaterThanOrEqual(0);
    }
    for (const c of ['comparisons', 'reads', 'edges']) expect(def.counters.some((x) => x.key === c)).toBe(true);
  });
});
