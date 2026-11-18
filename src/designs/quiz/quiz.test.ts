import { describe, expect, it } from 'vitest';
import type { Quiz } from './types';
import { byStage, clean, mark, parseTyped, range, score } from './mark';

/** Every quiz file, eagerly: one per design, named by its id. Passes with none. */
const FILES = import.meta.glob<{ quiz: Quiz }>(['./*.ts', '!./types.ts', '!./mark.ts', '!./*.test.ts'], { eager: true });

describe('quiz files', () => {
  it('found files are loadable', () => {
    for (const mod of Object.values(FILES)) expect(mod.quiz, 'each file exports `quiz`').toBeTruthy();
  });

  for (const [path, mod] of Object.entries(FILES)) {
    const name = /\/([^/]+)\.ts$/.exec(path)![1];
    describe(name, () => {
      const quiz = mod.quiz;
      it('names its design after the file and has an intro', () => {
        expect(quiz.design).toBe(name);
        expect(quiz.intro.trim()).not.toBe('');
        expect(quiz.questions.length).toBeGreaterThan(0);
      });
      it('has unique kebab-case ids', () => {
        const ids = quiz.questions.map((q) => q.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      });
      for (const q of quiz.questions) {
        it(`question ${q.id} is well formed`, () => {
          expect(q.from.startsWith('#/'), `${q.id}: from`).toBe(true);
          expect(q.q.trim(), `${q.id}: ellipsis`).not.toMatch(/(\.\.\.|…)$/);
          expect(q.why.trim(), `${q.id}: why`).not.toBe('');
          expect(q.stage.trim(), `${q.id}: stage`).not.toBe('');
          if (q.kind === 'number') {
            expect(Number.isFinite(q.answer), `${q.id}: answer`).toBe(true);
            expect(q.within, `${q.id}: within`).toBeGreaterThanOrEqual(0);
            expect(q.within, `${q.id}: within`).toBeLessThanOrEqual(0.2);
            expect(q.unit.trim(), `${q.id}: unit`).not.toBe('');
            expect(q.working.length, `${q.id}: working`).toBeGreaterThan(0);
          } else {
            const right = q.options.filter((o) => o.right).length;
            if (q.kind === 'one') {
              expect(right, `${q.id}: one right`).toBe(1);
              expect(q.options.length, `${q.id}: options`).toBeGreaterThanOrEqual(3);
              expect(q.options.length, `${q.id}: options`).toBeLessThanOrEqual(5);
            } else {
              expect(right, `${q.id}: at least two right`).toBeGreaterThanOrEqual(2);
              expect(q.options.length - right, `${q.id}: at least one wrong`).toBeGreaterThanOrEqual(1);
            }
            for (const [i, o] of q.options.entries()) if (!o.right) expect(o.why?.trim(), `${q.id}: option ${i + 1} why`).toBeTruthy();
          }
        });
      }
    });
  }
});

const fixture: Quiz = {
  design: 'fixture',
  intro: 'A fixture.',
  questions: [
    { id: 'pick-one', stage: 'Ask first', kind: 'one', q: 'Which?', why: 'Because.', from: '#/', options: [{ text: 'a', why: 'no' }, { text: 'b', right: true }, { text: 'c', why: 'no' }] },
    { id: 'pick-many', stage: 'The small design', kind: 'many', q: 'Which ones?', why: 'Because.', from: '#/', options: [{ text: 'a', right: true }, { text: 'b', right: true }, { text: 'c', why: 'no' }, { text: 'd', why: 'no' }] },
    { id: 'a-sum', stage: 'The sums', kind: 'number', q: 'How many?', why: 'Because.', from: '#/', answer: 11.6, unit: 'days', within: 0.05, working: ['1e9 / 86,400'] },
    { id: 'exact-sum', stage: 'The sums', kind: 'number', q: 'Seconds in a day?', why: 'Because.', from: '#/', answer: 86400, unit: 'seconds', within: 0, working: ['24 × 3,600'] },
  ],
};
const [one, many, sum, exact] = fixture.questions;

describe('parseTyped', () => {
  it('reads plain, comma and space separated numbers', () => {
    expect(parseTyped('86400')).toBe(86400);
    expect(parseTyped('86,400')).toBe(86400);
    expect(parseTyped(' 86 400 ')).toBe(86400);
    expect(parseTyped('11.6')).toBe(11.6);
    expect(parseTyped('-3')).toBe(-3);
    expect(parseTyped('1e6')).toBe(1e6);
    expect(parseTyped('.5')).toBe(0.5);
  });
  it('refuses what is not a number', () => {
    for (const s of ['', ' ', 'abc', '12 days', '1.2.3', '--1', 'Infinity', 'NaN']) expect(parseTyped(s), s).toBeNull();
  });
});

describe('mark', () => {
  it('marks a single choice', () => {
    expect(mark(one, { picked: [1] }).result).toBe('right');
    expect(mark(one, { picked: [0] }).result).toBe('wrong');
  });
  it('marks a many choice: right, partly, wrong', () => {
    expect(mark(many, { picked: [0, 1] }).result).toBe('right');
    expect(mark(many, { picked: [1] }).result).toBe('partly');
    expect(mark(many, { picked: [0, 2] }).result).toBe('wrong');
    expect(mark(many, { picked: [0, 1, 3] }).result).toBe('wrong');
    expect(mark(many, { picked: [2] }).result).toBe('wrong');
  });
  it('marks a number within its range', () => {
    expect(range(sum as never)).toEqual([11.6 - 0.58, 11.6 + 0.58]);
    expect(mark(sum, { typed: '11.6' })).toMatchObject({ result: 'right', exact: true });
    expect(mark(sum, { typed: '12' })).toMatchObject({ result: 'right', exact: false });
    expect(mark(sum, { typed: '11.02' }).result).toBe('right');
    expect(mark(sum, { typed: '12.3' }).result).toBe('wrong');
    expect(mark(sum, { typed: 'eleven' })).toMatchObject({ result: 'wrong', value: null });
  });
  it('needs an exact number when within is 0', () => {
    expect(mark(exact, { typed: '86,400' })).toMatchObject({ result: 'right', exact: true });
    expect(mark(exact, { typed: '86401' }).result).toBe('wrong');
  });
  it('treats an answer of the wrong shape as wrong', () => {
    expect(mark(one, { typed: '1' }).result).toBe('wrong');
    expect(mark(sum, { picked: [0] }).result).toBe('wrong');
  });
});

describe('clean', () => {
  it('keeps known ids of the right shape and drops the rest', () => {
    const got = clean(fixture, {
      'pick-one': { picked: [1] },
      'pick-many': { picked: [1, 0, 1] },
      'a-sum': { typed: '12' },
      'exact-sum': { picked: [0] },
      gone: { picked: [0] },
    });
    expect(got).toEqual({ 'pick-one': { picked: [1] }, 'pick-many': { picked: [0, 1] }, 'a-sum': { typed: '12' } });
    expect(clean(fixture, { 'pick-one': { picked: [0, 1] } })).toEqual({});
    expect(clean(fixture, { 'pick-one': { picked: [7] } })).toEqual({});
    expect(clean(fixture, null)).toEqual({});
    expect(clean(fixture, 'junk')).toEqual({});
  });
});

describe('score by stage', () => {
  it('scores in the file order of stages and lists the missed', () => {
    const answers = { 'pick-one': { picked: [1] }, 'pick-many': { picked: [1] }, 'a-sum': { typed: '11.5' } };
    expect(byStage(fixture, answers)).toEqual([
      { stage: 'Ask first', right: 1, total: 1, missed: [] },
      { stage: 'The small design', right: 0, total: 1, missed: ['pick-many'] },
      { stage: 'The sums', right: 1, total: 2, missed: ['exact-sum'] },
    ]);
    expect(score(fixture, answers)).toEqual({ right: 2, total: 4 });
    expect(score(fixture, {})).toEqual({ right: 0, total: 4 });
  });
});
