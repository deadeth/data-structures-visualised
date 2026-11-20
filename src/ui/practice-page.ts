import './practice.css';
import { h, scrollRegion, tableRoles } from '../core/dom';
import { listing, tokenise } from '../core/code';
import { inline } from './inline';
import { plain } from '../reading';
import { FIXTURE_ID, GUIDE, PRACTICES, loadPractice, type PracticeEntry, type PracticeSources } from '../practice';
import { proseCell, stripRegions } from '../practice/java';
import { CLOCK_KEY, IDLE, clockText, elapsed, overBy, parseClock, spoken, start, stop, type ClockState } from '../practice/clock';
import type { Guide, GuideBlock, Part, Practice, Trace } from '../practice/types';

/**
 * Pairing practice pages. `#/p` is the guide and the list of pages; `#/p/<id>` is one page, and
 * `#/p/<id>/<part id>` the same page scrolled to that part. Moving between parts of the page on screen
 * scrolls; it never draws the page again, so the clock and anything opened stay as they were.
 */

/** Practice mode: each part's pseudocode and Java start folded behind a button. Off unless switched on. */
export const HIDE_KEY = 'dsv.practice.hide';

const read = (store: () => Storage, key: string): string | null => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const write = (store: () => Storage, key: string, value: string | null): void => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // Storage can be blocked; the page still works for this visit.
  }
};
const local = () => localStorage;
const session = () => sessionStorage;

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

// ---- small pieces ----------------------------------------------------------------------

const paras = (list: string[]) => list.map((t) => h('p', null, inline(t)));

/** One line of Java, coloured with the site's code tokens. */
function javaLine(text: string): (Node | string)[] {
  return tokenise(text, 'java').map((t) => (t.kind === 'plain' ? t.text : h(`span.tok-${t.kind}`, null, t.text)));
}

/**
 * A block of code in a frame of its own. Lines never wrap: the frame scrolls sideways, and while it does it
 * is a named region with a tab stop and says so in its header.
 */
function codeFrame(lines: string[], o: { lang: 'java' | 'pseudo'; label: string; title?: (Node | string)[]; tools?: HTMLElement[] }): HTMLElement {
  const code = h('code', null);
  lines.forEach((l, i) => {
    if (i) code.append('\n');
    code.append(...(o.lang === 'java' ? javaLine(l) : [l]));
  });
  const pre = scrollRegion(h(`pre.pp-pre.${o.lang}`, null, code), o.label);
  // A frame with no title has a header only while it scrolls, to carry the cue.
  return h(
    `figure.pp-code${o.title ? '' : '.no-title'}`, null,
    h('figcaption.pp-code-head', null, o.title ? h('span.pp-code-title', null, ...o.title) : null, h('span.pp-scroll-hint', null, 'Scrolls sideways'), ...(o.tools ?? [])),
    pre,
  );
}

/** Say on a copy button that it worked, for a moment, so the reader sees it wherever the button is. */
function flash(btn: HTMLButtonElement, ok: boolean): void {
  const was = btn.dataset.label ?? btn.textContent ?? '';
  btn.dataset.label = was;
  btn.textContent = ok ? 'Copied' : 'Copy blocked';
  clearTimeout(Number(btn.dataset.timer));
  btn.dataset.timer = String(window.setTimeout(() => (btn.textContent = was), 2000));
}

/** Copy text to the clipboard; where the clipboard API is blocked, fall back to a hidden text area. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked or refused: try the old way.
  }
  const back = document.activeElement as HTMLElement | null;
  try {
    const ta = h('textarea', { readOnly: true, 'aria-hidden': 'true', tabIndex: -1 }) as HTMLTextAreaElement;
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    back?.focus({ preventScroll: true });
    return ok;
  } catch {
    back?.focus({ preventScroll: true });
    return false;
  }
}

const lineCount = (src: string) => src.replace(/\n+$/, '').split('\n').length;

function seeKind(href: string): string {
  if (href.startsWith('#/s/')) return 'Animated page';
  if (/^#\/d\/[^/]+\/read/.test(href)) return 'Walkthrough';
  if (href.startsWith('#/d/')) return 'Interactive design';
  if (href.startsWith('#/c/')) return 'Reading';
  if (href.startsWith('#/p/')) return 'Pairing practice';
  return 'Page';
}

/** "About 40 minutes to stage 3 · 4 stages · Java 21" */
export function factsLine(p: Practice): string {
  const n = p.parts.length;
  return `About ${p.minutes} minutes to stage ${p.core} · ${n} ${n === 1 ? 'stage' : 'stages'} · Java 21`;
}

/** A table that is a real table on a wide screen and stacked cards on a phone (practice.css), its cells labelled by column. */
function stackTable(head: string[], rows: string[][], labelledBy?: string, cls = ''): HTMLElement {
  const t = h(
    `table.pp-table.stack${cls}`, { 'aria-labelledby': labelledBy },
    h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col' }, inline(c))))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row', 'data-label': plain(head[0]) }, inline(c)) : h('td', { 'data-label': plain(head[i] ?? '') }, inline(c))))))),
  );
  return tableRoles(t as HTMLTableElement);
}

/** A trace: a real table with a caption, scrolling sideways inside its own frame when it must, never the page. */
function traceTable(t: Trace): HTMLElement {
  const capId = nextId('pp-cap');
  const table = tableRoles(
    h(
      // A wide trace (seven columns or more) packs its cells closer so it fits the column where it can.
      `table.pp-trace${t.head.length >= 7 ? '.many' : ''}`, { 'aria-labelledby': capId },
      h('thead', null, h('tr', null, t.head.map((c) => h('th', { scope: 'col' }, inline(c))))),
      h('tbody', null, t.rows.map((r) => h('tr', null, r.map((c, i) => h(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, class: proseCell(c) ? 'prose' : null }, inline(c)))))),
    ) as HTMLTableElement,
  );
  return h(
    'div.pp-trace-box', null,
    h('p.pp-trace-cap', { id: capId }, inline(t.caption), h('span.pp-scroll-hint', null, 'Scrolls sideways')),
    scrollRegion(h('div.pp-trace-wrap', null, table), plain(t.caption)),
    t.note ? h('p.pp-trace-note', null, inline(t.note)) : null,
  );
}

// ---- the guide ----------------------------------------------------------------------------

function guideBlock(b: GuideBlock): HTMLElement {
  if ('p' in b) return h('p', null, inline(b.p));
  if ('list' in b) return h(b.ordered ? 'ol.pp-list.ordered' : 'ul.pp-list', null, b.list.map((t) => h('li', null, inline(t))));
  if ('table' in b) {
    const capId = b.caption ? nextId('pp-gcap') : undefined;
    return h('div.pp-gtable', null, b.caption ? h('p.pp-gtable-cap', { id: capId }, inline(b.caption)) : null, stackTable(b.table.head, b.table.rows, capId));
  }
  return h('aside.pp-callout', { 'aria-label': b.title ? plain(b.title) : 'Note' }, b.title ? h('p.pp-callout-title', null, inline(b.title)) : null, h('p', null, inline(b.callout)));
}

function card(e: PracticeEntry): HTMLElement {
  const p = e.page;
  return h(
    'li', null,
    h('a.pp-card', { href: `#/p/${e.id}` }, h('span.pp-card-title', null, p.title), h('span.pp-card-summary', null, plain(p.summary)), h('span.pp-card-facts', null, factsLine(p))),
  );
}

function mountGuide(host: HTMLElement, g: Guide | undefined = GUIDE, extra: PracticeEntry[] = []): () => void {
  const article = h(
    'article.pp.pp-guide', null,
    h('header.page-head.pp-head', null, h('p.pp-kicker', null, 'Pairing practice'), h('h1', { tabIndex: -1 }, g?.title ?? 'Pairing practice'), h('p.lede', null, inline(g?.summary ?? 'Small coding tasks of the kind set in a pair-programming interview, built a stage at a time in Java against a clock.'))),
    ...(g?.sections ?? []).map((s) => h('section.pp-section', { id: `pp-${s.id}`, 'aria-labelledby': `pp-h-${s.id}` }, h('h2', { id: `pp-h-${s.id}` }, inline(s.title)), s.blocks.map(guideBlock))),
    h(
      'section.pp-section', { 'aria-labelledby': 'pp-h-tasks' },
      h('h2', { id: 'pp-h-tasks' }, 'The tasks'),
      PRACTICES.length + extra.length ? h('ul.pp-cards', null, [...PRACTICES, ...extra].map(card)) : h('p', null, 'No tasks are written yet.'),
    ),
  );
  host.append(article);
  return () => article.remove();
}

// ---- one page -------------------------------------------------------------------------------

/** The page on screen, so a change of part in the address scrolls to it instead of drawing the page again. */
let current: { id: string; go: (part?: string) => void } | null = null;

/** Scroll the page on screen to a part, if the address names the page already shown. True when it did. */
export function goToPart(id: string, part?: string): boolean {
  if (!current || current.id !== id) return false;
  current.go(part);
  return true;
}

/** The title for the window: the guide's, a page's, or undefined when there is no such page. */
export async function practiceTitle(id?: string): Promise<string | undefined> {
  if (!id) return GUIDE?.title ?? 'Pairing practice';
  if (import.meta.env.DEV && id === 'fixture-guide') return 'Fixture guide';
  return (await loadPractice(id))?.page.title;
}

/** In development only: the fixture page's card on the guide, and a fixture guide at `#/p/fixture-guide`. */
async function devGuide(host: HTMLElement, id?: string): Promise<(() => void) | undefined> {
  if (!import.meta.env.DEV) return undefined;
  const fixture = await loadPractice(FIXTURE_ID);
  const extra = fixture && !id ? [fixture] : [];
  if (!id) return mountGuide(host, GUIDE, extra);
  if (id !== 'fixture-guide') return undefined;
  const g = (await import('../practice/__fixtures__/fixture-guide')).default;
  return mountGuide(host, g, fixture ? [fixture] : []);
}

export async function mountPractice(host: HTMLElement, id?: string, part?: string): Promise<() => void> {
  const dev = await devGuide(host, id);
  if (dev) return dev;
  if (!id) return mountGuide(host);
  const entry = await loadPractice(id);
  if (!entry) {
    const lost = h('h1', { tabIndex: -1 }, 'No page at this address');
    const article = h('article', null, lost, h('p', null, 'Pick a task from ', h('a', { href: '#/p' }, 'the pairing practice list'), ', or ', h('a', { href: '#/' }, 'go to the start'), '.'));
    host.append(article);
    lost.focus();
    return () => article.remove();
  }
  const src = await entry.sources();
  return drawPage(host, entry, src, part);
}

interface Reveal {
  /** The button, shown only in practice mode. */
  button: HTMLButtonElement;
  /** What it shows and hides. */
  targets: HTMLElement[];
  /** The note shown in their place while hidden. */
  note: HTMLElement;
  open: boolean;
  /** Words on the button: "pseudocode", "Java", "the plan". */
  what: string;
}

function drawPage(host: HTMLElement, entry: PracticeEntry, src: PracticeSources, part?: string): () => void {
  const p = entry.page;
  const id = entry.id;
  const offs: (() => void)[] = [];

  // ---- the tool bar: copy, download, practice mode, clock ----
  const status = h('p.pp-status', { role: 'status' });
  let statusTimer = 0;
  const say = (text: string) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    statusTimer = window.setTimeout(() => (status.textContent = ''), 8000);
  };
  offs.push(() => clearTimeout(statusTimer));

  const starterLines = entry.hasStarter ? lineCount(src.starter) : 0;
  const copyBtn = h('button.btn.pp-tool', { type: 'button', disabled: !entry.hasStarter }, 'Copy starter') as HTMLButtonElement;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(src.starter);
    flash(copyBtn, ok);
    say(ok ? `Starter copied: ${starterLines} lines. Paste it into the editor.` : 'This browser blocked copying. Use Download starter instead, or select the text of a whole file below.');
  });
  const downloadBtn = h('button.btn.pp-tool', { type: 'button', disabled: !entry.hasStarter }, 'Download starter') as HTMLButtonElement;
  downloadBtn.addEventListener('click', () => {
    try {
      const url = URL.createObjectURL(new Blob([src.starter], { type: 'text/x-java-source;charset=utf-8' }));
      const a = h('a', { href: url, download: 'Solution.java' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say('Downloading Solution.java.');
    } catch {
      say('This browser blocked the download. Use Copy starter instead.');
    }
  });

  let hide = read(local, HIDE_KEY) === 'on';
  const hideBox = h('input', { type: 'checkbox', id: 'pp-hide', role: 'switch', checked: hide }) as HTMLInputElement;
  const hideSwitch = h('span.pp-switch', null, hideBox, h('label', { for: 'pp-hide' }, 'Hide the code until I ask'));

  // The clock: a plain count-up against the page's target. It never makes a sound or scrolls the page.
  const key = CLOCK_KEY(id);
  let state: ClockState = parseClock(read(session, key));
  const timeEl = h('span.pp-time', { role: 'timer', 'aria-live': 'off' });
  const overEl = h('span.pp-over');
  const startBtn = h('button.btn.primary.pp-tool', { type: 'button' }) as HTMLButtonElement;
  const resetBtn = h('button.btn.pp-tool', { type: 'button' }, 'Reset') as HTMLButtonElement;
  const clockEl = h('div.pp-clock', { role: 'group', 'aria-label': 'Clock' }, h('span.pp-time-box', null, timeEl, overEl), startBtn, resetBtn);
  let wasOver = false;
  let tick = 0;
  const paint = () => {
    const ms = elapsed(state, Date.now());
    const running = state.since !== null;
    timeEl.textContent = clockText(ms, p.minutes);
    timeEl.setAttribute('aria-label', `${spoken(ms)} of ${p.minutes} minutes`);
    const over = overBy(ms, p.minutes);
    clockEl.classList.toggle('is-over', !!over);
    clockEl.classList.toggle('is-running', running);
    overEl.textContent = over ? `Over time by ${over}` : '';
    if (over && !wasOver && running) say(`Past the ${p.minutes} minutes. The clock keeps counting.`);
    wasOver = !!over;
    startBtn.textContent = running ? 'Stop' : ms > 0 ? 'Carry on' : 'Start the clock';
    miniStart.textContent = startBtn.textContent;
    miniTime.textContent = timeEl.textContent + (over ? ' · over' : '');
    mini.classList.toggle('is-over', !!over);
    resetBtn.hidden = ms === 0 && !running;
  };
  const save = () => write(session, key, state.since === null && state.before === 0 ? null : JSON.stringify(state));
  const run = () => {
    clearInterval(tick);
    if (state.since !== null) tick = window.setInterval(paint, 1000);
    paint();
  };
  // On a phone the bar stays at the top of the page; once it is scrolled away a slim strip with the clock takes its place.
  const miniTime = h('span.pp-mini-time', { 'aria-hidden': 'true' });
  const miniStart = h('button.btn.pp-tool', { type: 'button' }) as HTMLButtonElement;
  const toolsBtn = h('button.btn.pp-tool', { type: 'button', 'aria-label': 'Tools: copy, download, practice mode and the clock' }, 'Tools') as HTMLButtonElement;
  const mini = h('div.pp-mini', { role: 'group', 'aria-label': 'Clock' }, miniTime, miniStart, toolsBtn);
  const toggle = () => {
    const now = Date.now();
    if (state.since === null) {
      state = start(state, now);
      say(elapsed(state, now) ? 'Clock running again.' : `Clock started. Target: ${p.minutes} minutes to stage ${p.core}.`);
    } else {
      state = stop(state, now);
      say(`Clock stopped at ${spoken(elapsed(state, now))}.`);
    }
    save();
    run();
  };
  startBtn.addEventListener('click', toggle);
  miniStart.addEventListener('click', toggle);
  resetBtn.addEventListener('click', () => {
    state = IDLE;
    save();
    run();
    say('Clock reset to 0:00.');
    startBtn.focus();
  });
  wasOver = !!overBy(elapsed(state, Date.now()), p.minutes);
  run();
  const onVisible = () => paint();
  document.addEventListener('visibilitychange', onVisible);
  offs.push(() => {
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVisible);
  });

  const bar = h(
    'div.pp-bar', { role: 'group', 'aria-label': 'Practice tools' },
    // The status sits in the row, in the room between the switch and the clock, so a message never moves the page.
    h('div.pp-bar-row', null, h('div.pp-bar-files', null, copyBtn, downloadBtn), hideSwitch, status, clockEl),
  );

  // ---- reveals for practice mode ----
  const reveals: Reveal[] = [];
  const paintReveal = (r: Reveal) => {
    const shown = !hide || r.open;
    for (const t of r.targets) t.hidden = !shown;
    r.note.hidden = shown;
    r.button.hidden = !hide;
    r.button.setAttribute('aria-expanded', String(shown));
    r.button.textContent = `${shown ? 'Hide' : 'Show'} ${r.what}`;
  };
  const reveal = (what: string, targets: HTMLElement[]): { button: HTMLElement; note: HTMLElement } => {
    for (const t of targets) t.id ||= nextId('pp-r');
    const button = h('button.btn.pp-reveal', { type: 'button', 'aria-controls': targets.map((t) => t.id).join(' ') }) as HTMLButtonElement;
    const note = h('p.pp-hidden-note', null, `Hidden while you try it yourself.`);
    const r: Reveal = { button, targets, note, open: false, what };
    button.addEventListener('click', () => {
      r.open = !(!hide || r.open);
      paintReveal(r);
    });
    reveals.push(r);
    return { button, note };
  };
  hideBox.addEventListener('change', () => {
    hide = hideBox.checked;
    write(local, HIDE_KEY, hide ? 'on' : null);
    for (const r of reveals) {
      r.open = false;
      paintReveal(r);
    }
    say(hide ? 'Practice mode on: pseudocode and Java are folded until you ask.' : 'Practice mode off: everything is shown.');
  });

  // ---- the head ----
  const head = h(
    'header.page-head.pp-head', null,
    h('p.pp-kicker', null, h('a', { href: '#/p' }, 'Pairing practice')),
    h('h1', { tabIndex: -1 }, p.title),
    h('p.lede', null, inline(p.summary)),
    h('p.pp-facts', null, factsLine(p)),
  );

  // ---- the opening sections ----
  const section = (sid: string, title: string, ...children: (Node | null)[]) => h('section.pp-section', { id: `pp-${sid}`, 'aria-labelledby': `pp-h-${sid}` }, h('h2', { id: `pp-h-${sid}`, tabIndex: -1 }, title), ...children);
  const askId = nextId('pp-askcap');
  const planFrame = codeFrame(p.outline.replace(/\n+$/, '').split('\n'), { lang: 'pseudo', label: 'The plan, in pseudocode' });
  const planReveal = reveal('the plan', [planFrame]);
  const opening = [
    section('brief', 'The brief', ...paras(p.brief)),
    section('given', 'What you are given', h('ul.pp-list', null, p.given.map((t) => h('li', null, inline(t))))),
    section(
      'ask', 'Ask first',
      h('p.pp-intro', { id: askId }, 'Before typing, ask these. If nobody answers, say the assumption aloud and carry on.'),
      stackTable(['Ask', 'Why it matters', 'If nobody answers, assume'], p.ask.map((a) => [a.q, a.why, a.assume]), askId, '.pp-ask-table'),
    ),
    section('plan', 'The plan', planReveal.note, planReveal.button, planFrame),
  ];

  // ---- contents ----
  const parts = [...p.parts].sort((a, b) => a.stage - b.stage);
  const tocLinks = new Map<string, HTMLAnchorElement>();
  const tocList = h('ol.pp-toc-list', null, parts.map((pt) => {
    const a = h(
      'a', { href: `#/p/${id}/${encodeURIComponent(pt.id)}` },
      h('span.pp-toc-n', null, `Stage ${pt.stage}`),
      h('span.pp-toc-title', null, inline(pt.title)),
      pt.stage === p.core ? h('span.pp-toc-core', null, `Stage ${pt.stage}: done here counts as finished`) : pt.stage > p.core ? h('span.pp-toc-ext', null, 'Extension') : null,
    );
    tocLinks.set(pt.id, a);
    return h('li', { class: pt.stage === p.core ? 'is-core' : null }, a);
  }));
  const toc = h('nav.pp-toc', { 'aria-labelledby': 'pp-toc-h' }, h('p.pp-toc-h', { id: 'pp-toc-h' }, 'Stages'), tocList);

  // ---- the parts ----
  const partEls = new Map<string, HTMLElement>();
  const partSections = parts.map((pt) => {
    const el = drawPart(pt, p, src, reveal, say);
    partEls.set(pt.id, el);
    return el;
  });

  // ---- the closing sections ----
  const fuDetails: HTMLDetailsElement[] = p.followUps.map((f) => h('details.pp-fu', null, h('summary', null, h('span', null, inline(f.q))), h('div.pp-fu-a', null, paras(f.a))) as HTMLDetailsElement);
  const setAll = (open: boolean) => fuDetails.forEach((d) => (d.open = open));
  const closing = [
    section(
      'follow-ups', 'What they ask next',
      h('p.pp-fu-tools', null, h('button.btn.quiet', { type: 'button', onclick: () => setAll(true) }, 'Open all'), h('button.btn.quiet', { type: 'button', onclick: () => setAll(false) }, 'Close all')),
      h('div.pp-fus', null, fuDetails),
    ),
    section('mistakes', 'Where the time goes', h('ul.pp-list', null, p.mistakes.map((t) => h('li', null, inline(t))))),
    p.see.length
      ? section('see', 'See it move', h('ul.rd-see', { 'aria-label': 'Pages that show the mechanism' }, p.see.map((s) => h('li', null, h('a.rd-see-card', { href: s.href }, h('span.rd-see-kind', null, seeKind(s.href)), h('span.rd-see-label', null, s.label), h('span.rd-see-why', null, inline(s.why)))))))
      : null,
    section('simplified', 'What this page leaves out', h('ul.pp-list', null, p.simplified.map((t) => h('li', null, inline(t))))),
    p.unverified?.length
      ? h(
          'section.rd-unverified.pp-unverified', { 'aria-labelledby': 'pp-unverified-h' },
          h('h2', { id: 'pp-unverified-h' }, 'Not checked against a source'),
          h('p', null, 'The writer could not check these against a source. Treat them as likely, not certain.'),
          h('ul', null, p.unverified.map((u) => h('li', null, inline(u)))),
        )
      : null,
  ];

  const body = h('div.pp-body', null, ...opening, h('div.pp-parts', null, partSections), ...closing);
  const article = h('article.pp', null, head, bar, mini, h('div.pp-layout', null, toc, body));
  toolsBtn.addEventListener('click', () => {
    bar.scrollIntoView({ block: 'start' });
    copyBtn.focus({ preventScroll: true });
  });
  const phone = matchMedia('(max-width: 599px)');
  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver(([e]) => article.classList.toggle('bar-away', !e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(bar);
    offs.push(() => io.disconnect());
  }
  host.append(article);
  for (const r of reveals) paintReveal(r);

  // The bar's height, so a part scrolled to lands below it rather than under it.
  // On a phone that is the strip's height, which is fixed in practice.css.
  const syncBar = () => article.style.setProperty('--pp-bar-h', phone.matches ? '56px' : `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  syncBar();
  phone.addEventListener('change', syncBar);
  offs.push(() => phone.removeEventListener('change', syncBar));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(syncBar);
    ro.observe(bar);
    offs.push(() => ro.disconnect());
  }

  // The contents list marks the part being read.
  let mark = '';
  const setMark = (pid: string) => {
    if (pid === mark) return;
    mark = pid;
    for (const [k, a] of tocLinks) {
      if (k === pid) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    }
  };
  const onScroll = () => {
    const line = (phone.matches ? 56 : bar.getBoundingClientRect().height) + 80;
    let at = '';
    for (const [pid, el] of partEls) if (el.getBoundingClientRect().top < line) at = pid;
    const last = [...partEls.values()].at(-1);
    if (last && last.getBoundingClientRect().bottom < line) at = '';
    setMark(at);
  };
  let raf = 0;
  const scrolled = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      onScroll();
    });
  };
  addEventListener('scroll', scrolled, { passive: true });
  offs.push(() => {
    removeEventListener('scroll', scrolled);
    cancelAnimationFrame(raf);
  });
  onScroll();

  const go = (pid?: string) => {
    const el = pid ? partEls.get(pid) : undefined;
    if (!el) {
      window.scrollTo(0, 0);
      return;
    }
    el.scrollIntoView({ block: 'start' });
    el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    setMark(pid!);
  };
  if (part) requestAnimationFrame(() => go(part));
  current = { id, go };

  return () => {
    for (const off of offs) off();
    if (current?.id === id) current = null;
    article.remove();
  };
}

type RevealFn = (what: string, targets: HTMLElement[]) => { button: HTMLElement; note: HTMLElement };

function drawPart(pt: Part, p: Practice, src: PracticeSources, reveal: RevealFn, say: (t: string) => void): HTMLElement {
  const hid = `pp-h-part-${pt.id}`;
  const sub = (title: string) => h('h3.pp-h3', null, title);
  const stageNote = pt.stage === p.core ? 'Core: done here counts as finished' : pt.stage > p.core ? 'Extension' : null;

  // Pseudocode.
  const pseudo = codeFrame(pt.pseudocode.replace(/\n+$/, '').split('\n'), { lang: 'pseudo', label: `Stage ${pt.stage} pseudocode` });
  const pseudoReveal = reveal('pseudocode', [pseudo]);

  // The Java this stage adds, from the stage file's regions.
  const file = src.stages.get(pt.stage);
  let javaEl: HTMLElement;
  if (!file) javaEl = h('p.pp-missing', null, `The file for stage ${pt.stage} is not written yet.`);
  else {
    let lines: string[] | null = null;
    try {
      lines = listing(file, 'java', pt.regions).lines;
    } catch (e) {
      javaEl = h('p.pp-missing', null, (e as Error).message);
    }
    if (lines) {
      const text = lines.join('\n');
      const copy = h('button.btn.pp-copy', { type: 'button', 'aria-label': `Copy the stage ${pt.stage} Java` }, 'Copy') as HTMLButtonElement;
      copy.addEventListener('click', async () => {
        const ok = await copyText(text);
        flash(copy, ok);
        say(ok ? `Stage ${pt.stage} Java copied: ${lines!.length} lines.` : 'This browser blocked copying. Select the code instead.');
      });
      const frame = codeFrame(lines, { lang: 'java', label: `Stage ${pt.stage} Java`, title: [`What stage ${pt.stage} adds or changes`], tools: [copy] });

      // The whole file at this stage, region markers removed, built the first time it is opened.
      const whole = h('details.pp-whole', null, h('summary', null, h('span.pp-whole-t', null, 'The whole file at this stage'), h('span.pp-whole-n', null, `${lineCount(stripRegions(file))} lines`))) as HTMLDetailsElement;
      let built = false;
      whole.addEventListener('toggle', () => {
        if (!whole.open || built) return;
        built = true;
        const all = stripRegions(file).replace(/\n+$/, '');
        const copyAll = h('button.btn.pp-copy', { type: 'button', 'aria-label': `Copy the whole file at stage ${pt.stage}` }, 'Copy') as HTMLButtonElement;
        copyAll.addEventListener('click', async () => {
          const ok = await copyText(`${all}\n`);
          flash(copyAll, ok);
          say(ok ? `The stage ${pt.stage} file copied: ${lineCount(all)} lines.` : 'This browser blocked copying. Select the code instead.');
        });
        whole.append(codeFrame(all.split('\n'), { lang: 'java', label: `Solution.java at stage ${pt.stage}`, title: ['Solution.java', h('span.pp-code-sub', null, ` · after stage ${pt.stage}`)], tools: [copyAll] }));
      });
      javaEl = h('div.pp-java', null, frame, whole);
    }
  }

  // Notes on single lines go with the Java: in practice mode they show when it does.
  const lineNotes = pt.lines?.length
    ? h(
        'div.pp-lines-box', null,
        sub('Line by line'),
        h('dl.pp-lines', null, pt.lines.flatMap((l) => [h('dt', null, scrollRegion(h('code.pp-line-code', null, ...javaLine(l.code)), 'Line of Java')), h('dd', null, inline(l.note))])),
      )
    : null;
  const javaReveal = reveal('Java', [javaEl!, ...(lineNotes ? [lineNotes] : [])]);

  return h(
    'section.pp-part', { id: `pp-part-${pt.id}`, 'aria-labelledby': hid },
    h('header.pp-part-head', null, h('p.pp-stage', null, h('span.pp-stage-n', null, `Stage ${pt.stage}`), stageNote ? h('span.pp-stage-note', null, stageNote) : null), h('h2', { id: hid, tabIndex: -1 }, inline(pt.title))),
    h('blockquote.pp-ask', null, h('p.pp-ask-who', null, 'The interviewer says'), h('p', null, inline(pt.ask))),
    h('div.pp-tests', null, sub('Tests this stage adds'), h('ul.pp-test-list', null, pt.tests.map((t) => h('li', null, t)))),
    h('div.pp-block', null, sub('Pseudocode'), pseudoReveal.note, pseudoReveal.button, pseudo),
    h('div.pp-block', null, sub(`Java`), javaReveal.note, javaReveal.button, javaEl!),
    h('div.pp-block', null, sub('Why it is written this way'), ...paras(pt.explain)),
    lineNotes,
    h('div.pp-block', null, sub('A run'), traceTable(pt.trace)),
    h('aside.pp-say', { 'aria-label': 'Say it while you type' }, h('p.pp-say-who', null, 'Say it while you type'), h('p', null, inline(pt.say))),
    pt.pitfalls.length ? h('div.pp-block', null, sub('Pitfalls'), h('ul.pp-list', null, pt.pitfalls.map((t) => h('li', null, inline(t))))) : null,
  );
}
