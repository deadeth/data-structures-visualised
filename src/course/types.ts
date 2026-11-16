/**
 * The course: a study plan for system design interviews, from fundamentals to full mock
 * designs, built mostly from the site's own pages. Rendered at `#/course` with progress
 * kept in the reader's browser.
 *
 * Inline markup in any text: **bold**, `code`, and links [label](#/...) to site pages.
 */

export interface Course {
  title: string;
  /** Two or three sentences: what the course is for and how to use it. */
  summary: string;
  /** How to study: a few short paragraphs (spacing, saying answers out loud, timing yourself). */
  howTo: string[];
  modules: Module[];
}

export interface Module {
  /** Stable: progress is stored against it. Never rename once published. */
  id: string;
  title: string;
  /** Why this module matters in an interview, in two or three sentences. */
  why: string;
  /** Rough total study time in minutes. */
  minutes: number;
  items: Item[];
  /** Self-test questions to answer out loud, without notes, before ticking the module off. */
  checkpoint: string[];
}

export interface Item {
  /** Stable within the module: progress is stored against `<module id>/<item id>`. */
  id: string;
  /**
   * read: a reading page or notes; watch: an animated page to step through;
   * practise: a design prompt to answer against the clock; drill: a short exercise (numbers, a sketch, a 2-minute explanation).
   */
  kind: 'read' | 'watch' | 'practise' | 'drill';
  title: string;
  /** A site address such as `#/c/caching`, `#/s/raft`, `#/d/ledger`, `#/d/web-crawler/read`, `#/d/ledger/rehearse`. Omit when the site has no page for it. */
  href?: string;
  minutes: number;
  /** One or two sentences: what to get out of it, or what to do. */
  note: string;
  /** For practise items: what a strong answer covers, as short points. */
  covers?: string[];
}
