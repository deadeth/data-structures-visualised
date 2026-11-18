/**
 * A design's test: questions answered one at a time, each explained once it is submitted.
 * One file per design, `src/designs/quiz/<design id>.ts`, exporting `quiz`. Shown at `#/d/<id>/test`.
 */
export interface Quiz {
  /** The design's id, the same as the file's name. */
  design: string;
  /** One or two sentences under the title: what the test covers and how long it takes. */
  intro: string;
  questions: Question[];
}

export type Question = Choice | Sum;

interface QuestionBase {
  /** Stable and kebab-case. Answers are stored against it: never rename one. */
  id: string;
  /** The part of the interview it belongs to, in the reader's words: "Ask first", "The sums", "The small design"... Questions with one stage are scored together. */
  stage: string;
  /** The question, as an interviewer would say it or as a situation to decide. */
  q: string;
  /** Shown once the answer is submitted, right or wrong: why the right answer is right, in two to four short sentences. */
  why: string;
  /** How to say it in the interview, in one sentence, in the first person. */
  say?: string;
  /** Where on the site the fact is, as an address: `#/d/web-crawler/t/6`, `#/s/bloom-filter`. */
  from: string;
}

/** Pick one answer, or, with `many`, every answer that is right. */
export interface Choice extends QuestionBase {
  kind: 'one' | 'many';
  /** Three to five. `one` has exactly one right; `many` has two or more. */
  options: Option[];
}

export interface Option {
  text: string;
  right?: boolean;
  /** For a wrong option: why it is wrong, in one sentence, shown if it was picked. For a right option under `many`: shown if it was missed. */
  why?: string;
}

/** Work a number out and type it in. */
export interface Sum extends QuestionBase {
  kind: 'number';
  answer: number;
  /** What follows the box: "days", "GB", "a second". */
  unit: string;
  /** How far off still counts as right, as a fraction of the answer: 0.05 accepts 11 to 12.2 for 11.6. */
  within: number;
  /** The working, line by line, shown after submitting. */
  working: string[];
}
