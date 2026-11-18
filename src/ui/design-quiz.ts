import './design-quiz.css';
import { h } from '../core/dom';
import type { DesignEntry } from '../designs';
import { loadQuiz } from '../designs/quizzes';
import type { Question, Quiz, Sum } from '../designs/quiz/types';
import { byStage, clean, mark, range, score, type Answer, type Answers, type Marked } from '../designs/quiz/mark';
import { inline } from './inline';

/**
 * A design's test (#/d/<id>/test): one question at a time, each explained once its answer is submitted.
 * Answers are kept in localStorage under `dsv.quiz.<design id>`.
 */

/** The site-wide switch for single-key shortcuts, set beside the search box. A missing value means on. */
const shortcutsOn = () => {
  try {
    return localStorage.getItem('dsv.shortcuts') !== 'off';
  } catch {
    return true;
  }
};

const fmt = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 4 });
/** A range end, to four figures: 10.99, not 10.9915. */
const near = (n: number) => n.toLocaleString('en-GB', { maximumSignificantDigits: 4 });

function notWritten(host: HTMLElement, entry: DesignEntry): () => void {
  const page = h(
    'article.dq-page', null,
    h('p.dq-back', null, h('a', { href: `#/d/${entry.id}` }, `Back to ${entry.name}`)),
    h('header.page-head', null, h('h1', null, `${entry.name}: test`)),
    h('p.dq-empty', null, 'The test for this design is not written yet. The design page has the diagram, the tour and the notes.'),
  );
  host.append(page);
  return () => page.remove();
}

export async function mountQuiz(host: HTMLElement, entry: DesignEntry): Promise<() => void> {
  const quiz = await loadQuiz(entry.id);
  if (!quiz || !quiz.questions.length) return notWritten(host, entry);
  return mountLoaded(host, entry, quiz);
}

function mountLoaded(host: HTMLElement, entry: DesignEntry, quiz: Quiz): () => void {
  const KEY = `dsv.quiz.${entry.id}`;
  const qs = quiz.questions;
  const N = qs.length;
  let answers: Answers = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) answers = clean(quiz, JSON.parse(raw));
  } catch {
    // Storage blocked or the stored value unreadable: start with no answers.
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(answers));
    } catch {
      // Storage can be blocked; answers still count for this visit.
    }
  };
  /** What has been picked or typed but not submitted yet, by question id. Not stored. */
  const drafts: Record<string, Answer> = {};
  const firstOpen = qs.findIndex((q) => !answers[q.id]);
  /** The question on show, or -1 for the score. */
  let at = firstOpen;
  let confirming = false;

  const progress = h('p.dq-progress');
  const strip = h('ol.dq-strip');
  const view = h('div.dq-view');
  /** Announces each verdict once; the visible verdict sits with the question. */
  const live = h('p.dq-sr', { 'aria-live': 'polite', role: 'status' });
  const page = h(
    'article.dq-page', null,
    h('p.dq-back', null, h('a', { href: `#/d/${entry.id}` }, `Back to ${entry.name}`)),
    h('header.page-head', null, h('h1', null, `${entry.name}: test`), h('p.lede', null, inline(quiz.intro)), progress),
    h('nav.dq-nav', { 'aria-label': 'Questions' }, strip),
    view,
    live,
  );
  host.append(page);

  const resultOf = (q: Question): Marked | null => (answers[q.id] ? mark(q, answers[q.id]) : null);

  function drawStrip(): void {
    strip.replaceChildren(
      ...qs.map((q, i) => {
        const r = resultOf(q)?.result;
        const state = r === 'right' ? 'right' : r ? 'wrong' : 'open';
        const said = r === 'right' ? 'right' : r === 'partly' ? 'partly right' : r ? 'wrong' : 'not answered';
        return h(
          'li', null,
          h('button.dq-cell', {
            type: 'button',
            class: `is-${state}`,
            'aria-label': `Question ${i + 1}, ${said}`,
            'aria-current': i === at ? 'step' : null,
            onclick: () => go(i),
          }, h('span.dq-cell-n', null, String(i + 1)), state === 'open' ? null : h('span.dq-cell-mark', { 'aria-hidden': 'true' }, state === 'right' ? '✓' : '✗')),
        );
      }),
      h('li.dq-strip-end', null, h('button.dq-cell.dq-cell-score', { type: 'button', 'aria-current': at === -1 ? 'step' : null, onclick: () => go(-1) }, 'Score')),
    );
  }

  function go(i: number, focus = true): void {
    at = i;
    confirming = false;
    draw(focus);
  }

  function draw(focus: boolean): void {
    const done = Object.keys(answers).length;
    progress.textContent = at === -1 ? `Your score. ${done} of ${N} answered.` : `Question ${at + 1} of ${N}`;
    drawStrip();
    if (at === -1) drawEnd(focus);
    else drawQuestion(qs[at], focus);
  }

  // ---- one question ----------------------------------------------------------
  function drawQuestion(q: Question, focus: boolean): void {
    const a = answers[q.id];
    const locked = !!a;
    const m = a ? mark(q, a) : null;
    const draft = drafts[q.id];
    const submit = h('button.btn.primary.dq-submit', { type: 'submit' }, 'Submit') as HTMLButtonElement;
    const legendId = `dq-${q.id}-q`;
    let body: HTMLElement;
    let firstInput: HTMLInputElement | null = null;

    if (q.kind === 'number') {
      const inputId = `dq-${q.id}-in`;
      const input = h('input.dq-num', {
        id: inputId,
        type: 'text',
        inputMode: 'decimal',
        autocomplete: 'off',
        spellcheck: false,
        value: locked ? (a as { typed: string }).typed : draft && 'typed' in draft ? draft.typed : '',
        disabled: locked,
        'aria-describedby': `${inputId}-unit`,
      }) as HTMLInputElement;
      input.addEventListener('input', () => {
        drafts[q.id] = { typed: input.value };
        submit.disabled = !input.value.trim();
      });
      firstInput = input;
      const cls = !m ? '' : m.result === 'right' ? 'is-right' : 'is-wrong';
      body = h(
        'div.dq-numrow', { class: cls },
        h('label.dq-numlabel', { for: inputId }, 'Your answer'),
        h('span.dq-numbox', null, input, h('span.dq-unit', { id: `${inputId}-unit` }, q.unit)),
        m ? h('span.dq-tag', { class: m.result === 'right' ? 'tag-right' : 'tag-wrong' }, m.result === 'right' ? '✓ Your answer, right' : '✗ Your answer, wrong') : null,
      );
      submit.disabled = !(draft && 'typed' in draft && draft.typed.trim());
    } else {
      const picked = new Set(locked && 'picked' in a ? a.picked : draft && 'picked' in draft ? draft.picked : []);
      const type = q.kind === 'one' ? 'radio' : 'checkbox';
      const rows = q.options.map((o, i) => {
        const id = `dq-${q.id}-${i}`;
        const input = h('input', { type, id, name: `dq-${q.id}`, value: String(i), checked: picked.has(i), disabled: locked }) as HTMLInputElement;
        if (i === 0) firstInput = input;
        input.addEventListener('change', () => {
          const now = [...rows.map((r) => r.input)].map((x, j) => (x.checked ? j : -1)).filter((j) => j >= 0);
          drafts[q.id] = { picked: now };
          submit.disabled = !now.length;
          rows.forEach((r) => r.row.classList.toggle('is-picked', r.input.checked));
        });
        const was = picked.has(i);
        let state = '';
        let tag: HTMLElement | null = null;
        let note: string | undefined;
        if (locked) {
          if (o.right && was) {
            state = 'is-right';
            tag = h('span.dq-tag.tag-right', null, '✓ Right, your pick');
          } else if (o.right) {
            state = 'is-right';
            tag = h('span.dq-tag.tag-right', null, q.kind === 'many' ? '✓ Right, you missed it' : '✓ Right answer');
            if (q.kind === 'many') note = o.why;
          } else if (was) {
            state = 'is-wrong';
            tag = h('span.dq-tag.tag-wrong', null, '✗ Your pick, wrong');
            note = o.why;
          }
        }
        const row = h(
          'div.dq-opt', { class: `${state}${was ? ' is-picked' : ''}` },
          h('label', { for: id }, input, h('span.dq-opt-n', { 'aria-hidden': 'true' }, String(i + 1)), h('span.dq-opt-text', null, inline(o.text))),
          tag || note ? h('div.dq-opt-after', null, tag, note ? h('p.dq-opt-why', null, inline(note)) : null) : null,
        );
        return { row, input };
      });
      body = h('div.dq-opts', null, q.kind === 'many' ? h('p.dq-hint', null, 'Pick every one that is right.') : null, rows.map((r) => r.row));
      submit.disabled = !picked.size;
    }

    const form = h(
      'form.dq-form', { novalidate: true },
      h('fieldset', null, h('legend.dq-q', { id: legendId }, inline(q.q)), body),
      locked ? null : h('p.dq-actions', null, submit),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (submit.disabled || answers[q.id]) return;
      const d = drafts[q.id];
      if (!d) return;
      answers[q.id] = d;
      delete drafts[q.id];
      save();
      const r = mark(q, d);
      live.textContent = `${verdictWord(r)} ${plain(q.why)}`;
      draw(false);
      (view.querySelector('.dq-next') as HTMLElement | null)?.focus();
    });
    // Enter on an option submits, as it does in the number box.
    form.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (e.key === 'Enter' && t.tagName === 'INPUT') {
        e.preventDefault();
        if (!submit.disabled) form.requestSubmit();
      }
    });

    view.replaceChildren(
      h('section.dq-card', { 'aria-labelledby': legendId }, h('p.dq-stage', null, q.stage), form, m ? explain(q, m) : null),
    );
    if (focus) {
      if (locked) (view.querySelector('.dq-verdict') as HTMLElement | null)?.focus();
      else firstInput?.focus();
    }
  }

  const verdictWord = (m: Marked) => (m.result === 'right' ? 'Right.' : m.result === 'partly' ? 'Partly right.' : 'Not quite.');
  const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  function explain(q: Question, m: Marked): HTMLElement {
    const last = at === N - 1;
    const parts: (HTMLElement | null)[] = [
      h('p.dq-verdict', { class: `is-${m.result}`, tabIndex: -1 }, h('span.dq-verdict-mark', { 'aria-hidden': 'true' }, m.result === 'right' ? '✓' : m.result === 'partly' ? '~' : '✗'), verdictWord(m)),
    ];
    if (q.kind === 'number') parts.push(...sumLines(q, m));
    parts.push(h('p.dq-why', null, inline(q.why)));
    if (q.kind === 'number') parts.push(h('div.dq-working', null, h('p.dq-label', null, 'The working'), h('ol', null, q.working.map((w) => h('li', null, inline(w))))));
    if (q.say) parts.push(h('div.dq-say', null, h('p.dq-label', null, 'Say it:'), h('p', null, inline(q.say))));
    parts.push(h('p.dq-from', null, h('a', { href: q.from }, 'Where this is on the site')));
    parts.push(h('p.dq-actions', null, h('button.btn.primary.dq-next', { type: 'button', onclick: () => go(last ? -1 : at + 1) }, last ? 'See your score' : 'Next question')));
    return h('div.dq-explain', null, parts);
  }

  function sumLines(q: Sum, m: Marked): HTMLElement[] {
    const out = [h('p.dq-answer', null, 'The answer: ', h('strong', null, `${fmt(q.answer)} ${q.unit}`))];
    if (m.value === null) out.push(h('p.dq-note', null, 'What was typed is not a number, so it could not be marked.'));
    else if (m.result === 'right' && !m.exact) {
      const [lo, hi] = range(q);
      out.push(h('p.dq-note', null, `Yours, ${fmt(m.value!)}, is within the accepted range: anything from ${near(lo)} to ${near(hi)} ${q.unit} counts.`));
    }
    return out;
  }

  // ---- the score -------------------------------------------------------------
  function drawEnd(focus: boolean): void {
    const s = score(quiz, answers);
    const stages = byStage(quiz, answers);
    const missed = stages.flatMap((x) => x.missed);
    const index = new Map(qs.map((q, i) => [q.id, i]));
    const heading = h('h2.dq-end-h', { tabIndex: -1 }, 'Your score');
    const again = confirming
      ? h(
          'p.dq-actions.dq-confirm', null,
          h('span.dq-confirm-q', null, 'Clear every answer?'),
          h('button.btn.danger', { type: 'button', onclick: () => {
            answers = {};
            for (const k of Object.keys(drafts)) delete drafts[k];
            save();
            go(0);
          } }, 'Yes, clear them all'),
          h('button.btn.quiet', { type: 'button', onclick: () => {
            confirming = false;
            draw(false);
            (view.querySelector('.dq-again') as HTMLElement | null)?.focus();
          } }, 'Keep them'),
        )
      : null;
    view.replaceChildren(
      h(
        'section.dq-card.dq-end', { 'aria-labelledby': 'dq-end-h' },
        Object.assign(heading, { id: 'dq-end-h' }),
        h('p.dq-total', null, `${s.right} of ${s.total}`),
        h(
          'ul.dq-stages', null,
          stages.map((st) =>
            h(
              'li', null,
              h('p.dq-stage-row', null, h('span.dq-stage-name', null, `${st.stage}:`), ' ', h('span.dq-stage-score', null, `${st.right} of ${st.total}`)),
              st.missed.length
                ? h('ul.dq-missed', { 'aria-label': `Missed in ${st.stage}` }, st.missed.map((id) => {
                    const i = index.get(id)!;
                    return h('li', null, h('button.dq-link', { type: 'button', onclick: () => go(i) }, h('span.dq-missed-n', null, `${i + 1}.`), ' ', inline(qs[i].q), answers[id] ? null : h('span.dq-unanswered', null, ' (not answered)')));
                  }))
                : null,
            ),
          ),
        ),
        h(
          'p.dq-actions', null,
          missed.length
            ? h('button.btn.primary', { type: 'button', onclick: () => {
                for (const id of missed) {
                  delete answers[id];
                  delete drafts[id];
                }
                save();
                go(index.get(missed[0])!);
              } }, 'Retry the ones I missed')
            : null,
          confirming ? null : h('button.btn.dq-again', { type: 'button', onclick: () => {
            confirming = true;
            draw(false);
            (view.querySelector('.dq-confirm .btn.danger') as HTMLElement | null)?.focus();
          } }, 'Start again'),
        ),
        again,
      ),
    );
    if (focus) heading.focus();
  }

  // ---- keys: 1 to 9 pick an option, Enter submits or moves on (only with the site's shortcuts on) ----
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || at === -1 || !shortcutsOn()) return;
    const t = e.target as HTMLElement;
    if (t.closest('textarea, select, [contenteditable], input[type="text"], input[type="search"], button, a')) return;
    const q = qs[at];
    if (/^[1-9]$/.test(e.key) && q.kind !== 'number' && !answers[q.id]) {
      const input = view.querySelectorAll<HTMLInputElement>('.dq-opt input')[Number(e.key) - 1];
      if (!input) return;
      e.preventDefault();
      if (q.kind === 'one') input.checked = true;
      else input.checked = !input.checked;
      input.dispatchEvent(new Event('change'));
      input.focus();
    } else if (e.key === 'Enter' && answers[q.id]) {
      e.preventDefault();
      (view.querySelector('.dq-next') as HTMLElement | null)?.click();
    } else if (e.key === 'Enter') {
      const f = view.querySelector('form');
      if (f && !(f.querySelector('.dq-submit') as HTMLButtonElement).disabled) {
        e.preventDefault();
        f.requestSubmit();
      }
    }
  };
  document.addEventListener('keydown', onKey);

  draw(false);
  return () => {
    document.removeEventListener('keydown', onKey);
    page.remove();
  };
}
