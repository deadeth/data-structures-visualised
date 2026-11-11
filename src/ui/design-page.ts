import './design.css';
import { h, tableRoles } from '../core/dom';
import { MODES, type Component, type Design, type Flow } from '../designs/types';

const NS = 'http://www.w3.org/2000/svg';
const SPEEDS = [0.5, 1, 2] as const;
const SPEED_NAMES: Record<number, string> = { 0.5: 'Half speed', 1: 'Normal speed', 2: 'Double speed' };
/** Token travel at 1x, in diagram units a second. */
const PACE = 260;
/** The shortest leg at 1x, so that a short hop still reads as movement. */
const MIN_LEG = 700;
/** The shortest leg at any speed. */
const FLOOR_LEG = 450;
/** The pause at a turn (a question reaching its answer), at 1x. */
const HOLD = 250;
/** Fading the token out where it was and in where the next trip starts. */
const FADE = 120;
/** Further than this from the last stop, the token fades across rather than jumping. */
const JUMP = 30;
/** Chip height, in diagram units. */
const CHIP_H = 30;
/** Space between a chip and a label above or below it. */
const LABEL_GAP = 5;
/** Space between a chip and a label beside it: room for a short leader line. */
const SIDE_GAP = 11;
/** The token's height, in diagram units. */
const TOKEN_H = 26;
/** From this width the opened detail shares the screen with the diagram. */
const WIDE = '(min-width: 1366px)';
/** The smallest scale the diagram is drawn at before it pans: its smallest text (15.5 units) is then 12.4px. Matches design.css. */
const BASE_SCALE = 0.8;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = () => matchMedia('(pointer: coarse)').matches;
/** The site-wide switch for keyboard shortcuts, set beside the search box. */
const shortcutsOn = () => {
  try {
    return localStorage.getItem('dsv.shortcuts') !== 'off';
  } catch {
    return true;
  }
};
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const ICON = {
  restart: 'M6 5v14M19 5l-9 7 9 7V5z',
  back: 'M15 5l-8 7 8 7V5z',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  next: 'M9 5l8 7-8 7V5z',
  close: 'M6 6l12 12M18 6L6 18',
  up: 'M12 19V6M6 11l6-6 6 6',
};

function icon(name: keyof typeof ICON): SVGSVGElement {
  const svg = el('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' });
  const line = name === 'pause' || name === 'restart' || name === 'close' || name === 'up';
  svg.append(el('path', { d: ICON[name], fill: line ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Pt {
  x: number;
  y: number;
}

const union = (a: Box | null, b: Box): Box => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * One piece of the token's trip. A path runs along a connection; a hop fades
 * across a gap between two connections that do not touch; a hold waits at a
 * turn; a fade takes the token out where it was, or in where it starts.
 */
type Seg =
  | { kind: 'path'; el: SVGPathElement; back: boolean; full: number; len: number; label: string }
  | { kind: 'hop'; a: Pt; b: Pt; label: string; next: string }
  | { kind: 'hold'; at: Pt; label: string; next: string }
  | { kind: 'fade'; at: Pt; label: string; dir: 'out' | 'in' };

/**
 * A system design as an interactive diagram: a guided tour that follows one
 * URL round the loop, and boxes that open to explain themselves.
 */
export async function mountDesign(host: HTMLElement, design: Design, open?: { kind: string; id: string }): Promise<() => void> {
  const W = design.size.w;
  const H = design.size.h;
  const base = `#/d/${design.id}`;
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const flowById = new Map(design.flows.map((f) => [f.id, f]));
  const nameOf = (id: string) => byId.get(id)!.name;
  const sizeOf = (c: Component) => ({ w: c.w ?? 156, h: c.h ?? 56 });
  const boxOf = (id: string): Box => {
    const c = byId.get(id)!;
    const { w, h: hh } = sizeOf(c);
    return { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
  };
  const modeOf = (fl: Flow) => MODES.find((m) => m.id === fl.mode)!;
  const DETAIL_ID = `${design.id}-detail`;

  // ---- diagram ---------------------------------------------------------------
  // tabindex -1: the drawing itself is not a tab stop (Chrome would make it one); the box or chip inside it that holds the roving stop is.
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, tabindex: -1, role: 'group', 'aria-label': `${design.name}: components and the connections between them. Arrow keys move between them, Enter opens one.` }, 'hld-svg');
  svg.style.setProperty('--hld-w', String(W));
  svg.style.setProperty('--hld-h', String(H));
  const defs = el('defs');
  for (const [id, cls] of [['hld-arrow', 'hld-tip'], ['hld-arrow-live', 'hld-tip live'], ['hld-arrow-linked', 'hld-tip linked'], ['hld-arrow-quiet', 'hld-tip quiet']] as const) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0 L10,5 L0,10 z' }, cls));
    defs.append(m);
  }
  svg.append(defs);

  const fr = design.frame;
  svg.append(el('rect', { x: fr.x, y: fr.y, width: fr.w, height: fr.h, rx: 14 }, 'hld-frame'));
  const frameLabel = el('text', { x: fr.x + 12, y: fr.y + 20 }, 'hld-frame-label');
  frameLabel.textContent = fr.label;

  interface FlowEl {
    fl: Flow;
    path: SVGPathElement;
    chip: SVGGElement;
    chipRect: SVGRectElement;
    ring: SVGRectElement;
    chipText: SVGTextElement;
    label: SVGTextElement | null;
    leader: SVGLineElement | null;
  }
  const flowEls = new Map<string, FlowEl>();
  const flowLayer = el('g');
  const hitLayer = el('g');
  const labelLayer = el('g');
  const chipLayer = el('g');
  /** Every box and chip, in one roving tab stop. */
  const items: SVGGElement[] = [];
  const peekers: (() => void)[] = [];
  for (const fl of design.flows) {
    const path = el('path', { d: fl.d }, `hld-flow mode-${fl.mode}${fl.cold ? ' cold' : ''}`);
    flowLayer.append(path);
    // A wide invisible stroke makes a thin line easy to hit.
    const hit = el('path', { d: fl.d }, 'hld-hit');
    hit.addEventListener('click', () => pickFlow(fl.id, 'pointer', hit));
    hitLayer.append(hit);
    const chip = el(
      'g',
      { tabindex: -1, role: 'button', 'aria-expanded': 'false', 'aria-controls': DETAIL_ID, 'aria-label': `${nameOf(fl.from)} to ${nameOf(fl.to)}, by ${fl.via}${fl.label ? `: ${fl.label}` : ''}${fl.cold ? ', off the hot path' : ''}. Connection.` },
      `hld-chip mode-${fl.mode}${fl.cold ? ' cold' : ''}`,
    );
    chip.dataset.flow = fl.id;
    const ring = el('rect', { y: -CHIP_H / 2 - 5, height: CHIP_H + 10, rx: CHIP_H / 2 + 5 }, 'hld-ring');
    const chipRect = el('rect', { y: -CHIP_H / 2, height: CHIP_H, rx: CHIP_H / 2 }, 'hld-chip-box');
    const chipText = el('text', { y: 5.5, 'text-anchor': 'middle' });
    chipText.textContent = fl.via;
    chip.append(ring, chipRect, chipText);
    chip.addEventListener('click', (e) => pickFlow(fl.id, e.detail === 0 ? 'key' : 'pointer', chip));
    chipLayer.append(chip);
    items.push(chip);
    let label: SVGTextElement | null = null;
    let leader: SVGLineElement | null = null;
    if (fl.label) {
      leader = el('line', {}, 'hld-leader');
      label = el('text', {}, 'hld-flow-label');
      label.textContent = fl.label;
      label.dataset.flow = fl.id;
      labelLayer.append(leader, label);
    }
    // Pointing at a line or its chip, or focusing the chip, shows what travels on it.
    // Only a pointer that moves counts: a line scrolled under a resting pointer does not light up.
    const peek = (on: boolean) => {
      label?.classList.toggle('peek', on);
      leader?.classList.toggle('peek', on);
      path.classList.toggle('peek', on);
    };
    peekers.push(() => peek(false));
    for (const t of [hit, chip]) {
      t.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) peek(true);
      });
      t.addEventListener('pointerleave', () => peek(false));
    }
    chip.addEventListener('focus', () => peek(true));
    chip.addEventListener('blur', () => peek(false));
    flowEls.set(fl.id, { fl, path, chip, chipRect, ring, chipText, label, leader });
  }
  svg.append(flowLayer, hitLayer, frameLabel);

  const nodeEls = new Map<string, SVGGElement>();
  for (const c of design.components) {
    const { w, h: hh } = sizeOf(c);
    const rx = c.kind === 'input' ? hh / 2 : 10;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})`, tabindex: -1, role: 'button', 'aria-expanded': 'false', 'aria-controls': DETAIL_ID, 'aria-label': `${c.name}. ${c.tech}. Component.` }, `hld-node kind-${c.kind}`);
    g.dataset.id = c.id;
    g.append(el('rect', { x: -6, y: -6, width: w + 12, height: hh + 12, rx: rx + 6 }, 'hld-ring'));
    g.append(el('rect', { width: w, height: hh, rx }, 'hld-box'));
    if (c.kind === 'store') g.append(el('path', { d: `M10,${hh - 7} H${w - 10}` }, 'hld-shelf'));
    // A log is drawn as a row of segments along its lower edge: messages in order.
    if (c.kind === 'queue') g.append(el('path', { d: Array.from({ length: 9 }, (_, i) => `M${18 + i * ((w - 36) / 8)},${hh - 11} v6`).join(' ') }, 'hld-shelf'));
    const top = c.lines ? 23 : hh / 2 - 4;
    const name = el('text', { x: w / 2, y: top, 'text-anchor': 'middle' }, 'hld-name');
    name.textContent = c.short ?? c.name;
    const tech = el('text', { x: w / 2, y: top + 19, 'text-anchor': 'middle' }, 'hld-tech');
    tech.textContent = c.tech;
    g.append(name, tech);
    (c.lines ?? []).forEach((line, i) => {
      const t = el('text', { x: 14, y: top + 42 + i * 18 }, 'hld-line');
      t.textContent = line;
      g.append(t);
    });
    g.addEventListener('click', (e) => select(c.id, e.detail === 0 ? 'key' : 'pointer', g));
    nodeEls.set(c.id, g);
    items.push(g);
    svg.append(g);
  }
  svg.append(labelLayer, chipLayer);

  // The thing being followed: one URL, drawn in the colour this site keeps for the followed key.
  const token = el('g', { 'aria-hidden': 'true' }, 'hld-token');
  const tokenBox = el('rect', { y: -TOKEN_H / 2, height: TOKEN_H, rx: TOKEN_H / 2 });
  const tokenText = el('text', { y: 5, 'text-anchor': 'middle' });
  token.append(tokenBox, tokenText);
  token.style.display = 'none';
  svg.append(token);

  const canvas = h('div.hld-canvas', null);
  canvas.append(svg);
  const pan = h('div.hld-pan', null, canvas);
  const fitBtn = h('button.hld-fit', { type: 'button', 'aria-pressed': 'false', onclick: () => setFit(!fitted) }, 'Fit to width') as HTMLButtonElement;
  const panHint = h('span.hld-pan-hint', null);
  const panBar = h('div.hld-panbar', null, panHint, fitBtn);
  panBar.hidden = true;

  // ---- tour bar ----------------------------------------------------------------
  const restText = () => (coarse() ? design.restTouch : design.rest);
  const stepTitle = h('h2.hld-step-title', null, 'Take the tour, or open any box');
  const stepText = h('p.hld-step-text', null, restText());
  const stepVia = h('p.hld-step-via', null);
  const readout = h('div.hld-readout', null, stepTitle, stepText, stepVia);
  // A hidden copy, laid out at the same width, finds the tallest step so the readout never changes height mid-tour.
  const measure = h('div.hld-readout.hld-measure', { 'aria-hidden': 'true' }, h('h2.hld-step-title'), h('p.hld-step-text'), h('p.hld-step-via'));

  const playLabel = h('span.hld-play-text', null, 'Play the tour');
  const btn = (name: keyof typeof ICON, label: string, fn: () => void, cls = '') => h(`button.hld-icon${cls}`, { type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(name));
  const restartBtn = btn('restart', 'Back to the start', () => go(0, true), '.hld-restart');
  const backBtn = btn('back', 'Previous step', () => go(step - 1, true));
  const nextBtn = btn('next', 'Next step', () => go(step + 1, true));
  const playBtn = h('button.hld-play', { type: 'button', onclick: () => toggle() }, icon('play'), playLabel);
  const counter = h('span.hld-count', null, `${design.tour.length} steps`);
  const exploreBtn = h('button.hld-quiet', { type: 'button', title: 'Leave the tour', onclick: () => leaveTour(true) }, icon('close'), h('span', null, 'Leave the tour'));
  const speedBtns: HTMLButtonElement[] = [];
  const speedGroup = h('div.hld-speed', { role: 'group', 'aria-label': 'Tour speed' }, h('span', { 'aria-hidden': 'true' }, 'Speed'));
  for (const s of SPEEDS) {
    const b = h('button', { type: 'button', 'aria-pressed': String(s === 1), 'aria-label': SPEED_NAMES[s], title: SPEED_NAMES[s], onclick: () => setSpeed(s) }, `${s}×`) as HTMLButtonElement;
    speedBtns.push(b);
    speedGroup.append(b);
  }
  // On a phone the three speeds become one button that steps through them, so the transport fits one row.
  const speedCycle = h('button.hld-speed-cycle', { type: 'button', onclick: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]) }, '1×') as HTMLButtonElement;
  const transport = h('div.hld-transport', null, h('div.hld-nav', null, restartBtn, backBtn, playBtn, nextBtn), counter, exploreBtn, speedGroup, speedCycle);
  const head = h('div.hld-head', null, readout, transport, measure);

  // ---- detail ------------------------------------------------------------------
  const index = h('div.hld-index', { role: 'group', 'aria-label': 'All components' });
  const indexBtns = new Map<string, HTMLButtonElement>();
  for (const c of design.components) {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => select(c.id, 'text', b) }, c.name) as HTMLButtonElement;
    indexBtns.set(c.id, b);
    index.append(b);
  }
  const detailBody = h('div.hld-detail-body', { id: DETAIL_ID });
  const detail = h(
    'section.hld-detail', { 'aria-label': 'Details', tabIndex: -1 },
    h('h2.visually-hidden', null, 'Details'),
    detailBody,
    h('h2.hld-index-head', null, 'All components'),
    index,
  );

  const skip = h('button.hld-skip', { type: 'button', onclick: () => (index.querySelector('button') as HTMLElement).focus() }, 'Skip diagram');

  const sample = (mode: string, cold = false) => {
    const s2 = el('svg', { viewBox: '0 0 72 24', width: 72, height: 24, 'aria-hidden': 'true' });
    s2.append(el('path', { d: 'M2,12 H66' }, `hld-flow mode-${mode}${cold ? ' cold' : ''} sample`));
    const g = el('g', { transform: 'translate(30,12)' }, `hld-chip mode-${mode}${cold ? ' cold' : ''} sample`);
    g.append(el('rect', { x: -13, y: -8, width: 26, height: 16, rx: 8 }, 'hld-chip-box'));
    s2.append(g);
    return s2;
  };
  const legend = h(
    'ul.hld-legend', { 'aria-label': 'Key to the line styles and chips' },
    MODES.map((m) => h('li', { title: m.note }, sample(m.id), h('span', null, m.label))),
    h('li', { title: 'Used to recover or reprocess, not on every fetch.' }, sample('write', true), h('span', null, 'Off the hot path')),
  );

  const stage = h('section.hld', { 'aria-label': 'Interactive design diagram' }, head, skip, pan, panBar, legend);
  const status = h('p.visually-hidden', { role: 'status', 'aria-live': 'polite' });

  // ---- written sections ------------------------------------------------------------
  const list = (items2: string[]) => h('ul', null, items2.map((t) => h('li', null, t)));
  type Cell = string | HTMLElement;
  const table = (head2: string[], rows: Cell[][], cls: string) =>
    h(
      'div.table-wrap', null,
      // `stack` is the site's rule for restacking a table into labelled blocks on a phone.
      tableRoles(
        h(
          `table.${cls}.stack`, null,
          h('thead', null, h('tr', null, head2.map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows.map((r) => h('tr', null, r.map((t, i) => (i === 0 ? h('th', { scope: 'row' }, t) : h('td', { 'data-label': head2[i] }, t)))))),
        ),
      ),
    );
  const notes = h(
    'div.notes', null,
    ...design.brief.map((b) => h('section.note', null, h('h2', null, b.heading), list(b.points))),
    h('section.note.wide', null, h('h2', null, 'Numbers to have ready'), table(['Quantity', 'Assumption', 'Result'], design.numbers.map((n) => [n.what, n.assumption, n.result]), 'hld-table')),
    h(
      'section.note.wide', null,
      h('h2', null, 'Three versions of the question'),
      h('div.hld-framings', null, design.framings.map((x) => h('div', null, h('h3', null, x.name), h('p.hld-scale', null, x.scale), h('p', null, x.shape)))),
    ),
    h('section.note.wide', null, h('h2', null, 'Decisions worth defending'), table(['Choice', 'One way', 'The other way', 'The call here'], design.decisions.map((d) => [d.choice, d.a, d.b, d.call]), 'hld-table')),
    h(
      'section.note.wide', null,
      h('h2', null, 'How the parts talk'),
      h('p.hld-lead', null, 'Inside a node everything is a function call, so the decisions that must be fast and exact never cross the network. Between nodes it is a log. To the outside world it is HTTPS with deadlines. Select a connection to open it under the diagram.'),
      table(
        ['Connection', 'Method', 'Kind', 'Delivery'],
        design.flows.map((x) => {
          const b: HTMLButtonElement = h('button.hld-where', { type: 'button', onclick: () => pickFlow(x.id, 'text', b) }, `${nameOf(x.from)} to ${nameOf(x.to)}`);
          return [b, x.via, `${modeOf(x).label}${x.cold ? ', off the hot path' : ''}`, x.delivery];
        }),
        'hld-table',
      ),
    ),
    h('section.note.wide', null, h('h2', null, 'Failure drills'), h('dl.hld-drills', null, design.drills.flatMap((d) => [h('dt', null, d.name), h('dd', null, d.what)]))),
    h('section.note.wide.interview', null, h('h2', null, 'Say this in the interview'), list(design.interview)),
    h(
      'section.note.wide', { id: 'glossary' },
      h('h2', null, 'Glossary'),
      h(
        'dl.hld-glossary', null,
        design.glossary.map((g) => {
          const see: HTMLButtonElement | null = g.where ? h('button.hld-where', { type: 'button', onclick: () => select(g.where!, 'text', see!) }, `See ${nameOf(g.where)}`) : null;
          const links = [see, g.see ? h('a.hld-struct', { href: `#/s/${g.see.id}` }, `${g.see.label}, step by step`) : null].filter(Boolean) as HTMLElement[];
          return h(
            'div.hld-gloss-row', { id: `term-${slug(g.term)}`, tabIndex: -1 },
            h('dt', null, g.term),
            h('dd', null, h('p', null, g.text), links.length ? h('p.hld-gloss-links', null, links.flatMap((l, i) => (i ? [h('span.hld-sep', { 'aria-hidden': 'true' }, ' · '), l] : [l]))) : null),
          );
        }),
      ),
    ),
    h(
      'section.note.wide', null,
      h('h2', null, 'Sources'),
      h('ul.hld-sources', null, design.sources.map((s) => h('li', null, s.href ? h('a', { href: s.href, rel: 'noopener' }, s.label) : h('span.hld-source', null, s.label), ` ${s.note}`))),
    ),
  );

  const page = h('article.design', null, h('header.page-head', null, h('h1', null, design.name), h('p.lede', null, design.blurb)), stage, status, detail, notes);
  host.append(page);

  // ---- state ---------------------------------------------------------------------
  let step = -1;
  /** The step the reader left the tour at, so Play picks up there. */
  let leftAt = -1;
  let playing = false;
  let speed = 1;
  let selected: string | null = null;
  let picked: string | null = null;
  let fitted = false;
  let raf = 0;
  let timer = 0;
  let followRaf = 0;
  let resizeTimer = 0;
  let alive = true;
  /** Where to go back to from an open detail: the box or chip or button it was opened from, and the scroll there. */
  let origin: { el: Element; y: number; x: number } | null = null;
  /** The running trip: its pieces, which one the token is on, and how far along it. */
  let trip: { segs: Seg[]; i: number; u: number; last: number | null } | null = null;
  let dwellAt = 0;
  let dwellMs = 0;
  /** What was left of the wait at a step when the tour was paused. */
  let dwellLeft = 0;
  /** The pause between a step starting and its trip, while the view glides into place. */
  let starting = 0;
  /** Set when the tour is paused during that glide: the trip then waits at its start. */
  let holdTrip = false;
  /** The tallest step's readout, in pixels, at the current width. */
  let reserve = 0;
  /** Where the token is and what it says, while it is shown. */
  let tokenAt: { x: number; y: number; label: string } | null = null;
  /** The box or chip that holds the diagram's one tab stop. */
  let rove: SVGGElement = nodeEls.get(design.tour[0]?.focus[0] ?? design.components[0].id) ?? items[0];
  rove.setAttribute('tabindex', '0');

  // ---- layout that needs the browser: chip widths and label places ------------------------
  await document.fonts?.ready;
  if (!alive) return () => undefined;

  // Chips first: they sit on their lines where the data says.
  const taken: Box[] = design.components.map((c) => boxOf(c.id));
  const chipBox = new Map<string, Box>();
  for (const fe of flowEls.values()) {
    const { fl, path, chip, chipRect, ring, chipText } = fe;
    const p = path.getPointAtLength(path.getTotalLength() * (fl.chip ?? 0.5));
    const w = Math.max(46, chipText.getComputedTextLength() + 24);
    chipRect.setAttribute('x', String(-w / 2));
    chipRect.setAttribute('width', String(w));
    ring.setAttribute('x', String(-w / 2 - 5));
    ring.setAttribute('width', String(w + 10));
    chip.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    const b = { x: p.x - w / 2, y: p.y - CHIP_H / 2, w, h: CHIP_H };
    chipBox.set(fl.id, b);
    taken.push(b);
  }
  const fb = frameLabel.getBBox();
  taken.push({ x: fb.x - 4, y: fb.y, w: fb.width + 8, h: fb.height });
  const clear = (b: Box) =>
    b.x >= 2 && b.y >= 2 && b.x + b.w <= W - 2 && b.y + b.h <= H - 2 &&
    taken.every((t) => b.x + b.w + 3 <= t.x || t.x + t.w + 3 <= b.x || b.y + b.h + 2 <= t.y || t.y + t.h + 2 <= b.y);
  const labelBox = new Map<string, Box>();
  // Then labels, each pinned to its chip: the side the data names if it is clear, else the next clear side.
  // A label beside its chip gets a short leader line to it, so it never floats.
  for (const fe of flowEls.values()) {
    const { fl, path, label, leader } = fe;
    if (!label || !leader) continue;
    const len = path.getTotalLength();
    const t = fl.chip ?? 0.5;
    const c = chipBox.get(fl.id)!;
    const p = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    const a = path.getPointAtLength(Math.max(0, len * t - 5));
    const b = path.getPointAtLength(Math.min(len, len * t + 5));
    const across = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const first = fl.at ?? (across ? 'above' : 'right');
    const sides = [first, ...(['above', 'below', 'right', 'left'] as const).filter((x) => x !== first)];
    label.setAttribute('x', '0');
    label.setAttribute('y', '0');
    const tb = label.getBBox();
    const lw = tb.width;
    const lh = tb.height;
    const asc = -tb.y;
    let spot: { x: number; y: number; anchor: string; box: Box; side: string } | null = null;
    for (const side of sides) {
      const tries: { x: number; y: number; anchor: string }[] = [];
      if (side === 'above' || side === 'below') {
        const y = side === 'above' ? c.y - LABEL_GAP - (lh - asc) : c.y + c.h + LABEL_GAP + asc;
        tries.push({ x: p.x, y, anchor: 'middle' }, { x: c.x + 6, y, anchor: 'start' }, { x: c.x + c.w - 6, y, anchor: 'end' });
      } else {
        const x = side === 'left' ? c.x - SIDE_GAP : c.x + c.w + SIDE_GAP;
        const anchor = side === 'left' ? 'end' : 'start';
        for (const dy of [0, -10, 10]) tries.push({ x, y: p.y + asc / 2 - 0.5 + dy, anchor });
      }
      for (const tr of tries) {
        const x0 = tr.anchor === 'middle' ? tr.x - lw / 2 : tr.anchor === 'end' ? tr.x - lw : tr.x;
        const box = { x: x0, y: tr.y - asc, w: lw, h: lh };
        if (clear(box)) {
          spot = { ...tr, box, side };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) {
      const y = c.y - LABEL_GAP - (lh - asc);
      spot = { x: p.x, y, anchor: 'middle', box: { x: p.x - lw / 2, y: y - asc, w: lw, h: lh }, side: 'above' };
    }
    label.setAttribute('x', spot.x.toFixed(1));
    label.setAttribute('y', spot.y.toFixed(1));
    label.setAttribute('text-anchor', spot.anchor);
    taken.push(spot.box);
    labelBox.set(fl.id, spot.box);
    if (spot.side === 'left' || spot.side === 'right') {
      const ly = spot.box.y + spot.box.h / 2;
      const x1 = spot.side === 'left' ? c.x - 1 : c.x + c.w + 1;
      const x2 = spot.side === 'left' ? spot.box.x + spot.box.w + 2 : spot.box.x - 2;
      leader.setAttribute('x1', x1.toFixed(1));
      leader.setAttribute('y1', p.y.toFixed(1));
      leader.setAttribute('x2', x2.toFixed(1));
      leader.setAttribute('y2', ly.toFixed(1));
    } else leader.remove();
  }

  // ---- roving focus: one tab stop for the diagram, arrow keys move by where things are ----
  const centreOf = (g: SVGGElement): Pt => {
    const id = g.dataset.id;
    if (id) {
      const b = boxOf(id);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    const b = chipBox.get(g.dataset.flow!)!;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  };
  function setRove(g: SVGGElement, focus: boolean): void {
    if (rove !== g) {
      rove.setAttribute('tabindex', '-1');
      g.setAttribute('tabindex', '0');
      rove = g;
    }
    if (focus) g.focus();
  }
  function nearest(from: SVGGElement, key: string): SVGGElement | null {
    const a = centreOf(from);
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
    if (!dir) return null;
    let best: SVGGElement | null = null;
    let bestScore = Infinity;
    for (const g of items) {
      if (g === from) continue;
      const b = centreOf(g);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 4) continue;
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      // Ahead counts once, sideways counts more, so the next thing in a row or column wins.
      const score = along + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = g;
      }
    }
    return best;
  }
  svg.addEventListener('keydown', (e) => {
    const g = (e.target as Element).closest('.hld-node, .hld-chip') as SVGGElement | null;
    if (!g || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (g.dataset.id) select(g.dataset.id, 'key', g);
      else pickFlow(g.dataset.flow!, 'key', g);
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      e.stopPropagation();
      const n = nearest(g, e.key);
      if (n) setRove(n, true);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      const sorted = [...items].sort((p, q) => centreOf(p).y - centreOf(q).y || centreOf(p).x - centreOf(q).x);
      setRove(e.key === 'Home' ? sorted[0] : sorted[sorted.length - 1], true);
    }
  });
  svg.addEventListener('focusin', (e) => {
    const g = (e.target as Element).closest('.hld-node, .hld-chip') as SVGGElement | null;
    if (g) setRove(g, false);
  });

  // ---- detail ------------------------------------------------------------------------
  const backLabel = () => (step >= 0 ? `Back to step ${step + 1}` : 'Back to diagram');
  const backControl = () => h('button.hld-back', { type: 'button', onclick: () => backTo() }, icon('up'), h('span', null, backLabel()));

  function renderDetail(c: Component | null, note?: string): void {
    if (!c) {
      detailBody.replaceChildren(
        ...(note ? [h('p.hld-missing', { tabIndex: -1 }, note)] : []),
        h('p.hld-hint', null, 'Select a box in the diagram, or a name below, to see what it does, why it is separate, how it fails and what you could use instead. Select a chip on a line to see how two parts talk.'),
      );
      return;
    }
    const alt = (a: Component['alternatives'][number]) =>
      h(
        `li${a.chosen ? '.chosen' : ''}`, null,
        h('p.hld-alt-name', null, a.name, a.chosen ? h('span.hld-used', null, 'used here') : null),
        h('p', null, h('span.hld-k', null, 'For: '), a.good),
        h('p', null, h('span.hld-k', null, 'Against: '), a.cost),
      );
    detailBody.replaceChildren(
      h('div.hld-detail-head', null, h('h3', { tabIndex: -1 }, c.name), h('p.hld-detail-tech', null, c.tech), backControl()),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          h('h4', null, 'What it does'), h('p.hld-first', null, c.what),
          h('h4', null, 'Why it is its own box'), h('p', null, c.why),
          c.numbers?.length ? h('h4', null, 'Numbers') : null,
          c.numbers?.length ? list(c.numbers) : null,
          h('h4', null, 'When it fails'), h('p', null, c.fails),
        ),
        h('div', null, h('h4', null, 'Alternatives'), h('ul.hld-alts', null, c.alternatives.map(alt))),
      ),
      h('p.hld-say', null, h('span.hld-k', null, 'Say: '), c.say),
      ...(c.see?.length
        ? [h('p.hld-see', null, 'The data structure inside: ', c.see.flatMap((s, i) => [i ? ', ' : '', h('a', { href: `#/s/${s.id}` }, s.label)]))]
        : []),
    );
  }

  function renderFlow(fl: Flow): void {
    const mode = modeOf(fl);
    detailBody.replaceChildren(
      h('div.hld-detail-head', null, h('h3', { tabIndex: -1 }, `${nameOf(fl.from)} to ${nameOf(fl.to)}`), h('p.hld-detail-tech', null, `${fl.via}, ${mode.label.toLowerCase()}${fl.cold ? ', off the hot path' : ''}`), backControl()),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          fl.label ? [h('h4', null, 'What travels'), h('p.hld-first', null, fl.label[0].toUpperCase() + fl.label.slice(1))] : null,
          h('h4', null, 'How they talk'), h(`p${fl.label ? '' : '.hld-first'}`, null, fl.how),
          h('h4', null, 'What is promised'), h('p', null, fl.delivery),
          h('h4', null, `About a ${mode.label.toLowerCase()}`), h('p', null, mode.note),
        ),
        h(
          'div', null,
          h('h4', null, 'Ways to connect them'),
          h(
            'ul.hld-alts', null,
            h('li.chosen', null, h('p.hld-alt-name', null, `${fl.via}, ${mode.label.toLowerCase()}`, h('span.hld-used', null, 'used here'))),
            fl.alts.map((a) => h('li', null, h('p', null, a))),
          ),
        ),
      ),
    );
  }

  /** The address for what is on screen, so a view can be shared. Replaces, never adds, a history entry. */
  function setUrl(): void {
    if (!alive) return;
    const want = selected ? `${base}/c/${selected}` : picked ? `${base}/f/${picked}` : step >= 0 ? `${base}/t/${step + 1}` : base;
    if (location.hash !== want) history.replaceState(history.state, '', want);
  }

  const smooth = (): ScrollBehavior => (reducedMotion() ? 'auto' : 'smooth');

  /**
   * Bring the opened detail into view. On a wide screen the page moves only as
   * far as it must to show the whole diagram and the detail's first paragraph
   * together. Narrower, the detail comes to the top, with a way back.
   */
  function reveal(behavior: ScrollBehavior): void {
    const first = detailBody.querySelector('.hld-first') ?? detailBody;
    const headH = step >= 0 && !stage.classList.contains('reading') ? head.offsetHeight : 0;
    if (matchMedia(WIDE).matches) {
      const c = canvas.getBoundingClientRect();
      const f = first.getBoundingClientRect();
      let dy = 0;
      if (f.bottom > innerHeight - 12) dy = f.bottom - innerHeight + 12;
      if (c.top - dy < headH + 8) dy = c.top - headH - 8;
      if (Math.abs(dy) > 1) window.scrollBy({ top: dy, behavior });
    } else {
      const d = detailBody.getBoundingClientRect();
      window.scrollBy({ top: d.top - headH - 12, behavior });
    }
  }

  function markOpen(): void {
    for (const [nid, g] of nodeEls) {
      g.classList.toggle('selected', nid === selected);
      g.setAttribute('aria-expanded', String(nid === selected));
    }
    for (const [nid, b] of indexBtns) b.setAttribute('aria-pressed', String(nid === selected));
    paintFlows();
    stage.classList.toggle('reading', !!(selected || picked));
    setUrl();
  }

  type How = 'pointer' | 'key' | 'text';
  /** Open (or, picked again from the diagram, close) a component. */
  function select(id: string, how: How, from?: Element): void {
    const wasPlaying = playing;
    if (playing) pause(false);
    picked = null;
    const closing = selected === id && how !== 'text';
    selected = closing ? null : id;
    renderDetail(selected ? byId.get(selected)! : null);
    markOpen();
    if (!selected) {
      origin = null;
      return;
    }
    afterOpen(how, from, wasPlaying, byId.get(id)!.name);
  }

  function pickFlow(id: string, how: How, from?: Element): void {
    const wasPlaying = playing;
    if (playing) pause(false);
    selected = null;
    const closing = picked === id && how !== 'text';
    picked = closing ? null : id;
    if (picked) renderFlow(flowById.get(picked)!);
    else renderDetail(null);
    markOpen();
    if (!picked) {
      origin = null;
      return;
    }
    const fl = flowById.get(id)!;
    afterOpen(how, from, wasPlaying, `${nameOf(fl.from)} to ${nameOf(fl.to)}`);
  }

  function afterOpen(how: How, from: Element | undefined, wasPlaying: boolean, what: string): void {
    origin = from ? { el: from, y: window.scrollY, x: canvas.scrollLeft } : null;
    const h3 = detailBody.querySelector('h3');
    // From the diagram, the notes or a link alike: on a wide screen the diagram and the detail share the screen; narrower, the detail comes to the top.
    reveal(how === 'text' ? 'auto' : smooth());
    if (how !== 'pointer') h3?.focus({ preventScroll: true });
    status.textContent = `${wasPlaying ? `Paused at step ${step + 1}. ` : ''}Showing ${what}.`;
  }

  /** Go back to where the detail was opened from, leaving it open. */
  function backTo(): void {
    stage.classList.remove('reading');
    const back = origin;
    if (back && back.el.isConnected) {
      window.scrollTo({ top: back.y, behavior: 'auto' });
      canvas.scrollLeft = back.x;
      (back.el as HTMLElement).focus({ preventScroll: true });
      const r = back.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) (back.el as HTMLElement).scrollIntoView({ block: 'center' });
    } else {
      stage.scrollIntoView({ block: 'start', behavior: 'auto' });
      if (step >= 0) follow(step, true);
      rove.focus({ preventScroll: true });
    }
  }

  /** Close an open box or connection, and take the reader back to where they opened it. */
  function close(): void {
    const back = origin;
    selected = null;
    picked = null;
    renderDetail(null);
    markOpen();
    origin = back;
    backTo();
    origin = null;
  }

  function paintFlows(light = true): void {
    const s = step >= 0 && light ? design.tour[step] : null;
    const live = new Set((s?.path ?? []).map((p) => p.replace(/^</, '')));
    const back = new Set((s?.path ?? []).filter((p) => p.startsWith('<')).map((p) => p.slice(1)));
    for (const { fl, path, chip, label, leader } of flowEls.values()) {
      const linked = selected != null && (fl.from === selected || fl.to === selected);
      const on = fl.id === picked;
      const isLive = live.has(fl.id);
      path.classList.toggle('live', isLive);
      // A connection travelled both ways in one step gets an arrowhead at each end.
      path.classList.toggle('both', isLive && back.has(fl.id));
      path.classList.toggle('linked', (linked || on) && !isLive);
      chip.classList.toggle('live', isLive);
      chip.classList.toggle('picked', on);
      chip.setAttribute('aria-expanded', String(on));
      label?.classList.toggle('on', isLive || on || linked);
      leader?.classList.toggle('on', isLive || on || linked);
    }
  }

  function sync(light = true): void {
    const inTour = step >= 0;
    const s = inTour ? design.tour[step] : null;
    stepTitle.textContent = s ? s.title : 'Take the tour, or open any box';
    stepText.textContent = s ? s.text : restText();
    counter.textContent = inTour ? `Step ${step + 1} of ${design.tour.length}` : `${design.tour.length} steps`;
    stepVia.replaceChildren(...(s ? viaLine(s.path) : []));
    readout.style.minHeight = inTour && reserve ? `${reserve}px` : '';
    const focus = new Set(light ? (s?.focus ?? []) : []);
    for (const [id, g] of nodeEls) {
      g.classList.toggle('lit', focus.has(id));
      g.classList.toggle('quiet', inTour && !focus.has(id));
    }
    stage.classList.toggle('touring', inTour);
    stage.classList.toggle('playing', playing);
    const atEnd = step === design.tour.length - 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), playLabel);
    playLabel.textContent = playing ? 'Pause' : !inTour ? (leftAt > 0 ? `Resume at step ${leftAt + 1}` : 'Play the tour') : atEnd && !trip ? 'Replay' : 'Play';
    playBtn.setAttribute('aria-label', playLabel.textContent);
    restartBtn.disabled = inTour ? step <= 0 : leftAt <= 0;
    backBtn.disabled = step <= 0;
    nextBtn.disabled = atEnd;
    exploreBtn.hidden = !inTour;
    document.documentElement.style.scrollPaddingTop = inTour ? `${head.offsetHeight + 8}px` : '';
    paintFlows(light);
  }

  function viaLine(path: string[]): (string | HTMLElement)[] {
    const ways = [...new Set(path.map((p) => flowById.get(p.replace(/^</, ''))!).map((x) => {
      const kind = modeOf(x).label.toLowerCase();
      return kind.startsWith(x.via.toLowerCase()) ? kind : `${x.via} (${kind})`;
    }))];
    return ways.length ? [h('span.hld-k', null, 'Travels by: '), ways.join(', then ')] : [];
  }

  /** Find the tallest readout of all the steps at the current width. */
  function measureReserve(): void {
    const [t, p, v] = Array.from(measure.children) as HTMLElement[];
    measure.style.width = `${readout.clientWidth}px`;
    let most = 0;
    for (const s of design.tour) {
      t.textContent = s.title;
      p.textContent = s.text;
      v.replaceChildren(...viaLine(s.path));
      most = Math.max(most, measure.offsetHeight);
    }
    reserve = Math.ceil(most);
    if (step >= 0) readout.style.minHeight = `${reserve}px`;
  }

  // ---- the token -----------------------------------------------------------------
  const tokenWidth = (label: string) => Math.max(46, label.length * 9.4 + 24);

  function place(x: number, y: number, label: string, opacity = 1): void {
    const w = tokenWidth(label);
    tokenBox.setAttribute('x', String(-w / 2));
    tokenBox.setAttribute('width', String(w));
    tokenText.textContent = label;
    token.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    token.style.opacity = opacity >= 1 ? '' : Math.max(0, opacity).toFixed(2);
    token.style.display = '';
    tokenAt = { x, y, label };
  }
  function hideToken(): void {
    token.style.display = 'none';
    tokenAt = null;
  }
  const tokenShown = () => token.style.display !== 'none' && (token.style.opacity === '' || +token.style.opacity > 0.05);

  /**
   * The connections of one step in order, each with the label the token
   * carries on it: the question going out, the answer on any leg that comes
   * back to where the trip started. The last leg stops short of its arrowhead
   * so the token never covers the name in the box it reaches.
   */
  function pathLegs(i: number): Extract<Seg, { kind: 'path' }>[] {
    const s = design.tour[i];
    const out = s.token ?? 'URL';
    const legs: Extract<Seg, { kind: 'path' }>[] = [];
    let startAt: string | null = null;
    s.path.forEach((p, n) => {
      const back = p.startsWith('<');
      const fl = flowById.get(p.replace(/^</, ''))!;
      const from = back ? fl.to : fl.from;
      const to = back ? fl.from : fl.to;
      startAt ??= from;
      const label = n > 0 && to === startAt ? s.back ?? out : out;
      const pe = flowEls.get(fl.id)!.path;
      const full = pe.getTotalLength();
      let len = full;
      if (n === s.path.length - 1) {
        const e1 = pe.getPointAtLength(back ? 0 : full);
        const e0 = pe.getPointAtLength(back ? Math.min(full, 6) : Math.max(0, full - 6));
        const across = Math.abs(e1.x - e0.x) >= Math.abs(e1.y - e0.y);
        const r = (across ? tokenWidth(label) / 2 : TOKEN_H / 2) + 7;
        len = Math.max(full * 0.45, full - r);
      }
      legs.push({ kind: 'path', el: pe, back, full, len, label });
    });
    return legs;
  }
  const legStart = (l: Extract<Seg, { kind: 'path' }>): Pt => l.el.getPointAtLength(l.back ? l.full : 0);
  const legEnd = (l: Extract<Seg, { kind: 'path' }>): Pt => l.el.getPointAtLength(l.back ? l.full - l.len : l.len);

  /** The whole trip for step i, from wherever the token is now. */
  function tripFor(i: number): Seg[] {
    const legs = pathLegs(i);
    const segs: Seg[] = [];
    const s = design.tour[i];
    const firstAt = legs.length ? legStart(legs[0]) : endOf(i);
    const firstLabel = legs.length ? legs[0].label : s.token ?? 'URL';
    // Never jump: fade out where it was, and in where it starts.
    if (tokenAt && tokenShown() && Math.hypot(tokenAt.x - firstAt.x, tokenAt.y - firstAt.y) > JUMP) {
      segs.push({ kind: 'fade', at: { x: tokenAt.x, y: tokenAt.y }, label: tokenAt.label, dir: 'out' });
      segs.push({ kind: 'fade', at: firstAt, label: firstLabel, dir: 'in' });
    } else if (!tokenAt || !tokenShown()) segs.push({ kind: 'fade', at: firstAt, label: firstLabel, dir: 'in' });
    legs.forEach((l, n) => {
      if (n > 0) {
        const prev = legEnd(legs[n - 1]);
        const start = legStart(l);
        const d = Math.hypot(start.x - prev.x, start.y - prev.y);
        if (d > 8) segs.push({ kind: 'hop', a: prev, b: start, label: legs[n - 1].label, next: l.label });
        else segs.push({ kind: 'hold', at: prev, label: legs[n - 1].label, next: l.label });
      }
      segs.push(l);
    });
    return segs;
  }

  /** How long a piece of the trip takes, in real milliseconds at the current speed. */
  function durOf(sg: Seg): number {
    if (sg.kind === 'path') return Math.max(FLOOR_LEG, Math.max(MIN_LEG, (sg.len / PACE) * 1000) / speed);
    if (sg.kind === 'hold') return Math.max(160, HOLD / speed);
    if (sg.kind === 'hop') return 2 * FADE + 80;
    return FADE;
  }

  function drawSeg(sg: Seg, u: number): void {
    if (sg.kind === 'path') {
      const d = ease(u) * sg.len;
      const pt = sg.el.getPointAtLength(sg.back ? sg.full - d : d);
      place(pt.x, pt.y, sg.label);
    } else if (sg.kind === 'hold') place(sg.at.x, sg.at.y, u < 0.5 ? sg.label : sg.next);
    else if (sg.kind === 'hop') {
      // Fade out, glide unseen, fade in: no jump, and no line drawn where none exists.
      const o = u < 0.38 ? 1 - u / 0.38 : u > 0.62 ? (u - 0.62) / 0.38 : 0;
      const k = Math.min(1, Math.max(0, (u - 0.38) / 0.24));
      place(sg.a.x + (sg.b.x - sg.a.x) * k, sg.a.y + (sg.b.y - sg.a.y) * k, u < 0.5 ? sg.label : sg.next, o);
    } else place(sg.at.x, sg.at.y, sg.label, sg.dir === 'out' ? 1 - u : u);
  }

  function tick(now: number): void {
    raf = 0;
    if (!alive || !trip) return;
    let dt = trip.last == null ? 0 : now - trip.last;
    trip.last = now;
    while (dt > 0 && trip.i < trip.segs.length) {
      const dur = durOf(trip.segs[trip.i]);
      const rem = (1 - trip.u) * dur;
      if (dt >= rem) {
        dt -= rem;
        trip.i++;
        trip.u = 0;
      } else {
        trip.u += dt / dur;
        dt = 0;
      }
    }
    if (trip.i >= trip.segs.length) {
      drawSeg(trip.segs[trip.segs.length - 1], 1);
      trip = null;
      sync();
      dwell(step);
      return;
    }
    drawSeg(trip.segs[trip.i], trip.u);
    raf = requestAnimationFrame(tick);
  }

  /** Where the token is at the end of a step, or where it waits on a step with no path. */
  function endOf(i: number): Pt {
    for (let k = i; k >= 0; k--) {
      const legs = pathLegs(k);
      if (legs.length) return legEnd(legs[legs.length - 1]);
    }
    const b = boxOf(design.tour[i].focus[0]);
    return { x: b.x + b.w / 2, y: b.y - 20 };
  }

  /** Everything the reader needs to see for one step, in diagram units: lit boxes, the trip, its labels and where it stops. */
  function stepBox(i: number): Box {
    const s = design.tour[i];
    let u: Box | null = null;
    for (const id of s.focus) u = union(u, boxOf(id));
    for (const p of s.path) {
      const id = p.replace(/^</, '');
      const b = flowEls.get(id)!.path.getBBox();
      u = union(u, { x: b.x, y: b.y, w: b.width, h: b.height });
      u = union(u, chipBox.get(id)!);
      const lb = labelBox.get(id);
      if (lb) u = union(u, lb);
    }
    const e = endOf(i);
    const tw = Math.max(tokenWidth(s.token ?? 'URL'), tokenWidth(s.back ?? ''));
    u = union(u, { x: e.x - tw / 2, y: e.y - TOKEN_H / 2, w: tw, h: TOKEN_H });
    return u!;
  }

  /**
   * Keep the step in view. When the readout, the transport and the whole
   * diagram fit on the screen together, the page sits with the stage at the
   * top for the whole tour and never moves. Otherwise the page scrolls, and the
   * diagram pans, so the step sits below the readout (which sticks to the top
   * of the screen) and above the bottom edge. Done once at the start of each
   * step, so nothing moves mid-trip.
   */
  function follow(i: number, force = false): number {
    cancelAnimationFrame(followRaf);
    const sr = stage.getBoundingClientRect();
    const vh = innerHeight;
    if (!force && (sr.bottom < 40 || sr.top > vh - 40)) return 0;
    for (const p of peekers) p();
    const u = stepBox(i);
    const k = zoomFor(i);
    const pad = 10;
    const cw = canvas.clientWidth;
    const x0 = (u.x - pad) * k;
    const x1 = (u.x + u.w + pad) * k;
    let sl = canvas.scrollLeft;
    if (x1 - x0 > cw) sl = (x0 + x1) / 2 - cw / 2;
    else if (x0 < sl) sl = x0;
    else if (x1 > sl + cw) sl = x1 - cw;
    sl = Math.max(0, Math.min(sl, canvas.scrollWidth - cw));
    const stageTop = sr.top + window.scrollY;
    const top = canvas.getBoundingClientRect().top + window.scrollY;
    const headH = head.offsetHeight;
    let y = window.scrollY;
    if (headH + canvas.offsetHeight <= vh) y = stageTop;
    else {
      // The lowest scroll that shows the bottom of the step, and the highest that keeps its top below the stuck readout.
      const lo = top + (u.y + u.h + pad) * k - vh + 6;
      const hi = top + (u.y - pad) * k - headH - 6;
      y = Math.max(lo, Math.min(y, hi));
      if (lo > hi) y = hi;
    }
    y = Math.max(0, Math.min(y, document.documentElement.scrollHeight - vh));
    const fromY = window.scrollY;
    const fromL = canvas.scrollLeft;
    if (Math.abs(y - fromY) < 1 && Math.abs(sl - fromL) < 1) return 0;
    if (reducedMotion()) {
      window.scrollTo(0, y);
      canvas.scrollLeft = sl;
      return 0;
    }
    const t0 = performance.now();
    const ms = Math.min(520, 260 + Math.max(Math.abs(y - fromY), Math.abs(sl - fromL)) * 0.6);
    const step2 = (now: number) => {
      if (!alive) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      window.scrollTo(0, fromY + (y - fromY) * e);
      canvas.scrollLeft = fromL + (sl - fromL) * e;
      if (t < 1) followRaf = requestAnimationFrame(step2);
    };
    followRaf = requestAnimationFrame(step2);
    return ms;
  }

  /**
   * On a screen narrower than the diagram, a step wider than the screen makes
   * the diagram zoom out just far enough to show the whole step, labels and
   * all; it zooms back once the step fits. Returns the scale the diagram will
   * have, in pixels per diagram unit.
   */
  function zoomFor(i: number | null): number {
    const cw = canvas.clientWidth;
    const natural = Math.max(cw / W, BASE_SCALE);
    let k = fitted ? cw / W : natural;
    if (i != null && !fitted && natural > cw / W) {
      const need = stepBox(i).w + 24;
      if (need * natural > cw) k = Math.max(cw / W, cw / need);
    }
    const want = Math.abs(k - natural) < 0.001 || fitted ? '' : `${(W * k).toFixed(1)}px`;
    if (svg.style.minWidth !== want) {
      svg.style.minWidth = want;
      svg.style.width = want;
    }
    return k;
  }

  function dwell(i: number, ms?: number): void {
    clearTimeout(timer);
    timer = 0;
    dwellLeft = 0;
    if (!playing) return;
    const s = design.tour[i];
    dwellMs = ms ?? Math.min(11000, Math.max(4200, s.text.length * 42)) / speed;
    dwellAt = performance.now();
    timer = window.setTimeout(() => {
      timer = 0;
      if (!alive || !playing) return;
      if (i < design.tour.length - 1) go(i + 1, false);
      else pause();
    }, dwellMs);
  }

  /** Move the token through step i. With `frozen`, the trip is set up and waits at its start until Play. */
  function run(i: number, animate: boolean, frozen = false): void {
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(timer);
    timer = 0;
    trip = null;
    if (!animate || reducedMotion()) {
      const legs = pathLegs(i);
      const e = endOf(i);
      place(e.x, e.y, legs.length ? legs[legs.length - 1].label : design.tour[i].token ?? 'URL');
      dwell(i);
      return;
    }
    const segs = tripFor(i);
    if (!segs.length) {
      // A step with no connection, and the token already where it waits.
      const e = endOf(i);
      place(e.x, e.y, design.tour[i].token ?? 'URL');
      sync();
      dwell(i);
      return;
    }
    trip = { segs, i: 0, u: 0, last: null };
    drawSeg(trip.segs[0], 0);
    if (!frozen) raf = requestAnimationFrame(tick);
  }

  function announce(i: number, manual: boolean): void {
    const s = design.tour[i];
    status.textContent = manual ? `Step ${i + 1} of ${design.tour.length}. ${s.title}. ${s.text}` : `Step ${i + 1} of ${design.tour.length}. ${s.title}.`;
  }

  function go(i: number, manual: boolean, whole = false): void {
    if (i < 0 || i >= design.tour.length) return;
    clearTimeout(starting);
    starting = 0;
    holdTrip = false;
    if (manual && playing) pause(false);
    step = i;
    leftAt = -1;
    stage.classList.remove('reading');
    // The readout takes its touring height first, so the view is worked out with the readout as it will be.
    stage.classList.add('touring');
    if (reserve) readout.style.minHeight = `${reserve}px`;
    const ms = follow(i, manual || whole);
    if (ms > 0) {
      // The view glides to the step first. The new text shows at once; the boxes, lines and token light up when the view arrives.
      sync(false);
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(timer);
      timer = 0;
      trip = null;
      hideToken();
      starting = window.setTimeout(() => {
        starting = 0;
        if (!alive || step !== i) return;
        sync();
        run(i, true, holdTrip);
        holdTrip = false;
      }, ms);
    } else {
      sync();
      run(i, true);
    }
    announce(i, manual);
    if (!selected && !picked) setUrl();
  }

  function pause(say = true): void {
    if (!playing) return;
    playing = false;
    if (timer) {
      dwellLeft = Math.max(0, dwellMs - (performance.now() - dwellAt));
      clearTimeout(timer);
      timer = 0;
    }
    // Freeze the token where it is; Play carries on from there.
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      if (trip) trip.last = null;
    }
    if (starting) holdTrip = true;
    sync();
    if (say) status.textContent = `Paused at step ${step + 1}.`;
  }

  function toggle(): void {
    if (playing) {
      pause();
      return;
    }
    const atEnd = step === design.tour.length - 1;
    playing = true;
    if (step < 0) {
      const from = leftAt > 0 ? leftAt : 0;
      go(from, false, true);
      status.textContent = `Playing the tour. ${status.textContent}`;
      return;
    }
    if (atEnd && !trip && !starting) {
      go(0, false, true);
      status.textContent = `Playing the tour. ${status.textContent}`;
      return;
    }
    sync();
    status.textContent = `Playing from step ${step + 1}.`;
    if (starting) holdTrip = false;
    else if (trip) {
      trip.last = null;
      if (!raf) raf = requestAnimationFrame(tick);
    } else dwell(step, dwellLeft > 0 ? dwellLeft : undefined);
  }

  function leaveTour(fromButton = false): void {
    const wasIn = step >= 0;
    clearTimeout(starting);
    starting = 0;
    cancelAnimationFrame(followRaf);
    const before = canvas.getBoundingClientRect().top;
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(timer);
    timer = 0;
    trip = null;
    if (wasIn) leftAt = step < design.tour.length - 1 ? step : -1;
    step = -1;
    hideToken();
    sync();
    zoomFor(null);
    // The readout drops its touring height: keep the diagram where it was on screen.
    const after = canvas.getBoundingClientRect().top;
    if (Math.abs(after - before) > 0.5 && before < innerHeight && canvas.getBoundingClientRect().bottom > 0) window.scrollBy(0, after - before);
    status.textContent = wasIn ? 'Left the tour.' : '';
    if (!selected && !picked) setUrl();
    if (fromButton) playBtn.focus({ preventScroll: true });
  }

  function setSpeed(s: number): void {
    const old = speed;
    speed = s;
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === s)));
    speedCycle.textContent = `${s}×`;
    speedCycle.setAttribute('aria-label', `${SPEED_NAMES[s]}. Change speed`);
    // A running trip reads the speed on every frame, and the glide has no timer of its own: only a running wait needs re-arming.
    if (playing && timer) {
      const left = Math.max(0, dwellMs - (performance.now() - dwellAt));
      dwell(step, (left * old) / s);
    } else if (!playing && dwellLeft) dwellLeft = (dwellLeft * old) / s;
  }
  speedCycle.setAttribute('aria-label', 'Normal speed. Change speed');

  function setFit(on: boolean): void {
    fitted = on;
    svg.classList.toggle('fit', on);
    zoomFor(step >= 0 ? step : null);
    fitBtn.setAttribute('aria-pressed', String(on));
    syncPan();
    if (step >= 0) follow(step, true);
  }

  /** The cues for a diagram wider than its box: a fade at each edge with more to see, and a line saying so. */
  function syncPan(): void {
    const over = canvas.scrollWidth > canvas.clientWidth + 1;
    panBar.hidden = !over && !fitted;
    pan.classList.toggle('more-left', over && canvas.scrollLeft > 2);
    pan.classList.toggle('more-right', over && canvas.scrollLeft < canvas.scrollWidth - canvas.clientWidth - 2);
    if (over) {
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'region');
      canvas.setAttribute('aria-label', 'Design diagram, scrolls');
    } else {
      canvas.removeAttribute('tabindex');
      canvas.removeAttribute('role');
      canvas.removeAttribute('aria-label');
    }
    panHint.textContent = fitted
      ? 'Shrunk to fit the width. Turn this off to read the labels.'
      : coarse()
        ? 'The diagram is wider than the screen: drag it sideways to see the rest.'
        : 'The diagram is wider than its box: scroll it sideways, or focus it and use the arrow keys.';
  }
  canvas.addEventListener('scroll', () => syncPan(), { passive: true });

  const stageInView = () => {
    const r = stage.getBoundingClientRect();
    return r.top < innerHeight * 0.6 && r.bottom > innerHeight * 0.3;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, [contenteditable]')) return;
    if (e.key === 'Escape') {
      if (selected || picked) {
        e.preventDefault();
        close();
      } else if (step >= 0) {
        e.preventDefault();
        leaveTour();
      }
      return;
    }
    if (!shortcutsOn()) return;
    // Tour keys work on the readout and transport, or with nothing focused and the stage in view.
    // Never in the notes, never in the diagram (arrows move between parts there), never on the canvas (arrows pan it).
    const onControls = !!t.closest('.hld-head');
    const onBody = t === document.body || t === document.documentElement || t === host || t.id === 'main';
    if (!onControls && !(onBody && stageInView())) return;
    if (e.key === 'ArrowRight' && step < design.tour.length - 1) {
      e.preventDefault();
      go(step + 1, true);
    } else if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault();
      go(step - 1, true);
    } else if (e.key === ' ' && onBody) {
      e.preventDefault();
      toggle();
    }
  };
  document.addEventListener('keydown', onKey);

  // While the readout sticks to the top, nothing focused may hide under it.
  const onFocusIn = (e: FocusEvent) => {
    if (step < 0 || stage.classList.contains('reading')) return;
    const t = e.target as Element;
    if (!t || head.contains(t)) return;
    const r = t.getBoundingClientRect();
    const hb = head.getBoundingClientRect().bottom;
    if (r.top < hb + 4 && r.bottom > 0) window.scrollBy(0, r.top - hb - 8);
  };
  document.addEventListener('focusin', onFocusIn);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestAnimationFrame(() => alive && measureReserve())) : null;
  ro?.observe(readout);
  const panRo = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => requestAnimationFrame(() => alive && syncPan())) : null;
  panRo?.observe(canvas);
  // A turned phone or a resized window: keep the step in view.
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!alive) return;
      measureReserve();
      if (step < 0) stepText.textContent = restText();
      syncPan();
      sync(!starting);
      if (step >= 0 && !stage.classList.contains('reading')) follow(step, true);
    }, 160);
  };
  window.addEventListener('resize', onResize);
  measureReserve();
  renderDetail(null);
  sync();
  syncPan();

  // A link can open a box, a connection, a glossary term or a tour step. Focus goes to what opened.
  if (open) {
    requestAnimationFrame(() => {
      if (!alive) return;
      const missing = (what: string) => {
        renderDetail(null, `There is no ${what} called "${open.id}" on this diagram. Pick one below.`);
        detailBody.scrollIntoView({ block: 'start' });
        (detailBody.querySelector('.hld-missing') as HTMLElement).focus({ preventScroll: true });
        status.textContent = `No ${what} called ${open.id}.`;
      };
      if (open.kind === 'c') {
        if (byId.has(open.id)) select(open.id, 'text');
        else missing('component');
      } else if (open.kind === 'f') {
        if (flowById.has(open.id)) pickFlow(open.id, 'text');
        else missing('connection');
      } else if (open.kind === 't') {
        const n = Number(open.id);
        if (Number.isInteger(n) && n >= 1 && n <= design.tour.length) {
          go(n - 1, true, true);
          playBtn.focus({ preventScroll: true });
        } else missing('tour step');
      } else if (open.kind === 'g') {
        const term = document.getElementById(`term-${open.id}`);
        if (term) {
          term.classList.add('found');
          term.scrollIntoView({ block: 'center' });
          term.focus({ preventScroll: true });
        } else missing('glossary term');
      }
    });
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(followRaf);
    clearTimeout(timer);
    clearTimeout(starting);
    clearTimeout(resizeTimer);
    ro?.disconnect();
    panRo?.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('resize', onResize);
    document.documentElement.style.scrollPaddingTop = '';
    page.remove();
  };
}
