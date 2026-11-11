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
  /** A timed run-through: what to do in each stage of a 45-minute interview. */
  rehearsal: { stage: string; minutes: number; prompt: string; cover: string[] }[];
}
