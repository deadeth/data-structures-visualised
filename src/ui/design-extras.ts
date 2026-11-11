import './design-extras.css';
import { figures, h, tableRoles } from '../core/dom';
import type { DesignEntry } from '../designs';
import type { Extras } from '../designs/extras/types';
import type { Design } from '../designs/types';

/**
 * The interview extras for a design: the "Lead it" and "Likely pushes" sections on the design page,
 * rehearsal mode (#/d/<id>/rehearse) and the printable crib (#/d/<id>/crib).
 */

type Cell = string | HTMLElement;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A table that restacks into labelled blocks on a phone, named by its heading. */
function table(head: string[], rows: Cell[][], named: string, cls = 'hld-table'): HTMLElement {
  return h(
    'div.table-wrap', null,
    tableRoles(
      h(
        `table.${cls}.stack`, { 'aria-labelledby': named },
        h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((t, i) => (i === 0 ? h('th', { scope: 'row' }, t) : h('td', { 'data-label': head[i] }, t)))))),
      ),
    ),
  );
}

/** A phase written as "1. Correct core" sits in a numbered list already: the list gives the number. */
const unnumbered = (name: string) => name.replace(/^\s*\d+[.):]\s+/, '');

const points = (items: string[]) => h('ul', null, items.map((t) => h('li', null, t)));

/** The ways into rehearsal mode and the crib, as the design page shows them. */
function actions(id: string): HTMLElement {
  return h(
    'p.dx-actions', null,
    h('a.dx-action.primary', { href: `#/d/${id}/rehearse` }, 'Rehearse this in 45 minutes'),
    h('a.dx-action', { href: `#/d/${id}/crib` }, 'One-page crib'),
  );
}

/** The design page's own sections that rehearsal links back to, by key. */
const SECTION_NAMES: Record<string, string> = {
  lead: 'Lead it',
  opening: 'The opening',
  pushes: 'Likely pushes',
  phases: 'What ships, in order',
  migration: 'Migration',
  slos: 'Service level objectives',
  oncall: 'On call',
  teams: 'Teams',
  'build-buy': 'Build or buy',
  cost: 'Cost',
  risks: 'Risks',
  numbers: 'Numbers to have ready',
  decisions: 'Decisions worth defending',
  talk: 'How the parts talk',
};

/**
 * The extras' sections for the design page, the links into rehearsal and the crib for its header,
 * and a way to open a question (`q/<n>`) or a section (`x/<key>`) from the address.
 */
export function extrasParts(design: Design, extras: Extras): { links: HTMLElement; sections: HTMLElement[]; open: (o: { kind: string; id: string }) => void } {
  const id = design.id;
  const hid = (k: string) => `${id}-${k}`;
  const l = extras.lead;
  const sub = (key: string, title: string, ...body: (HTMLElement | null)[]) => h('section.dx-sub', { 'aria-labelledby': hid(key) }, h('h3', { id: hid(key), tabIndex: -1 }, title), ...body);

  const lead = h(
    'section.note.wide.hld-card.dx.dx-lead', { 'aria-labelledby': hid('lead') },
    h('div.dx-head', null, h('h2', { id: hid('lead'), tabIndex: -1 }, 'Lead it'), actions(id)),
    h('p.hld-lead', null, 'How to open the answer, then how you would deliver and run it: the engineering-leader view an interviewer is also judging.'),
    sub(
      'opening', 'The opening',
      h('p.dx-say', null, 'The first two minutes, as you might say them.'),
      h('ol.dx-script', null, extras.opening.map((t) => h('li', null, t))),
    ),
    sub(
      'phases', 'What ships, in order',
      h('ol.dx-phases', null, l.phases.map((p) => h('li', null, h('p.dx-phase-name', null, unnumbered(p.name)), h('p', null, h('span.dx-k', null, 'Ships: '), p.ships), h('p', null, h('span.dx-k', null, 'Why this order: '), p.why)))),
    ),
    h(
      'div.dx-grid', null,
      sub('migration', 'Migration', points(l.migration)),
      sub('oncall', 'On call', points(l.oncall)),
    ),
    sub('slos', 'Service level objectives', table(['Objective', 'Target', 'Why'], l.slos.map((s) => [s.name, s.target, s.why]), hid('slos'))),
    h(
      'div.dx-grid', null,
      sub('teams', 'Teams', h('dl.dx-teams', null, l.teams.flatMap((t) => [h('dt', null, t.name), h('dd', null, t.owns)]))),
      sub('cost', 'Cost', points(l.cost)),
    ),
    sub('build-buy', 'Build or buy', table(['Part', 'Call', 'Why'], l.buildBuy.map((b) => [b.part, b.call, b.why]), hid('build-buy'))),
    sub('risks', 'Risks', table(['Risk', 'What to do about it'], l.risks.map((r) => [r.risk, r.answer]), hid('risks'))),
  );

  const asks: HTMLDetailsElement[] = extras.pushes.map((p, i) =>
    h(
      'details.dx-push', { id: hid(`q-${i + 1}`) },
      h('summary', null, h('span.dx-push-n', { 'aria-hidden': 'true' }, String(i + 1)), h('span.dx-push-q', null, p.q)),
      h('div.dx-push-a', null, points(p.a)),
    ),
  );
  const setAll = (on: boolean) => asks.forEach((d) => (d.open = on));
  const pushes = h(
    'section.note.wide.hld-card.dx.dx-pushes-card', { 'aria-labelledby': hid('pushes') },
    h('h2', { id: hid('pushes'), tabIndex: -1 }, 'Likely pushes'),
    h('p.hld-lead', null, `The ${extras.pushes.length} questions an interviewer is most likely to push on, hardest first. Answer out loud before you open one.`),
    h(
      'p.dx-tools', null,
      h('button.btn', { type: 'button', 'aria-controls': asks.map((a) => a.id).join(' '), onclick: () => setAll(true) }, 'Reveal all'),
      h('button.btn', { type: 'button', 'aria-controls': asks.map((a) => a.id).join(' '), onclick: () => setAll(false) }, 'Hide all'),
    ),
    h('ol.dx-pushes', null, asks.map((d) => h('li', null, d))),
  );

  const open = (o: { kind: string; id: string }) => {
    let target: HTMLElement | null = null;
    if (o.kind === 'q') {
      const d = asks[Number(o.id) - 1];
      if (d) {
        d.open = true;
        target = d.querySelector('summary');
      }
    } else if (o.kind === 'x' && SECTION_NAMES[o.id]) {
      target = document.getElementById(hid(o.id));
      if (target && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    }
    if (!target) return;
    target.scrollIntoView({ block: o.kind === 'q' ? 'center' : 'start' });
    // Focus moved by a link, not a key: no ring until the reader presses a key there (as the design page does).
    const t = target;
    t.classList.add('by-link');
    t.focus({ preventScroll: true });
    const off = () => {
      t.classList.remove('by-link');
      t.removeEventListener('blur', off);
      t.removeEventListener('keydown', off);
    };
    t.addEventListener('blur', off);
    t.addEventListener('keydown', off);
  };

  return { links: actions(id), sections: [lead, pushes], open };
}

/** "7:05", or "-0:40" once past zero. */
function clock(sec: number): string {
  const s = Math.round(Math.abs(sec));
  return `${sec < -0.5 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Words for a span of seconds: "4 minutes 10 seconds". */
function spoken(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (!m) return part(r, 'second');
  return r ? `${part(m, 'minute')} ${part(r, 'second')}` : part(m, 'minute');
}

function notWritten(host: HTMLElement, entry: DesignEntry, what: string): () => void {
  const page = h(
    'article.dx-page', null,
    h('p.dx-back', null, h('a', { href: `#/d/${entry.id}` }, `Back to ${entry.name}`)),
    h('header.page-head', null, h('h1', null, `${what}: ${entry.name}`)),
    h('p.dx-empty', null, `The ${what.toLowerCase()} for this design is not written yet. The design page has the diagram, the tour and the notes.`),
  );
  host.append(page);
  return () => page.remove();
}

/** Which section of the design page best backs up a rehearsal stage, from the words in its name and prompt. */
function sectionFor(stage: { stage: string; prompt: string }): string {
  const s = stage.stage.toLowerCase();
  const all = `${s} ${stage.prompt.toLowerCase()}`;
  const rules: [RegExp, string][] = [
    [/lead|phase|deliver|migrat|team|run it|operat|roll ?out/, 'lead'],
    [/clarif|scope|require|open|question/, 'opening'],
    [/number|estimat|capacity|sizing|size|back.of/, 'numbers'],
    [/fail|break|recover|outage|incident|prov|right|correct/, 'pushes'],
    [/deep|trade|decision|dive|choice|invariant|model|schema/, 'decisions'],
    [/high.level|diagram|architect|design|component|draw|path|flow|line from/, 'design'],
    [/wrap|summar|close|question|push/, 'pushes'],
  ];
  for (const [re, key] of rules) if (re.test(s)) return key;
  for (const [re, key] of rules) if (re.test(all)) return key;
  return 'pushes';
}

const TOTAL = 45 * 60;

interface Saved {
  notes: string[];
  ticks: boolean[][];
}

/** Rehearsal mode: the question, a 45-minute clock, and the stages one at a time, ending in a summary. */
export async function mountRehearse(host: HTMLElement, entry: DesignEntry, design: Design, extras?: Extras): Promise<() => void> {
  if (!extras || !extras.rehearsal.length) return notWritten(host, entry, 'Rehearsal');
  const stages = extras.rehearsal;
  const id = design.id;
  const base = `#/d/${id}`;
  const KEY = `dsv.rehearse.${id}`;

  // ---- what is kept: notes and ticks, in memory and (when allowed) in localStorage ----
  const saved: Saved = { notes: stages.map(() => ''), ticks: stages.map((s) => s.cover.map(() => false)) };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const got = JSON.parse(raw) as Partial<Saved>;
      stages.forEach((s, i) => {
        if (typeof got.notes?.[i] === 'string') saved.notes[i] = got.notes[i];
        const t = got.ticks?.[i];
        if (Array.isArray(t)) s.cover.forEach((_, j) => (saved.ticks[i][j] = t[j] === true));
      });
    }
  } catch {
    // Storage can be blocked or hold something unreadable: start clean, keep going in memory.
  }
  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Blocked storage: the notes still live in memory for this visit.
    }
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 400);
  };

  // ---- clock state ----
  let cur = 0;
  let finished = false;
  let running = false;
  let elapsed = 0;
  const spent = stages.map(() => 0);
  const stageDone = stages.map(() => false);
  const visited = new Set<number>([0]);
  let lastTick = 0;
  let interval = 0;
  let fiveSaid = false;
  let overSaid = false;

  // ---- page ----
  const status = h('p.visually-hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (t: string) => {
    // Cleared first so the same words twice are still read.
    status.textContent = '';
    window.setTimeout(() => (status.textContent = t), 60);
  };
  const totalClock = h('span.dx-clock-figure', null, clock(TOTAL));
  const totalNote = h('span.dx-clock-note', null, 'of 45 minutes left');
  const startBtn = h('button.btn.primary.dx-start', { type: 'button', onclick: () => (running ? pause() : start()) }, 'Start');
  const resetBtn = h('button.btn', { type: 'button', onclick: () => reset() }, 'Reset');
  const clockBox = h(
    'section.dx-clock', { 'aria-label': 'Interview clock' },
    // A timer is never read out by itself; stage changes and time warnings go to the status line instead.
    h('p.dx-clock-read', { role: 'timer', 'aria-live': 'off', 'aria-atomic': 'true' }, totalClock, ' ', totalNote),
    h('p.dx-clock-btns', null, startBtn, resetBtn),
  );

  const stripBtns: HTMLButtonElement[] = [];
  const strip = h(
    'nav.dx-strip', { 'aria-label': 'Stages' },
    h(
      'ol', null,
      stages.map((s, i) => {
        const b = h(
          'button.dx-seg', { type: 'button', onclick: () => goTo(i) },
          h('span.dx-seg-bar', { 'aria-hidden': 'true' }),
          h('span.dx-seg-label', null, h('span.dx-seg-n', null, `${i + 1}`), h('span.dx-seg-name', null, ` ${s.stage}`)),
          h('span.dx-seg-mins', null, `, ${s.minutes} min`),
          h('span.visually-hidden.dx-seg-state'),
        );
        stripBtns.push(b);
        const li = h('li', null, b);
        li.style.flexGrow = String(s.minutes);
        return li;
      }),
    ),
  );

  const body = h('div.dx-body');
  const page = h(
    'article.dx-page.dx-rehearse', null,
    h('p.dx-back', null, h('a', { href: base }, `Back to ${design.name}`)),
    h('header.page-head', null, h('h1', null, 'Rehearse: ', design.name), h('p.lede', null, 'Talk it through out loud against the clock, one stage at a time. The diagram is not shown: draw your own.')),
    h('section.dx-question', { 'aria-label': 'The question' }, h('p.dx-k', null, 'The question'), h('p.dx-question-text', null, entry.question)),
    clockBox,
    strip,
    body,
    status,
  );
  host.append(page);

  // ---- the current stage ----
  let stageClock: HTMLElement | null = null;
  let stageHead: HTMLElement | null = null;

  function syncStrip(): void {
    stripBtns.forEach((b, i) => {
      const here = !finished && i === cur;
      if (here) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.classList.toggle('done', visited.has(i) && (finished || i !== cur));
      b.classList.toggle('over', spent[i] > stages[i].minutes * 60);
      const n = saved.ticks[i].filter(Boolean).length;
      (b.querySelector('.dx-seg-state') as HTMLElement).textContent = here ? ', current stage' : visited.has(i) ? `, visited, ${n} of ${stages[i].cover.length} ticked` : '';
    });
  }

  function paintClocks(): void {
    const left = TOTAL - elapsed;
    totalClock.textContent = clock(Math.max(0, left));
    totalNote.textContent = left < 0 ? `of 45 minutes left: ${clock(-left).replace('-', '')} over` : 'of 45 minutes left';
    clockBox.classList.toggle('over', left < 0);
    if (stageClock) {
      const sl = stages[cur].minutes * 60 - spent[cur];
      const words = sl >= 0 ? `${clock(sl)} left in this stage` : `${clock(-sl)} over this stage's ${stages[cur].minutes} minutes`;
      if (stageClock.textContent !== words) stageClock.replaceChildren(figures(words));
      stageClock.parentElement!.classList.toggle('over', sl < 0);
    }
  }

  function tick(): void {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (!running) return;
    elapsed += dt;
    if (!finished) spent[cur] += dt;
    if (!finished && !stageDone[cur] && spent[cur] >= stages[cur].minutes * 60) {
      stageDone[cur] = true;
      say(cur < stages.length - 1 ? `Time is up for ${stages[cur].stage}. Move on to ${stages[cur + 1].stage} when you are ready.` : `Time is up for ${stages[cur].stage}.`);
      syncStrip();
    }
    if (!fiveSaid && TOTAL - elapsed <= 300) {
      fiveSaid = true;
      say('Five minutes left.');
    }
    if (!overSaid && elapsed >= TOTAL) {
      overSaid = true;
      say('The 45 minutes are up.');
    }
    paintClocks();
  }

  function start(): void {
    if (running) return;
    running = true;
    lastTick = performance.now();
    interval = window.setInterval(tick, 250);
    startBtn.textContent = 'Pause';
    say(elapsed ? 'Clock running.' : `Clock started. Stage ${cur + 1}: ${stages[cur].stage}.`);
  }

  function pause(quiet = false): void {
    if (!running) return;
    tick();
    running = false;
    clearInterval(interval);
    startBtn.textContent = elapsed ? 'Resume' : 'Start';
    if (!quiet) say(`Clock paused with ${spoken(TOTAL - elapsed)} left.`);
  }

  function reset(): void {
    pause(true);
    elapsed = 0;
    spent.fill(0);
    stageDone.fill(false);
    fiveSaid = false;
    overSaid = false;
    startBtn.textContent = 'Start';
    paintClocks();
    syncStrip();
    say('Clock reset to 45 minutes.');
  }

  function renderStage(focus: boolean): void {
    const s = stages[cur];
    const i = cur;
    const notesId = `${id}-rehearse-notes-${i}`;
    const notes = h('textarea.dx-notes', { id: notesId, rows: 6, spellcheck: true }) as HTMLTextAreaElement;
    notes.value = saved.notes[i];
    notes.addEventListener('input', () => {
      saved.notes[i] = notes.value;
      saveSoon();
    });
    const coverList = h(
      'ul.dx-cover', null,
      s.cover.map((c, j) => {
        const box = h('input', { type: 'checkbox', id: `${id}-cover-${i}-${j}`, checked: saved.ticks[i][j] }) as HTMLInputElement;
        box.addEventListener('change', () => {
          saved.ticks[i][j] = box.checked;
          save();
          syncStrip();
        });
        return h('li', null, box, h('label', { for: box.id }, c));
      }),
    );
    const reveal = h(
      'details.dx-reveal', { open: saved.ticks[i].some(Boolean) },
      h('summary', null, 'Reveal what to cover'),
      h('fieldset', null, h('legend', null, `Tick what you covered in ${s.stage}`), coverList),
    );
    stageClock = h('span', null);
    stageHead = h('h2', { tabIndex: -1 }, s.stage);
    const back = h('button.btn', { type: 'button', disabled: i === 0, onclick: () => goTo(i - 1) }, 'Back');
    const last = i === stages.length - 1;
    const next = h('button.btn.primary', { type: 'button', onclick: () => (last ? finish() : goTo(i + 1)) }, last ? 'Finish and see how it went' : 'Next stage');
    body.replaceChildren(
      h(
        'section.dx-stage', { 'aria-labelledby': `${id}-stage-head` },
        h('p.dx-stage-meta', null, `Stage ${i + 1} of ${stages.length}`, h('span.dx-dot', { 'aria-hidden': 'true' }, ' · '), `${s.minutes} minutes`),
        stageHead,
        h('p.dx-stage-clock', null, h('span.dx-stage-pip', { 'aria-hidden': 'true' }), stageClock),
        h('p.dx-prompt', null, s.prompt),
        h('label.dx-notes-label', { for: notesId }, 'Your notes for this stage'),
        h('p.dx-hint', { id: `${notesId}-hint` }, 'Kept in this browser only.'),
        notes,
        reveal,
      ),
      h('p.dx-nav', null, back, next),
    );
    stageHead.id = `${id}-stage-head`;
    notes.setAttribute('aria-describedby', `${notesId}-hint`);
    paintClocks();
    syncStrip();
    if (focus) stageHead.focus({ preventScroll: true });
    if (focus) {
      const top = page.querySelector('.dx-strip')!.getBoundingClientRect().top;
      if (top < 0 || top > innerHeight * 0.6) page.querySelector('.dx-strip')!.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function goTo(i: number): void {
    if (i < 0 || i >= stages.length) return;
    save();
    finished = false;
    cur = i;
    visited.add(i);
    renderStage(true);
    say(`Stage ${i + 1} of ${stages.length}: ${stages[i].stage}. ${stages[i].minutes} minutes.`);
  }

  function finish(): void {
    save();
    finished = true;
    pause(true);
    stageClock = null;
    syncStrip();
    const link = (key: string) =>
      key === 'design'
        ? h('a', { href: base }, 'The diagram and the tour')
        : h('a', { href: `${base}/x/${key}` }, SECTION_NAMES[key]);
    const used = elapsed;
    const totalTicked = saved.ticks.flat().filter(Boolean).length;
    const totalCover = stages.reduce((n, s) => n + s.cover.length, 0);
    const head = h('h2', { tabIndex: -1 }, 'How it went');
    body.replaceChildren(
      h(
        'section.dx-summary', { 'aria-labelledby': `${id}-summary-head` },
        head,
        h('p.dx-summary-lead', null, `You covered ${totalTicked} of ${totalCover} points${used >= 1 ? ` in ${spoken(used)}${used > TOTAL ? `, ${spoken(used - TOTAL)} over the 45 minutes` : ''}` : ''}.`),
        h(
          'ol.dx-summary-list', null,
          stages.map((s, i) => {
            const got = s.cover.filter((_, j) => saved.ticks[i][j]);
            const missed = s.cover.filter((_, j) => !saved.ticks[i][j]);
            const note = saved.notes[i].trim();
            return h(
              'li.dx-sum', null,
              h('h3', null, s.stage),
              h('p.dx-sum-meta', null, `${got.length} of ${s.cover.length} covered`, h('span.dx-dot', { 'aria-hidden': 'true' }, ' · '), spent[i] >= 1 ? `${clock(spent[i])} spent of ${s.minutes} minutes` : `${s.minutes} minutes planned`),
              h(
                'div.dx-sum-cols', null,
                h('div', null, h('h4', null, 'Covered'), got.length ? h('ul.dx-got', null, got.map((c) => h('li', null, c))) : h('p.dx-none', null, 'Nothing ticked.')),
                h('div', null, h('h4', null, 'Missed'), missed.length ? h('ul.dx-missed', null, missed.map((c) => h('li', null, c))) : h('p.dx-none', null, 'Nothing missed.')),
              ),
              h('h4', null, 'Your notes'),
              note ? h('p.dx-sum-notes', null, note) : h('p.dx-none', null, 'No notes.'),
              h('p.dx-sum-link', null, 'Read again: ', link(sectionFor(s))),
            );
          }),
        ),
        h(
          'p.dx-nav', null,
          h('button.btn', { type: 'button', onclick: () => goTo(stages.length - 1) }, 'Back to the stages'),
          h('button.btn', { type: 'button', onclick: () => fresh() }, 'Start a fresh run'),
          h('a.dx-action', { href: `${base}/crib` }, 'One-page crib'),
          h('a.dx-action', { href: base }, `Back to ${design.name}`),
        ),
      ),
    );
    head.id = `${id}-summary-head`;
    head.focus({ preventScroll: true });
    head.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    say('Rehearsal finished. Summary below.');
  }

  function fresh(): void {
    if (!window.confirm('Clear your notes and ticks for every stage, and reset the clock?')) return;
    saved.notes = stages.map(() => '');
    saved.ticks = stages.map((s) => s.cover.map(() => false));
    save();
    visited.clear();
    reset();
    goTo(0);
  }

  renderStage(false);

  return () => {
    clearInterval(interval);
    if (saveTimer) save();
    page.remove();
  };
}

/**
 * A point cut to a cue line for the crib: its first sentence, and if that is still long, the sentence up to the last
 * clause break (a comma, semicolon, colon or dash) before about 120 characters, with an ellipsis. The crib is for
 * glancing at; the full text is on the design page.
 */
export function cue(text: string, max = 120): string {
  const m = /^(.+?[.?!])\s+(?=[A-Z"'‘“(])/.exec(text);
  const first = m && m[1].length >= 24 ? m[1] : text;
  if (first.length <= max + 12) return first;
  const head = first.slice(0, max);
  const at = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(' – '), head.lastIndexOf(' — '));
  if (at >= 50) return `${head.slice(0, at)} …`;
  const sp = head.lastIndexOf(' ');
  return `${head.slice(0, sp > 60 ? sp : max)} …`;
}

/** The crib: everything worth glancing at before the interview, on one or two printed A4 pages. */
export async function mountCrib(host: HTMLElement, entry: DesignEntry, design: Design, extras?: Extras): Promise<() => void> {
  if (!extras) return notWritten(host, entry, 'Crib');
  const id = design.id;
  const root = document.documentElement;
  root.classList.add('crib-mode');
  const hid = (k: string) => `${id}-crib-${k}`;
  const sec = (key: string, title: string, ...body: HTMLElement[]) => h(`section.dx-crib-sec.dx-crib-sec-${key}`, { 'aria-labelledby': hid(key) }, h('h2', { id: hid(key) }, title), ...body);
  // The short sections, in order, split between two columns so the columns end level (about: a table row costs its
  // tallest cell, a cell having roughly half the column's width).
  const rows = (r: string[][]) => r.reduce((n, x) => n + 30 + Math.max(...x.map((c) => c.length * 2)), 80);
  const prose = (r: string[]) => r.reduce((n, x) => n + 30 + x.length, 80);
  const opening = extras.opening.map((t) => cue(t, 110));
  const phases = extras.lead.phases.map((p) => [unnumbered(p.name), cue(p.ships, 100)]);
  const numbers = design.numbers.map((n) => [n.what, n.result]);
  const decisions = design.decisions.map((d) => [d.choice, cue(d.call, 90)]);
  const slos = extras.lead.slos.map((x) => [x.name, x.target.replace(/^Target:\s*/i, '')]);
  const tops = [
    { el: sec('opening', 'Opening', h('ol.dx-crib-script', null, opening.map((t) => h('li', null, t)))), w: prose(opening) },
    { el: sec('phases', 'Phases', h('ol.dx-crib-phases', null, phases.map(([n, t]) => h('li', null, h('strong', null, n), `: ${t}`)))), w: prose(phases.map((x) => x.join(': '))) },
    { el: sec('numbers', 'Numbers', table(['Quantity', 'Result'], numbers, hid('numbers'), 'dx-crib-table')), w: rows(numbers) },
    { el: sec('decisions', 'Decisions', table(['Choice', 'The call here'], decisions, hid('decisions'), 'dx-crib-table')), w: rows(decisions) },
    { el: sec('slos', 'Service level objectives', table(['Objective', 'Target'], slos, hid('slos'), 'dx-crib-table')), w: rows(slos) },
  ];
  const all = tops.reduce((n, t) => n + t.w, 0);
  let split = 1;
  let best = Infinity;
  for (let k = 1, left = 0; k < tops.length; k++) {
    left += tops[k - 1].w;
    if (Math.abs(all - 2 * left) < best) {
      best = Math.abs(all - 2 * left);
      split = k;
    }
  }

  // The pushes in two lists of about the same length, side by side. (CSS columns break badly across printed pages in Chrome.)
  const size = (p: Extras['pushes'][number]) => p.q.length + 40 + p.a.reduce((n, t) => n + cue(t).length + 30, 0);
  const whole = extras.pushes.reduce((n, p) => n + size(p), 0);
  let run = 0;
  let cut = extras.pushes.findIndex((p) => (run += size(p)) >= whole / 2);
  if (cut >= 0 && run - size(extras.pushes[cut]) / 2 > whole / 2) cut -= 1;
  const halves = [extras.pushes.slice(0, cut + 1), extras.pushes.slice(cut + 1)].filter((x) => x.length);
  const page = h(
    'article.dx-page.dx-crib-page', null,
    h(
      'div.dx-crib-bar', null,
      h('p.dx-back', null, h('a', { href: `#/d/${id}` }, `Back to ${design.name}`)),
      h('p.dx-crib-tools', null, h('button.btn.primary', { type: 'button', onclick: () => window.print() }, 'Print'), h('span.dx-hint', null, 'Laid out for A4.')),
    ),
    h(
      'div.dx-crib', null,
      h('header.dx-crib-head', null, h('h1', null, design.name, h('span.dx-crib-kind', null, ': crib')), h('p.dx-crib-q', null, h('span.dx-k', null, 'The question: '), entry.question)),
      h('p.dx-crib-note', null, 'Cue lines only: each point is cut to its first sentence or clause. The full text is on the design page.'),
      h('div.dx-crib-top', null, h('div', null, tops.slice(0, split).map((t) => t.el)), h('div', null, tops.slice(split).map((t) => t.el))),
      sec('pushes', 'Likely pushes', h('div.dx-crib-pcols', null, halves.map((part, k) => h('ol.dx-crib-pushes', { start: k ? halves[0].length + 1 : 1 }, part.map((p) => h('li', null, h('p.dx-crib-pq', null, p.q), points(p.a.map((t) => cue(t, 96))))))))),
    ),
  );
  host.append(page);
  return () => {
    root.classList.remove('crib-mode');
    page.remove();
  };
}
