import type { Choice, Question, Quiz, Sum } from './types';

/**
 * Marking for a design's test, with no DOM: what was answered, whether it was right, and the score by stage.
 * Used by `src/ui/design-quiz.ts` and tested in `quiz.test.ts`.
 */

/** One stored answer: the options picked (positions in the file's order), or what was typed. */
export type Answer = { picked: number[] } | { typed: string };

/** Answers by question id, as kept in `localStorage` under `dsv.quiz.<design id>`. */
export type Answers = Record<string, Answer>;

export type Result = 'right' | 'partly' | 'wrong';

export interface Marked {
  result: Result;
  /** For a number: the typed value equals the answer, not only within the range. */
  exact?: boolean;
  /** For a number: what was read from the box, or null when it was not a number. */
  value?: number | null;
}

/** Reads a typed number, allowing commas, spaces and underscores between digits ("86,400", "1 000"). Null when it is not a number. */
export function parseTyped(s: string): number | null {
  const t = s.replace(/[\s,_   ]/g, '').replace(/^−/, '-');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The lowest and highest values accepted for a number question. */
export function range(q: Sum): [number, number] {
  const d = q.within * Math.abs(q.answer);
  return [q.answer - d, q.answer + d];
}

/** Whether this is a usable answer to this question: something picked or typed, of the right shape. */
export function isAnswer(q: Question, a: unknown): a is Answer {
  if (!a || typeof a !== 'object') return false;
  if (q.kind === 'number') return typeof (a as { typed?: unknown }).typed === 'string';
  const p = (a as { picked?: unknown }).picked;
  if (!Array.isArray(p) || !p.length) return false;
  if (!p.every((i) => Number.isInteger(i) && i >= 0 && i < q.options.length)) return false;
  return q.kind === 'many' || p.length === 1;
}

function markChoice(q: Choice, picked: number[]): Marked {
  const set = new Set(picked);
  const rights = q.options.map((o, i) => (o.right ? i : -1)).filter((i) => i >= 0);
  const wrongPicked = [...set].some((i) => !q.options[i]?.right);
  const rightPicked = rights.filter((i) => set.has(i)).length;
  if (!wrongPicked && rightPicked === rights.length) return { result: 'right' };
  if (q.kind === 'many' && !wrongPicked && rightPicked > 0) return { result: 'partly' };
  return { result: 'wrong' };
}

function markSum(q: Sum, typed: string): Marked {
  const value = parseTyped(typed);
  if (value === null) return { result: 'wrong', value };
  // A tiny allowance so that 0.1 + 0.2 style rounding never marks an exact answer wrong.
  const eps = 1e-9 * Math.max(1, Math.abs(q.answer));
  const exact = Math.abs(value - q.answer) <= eps;
  const ok = exact || Math.abs(value - q.answer) <= q.within * Math.abs(q.answer) + eps;
  return { result: ok ? 'right' : 'wrong', exact, value };
}

/** Marks one answer. An answer of the wrong shape is wrong. */
export function mark(q: Question, a: Answer): Marked {
  if (q.kind === 'number') return 'typed' in a ? markSum(q, a.typed) : { result: 'wrong', value: null };
  return 'picked' in a ? markChoice(q, a.picked) : { result: 'wrong' };
}

/** Keeps only stored answers whose id is a question in this quiz and whose shape fits it. */
export function clean(quiz: Quiz, stored: unknown): Answers {
  const out: Answers = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const q of quiz.questions) {
    const a = (stored as Record<string, unknown>)[q.id];
    if (isAnswer(q, a)) out[q.id] = q.kind === 'number' ? { typed: (a as { typed: string }).typed } : { picked: [...new Set((a as { picked: number[] }).picked)].sort((x, y) => x - y) };
  }
  return out;
}

export interface StageScore {
  stage: string;
  right: number;
  total: number;
  /** Ids of the questions in this stage not answered right (wrong, partly right or not answered), in file order. */
  missed: string[];
}

/** The score by stage, stages in the order they first appear in the file. */
export function byStage(quiz: Quiz, answers: Answers): StageScore[] {
  const out: StageScore[] = [];
  const at = new Map<string, StageScore>();
  for (const q of quiz.questions) {
    let s = at.get(q.stage);
    if (!s) {
      s = { stage: q.stage, right: 0, total: 0, missed: [] };
      at.set(q.stage, s);
      out.push(s);
    }
    s.total++;
    const a = answers[q.id];
    if (a && mark(q, a).result === 'right') s.right++;
    else s.missed.push(q.id);
  }
  return out;
}

/** The whole score: right answers out of all questions. */
export function score(quiz: Quiz, answers: Answers): { right: number; total: number } {
  const s = byStage(quiz, answers);
  return { right: s.reduce((n, x) => n + x.right, 0), total: quiz.questions.length };
}
