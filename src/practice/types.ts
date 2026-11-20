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

/** One stage of the task: a requirement, the code that meets it, and why it is written that way. */
export interface Part {
  /** Used in the address (`#/p/<page>/<part>`) and the contents list. */
  id: string;
  title: string;
  /** 1 for the first stage. Stages run 1, 2, 3 with no gaps, one part each. */
  stage: number;
  /** The requirement in the interviewer's words, as it would be said in the room. */
  ask: string;
  /** The tests this stage adds, by the exact names the harness prints. */
  tests: string[];
  /** This stage's logic in plain steps. No Java syntax. */
  pseudocode: string;
  /**
   * Regions of `solution/s<stage>/Solution.java` that this stage adds or changes, in
   * reading order. A region is marked `// region name` ... `// endregion` in that file.
   */
  regions: string[];
  /** Why it is written this way: a few short paragraphs. */
  explain: string[];
  /** Notes on single lines. `code` is an exact fragment of one line in the regions shown. */
  lines?: { code: string; note: string }[];
  /** A run of this stage's code, taken from the real program's output. */
  trace: Trace;
  /** One or two sentences to say aloud while writing this stage. */
  say: string;
  /** The mistakes this stage invites. Plain sentences. */
  pitfalls: string[];
}

export interface Practice {
  /** The folder name. */
  id: string;
  title: string;
  /** One or two sentences under the title, also used by search, the sidebar and the home page. */
  summary: string;
  /** A fair time, in minutes, to reach `core` with its tests passing. */
  minutes: number;
  /** The stage that counts as "done" in a timed session. Later stages are extensions. */
  core: number;
  /** The task as it would be given at the start, in a few short paragraphs. */
  brief: string[];
  /** What the starter file already contains, so the reader knows what not to write. */
  given: string[];
  /** Questions to ask before writing code. `assume` is what to say you will assume if nobody answers. */
  ask: { q: string; why: string; assume: string }[];
  /** The whole solution in plain steps, at most about 25 lines. */
  outline: string;
  parts: Part[];
  /** What an interviewer asks next, with an answer short enough to say. */
  followUps: { q: string; a: string[] }[];
  /** How people lose time on this task. Plain sentences. */
  mistakes: string[];
  /** Other pages on this site that show the mechanism. */
  see: { href: string; label: string; why: string }[];
  /** What this page leaves out or makes simpler than production code. */
  simplified: string[];
  /** Facts the writer could not check against a source. Shown at the foot of the page. */
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
