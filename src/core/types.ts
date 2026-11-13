/**
 * The contract between a data structure and the player.
 *
 * A structure never draws anything. It mutates its own state and, at each
 * interesting moment, asks the Recorder for a snapshot. A snapshot is a Frame:
 * a complete Scene plus the narration, the comparison being made and the
 * running counters. Because every frame is complete, the player can step
 * backwards, scrub and change speed without re-running any logic.
 */
import type { Source } from './code';

/**
 * Colour meaning, shared by every structure. Keep to these meanings:
 * - idle:    nothing happening
 * - path:    visited on the way to the answer
 * - compare: being compared with the key right now
 * - ok:      found, inserted, kept
 * - bad:     removed, evicted, missed
 * - key:     this cell holds the key being followed (magenta is reserved for it)
 * - dim:     ruled out, not relevant to this step
 */
export type Tone = 'idle' | 'path' | 'compare' | 'ok' | 'bad' | 'key' | 'dim';

export interface Cell {
  text: string;
  tone?: Tone;
  /** Small label under the cell, e.g. an array index. */
  sub?: string;
  /**
   * Set when the label under the cell is data the reader should track (a
   * distance so far), not furniture such as an index. It is then drawn in the
   * mono face at full weight.
   */
  subValue?: boolean;
  /** Fixed width in px. Leave unset to size from the text. */
  w?: number;
}

export interface SceneNode {
  /** Stable identity. The renderer animates a node between frames by id. */
  id: string;
  /** Centre of the node, in scene units (px at 1x zoom). */
  x: number;
  y: number;
  /** One cell for a simple node, several for an array-like node. */
  cells: Cell[];
  /**
   * `tag` is a named pointer (top, head, tail, lo, hi): a small white label
   * with an outline, drawn the same way on every page. It never takes a tone or
   * a hue. Its one cell holds the name.
   */
  shape?: 'box' | 'circle' | 'tag';
  /** Outline tone for the whole node. */
  tone?: Tone;
  /** Categorical tint 0-5 for grouping (an owner, a level). Not a state. */
  hue?: number;
  /**
   * The node's own colour where the colour is the data: the red and black of a red-black tree. Drawn as a solid fill
   * with white text, and kept under any tone (a tone then shows as the outline only), so it is never mistaken for the
   * pale, dashed red of `bad`. Use it for nothing else.
   */
  ink?: 'red' | 'black';
  /** Small text above the node. */
  title?: string;
  /** Small text below the node. A newline breaks it onto a second line. */
  caption?: string;
  /** If the node is new this frame, it grows out of this node's position. */
  from?: string;
  /** Radius for circles. Defaults to fit the text. */
  r?: number;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  /**
   * - tree: bottom of `from` to top of `to`
   * - side: facing vertical sides, for lists and chains
   * - line: centre to centre, clipped to the node outlines (graphs)
   */
  kind?: 'tree' | 'side' | 'line';
  /** For tree edges out of a multi-cell node: leave from the boundary before this cell index (0..cells.length). */
  fromSlot?: number;
  /** Leave from the centre of this cell instead of the node centre. */
  fromCell?: number;
  /** Arrive at the centre of this cell instead of the node centre. */
  toCell?: number;
  tone?: Tone;
  dashed?: boolean;
  arrow?: boolean;
  label?: string;
  /** Shift the edge sideways (px) so two edges between the same nodes do not overlap. */
  offset?: number;
}

export type Decor =
  | { id: string; type: 'ring'; cx: number; cy: number; r: number }
  /** A label. A newline breaks it: the lines are stacked downwards from y. */
  | { id: string; type: 'label'; x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end'; strong?: boolean }
  | { id: string; type: 'band'; x: number; y: number; w: number; h: number; label?: string };

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Static furniture: lane backgrounds, a ring, row labels. */
  decor?: Decor[];
}

/** The key being followed. Drawn as a magenta chip that travels to wherever it is being compared. */
export interface Probe {
  text: string;
  /** Node id the chip sits next to. */
  at: string;
  /** Cell within that node. */
  cell?: number;
  place?: 'above' | 'below' | 'left' | 'right';
}

export interface Compare {
  left: string | number;
  op: '<' | '>' | '=' | '≤' | '≥' | '≠';
  right: string | number;
  /** What the result means for the next move, e.g. "go left". */
  verdict: string;
}

export interface Frame {
  scene: Scene;
  /** One or two plain sentences: what is happening and why. */
  message: string;
  probe?: Probe;
  compare?: Compare;
  /** Running totals at this frame. */
  counters: Record<string, number>;
  /** Anchors in the example code that this step is executing. See src/core/code.ts. */
  lines?: string[];
  /** The listing's variables at this step, in the order to show them: name and value as text. See `Rec.vars`. */
  vars?: [string, string][];
}

/** A value a listing's variable can hold, as the page shows it. */
export type VarValue = string | number | boolean | null | undefined | (string | number | null)[];

export interface ArgDef {
  name: string;
  label: string;
  /**
   * 'int' is one whole number and 'word' one short word. 'ints' is a list of whole numbers typed with spaces or commas
   * ("5 2 9 1"); `run` receives it as a string of the numbers joined by single spaces. For 'ints', `min` and `max` bound each
   * number (0 to 999 unless given) and `maxItems` bounds how many (16 unless given).
   */
  kind: 'int' | 'word' | 'ints';
  min?: number;
  max?: number;
  maxItems?: number;
}

/** Minimal recorder surface that operations use. See recorder.ts. */
export interface Rec {
  readonly recording: boolean;
  step(message: string, extra?: { probe?: Probe; compare?: Compare }): void;
  compare(left: string | number, op: Compare['op'], right: string | number, verdict: string, extra?: { probe?: Probe; message?: string }): void;
  count(counter: string, by?: number): void;
  /**
   * Name the code anchors the next frames belong to. Sticky: it applies to
   * every frame recorded from now until it is called again. Call it with no
   * arguments to clear it.
   */
  line(...anchors: string[]): void;
  /**
   * Say what the listing's variables hold now, for the "Variables" strip beside the code. Sticky, like `line`: the
   * values apply to every frame from now until the next call. Each call replaces the whole set, so pass every variable
   * that is in scope at that point, named as the listing names them (`lo`, `mid`, `a[mid]`), in the order to show them.
   * A value of `undefined` leaves that name out. Call it with no arguments to clear the strip (a new call, a helper
   * returning). Costs nothing with recording off.
   */
  vars(values?: Record<string, VarValue>): void;
  mark(nodeId: string, tone: Tone): void;
  markCell(nodeId: string, cell: number, tone: Tone): void;
  markEdge(edgeId: string, tone: Tone): void;
  unmark(nodeId: string): void;
  clearMarks(): void;
}

export interface OpDef<S> {
  id: string;
  label: string;
  args: ArgDef[];
  /** Mutate state and narrate through rec. Must also work when rec.recording is false. */
  run(state: S, args: (number | string)[], rec: Rec): void;
  /** Suggest arguments that make an interesting run from the current state. */
  suggest?(state: S): (number | string)[];
  /** Visual weight of the button. */
  intent?: 'primary' | 'neutral' | 'danger';
  /** Regions of the structure's source files to show beside this operation, in order. */
  code?: string[];
}

export interface ParamDef {
  id: string;
  label: string;
  options: { value: number; label: string }[];
  default: number;
}

export interface ComplexityRow {
  op: string;
  average: string;
  worst: string;
  note?: string;
}

export interface Info {
  /** Two or three sentences: what it is and the one idea that makes it work. */
  summary: string;
  /** What to look for while the animation runs. */
  watch: string[];
  complexity: ComplexityRow[];
  space: string;
  /** Real systems and what they use it for. */
  usedIn: { name: string; how: string }[];
  /** Situations where this is the right pick. */
  reachFor: string[];
  /** What it costs you, and when to pick something else. */
  costs: string[];
  /** Things worth saying out loud in a systems design interview. */
  interview: string[];
}

export interface StructureDef<S = any> {
  id: string;
  /** Tunables that rebuild the structure when changed (node order, capacity). */
  params?: ParamDef[];
  create(params: Record<string, number>): S;
  /** Starting contents, as [opId, ...args]. Applied without animation. */
  seed: [string, ...(number | string)[]][];
  /**
   * Optional: the seed for other parameter values, when `seed` would not suit
   * them (a partition that does not exist, a structure too small to hold it).
   * The page uses it in place of `seed` when it is there.
   */
  seedFor?: (params: Record<string, number>) => [string, ...(number | string)[]][];
  ops: OpDef<S>[];
  layout(state: S): Scene;
  /** Counters to display, in order. `comparisons` should come first when used. */
  counters: { key: string; label: string }[];
  /** Live facts about the structure: size, height, load factor. */
  status?(state: S): { label: string; value: string }[];
  /** A short scripted tour, as [opId, ...args]. Used by "Play the tour" and by screenshots. */
  tour: [string, ...(number | string)[]][];
  /** Add several keys at once without animation. Returns [opId, ...args]. */
  fill?(state: S): [string, ...(number | string)[]];
  /** Op ids the head-to-head page can drive with integer keys. */
  bench?: {
    insert: string;
    search: string;
    /** Run more than once with different params, e.g. a narrow and a wide node. */
    variants?: { label: string; params: Record<string, number> }[];
  };
  /** Example implementations, one real file per language, marked up as described in src/core/code.ts. */
  source?: Source;
  info: Info;
}
