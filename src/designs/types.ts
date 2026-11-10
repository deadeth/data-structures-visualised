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
  /** Drives the box style: part of a crawler node, a shared service, a store, or outside the system. */
  kind: 'node' | 'shared' | 'store' | 'outside' | 'input';
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

export interface Flow {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** SVG path data in diagram space. Drawn as given; the token travels along it. */
  d: string;
  /** Where the label sits. */
  lx?: number;
  ly?: number;
  dashed?: boolean;
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
}
