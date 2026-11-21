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

/** Practice mode: each core stage's Java starts hidden behind a button. Off unless switched on. */
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

/** How many stages of each kind a page has: core (up to `core`), stretch (after it) and variant. */
export function stageKinds(p: Practice): { core: number; stretch: number; variant: number } {
  const core = p.parts.filter((pt) => pt.stage <= p.core && !pt.variant).length;
  const variant = p.parts.filter((pt) => pt.variant).length;
  return { core, stretch: p.parts.length - core - variant, variant };
}

/** "About 40 minutes · 3 core stages and 2 stretch stages · Java 21" */
export function factsLine(p: Practice): string {
  const k = stageKinds(p);
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const bits = [n(k.core, 'core stage', 'core stages')];
  if (k.stretch) bits.push(n(k.stretch, 'stretch stage', 'stretch stages'));
  if (k.variant) bits.push(n(k.variant, 'variant', 'variants'));
  const list = bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}` : bits[0];
  return `About ${p.minutes} minutes · ${list} · Java 21`;
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
  /** Words on the button: "the code". */
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
    say(hide ? "Practice mode on: each core stage's Java is hidden until you ask." : 'Practice mode off: the Java is shown.');
  });

  // ---- the head: title, summary, facts, what is tested and how to use the page ----
  // Pages written to the contract before 20 November 2026 lack `testing` and `use`; they draw without them.
  const testing = (p as Partial<Practice>).testing;
  const head = h(
    'header.page-head.pp-head', null,
    h('p.pp-kicker', null, h('a', { href: '#/p' }, 'Pairing practice')),
    h('h1', { tabIndex: -1 }, p.title),
    h('p.lede', null, inline(p.summary)),
    h('p.pp-facts', null, factsLine(p)),
    testing
      ? h(
          'section.pp-open', { 'aria-labelledby': 'pp-h-testing' },
          h('h2.pp-open-h', { id: 'pp-h-testing' }, 'What this is testing'),
          h('p', null, inline(testing.intro)),
          h('ul.pp-list.pp-open-list', null, testing.points.map((t) => h('li', null, inline(t)))),
        )
      : null,
    p.use ? h('section.pp-open', { 'aria-labelledby': 'pp-h-use' }, h('h2.pp-open-h', { id: 'pp-h-use' }, 'How to use this page'), h('p', null, inline(p.use))) : null,
  );

  // ---- the opening sections ----
  const section = (sid: string, title: string, ...children: (Node | null)[]) => h('section.pp-section', { id: `pp-${sid}`, 'aria-labelledby': `pp-h-${sid}` }, h('h2', { id: `pp-h-${sid}`, tabIndex: -1 }, title), ...children);
  const askId = nextId('pp-askcap');
  const outline = p.outline.replace(/\n+$/, '').split('\n');
  const opening = [
    section('brief', 'The brief', ...paras(p.brief)),
    section('given', 'What the starter gives you', h('ul.pp-list', null, p.given.map((t) => h('li', null, inline(t))))),
    section(
      'ask', 'Ask first',
      h('p.pp-intro', { id: askId }, 'Before typing, ask these. If nobody answers, say the assumption aloud and carry on.'),
      stackTable(['Ask', 'Why it matters', 'If nobody answers, assume'], p.ask.map((a) => [a.q, a.why, a.assume]), askId, '.pp-ask-table'),
    ),
    section('plan', 'The whole solution as pseudocode', fold(`Show the pseudocode`, `${outline.length} lines`, () => codeFrame(outline, { lang: 'pseudo', label: 'The whole solution, in pseudocode' }))),
  ];

  // ---- the stages, by kind ----
  const parts = [...p.parts].sort((a, b) => a.stage - b.stage);
  const kindOf = (pt: Part): Kind => (pt.variant ? 'variant' : pt.stage <= p.core ? 'core' : 'stretch');
  const core = parts.filter((pt) => kindOf(pt) === 'core');
  const stretch = parts.filter((pt) => kindOf(pt) === 'stretch');
  const variant = parts.find((pt) => kindOf(pt) === 'variant');

  // Places the address and the contents list can name: every part, and the last ten minutes.
  const FU_ID = 'last-ten-minutes';
  const partEls = new Map<string, HTMLElement>();
  const partSections = [...core, ...stretch].map((pt) => {
    const el = drawPart(pt, kindOf(pt), p, src, reveal, say);
    partEls.set(pt.id, el);
    return el;
  });

  // ---- the last ten minutes ----
  const answer = (a: string | string[]) => paras(Array.isArray(a) ? a : [a]);
  const fuDetails: HTMLDetailsElement[] = p.followUps.map((f) => h('details.pp-fu', null, h('summary', null, h('span', null, inline(f.q))), h('div.pp-fu-a', null, answer(f.a))) as HTMLDetailsElement);
  const setAll = (open: boolean) => fuDetails.forEach((d) => (d.open = open));
  const fuSection = section(
    FU_ID, 'The last ten minutes',
    h('p.pp-intro', null, 'What they ask once the code works, and what this solution leaves out. Answer each in about twenty seconds.'),
    h('p.pp-fu-tools', null, h('button.btn.quiet', { type: 'button', onclick: () => setAll(true) }, 'Open all'), h('button.btn.quiet', { type: 'button', onclick: () => setAll(false) }, 'Close all')),
    h('div.pp-fus', null, fuDetails),
  );
  partEls.set(FU_ID, fuSection);

  const variantEl = variant ? drawPart(variant, 'variant', p, src, reveal, say) : null;
  if (variant && variantEl) partEls.set(variant.id, variantEl);

  const foot = p.see.length
    ? h('nav.pp-see', { 'aria-labelledby': 'pp-see-h' }, h('span.pp-see-h', { id: 'pp-see-h' }, 'Related pages'), h('ul', null, p.see.map((s) => h('li', null, h('a', { href: s.href }, s.label)))))
    : null;

  // ---- contents ----
  const tocLinks = new Map<string, HTMLAnchorElement>();
  const tocItem = (key: string, label: (Node | string)[], cls: string | null, ...rest: (Node | string | null)[]) => {
    const a = h('a', { href: `#/p/${id}/${encodeURIComponent(key)}` }, ...label, ...rest);
    tocLinks.set(key, a);
    return h('li', { class: cls }, a);
  };
  const tocList = h(
    'ol.pp-toc-list', null,
    ...core.map((pt) => tocItem(pt.id, [h('span.pp-toc-n', null, `Stage ${pt.stage}`), h('span.pp-toc-title', null, inline(pt.title))], pt.stage === p.core ? 'is-core' : null, pt.stage === p.core ? h('span.pp-toc-core', null, `Stage ${pt.stage}: done here counts as finished`) : null)),
    ...stretch.map((pt) => tocItem(pt.id, [h('span.pp-toc-n', null, `Stage ${pt.stage}`), h('span.pp-toc-title', null, inline(pt.title))], 'is-light', h('span.pp-toc-ext', null, 'Stretch: say it, code it if there is time'))),
    tocItem(FU_ID, [h('span.pp-toc-n', null, ''), h('span.pp-toc-title', null, 'The last ten minutes')], 'is-light'),
    ...(variant ? [tocItem(variant.id, [h('span.pp-toc-n', null, ''), h('span.pp-toc-title', null, inline(variant.title))], 'is-light', h('span.pp-toc-ext', null, 'Variant'))] : []),
  );
  const toc = h('nav.pp-toc', { 'aria-labelledby': 'pp-toc-h' }, h('p.pp-toc-h', { id: 'pp-toc-h' }, 'On this page'), tocList);

  const body = h('div.pp-body', null, ...opening, h('div.pp-parts', null, partSections), fuSection, variantEl, foot);
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
    // At the foot of the page the last sections can never reach the line: mark the lowest one in view.
    const atFoot = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    for (const [pid, el] of partEls) if (el.getBoundingClientRect().top < (atFoot ? innerHeight * 0.6 : line)) at = pid;
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
    // A stretch stage or the variant lands on its section with its code still folded.
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
type Kind = 'core' | 'stretch' | 'variant';

/**
 * A disclosure: a real `<details>`, closed, whose content is built the first time it opens. `label` is what the
 * summary says; `count` a quieter note beside it, such as "41 lines".
 */
function fold(label: string, count: string | null, build: () => HTMLElement | HTMLElement[], cls = ''): HTMLDetailsElement {
  const d = h(`details.pp-fold${cls}`, null, h('summary', null, h('span.pp-fold-t', null, label), count ? h('span.pp-fold-n', null, count) : null)) as HTMLDetailsElement;
  let built = false;
  d.addEventListener('toggle', () => {
    if (!d.open || built) return;
    built = true;
    const made = build();
    d.append(...(Array.isArray(made) ? made : [made]));
  });
  return d;
}

/** A small picture in plain characters: never wraps, scrolls inside its frame only if it must. */
function sketchFigure(sk: { caption: string; text: string }): HTMLElement {
  const capId = nextId('pp-skcap');
  return h(
    'figure.pp-sketch', { 'aria-labelledby': capId },
    h('figcaption.pp-sketch-cap', { id: capId }, inline(sk.caption), h('span.pp-scroll-hint', null, 'Scrolls sideways')),
    scrollRegion(h('pre.pp-sketch-pre', null, sk.text.replace(/\n+$/, '')), plain(sk.caption)),
  );
}

/**
 * One stage. A core stage shows its five things: what is asked, the code, the design choice, a run, the pitfalls.
 * A stretch stage and the variant lead with what to say and fold the five things away.
 */
function drawPart(pt: Part, kind: Kind, p: Practice, src: PracticeSources, reveal: RevealFn, say: (t: string) => void): HTMLElement {
  const hid = `pp-h-part-${pt.id}`;
  const stageName = kind === 'variant' ? 'The variant' : `Stage ${pt.stage}`;
  // Each of the five headings carries the stage, so a reader part-way down still knows where they are.
  const thing = (title: string, ...children: (Node | null)[]) =>
    h('div.pp-thing', null, h('h3.pp-h3', null, h('span.pp-h3-stage', null, stageName), h('span.pp-h3-t', null, title)), ...children);

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
      javaEl = codeFrame(lines, { lang: 'java', label: `Stage ${pt.stage} Java`, title: [`What stage ${pt.stage} adds or changes`], tools: [copy] });
    }
  }

  // Practice mode hides the Java of a core stage only; anything folded is hidden until opened anyway.
  const javaBits: (Node | null)[] = [javaEl!];
  if (kind === 'core') {
    const r = reveal('the code', [javaEl!]);
    javaBits.unshift(r.note, r.button);
  }

  const pseudoLines = pt.pseudocode.replace(/\n+$/, '').split('\n');
  const folds = h(
    'div.pp-folds', null,
    fold('Pseudocode for this stage', `${pseudoLines.length} lines`, () => codeFrame(pseudoLines, { lang: 'pseudo', label: `Stage ${pt.stage} pseudocode` })),
    file
      ? fold('The whole file at this stage', `${lineCount(stripRegions(file))} lines`, () => {
          const all = stripRegions(file).replace(/\n+$/, '');
          const copyAll = h('button.btn.pp-copy', { type: 'button', 'aria-label': `Copy the whole file at stage ${pt.stage}` }, 'Copy') as HTMLButtonElement;
          copyAll.addEventListener('click', async () => {
            const ok = await copyText(`${all}\n`);
            flash(copyAll, ok);
            say(ok ? `The stage ${pt.stage} file copied: ${lineCount(all)} lines.` : 'This browser blocked copying. Select the code instead.');
          });
          return codeFrame(all.split('\n'), { lang: 'java', label: `Solution.java at stage ${pt.stage}`, title: ['Solution.java', h('span.pp-code-sub', null, ` · after stage ${pt.stage}`)], tools: [copyAll] });
        }, '.pp-whole')
      : null,
  );

  const five = () =>
    h(
      'div.pp-things', null,
      thing(
        'What is asked',
        h('blockquote.pp-ask', null, h('p.pp-ask-who', null, 'The interviewer says'), h('p', null, inline(pt.ask))),
        h('p.pp-tests-h', null, `Tests this stage adds (${pt.tests.length})`),
        h('ul.pp-test-list', null, pt.tests.map((t) => h('li', null, t))),
      ),
      thing('The code', pt.sketch ? sketchFigure(pt.sketch) : null, ...javaBits, folds),
      thing(
        'The design choice',
        h('p', null, inline(pt.choice ?? '')),
        h('aside.pp-say', { 'aria-label': 'Say it aloud' }, h('p.pp-say-who', null, 'Say it aloud'), h('p', null, inline(pt.say))),
      ),
      thing('A run', traceTable(pt.trace)),
      pt.pitfalls.length ? thing('Pitfalls', h('ul.pp-list', null, pt.pitfalls.map((t) => h('li', null, inline(t))))) : null,
    );

  const kicker =
    kind === 'core'
      ? h('p.pp-stage', null, h('span.pp-stage-n', null, `Stage ${pt.stage}`), pt.stage === p.core ? h('span.pp-stage-note', null, 'Core: done here counts as finished') : null)
      : h('p.pp-stage', null, h('span.pp-stage-n', null, kind === 'stretch' ? `Stretch · Stage ${pt.stage}` : 'Variant'), kind === 'variant' ? h('span.pp-stage-note', null, 'Another framing of the same task') : null);
  const head = h('header.pp-part-head', null, kicker, h('h2', { id: hid, tabIndex: -1 }, inline(pt.title)));

  if (kind === 'core') return h('section.pp-part.is-core', { id: `pp-part-${pt.id}`, 'aria-labelledby': hid }, head, five());

  const verbal = pt.verbal ?? [];
  const sayHid = nextId('pp-verbal-h');
  return h(
    `section.pp-part.is-${kind}`, { id: `pp-part-${pt.id}`, 'aria-labelledby': hid },
    head,
    verbal.length
      ? h(
          'div.pp-verbal', { role: 'group', 'aria-labelledby': sayHid },
          h('p.pp-verbal-h', { id: sayHid }, kind === 'stretch' ? 'If there is no time to code it, say this' : 'The takeaway'),
          verbal.length === 1 ? h('p', null, inline(verbal[0])) : h('ul.pp-list', null, verbal.map((t) => h('li', null, inline(t)))),
        )
      : null,
    pt.caveat ? h('p.pp-caveat', null, h('span.pp-caveat-who', null, 'Caveat'), ' ', inline(pt.caveat)) : null,
    fold('Show the code and the run', null, five, '.pp-more'),
  );
}
