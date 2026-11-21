/**
 * Pairing practice pages (`#/p/<id>`): one small coding task of the kind set in a
 * pair-programming interview, built a stage at a time in Java.
 *
 * A page is a folder, `src/practice/<id>/`:
 *
 *   page.ts                      the words: a default export of type Practice
 *   starter/Solution.java        what the reader pastes into an online editor: supplied
 *                                code, empty stubs and every stage's tests
 *   solution/s<n>/Solution.java  the whole file as it stands once stage n is done
 *
 * Every Java file is one real program: `public class Solution` with a `main` that runs
 * the tests up to its `STAGE` constant and prints PASS or FAIL lines. The supplied code
 * and the tests are the same text in every file of a page; only `STAGE` and the reader's
 * own code differ. `scripts/practice/check.mjs` compiles and runs them all on a JDK.
 * See docs/briefs/practice-code.md and docs/briefs/practice-page.md.
 *
 * Inline markup inside any string shown as text: **bold**, `code`, and links written
 * [label](#/s/<structure id>), [label](#/c/<concept id>), [label](#/d/<design id>) or
 * [label](#/p/<practice id>). Nothing else is parsed. Pseudocode strings are shown as
 * written, in a fixed-width face: keep their lines to 64 characters.
 */

/** A worked example as a table: one row per event, the state after it in the columns. */
export interface Trace {
  /** What to notice, not just what it is. */
  caption: string;
  head: string[];
  rows: string[][];
  /** One line under the table, such as which test this run matches. */
  note?: string;
}

/**
 * One stage of the task: a requirement, the code that meets it, and the one decision it
 * turns on. On the page a stage has five things and no more: what is asked and its tests,
 * the code, the design choice, a traced run, and the pitfalls.
 *
 * A stage up to the page's `core` is a core stage, shown in full. A later stage is a
 * stretch: it opens with a spoken answer (`verbal`) and keeps the rest folded away. A
 * stage marked `variant` is another framing of the same task; it is shown last, folded.
 */
export interface Part {
  /** Used in the address (`#/p/<page>/<part>`) and the contents list. Never renamed. */
  id: string;
  title: string;
  /** 1 for the first stage. Stages run 1, 2, 3 with no gaps, one part each. */
  stage: number;
  /** The requirement in the interviewer's words, as it would be said in the room. */
  ask: string;
  /** The tests this stage adds, by the exact names the harness prints. */
  tests: string[];
  /**
   * Regions of `solution/s<stage>/Solution.java` that this stage adds or changes, in
   * reading order. A region is marked `// region name` ... `// endregion` in that file.
   */
  regions: string[];
  /** This stage's logic in plain steps. No Java syntax. Shown folded under the code. */
  pseudocode: string;
  /**
   * The one decision this stage turns on and why it goes this way: a single short
   * paragraph, at most 110 words. Name the idiom or the boundary where it matters.
   */
  choice: string;
  /** One sentence to say aloud while writing this stage. Shown under the choice. */
  say: string;
  /** A small picture in plain characters, shown before the code. Lines of at most 64. */
  sketch?: { caption: string; text: string };
  /** A run of this stage's code, taken from the real program's output. */
  trace: Trace;
  /** The mistakes this stage invites: two to four plain sentences. */
  pitfalls: string[];
  /**
   * For a stretch stage: the answer to give aloud if there is no time to code it, as
   * exactly three short sentences. For a variant: the one or two sentences to take away.
   * Not used on core stages.
   */
  verbal?: string[];
  /** Another framing of the same task, not a next step. Shown last on the page, folded. */
  variant?: boolean;
  /** One line of warning that belongs with this stage, such as what its tests cannot show. */
  caveat?: string;
}

export interface Practice {
  /** The folder name. */
  id: string;
  title: string;
  /** One sentence under the title: what to build. Also used by search, the sidebar and the home page. */
  summary: string;
  /** A fair time, in minutes, to reach `core` with its tests passing. */
  minutes: number;
  /** The stage that counts as "done" in a timed session. Later stages are stretches. */
  core: number;
  /**
   * What the task is testing: one or two sentences, then exactly three points, each a
   * plain sentence (not a bold term and an explanation).
   */
  testing: { intro: string; points: string[] };
  /** How to use the page: one or two sentences on what to drill and what only to talk through. */
  use: string;
  /** The task as it would be given at the start, in a few short paragraphs. */
  brief: string[];
  /** What the starter file already contains, so the reader knows what not to write. At most five short items. */
  given: string[];
  /** Five or six questions to ask before writing code. `assume` is what to say you will assume if nobody answers. */
  ask: { q: string; why: string; assume: string }[];
  /** The whole solution in plain steps, at most about 25 lines. Shown folded. */
  outline: string;
  parts: Part[];
  /**
   * The last ten minutes: what an interviewer asks once the code works, and what the
   * solution leaves out compared with production code, as one list. Each answer is two
   * or three sentences, short enough to say.
   */
  followUps: { q: string; a: string }[];
  /** Other pages on this site that show the mechanism. One line of links at the foot. */
  see: { href: string; label: string }[];
  /**
   * Facts the writer could not check against a source. Kept here for whoever maintains
   * the page; not shown to the reader.
   */
  unverified?: string[];
}

/** A block of the guide page (`#/p`). */
export type GuideBlock =
  | { p: string }
  | { list: string[]; ordered?: boolean }
  | { table: { head: string[]; rows: string[][] }; caption?: string }
  | { callout: string; title?: string };

/** The section's own front page: how to use the practice pages. One file, `src/practice/guide.ts`. */
export interface Guide {
  title: string;
  summary: string;
  sections: { id: string; title: string; blocks: GuideBlock[] }[];
  /** The order the pages are listed in, by id. Pages not named come after, by title. */
  order: string[];
}
