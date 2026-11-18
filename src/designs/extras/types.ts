/**
 * Interview extras for one design, kept apart from the diagram data so they can be written and
 * checked on their own: how to lead the work, the likely pushes, and a timed rehearsal.
 */
export interface Extras {
  /** The first two minutes, as you would say them: scope, the one hard problem, the shape of the answer. */
  opening: string[];
  /** Questions an interviewer is likely to push on, each with the points of a good answer. */
  pushes: { q: string; a: string[] }[];
  /** How you would deliver and run it: the engineering-leader view. */
  lead: {
    /** What ships in what order, and why that order. */
    phases: { name: string; ships: string; why: string }[];
    /** Getting from the system that exists today to this one without downtime or lost money. */
    migration: string[];
    /** Service level objectives worth committing to. */
    slos: { name: string; target: string; why: string }[];
    /** What pages a person, and what waits for the morning. */
    oncall: string[];
    /** Who owns what. */
    teams: { name: string; owns: string }[];
    /** Build or buy, part by part. */
    buildBuy: { part: string; call: string; why: string }[];
    /** What drives the bill and the headcount. */
    cost: string[];
    /** What could sink it, and what you would do about each. */
    risks: { risk: string; answer: string }[];
  };
  /** A timed run-through: what to do in each stage. The rehearsal clock runs for the sum of the stage minutes. */
  rehearsal: { stage: string; minutes: number; prompt: string; cover: string[] }[];
  /**
   * A hand-written cheat sheet for the crib page, to glance at on a second screen or print. With one, the crib shows
   * it in place of cue lines cut from the page's own text. Every line is a whole short sentence, written to be read in
   * a glance: no line over 100 characters, none cut off.
   */
  crib?: Crib;
}

export interface Crib {
  /** The one idea to hold on to, in a sentence or two. */
  idea: string;
  /** What to drop when the clock is against you, in a sentence or two. */
  late?: string;
  /**
   * The interview in order: what to do in each stretch of the clock. `when` is minutes, "8 to 16", each stretch
   * starting where the last ended, or "Any time" for something the interviewer may start whenever they like.
   */
  hour: { when: string; title: string; lines: string[] }[];
  /** The figures worth saying out loud, each with what it is and where it comes from. */
  numbers: { figure: string; what: string }[];
  /** Habits that are easy to drop under pressure. */
  remember: string[];
  /**
   * Likely questions, each with an answer short enough to say in one breath, grouped by the part of the hour they
   * tend to come up in, in the hour's order. `when` is that stretch's minutes, as in `hour`.
   */
  asked: { about: string; when?: string; items: { q: string; a: string }[] }[];
}
