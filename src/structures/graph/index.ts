import { randomInt } from '../../core/rng';
import type { Cell, Rec, Scene, SceneEdge, SceneNode, StructureDef, Tone } from '../../core/types';
import { info } from './info';

/**
 * Graph traversal on a fixed, weighted, undirected graph.
 *
 * The graph never changes. The state holds its adjacency list and the working
 * data of the last run (frontier, seen set, tree edges, distances), so the
 * picture at rest shows the result of that run.
 *
 * All three algorithms are the same loop with a different container for the
 * frontier: a queue (BFS), a stack (DFS) or a priority queue (Dijkstra).
 */

export const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Hand-placed centres: two diamonds sharing D, with H hanging off the far end. */
const POS: [number, number][] = [
  [40, 95], // A
  [170, 0], // B
  [170, 190], // C
  [300, 95], // D
  [430, 0], // E
  [430, 190], // F
  [560, 95], // G
  [690, 95], // H
];

/**
 * [a, b, weight, flip]. `flip` only chooses which way the line is drawn, which
 * decides the side its weight label sits on (inside the diamonds).
 *
 * The weights are chosen so that the cheapest route from A to H, A C D E G H
 * (16), has more edges than the route with the fewest hops, A B E G H (18).
 */
const EDGE_LIST: [string, string, number, boolean][] = [
  ['A', 'B', 3, false],
  ['A', 'C', 5, true],
  ['B', 'D', 6, false],
  ['B', 'E', 9, true],
  ['C', 'D', 2, true],
  ['C', 'F', 8, false],
  ['D', 'E', 3, false],
  ['D', 'F', 7, true],
  ['E', 'G', 4, false],
  ['F', 'G', 5, true],
  ['G', 'H', 2, true],
];

export interface Edge {
  id: string;
  a: number;
  b: number;
  w: number;
  flip: boolean;
}

export interface Link {
  to: number;
  w: number;
  /** Index into `edges`. */
  edge: number;
}

export type Algo = 'bfs' | 'dfs' | 'dijkstra';

/** One item waiting in the frontier. */
export interface Entry {
  node: number;
  /** Node that put it there, -1 for the start. */
  from: number;
  /** Edge it was reached by, -1 for the start. */
  edge: number;
  /** Dijkstra: distance when it was pushed. */
  d: number;
}

export interface Run {
  algo: Algo;
  start: number;
  /** Dijkstra's destination, -1 for the traversals. */
  target: number;
  /** Queue (read from `head`), stack (top at the end) or binary min-heap. */
  frontier: Entry[];
  head: number;
  /** BFS: has been queued. DFS: has been visited. Dijkstra: distance is final. */
  seen: boolean[];
  /** Nodes in the order they were expanded. */
  order: number[];
  /** Tree edge into each node, as a node and as an edge index. -1 for none. */
  parent: number[];
  parentEdge: number[];
  /** BFS: hops from the start. Dijkstra: best distance found so far. */
  dist: number[];
  /** Dijkstra's answer. */
  path: number[];
  cost: number;
  done: boolean;
}

export interface GraphState {
  names: string[];
  edges: Edge[];
  /** Neighbours of each node, in alphabetical order. */
  adj: Link[][];
  /** The last traversal, or null before the first one. */
  run: Run | null;
}

const nid = (i: number) => `n${NAMES[i]}`;
const FRONTIER = 'frontier';
const ORDER = 'order';

export function create(): GraphState {
  const edges: Edge[] = EDGE_LIST.map(([a, b, w, flip]) => ({ id: `e${a}${b}`, a: NAMES.indexOf(a), b: NAMES.indexOf(b), w, flip }));
  const adj: Link[][] = NAMES.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a].push({ to: e.b, w: e.w, edge: i });
    adj[e.b].push({ to: e.a, w: e.w, edge: i });
  });
  for (const list of adj) list.sort((x, y) => x.to - y.to);
  return { names: NAMES.slice(), edges, adj, run: null };
}

/** Accepts one letter, a to h, in either case. Returns -1 for anything else. */
export function nodeIndex(s: GraphState, arg: number | string): number {
  const text = String(arg).trim().toUpperCase();
  return text.length === 1 ? s.names.indexOf(text) : -1;
}

function begin(s: GraphState, algo: Algo, start: number, target: number): Run {
  const n = s.names.length;
  const run: Run = {
    algo,
    start,
    target,
    frontier: [],
    head: 0,
    seen: new Array<boolean>(n).fill(false),
    order: [],
    parent: new Array<number>(n).fill(-1),
    parentEdge: new Array<number>(n).fill(-1),
    dist: new Array<number>(n).fill(Infinity),
    path: [],
    cost: 0,
    done: false,
  };
  s.run = run;
  return run;
}

function notANode(s: GraphState, arg: number | string, rec: Rec): void {
  rec.step(`Sorry, "${arg}" is not a node in this graph. Please pick a letter from ${s.names[0]} to ${s.names[s.names.length - 1]}.`);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (s: GraphState, nodes: number[], sep = ', ') => nodes.map((i) => s.names[i]).join(sep);

// ---- breadth-first search ----------------------------------------------------

/** Visit every node reachable from `start`, nearest first. Returns the visit order. */
export function bfs(s: GraphState, start: number, rec: Rec): number[] {
  const run = begin(s, 'bfs', start, -1);
  const S = s.names[start];
  run.seen[start] = true;
  run.dist[start] = 0;
  run.frontier.push({ node: start, from: -1, edge: -1, d: 0 });
  rec.step(`Breadth-first search from ${S}: mark ${S} as seen and put it in the queue. Weights are ignored here, so every edge counts as one hop.`, {
    probe: { text: S, at: nid(start) },
  });
  let checks = 0;
  while (run.head < run.frontier.length) {
    const u = run.frontier[run.head++].node;
    const U = s.names[u];
    const probe = { text: U, at: nid(u) };
    run.order.push(u);
    rec.count('reads');
    rec.step(
      u === start
        ? `Take ${U} from the front of the queue and look at its neighbours in alphabetical order.`
        : `Take ${U} from the front of the queue: it is ${plural(run.dist[u], 'hop')} from ${S}. Look at each of its neighbours.`,
      { probe },
    );
    for (const link of s.adj[u]) {
      const v = link.to;
      const V = s.names[v];
      const edge = s.edges[link.edge];
      rec.count('edges');
      checks++;
      rec.mark(nid(v), 'compare');
      rec.markEdge(edge.id, 'compare');
      if (!run.seen[v]) {
        run.seen[v] = true;
        run.dist[v] = run.dist[u] + 1;
        run.parent[v] = u;
        run.parentEdge[v] = link.edge;
        run.frontier.push({ node: v, from: u, edge: link.edge, d: 0 });
        rec.compare(V, '=', 'new', `not seen before, add ${V} to the back of the queue`, { probe });
        rec.markEdge(edge.id, 'path');
      } else {
        rec.compare(V, '=', 'seen', `already seen, skip`, { probe });
        rec.markEdge(edge.id, run.parentEdge[u] === link.edge || run.parentEdge[v] === link.edge ? 'path' : 'dim');
      }
      rec.unmark(nid(v));
    }
  }
  run.done = true;
  if (rec.recording) {
    rec.clearMarks();
    rec.step(
      `BFS order: ${list(s, run.order)}, nearest first, so each node was reached by the fewest hops. ` +
        `Cost: ${plural(run.order.length, 'node')} expanded and ${plural(checks, 'edge check')}, because every edge is looked at from both ends.`,
    );
  }
  return run.order;
}

// ---- depth-first search ------------------------------------------------------

/** Visit every node reachable from `start`, following each route to its end first. Returns the visit order. */
export function dfs(s: GraphState, start: number, rec: Rec): number[] {
  const run = begin(s, 'dfs', start, -1);
  const n = s.names.length;
  const S = s.names[start];
  run.frontier.push({ node: start, from: -1, edge: -1, d: 0 });
  rec.step(`Depth-first search from ${S}, with a stack doing the job recursion would do. Push ${S}.`, { probe: { text: S, at: nid(start) } });
  let checks = 0;
  let last = -1;
  let lastPushed = 0;
  while (run.frontier.length) {
    const top = run.frontier.pop()!;
    const u = top.node;
    const U = s.names[u];
    const probe = { text: U, at: nid(u) };
    if (run.seen[u]) {
      rec.compare(U, '=', 'visited', `old entry, discard`, {
        probe,
        message: `Pop ${U}. It has been visited since this entry was pushed, so the entry is out of date and is discarded.`,
      });
      continue;
    }
    run.seen[u] = true;
    run.order.push(u);
    run.parent[u] = top.from;
    run.parentEdge[u] = top.edge;
    rec.count('reads');
    if (top.edge >= 0) rec.markEdge(s.edges[top.edge].id, 'path');
    const F = top.from >= 0 ? s.names[top.from] : '';
    rec.compare(U, '=', 'new', `visit ${U}`, {
      probe,
      message:
        top.from < 0
          ? `Pop ${U} from the top of the stack and visit it. Its unvisited neighbours are pushed in reverse order, so the first in the alphabet ends up on top.`
          : top.from === last
            ? `Pop ${U}, which ${F} has just pushed, and visit it. The search goes one step deeper.`
            : lastPushed === 0
              ? `${s.names[last]} had nothing new to push, so the search backs up. Pop ${U}, which ${F} pushed earlier, and visit it.`
              : `The search backs up. Pop ${U}, which ${F} pushed earlier, and visit it.`,
    });
    last = u;
    lastPushed = 0;
    const links = s.adj[u];
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      const v = link.to;
      const V = s.names[v];
      const edge = s.edges[link.edge];
      rec.count('edges');
      checks++;
      rec.mark(nid(v), 'compare');
      rec.markEdge(edge.id, 'compare');
      if (!run.seen[v]) {
        run.frontier.push({ node: v, from: u, edge: link.edge, d: 0 });
        lastPushed++;
        rec.compare(V, '=', 'new', `not visited, push ${V}`, { probe });
        rec.markEdge(edge.id, 'idle');
      } else {
        rec.compare(V, '=', 'visited', `already visited, skip`, { probe });
        rec.markEdge(edge.id, run.parentEdge[u] === link.edge || run.parentEdge[v] === link.edge ? 'path' : 'dim');
      }
      rec.unmark(nid(v));
    }
    // Once every node has been visited, whatever is left on the stack is out of date.
    if (run.order.length === n) break;
  }
  run.done = true;
  if (rec.recording) {
    const left = run.frontier.length;
    rec.clearMarks();
    rec.step(
      `DFS order: ${list(s, run.order)}. It followed one route as deep as it could before coming back for the alternatives, ` +
        `at a cost of ${plural(run.order.length, 'node')} expanded and ${plural(checks, 'edge check')}` +
        (left ? `, and the ${plural(left, 'out-of-date entry', 'out-of-date entries')} left on the stack ${left === 1 ? 'is' : 'are'} thrown away.` : '.'),
    );
  }
  return run.order;
}

// ---- Dijkstra ----------------------------------------------------------------

const before = (a: Entry, b: Entry) => a.d < b.d || (a.d === b.d && a.node < b.node);

function heapPush(heap: Entry[], e: Entry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(e, heap[p])) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = e;
}

function heapPop(heap: Entry[]): Entry {
  const top = heap[0];
  const e = heap.pop()!;
  const n = heap.length;
  if (n > 0) {
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && before(heap[c + 1], heap[c])) c++;
      if (!before(heap[c], e)) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = e;
  }
  return top;
}

/**
 * Fewest-edge route from a to b, and the cheapest cost among routes that short.
 * Only used to compare against Dijkstra's answer in the last sentence, and in tests.
 */
export function fewestHops(s: GraphState, a: number, b: number): { hops: number; cost: number; path: number[] } {
  const n = s.names.length;
  const hops = new Array<number>(n).fill(-1);
  const cost = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const queue = [a];
  hops[a] = 0;
  cost[a] = 0;
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const link of s.adj[u]) {
      const v = link.to;
      if (hops[v] === -1) {
        hops[v] = hops[u] + 1;
        queue.push(v);
      }
      if (hops[v] === hops[u] + 1 && cost[u] + link.w < cost[v]) {
        cost[v] = cost[u] + link.w;
        prev[v] = u;
      }
    }
  }
  const path: number[] = [];
  if (hops[b] >= 0) for (let v = b; v !== -1; v = prev[v]) path.unshift(v);
  return { hops: hops[b], cost: cost[b], path };
}

/** Cheapest route from `from` to `to` by total weight. */
export function dijkstra(s: GraphState, from: number, to: number, rec: Rec): { path: number[]; cost: number } {
  const run = begin(s, 'dijkstra', from, to);
  const S = s.names[from];
  const T = s.names[to];
  run.dist[from] = 0;
  heapPush(run.frontier, { node: from, from: -1, edge: -1, d: 0 });
  rec.step(`Dijkstra from ${S} to ${T}: every node starts at distance ∞ except ${S}, which is 0. Put ${S} in the priority queue.`, {
    probe: { text: `${S} 0`, at: nid(from) },
  });
  let checks = 0;
  while (run.frontier.length) {
    const top = heapPop(run.frontier);
    const u = top.node;
    const U = s.names[u];
    const probe = { text: `${U} ${top.d}`, at: nid(u) };
    if (run.seen[u]) {
      rec.step(`Take ${U} ${top.d} from the priority queue. ${U} was already settled at ${run.dist[u]}, so this older entry is out of date and is discarded.`, { probe });
      continue;
    }
    run.seen[u] = true;
    run.order.push(u);
    rec.count('reads');
    if (u === to) {
      rec.step(
        u === from
          ? `Take ${U} 0 from the priority queue. ${U} is the target as well as the start, so there is nothing to search.`
          : `Take ${U} ${top.d}, the smallest entry. ${U} is the target and nothing still waiting is closer, so ${top.d} is final and the search can stop.`,
        { probe },
      );
      break;
    }
    rec.step(
      u === from
        ? `Take ${U} 0 from the priority queue. Now relax each edge out of ${U}: would going through ${U} give the neighbour a shorter distance?`
        : run.order.length === 2
          ? `Take ${U} ${top.d}, the smallest entry. No waiting node is closer and no weight is negative, so no cheaper route to ${U} can turn up: ${top.d} is final.`
          : `Take ${U} ${top.d}, the smallest entry, so ${top.d} is final for ${U}. Relax its edges.`,
      { probe },
    );
    for (const link of s.adj[u]) {
      const v = link.to;
      const V = s.names[v];
      const edge = s.edges[link.edge];
      const cand = top.d + link.w;
      const cur = run.dist[v];
      rec.count('edges');
      checks++;
      rec.mark(nid(v), 'compare');
      rec.markEdge(edge.id, 'compare');
      if (cand < cur) {
        const old = run.parentEdge[v];
        run.dist[v] = cand;
        run.parent[v] = u;
        run.parentEdge[v] = link.edge;
        heapPush(run.frontier, { node: v, from: u, edge: link.edge, d: cand });
        rec.compare(cand, '<', cur === Infinity ? '∞' : cur, `shorter, update`, {
          probe,
          message:
            cur === Infinity
              ? `Through ${U}, ${V} costs ${top.d} + ${link.w} = ${cand}. Shorter than ∞, so ${V} gets ${cand} and joins the queue.`
              : `Through ${U}, ${V} costs ${top.d} + ${link.w} = ${cand}. Shorter than ${cur}, so ${V} drops to ${cand}; the old entry ${V} ${cur} stays in the queue until it comes out.`,
        });
        if (old >= 0) rec.markEdge(s.edges[old].id, 'dim');
        rec.markEdge(edge.id, 'path');
      } else {
        rec.compare(cand, '≥', cur, `no better, skip`, {
          probe,
          message: `Through ${U}, ${V} would cost ${top.d} + ${link.w} = ${cand}. No better than ${cur}, skip.`,
        });
        rec.markEdge(edge.id, run.parentEdge[u] === link.edge ? 'path' : 'dim');
      }
      rec.unmark(nid(v));
    }
  }
  if (run.seen[to]) {
    for (let v = to; v !== -1; v = run.parent[v]) run.path.push(v);
    run.path.reverse();
    run.cost = run.dist[to];
  } else {
    run.cost = Infinity;
  }
  run.done = true;
  if (rec.recording) {
    rec.clearMarks();
    if (!run.path.length) {
      rec.step(`The priority queue is empty and ${T} was never reached. There is no route from ${S} to ${T}.`);
    } else {
      const edges = run.path.length - 1;
      const few = fewestHops(s, from, to);
      rec.step(
        `Shortest path: ${list(s, run.path, ' → ')}, total weight ${run.cost}, found by settling ${run.order.length} of ${s.names.length} nodes with ${plural(checks, 'relaxation check')}.` +
          (few.hops < edges
            ? ` It uses ${plural(edges, 'edge')}: the best route with only ${few.hops}, ${list(s, few.path, ' → ')}, costs ${few.cost}, so the fewest hops is not the cheapest.`
            : run.order.length < s.names.length
              ? ` The search stopped as soon as ${T} was settled, so the rest of the graph was never expanded.`
              : ''),
        { probe: { text: `${T} ${run.cost}`, at: nid(to) } },
      );
    }
  }
  return { path: run.path, cost: run.cost };
}

// ---- drawing -----------------------------------------------------------------

const R = 22;
const TRAY_Y = 290;
const FRONTIER_X = 175;
const ORDER_X = 537.5;

const ORDINALS = ['1st', '2nd', '3rd'];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

const FRONTIER_TITLE: Record<Algo, string> = {
  bfs: 'Queue: the left end comes out next',
  dfs: 'Stack: the right end comes out next',
  dijkstra: 'Priority queue: smallest distance (left) comes out next',
};

export function layout(s: GraphState): Scene {
  const run = s.run;
  const n = s.names.length;

  // Position of each node in the visit order, -1 if it has not been expanded.
  const rank = new Array<number>(n).fill(-1);
  const onPath = new Array<boolean>(n).fill(false);
  const treeEdge = new Array<boolean>(s.edges.length).fill(false);
  const pathEdge = new Array<boolean>(s.edges.length).fill(false);
  if (run) {
    run.order.forEach((v, i) => (rank[v] = i));
    for (let v = 0; v < n; v++) {
      // At rest, only edges into nodes that were really expanded count as part of the tree.
      if (run.parentEdge[v] >= 0 && (!run.done || rank[v] >= 0)) treeEdge[run.parentEdge[v]] = true;
    }
    for (const v of run.path) {
      onPath[v] = true;
      if (run.parentEdge[v] >= 0) pathEdge[run.parentEdge[v]] = true;
    }
  }

  const nodes: SceneNode[] = [];
  for (let i = 0; i < n; i++) {
    let sub: string | undefined;
    let tone: Tone | undefined;
    if (run) {
      if (run.algo === 'dijkstra') sub = run.dist[i] === Infinity ? '∞' : String(run.dist[i]);
      else if (run.algo === 'bfs') sub = !run.seen[i] ? undefined : run.dist[i] === 0 ? 'start' : run.dist[i] === 1 ? '1 hop' : `${run.dist[i]} hops`;
      else if (rank[i] >= 0) sub = ordinal(rank[i] + 1);
      if (onPath[i]) tone = 'ok';
      else if (rank[i] >= 0) tone = 'path';
    }
    nodes.push({ id: nid(i), x: POS[i][0], y: POS[i][1], shape: 'circle', r: R, cells: [{ text: s.names[i], sub }], tone });
  }

  const edges: SceneEdge[] = s.edges.map((e, i) => {
    let tone: Tone | undefined;
    if (pathEdge[i]) tone = 'ok';
    else if (treeEdge[i]) tone = 'path';
    else if (run?.done) tone = 'dim';
    return { id: e.id, from: nid(e.flip ? e.b : e.a), to: nid(e.flip ? e.a : e.b), kind: 'line', label: String(e.w), tone };
  });

  // The frontier: what is waiting, drawn in the order it will come out.
  let waiting: Cell[] = [];
  if (run) {
    if (run.algo === 'bfs') {
      for (let i = run.head; i < run.frontier.length; i++) waiting.push({ text: s.names[run.frontier[i].node] });
    } else if (run.algo === 'dfs') {
      waiting = run.frontier.map((e) => ({ text: s.names[e.node], tone: run.seen[e.node] ? 'dim' : undefined }));
    } else {
      waiting = run.frontier
        .slice()
        .sort((a, b) => a.d - b.d || a.node - b.node)
        .map((e) => ({ text: `${s.names[e.node]} ${e.d}`, tone: run.seen[e.node] ? 'dim' : undefined }));
    }
  }
  if (!waiting.length) waiting = [{ text: 'empty', tone: 'dim' }];
  nodes.push({
    id: FRONTIER,
    x: FRONTIER_X,
    y: TRAY_Y,
    cells: waiting,
    title: run ? FRONTIER_TITLE[run.algo] : 'Frontier: nodes found but not yet expanded',
  });

  // The visit order so far, in fixed slots so nothing shifts as it fills.
  const slots: Cell[] = [];
  for (let i = 0; i < n; i++) {
    if (run && i < run.order.length) {
      const v = run.order[i];
      const tone: Tone = !run.done ? 'path' : run.algo !== 'dijkstra' || onPath[v] ? 'ok' : 'path';
      slots.push({ text: s.names[v], tone });
    } else {
      slots.push({ text: '', tone: 'dim' });
    }
  }
  nodes.push({
    id: ORDER,
    x: ORDER_X,
    y: TRAY_Y,
    cells: slots,
    tone: run?.done && run.algo !== 'dijkstra' ? 'ok' : undefined,
    title: run?.algo === 'dijkstra' ? 'Settled, nearest first' : 'Visit order',
  });

  return { nodes, edges };
}

// ---- definition --------------------------------------------------------------

function lastResult(s: GraphState): string {
  const run = s.run;
  if (!run || !run.done) return 'None yet';
  if (run.algo === 'dijkstra') return run.path.length ? `${list(s, run.path, ' → ')}, cost ${run.cost}` : `No route from ${s.names[run.start]} to ${s.names[run.target]}`;
  return `${run.algo === 'bfs' ? 'BFS' : 'DFS'} from ${s.names[run.start]}: ${list(s, run.order, ' ')}`;
}

const randomNode = (s: GraphState) => s.names[randomInt(0, s.names.length - 1)];

/** Run a traversal op after checking its start node. */
function traverse(go: (s: GraphState, start: number, rec: Rec) => unknown) {
  return (s: GraphState, [arg]: (number | string)[], rec: Rec): void => {
    const start = nodeIndex(s, arg);
    if (start < 0) notANode(s, arg, rec);
    else go(s, start, rec);
  };
}

const def: StructureDef<GraphState> = {
  id: 'graph',
  create: () => create(),
  seed: [],
  ops: [
    {
      id: 'bfs',
      label: 'Breadth-first',
      intent: 'primary',
      args: [{ name: 'start', label: 'Start node', kind: 'word' }],
      run: traverse(bfs),
      suggest: (s) => [randomNode(s)],
    },
    {
      id: 'dfs',
      label: 'Depth-first',
      args: [{ name: 'start', label: 'Start node', kind: 'word' }],
      run: traverse(dfs),
      suggest: (s) => [randomNode(s)],
    },
    {
      id: 'dijkstra',
      label: 'Shortest path (Dijkstra)',
      args: [
        { name: 'from', label: 'From', kind: 'word' },
        { name: 'to', label: 'To', kind: 'word' },
      ],
      run: (s, [a, b], rec) => {
        const from = nodeIndex(s, a);
        const to = nodeIndex(s, b);
        if (from < 0) notANode(s, a, rec);
        else if (to < 0) notANode(s, b, rec);
        else dijkstra(s, from, to, rec);
      },
      suggest: (s) => {
        const from = randomInt(0, s.names.length - 1);
        // Any other node: step round the alphabet by 1 to n - 1 places.
        const to = (from + randomInt(1, s.names.length - 1)) % s.names.length;
        return [s.names[from], s.names[to]];
      },
    },
  ],
  layout,
  counters: [
    { key: 'comparisons', label: 'Comparisons' },
    { key: 'reads', label: 'Nodes expanded' },
    { key: 'edges', label: 'Edges examined' },
  ],
  status: (s) => [
    { label: 'Nodes', value: String(s.names.length) },
    { label: 'Edges', value: String(s.edges.length) },
    { label: 'Last result', value: lastResult(s) },
  ],
  // Same start for both traversals so the visit orders can be compared. The short Dijkstra run shows a
  // distance being improved and the early stop; the long one shows that the fewest hops is not the cheapest.
  tour: [
    ['bfs', 'A'],
    ['dfs', 'A'],
    ['dijkstra', 'A', 'D'],
    ['dijkstra', 'A', 'H'],
  ],
  info,
};

export default def;
