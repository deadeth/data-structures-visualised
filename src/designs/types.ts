/** A system design drawn as boxes and flows, with a guided tour through it. */

export interface Alternative {
  name: string;
  /** True for the option this design uses. */
  chosen?: boolean;
  /** When it is the right pick, or what it gives you. */
  good: string;
  /** What it costs, or why this design passes on it. */
  cost: string;
}

export interface Component {
  id: string;
  name: string;
  /** Short technology line drawn under the name. */
  tech: string;
  /** A shorter name for the box on the diagram, when the full name does not fit. */
  short?: string;
  /** Where it sits on the diagram: centre x and y in the design's `size` space. */
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Drives the box style: part of a crawler node, a shared service, a store, a message log, or outside the system. */
  kind: 'node' | 'shared' | 'store' | 'queue' | 'outside' | 'input';
  /** Extra lines drawn inside a large box. */
  lines?: string[];
  what: string;
  why: string;
  numbers?: string[];
  fails: string;
  alternatives: Alternative[];
  say: string;
  /** Structure pages on this site that show the data structure inside this component. */
  see?: { id: string; label: string }[];
}

/** How two components talk. Each mode has its own line style and chip, explained in the legend. */
export type Mode = 'local' | 'call' | 'async' | 'write' | 'external';

/** The one rule for in-process chips, as the key states it. It holds on the diagram, on the tour and in the detail. */
export const LOCAL_RULE = 'In-process call: thin line; its chip shows when the line is live or selected.';

export const MODES: { id: Mode; label: string; about: string; note: string }[] = [
  { id: 'local', label: 'In-process call', about: 'About in-process calls', note: 'Same machine, no network. Cannot be lost, cannot be slow. Drawn as a thin line; its chip shows when the line is live or selected.' },
  { id: 'call', label: 'Network call', about: 'About network calls', note: 'Request and reply. The caller waits, so it needs a timeout.' },
  { id: 'async', label: 'Message log', about: 'About message logs', note: 'Asynchronous. The sender does not wait and the reader sets its own pace.' },
  { id: 'write', label: 'Storage write', about: 'About storage writes', note: 'Durable once acknowledged. Written so that doing it twice is harmless.' },
  { id: 'external', label: 'Public internet', about: 'About the public internet', note: "Someone else's server. No guarantees at all." },
];

/** The answer that comes back on the same line, when one line carries a request and its reply. */
export interface Reply {
  /** Its own id, so a link or a tour step can name this direction. */
  id: string;
  /** What travels back. */
  label: string;
  how: string;
  delivery: string;
  /** How the reply travels, when it differs from the line's own method: a read back over a line drawn as a write. */
  via?: string;
  /** Its kind, when it differs from the line's own (a read is a call). */
  mode?: Mode;
}

export interface Flow {
  id: string;
  from: string;
  to: string;
  /** What travels: the purpose of the hop. */
  label?: string;
  /** What travels, in full, for the detail's "What travels" when the short label on the diagram is too terse. */
  travels?: string;
  /** SVG path data in diagram space. Drawn as given; the token travels along it. */
  d: string;
  /**
   * Where the purpose label sits, pinned to the chip: above or below it on a
   * line that runs across, left or right of it on a line that runs up and down.
   */
  at?: 'above' | 'below' | 'left' | 'right';
  mode: Mode;
  /** The method, in a few words: "in-process", "Kafka", "HTTPS". Drawn on the line as a chip. */
  via: string;
  /**
   * Where along the path the chip sits, 0 to 1. Every connection has a chip, so every one can be opened from the
   * keyboard; an in-process chip is only drawn while the line is live or selected (open, pointed at or focused).
   */
  chip?: number;
  /**
   * The height the chip's centre sits at, in diagram units: the point on the path at this height nearest `chip`.
   * Lets the chips on neighbouring lines be staggered to exact heights.
   */
  chipY?: number;
  /** Off the hot path: used for recovery or reprocessing, not on every fetch. Hidden until asked for. */
  cold?: boolean;
  /** The reply on the same line: one two-way line, with an arrowhead at each end. */
  reply?: Reply;
  /** One or two sentences: the call or message, and what it carries. */
  how: string;
  /** What is promised about delivery, and what makes that safe. */
  delivery: string;
  /** Other ways these two could talk. */
  alts: string[];
}

/** Which side of its line the token's label sits on, for a leg where the place worked out from the diagram reads poorly. */
export type PillSide = 'above' | 'below' | 'left' | 'right';

export interface TourStep {
  title: string;
  text: string;
  /** Components lit for this step. */
  focus: string[];
  /** Flows the URL travels along, in order. Prefix an id with "<" to travel it backwards; a reply's id travels its line backwards. */
  path: string[];
  /** What the token is carrying on each leg of `path`, in order. A missing entry repeats the one before. */
  labels: string[];
  /** Where the token's label sits on each leg of `path`, when set by hand; otherwise it is worked out once from the leg's whole path. */
  pill?: (PillSide | undefined)[];
  /** A side trip that leaves from where the main path ends: a second token travels it, so the reader sees the split. */
  branch?: { path: string[]; label: string; pill?: PillSide };
  /** Connections that fail on this step (a lease that expires, a call that is refused): drawn red and dashed. */
  failed?: string[];
  /** Show the recovery and reprocessing paths for this step, whatever the key's toggle says. */
  recovery?: boolean;
}

export interface Design {
  id: string;
  name: string;
  blurb: string;
  /** What the readout says before the tour starts: how to use the diagram, not a repeat of the blurb. */
  rest: string;
  /** The same, for a touch screen, where there are no keys to mention. */
  restTouch: string;
  /** The diagram's coordinate space. */
  size: { w: number; h: number };
  /** Dashed rectangle around the components that make up one node. Its label sits inside the top-left corner, its note inside the top-right. */
  frame: { x: number; y: number; w: number; h: number; label: string; note?: string };
  components: Component[];
  flows: Flow[];
  tour: TourStep[];
  brief: { heading: string; points: string[] }[];
  numbers: { what: string; assumption: string; result: string }[];
  framings: { name: string; scale: string; shape: string }[];
  decisions: { choice: string; a: string; b: string; call: string }[];
  drills: { name: string; what: string }[];
  interview: string[];
  sources: { label: string; href?: string; note: string }[];
  /** Terms worth being able to look up. `where` is the component the term belongs to. */
  glossary: { term: string; also?: string[]; text: string; where?: string; see?: { id: string; label: string } }[];
}
