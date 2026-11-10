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
  /** Where it sits on the diagram: centre x and y in a 1120 by 590 space. */
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

export const MODES: { id: Mode; label: string; note: string }[] = [
  { id: 'local', label: 'In-process call', note: 'Same machine, no network. Cannot be lost, cannot be slow.' },
  { id: 'call', label: 'Network call', note: 'Request and reply. The caller waits, so it needs a timeout.' },
  { id: 'async', label: 'Message log', note: 'Asynchronous. The sender does not wait and the reader sets its own pace.' },
  { id: 'write', label: 'Storage write', note: 'Durable once acknowledged. Written so that doing it twice is harmless.' },
  { id: 'external', label: 'Public internet', note: "Someone else's server. No guarantees at all." },
];

export interface Flow {
  id: string;
  from: string;
  to: string;
  /** What travels: the purpose of the hop. */
  label?: string;
  /** SVG path data in diagram space. Drawn as given; the token travels along it. */
  d: string;
  /** Where the purpose label sits. */
  lx?: number;
  ly?: number;
  mode: Mode;
  /** The method, in a few words: "in-process", "Kafka", "HTTPS". Drawn on the line as a chip. */
  via: string;
  /** Where along the path the chip sits, 0 to 1. Leave out to hide the chip on a very short hop. */
  chip?: number;
  /** One or two sentences: the call or message, and what it carries. */
  how: string;
  /** What is promised about delivery, and what makes that safe. */
  delivery: string;
  /** Other ways these two could talk. */
  alts: string[];
}

export interface TourStep {
  title: string;
  text: string;
  /** Components lit for this step. */
  focus: string[];
  /** Flows the URL travels along, in order. Prefix an id with "<" to travel it backwards. */
  path: string[];
  /** What the token is carrying at this point. */
  token?: string;
}

export interface Design {
  id: string;
  name: string;
  blurb: string;
  /** Dashed outline around the components that make up one node. */
  frame: { x: number; y: number; w: number; h: number; label: string };
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
  glossary: { term: string; also?: string[]; text: string; where?: string }[];
}
