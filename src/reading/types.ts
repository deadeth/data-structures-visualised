/**
 * Reading pages: prose with diagrams, for reading rather than watching.
 *
 * Two uses share this format:
 * - concept pages (`#/c/<id>`): one system design pattern, such as consistency or sharding,
 *   linking out to the animated pages that show its mechanisms;
 * - design walkthroughs (`#/d/<design id>/read`): a design page told as a story, with
 *   snapshots of that design's own diagram.
 *
 * Inline markup inside any string that is shown as text: **bold**, `code`, and links
 * written [label](#/s/<structure id>), [label](#/d/<design id>) or [label](#/c/<concept id>).
 * Nothing else is parsed. Keep paragraphs to a few short sentences.
 */

/** Colours carry the site's meanings and nothing else (ADR 0003). */
export type Tone =
  | 'follow' // magenta: the one thing the reader is following
  | 'compare' // amber: being compared or checked
  | 'visited' // blue: visited, read, passed through
  | 'ok' // green: found, written, committed, healthy
  | 'bad' // red dashed: removed, rejected, failed, lost
  | 'muted'; // grey: present but not the point

/** A box in a diagram. Coordinates are the box's top-left corner, in diagram units. */
export interface DiagramNode {
  id: string;
  label: string;
  /** One short second line, such as "Postgres" or "eu-west-1". */
  sub?: string;
  x: number;
  y: number;
  /** Defaults: 140 wide, 56 tall. */
  w?: number;
  h?: number;
  /** box: a service; store: a database or disk; queue: a queue or log; client: a user or caller; note: a small free-standing label. */
  kind?: 'box' | 'store' | 'queue' | 'client' | 'note';
  tone?: Tone;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** A few words, drawn at the middle of the line. */
  label?: string;
  /** Dashed: asynchronous, optional or failed. */
  dashed?: boolean;
  /** Arrow heads at both ends. */
  both?: boolean;
  tone?: Tone;
}

/** A labelled area drawn behind nodes, such as a region, a shard or a team. */
export interface DiagramGroup {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: Tone;
}

/**
 * A boxes-and-arrows picture. Keep it at most 640 wide and 420 tall, labels short (about
 * 18 characters a line), and prefer tall layouts to wide ones: on a phone the diagram
 * shrinks to fit or scrolls sideways.
 */
export interface Diagram {
  w: number;
  h: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
}

/** A message sequence chart: actors across the top, messages down the page in time order. */
export interface Sequence {
  /** At most 5 actors. */
  actors: string[];
  messages: {
    from: string;
    to: string;
    label: string;
    tone?: Tone;
    dashed?: boolean;
    /** A note written beside this point in time, such as "network partition here". */
    note?: string;
  }[];
}

export type Block =
  | { p: string }
  /** A subheading inside a section. */
  | { h: string }
  | { list: string[]; ordered?: boolean }
  /** interview: what to say; pitfall: a common mistake; rule: a rule of thumb; example: a worked case. */
  | { callout: string; kind: 'interview' | 'pitfall' | 'rule' | 'example'; title?: string }
  | { table: { head: string[]; rows: string[][] }; caption?: string }
  | { code: string; lang: 'sql' | 'json' | 'text' | 'python' | 'java' | 'http'; title?: string }
  | { diagram: Diagram; caption: string }
  | { sequence: Sequence; caption: string }
  /**
   * A snapshot of a design page's own diagram (walkthroughs): the named components and
   * flows lit, the rest dimmed. Ids are those in `src/designs/<design>.ts`.
   */
  | { design: { id: string; lit: string[]; flows?: string[] }; caption: string }
  /** Links to animated pages that show a mechanism step by step. */
  | { see: { href: string; label: string; why: string }[] };

export interface Section {
  /** Used in the address (`#/c/<page>/<section>`) and the contents list. */
  id: string;
  title: string;
  blocks: Block[];
}

export interface Reading {
  id: string;
  title: string;
  /** One or two sentences under the title, also used by search and the sidebar. */
  summary: string;
  /** Reading time, roughly words / 200. */
  minutes: number;
  sections: Section[];
  /** Facts the writer could not check against a source (product defaults, version numbers). Shown at the foot of the page. */
  unverified?: string[];
}

/** A concept page, listed in the sidebar under its group. */
export interface Concept extends Reading {
  group: 'Data' | 'Messaging' | 'Reliability' | 'Interview craft';
}
