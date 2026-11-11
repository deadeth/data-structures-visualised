import './design.css';
import { h, scrollRegion, tableRoles } from '../core/dom';
import { MODES, type Component, type Design, type Flow } from '../designs/types';

const NS = 'http://www.w3.org/2000/svg';
const SPEEDS = [0.5, 1, 2] as const;
/** Token travel at 1x, in diagram units a second. */
const PACE = 260;
/** The shortest trip, so that a short hop still reads as movement. */
const MIN_TRIP = 420;
/** Chip height, in diagram units. */
const CHIP_H = 26;
/** Space between a chip and its label. */
const LABEL_GAP = 5;
/** The token's height, in diagram units. */
const TOKEN_H = 26;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The site-wide switch for keyboard shortcuts, set beside the search box. */
const shortcutsOn = () => {
  try {
    return localStorage.getItem('dsv.shortcuts') !== 'off';
  } catch {
    return true;
  }
};
/** Short, wide screens: the readout sits beside the diagram. Matches the rule in design.css. */
const SIDE = '(max-height: 500px) and (min-width: 600px)';
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const ICON = {
  restart: 'M6 5v14M19 5l-9 7 9 7V5z',
  back: 'M15 5l-8 7 8 7V5z',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  next: 'M9 5l8 7-8 7V5z',
  close: 'M6 6l12 12M18 6L6 18',
};

function icon(name: keyof typeof ICON): SVGSVGElement {
  const svg = el('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true' });
  const line = name === 'pause' || name === 'restart' || name === 'close';
  svg.append(el('path', { d: ICON[name], fill: line ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const union = (a: Box | null, b: Box): Box => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** One stretch of the token's trip: along a connection, or a short faded hop between two that do not touch. */
type Leg =
  | { kind: 'path'; el: SVGPathElement; back: boolean; full: number; len: number }
  | { kind: 'hop'; a: DOMPoint; b: DOMPoint; len: number };

/**
 * A system design as an interactive diagram: a guided tour that follows one
 * URL round the loop, and boxes that open to explain themselves.
 */
export async function mountDesign(host: HTMLElement, design: Design, open?: { kind: string; id: string }): Promise<() => void> {
  const W = design.size.w;
  const H = design.size.h;
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const flowById = new Map(design.flows.map((f) => [f.id, f]));
  const nameOf = (id: string) => byId.get(id)!.name;
  const sizeOf = (c: Component) => ({ w: c.w ?? 156, h: c.h ?? 56 });
  const boxOf = (id: string): Box => {
    const c = byId.get(id)!;
    const { w, h: hh } = sizeOf(c);
    return { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
  };

  // ---- diagram ---------------------------------------------------------------
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${design.name}: components and the connections between them` }, 'hld-svg');
  svg.style.setProperty('--hld-w', String(W));
  const defs = el('defs');
  for (const [id, cls] of [['hld-arrow', 'hld-tip'], ['hld-arrow-live', 'hld-tip live'], ['hld-arrow-linked', 'hld-tip linked'], ['hld-arrow-cold', 'hld-tip cold']] as const) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0 L10,5 L0,10 z' }, cls));
    defs.append(m);
  }
  svg.append(defs);

  const fr = design.frame;
  svg.append(el('path', { d: fr.d }, 'hld-frame'));
  const frameLabel = el('text', { x: fr.lx, y: fr.ly, 'text-anchor': 'middle' }, 'hld-frame-label');
  frameLabel.textContent = fr.label;

  interface FlowEl {
    fl: Flow;
    path: SVGPathElement;
    chip: SVGGElement;
    chipRect: SVGRectElement;
    ring: SVGRectElement;
    chipText: SVGTextElement;
    label: SVGTextElement | null;
  }
  const flowEls = new Map<string, FlowEl>();
  const flowLayer = el('g');
  const hitLayer = el('g');
  const labelLayer = el('g');
  const chipLayer = el('g');
  for (const fl of design.flows) {
    const path = el('path', { d: fl.d }, `hld-flow mode-${fl.mode}${fl.cold ? ' cold' : ''}`);
    flowLayer.append(path);
    // A wide invisible stroke makes a thin line easy to hit.
    const hit = el('path', { d: fl.d }, 'hld-hit');
    hit.addEventListener('click', () => pickFlow(fl.id, true, hit));
    hitLayer.append(hit);
    const chip = el('g', { tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `${nameOf(fl.from)} to ${nameOf(fl.to)}, by ${fl.via}${fl.label ? `: ${fl.label}` : ''}. Show details.` }, `hld-chip mode-${fl.mode}${fl.cold ? ' cold' : ''}`);
    const ring = el('rect', { y: -CHIP_H / 2 - 5, height: CHIP_H + 10, rx: CHIP_H / 2 + 5 }, 'hld-ring');
    const chipRect = el('rect', { y: -CHIP_H / 2, height: CHIP_H, rx: CHIP_H / 2 }, 'hld-chip-box');
    const chipText = el('text', { y: 5, 'text-anchor': 'middle' });
    chipText.textContent = fl.via;
    chip.append(ring, chipRect, chipText);
    chip.addEventListener('click', () => pickFlow(fl.id, true, chip));
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        pickFlow(fl.id, true, chip);
      }
    });
    chipLayer.append(chip);
    let label: SVGTextElement | null = null;
    if (fl.label) {
      label = el('text', {}, 'hld-flow-label');
      label.textContent = fl.label;
      label.dataset.flow = fl.id;
      labelLayer.append(label);
    }
    // Pointing at a line or its chip, or focusing the chip, shows what travels on it.
    const peek = (on: boolean) => {
      label?.classList.toggle('peek', on);
      path.classList.toggle('peek', on);
    };
    for (const t of [hit, chip]) {
      t.addEventListener('pointerenter', () => peek(true));
      t.addEventListener('pointerleave', () => peek(false));
    }
    chip.addEventListener('focus', () => peek(true));
    chip.addEventListener('blur', () => peek(false));
    flowEls.set(fl.id, { fl, path, chip, chipRect, ring, chipText, label });
  }
  svg.append(flowLayer, hitLayer, frameLabel);

  const nodeEls = new Map<string, SVGGElement>();
  for (const c of design.components) {
    const { w, h: hh } = sizeOf(c);
    const rx = c.kind === 'input' ? hh / 2 : 10;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})`, tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `${c.name}. ${c.tech}. Show details.` }, `hld-node kind-${c.kind}`);
    g.dataset.id = c.id;
    g.append(el('rect', { x: -6, y: -6, width: w + 12, height: hh + 12, rx: rx + 6 }, 'hld-ring'));
    g.append(el('rect', { width: w, height: hh, rx }, 'hld-box'));
    if (c.kind === 'store') g.append(el('path', { d: `M10,${hh - 7} H${w - 10}` }, 'hld-shelf'));
    // A log is drawn as a row of segments along its lower edge: messages in order.
    if (c.kind === 'queue') g.append(el('path', { d: Array.from({ length: 9 }, (_, i) => `M${18 + i * ((w - 36) / 8)},${hh - 11} v6`).join(' ') }, 'hld-shelf'));
    const top = c.lines ? 26 : hh / 2 - 4;
    const name = el('text', { x: w / 2, y: top, 'text-anchor': 'middle' }, 'hld-name');
    name.textContent = c.short ?? c.name;
    const tech = el('text', { x: w / 2, y: top + 19, 'text-anchor': 'middle' }, 'hld-tech');
    tech.textContent = c.tech;
    g.append(name, tech);
    (c.lines ?? []).forEach((line, i) => {
      const t = el('text', { x: 14, y: top + 44 + i * 19 }, 'hld-line');
      t.textContent = line;
      g.append(t);
    });
    g.addEventListener('click', () => select(c.id, true, false, g));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        select(c.id, true, false, g);
      }
    });
    nodeEls.set(c.id, g);
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

  const canvas = scrollRegion(h('div.hld-canvas', null), 'Design diagram');
  canvas.append(svg);

  // ---- tour bar ----------------------------------------------------------------
  const stepTitle = h('h2.hld-step-title', null, 'Take the tour, or open any box');
  const stepText = h('p.hld-step-text', null, design.rest);
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
  const speedGroup = h('div.hld-speed', { role: 'group', 'aria-label': 'Tour speed' }, h('span', null, 'Speed'));
  for (const s of SPEEDS) {
    const b = h('button', { type: 'button', 'aria-pressed': String(s === 1), onclick: () => setSpeed(s) }, `${s}×`) as HTMLButtonElement;
    speedBtns.push(b);
    speedGroup.append(b);
  }
  // On a phone the three speeds become one button that steps through them, so the transport fits one row.
  const speedCycle = h('button.hld-speed-cycle', { type: 'button', onclick: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]) }, '1×') as HTMLButtonElement;
  const transport = h('div.hld-transport', null, h('div.hld-nav', null, restartBtn, backBtn, playBtn, nextBtn), counter, exploreBtn, speedGroup, speedCycle);
  const head = h('div.hld-head', null, readout, transport, measure);

  // ---- detail ------------------------------------------------------------------
  const index = h('div.hld-index', { role: 'group', 'aria-label': 'Components' });
  const indexBtns = new Map<string, HTMLButtonElement>();
  for (const c of design.components) {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => select(c.id, false, false, b) }, c.name) as HTMLButtonElement;
    indexBtns.set(c.id, b);
    index.append(b);
  }
  const detailBody = h('div.hld-detail-body', null);
  const detail = h('section.hld-detail', { 'aria-label': 'Component details', tabIndex: -1 }, h('h2', null, 'Components'), index, detailBody);

  const sample = (mode: string, cold = false) => {
    const s2 = el('svg', { viewBox: '0 0 66 12', width: 66, height: 12, 'aria-hidden': 'true' });
    s2.append(el('path', { d: 'M2,6 H58' }, `hld-flow mode-${mode}${cold ? ' cold' : ''} sample`));
    return s2;
  };
  const legend = h(
    'ul.hld-legend', { 'aria-label': 'Line styles' },
    MODES.map((m) => h('li', { title: m.note }, sample(m.id), h('span', null, m.label))),
    h('li', { title: 'Used to recover or reprocess, not on every fetch.' }, sample('write', true), h('span', null, 'Off the hot path')),
  );

  const stage = h('section.hld', { 'aria-label': 'Interactive design diagram' }, head, canvas, legend);
  const status = h('p.visually-hidden', { role: 'status', 'aria-live': 'polite' });

  // ---- written sections ------------------------------------------------------------
  const list = (items: string[]) => h('ul', null, items.map((t) => h('li', null, t)));
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
      h('p.hld-lead', null, 'Inside a node everything is a function call, so the decisions that must be fast and exact never cross the network. Between nodes it is a log. To the outside world it is HTTPS with deadlines. Select a connection to open it above the diagram notes.'),
      table(
        ['Connection', 'Method', 'Kind', 'Delivery'],
        design.flows.map((x) => {
          const b: HTMLButtonElement = h('button.hld-where', { type: 'button', onclick: () => openFromText('f', x.id, b) }, `${nameOf(x.from)} to ${nameOf(x.to)}`);
          return [b, x.via, `${MODES.find((m) => m.id === x.mode)!.label}${x.cold ? ', off the hot path' : ''}`, x.delivery];
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
        design.glossary.flatMap((g) => {
          const see: HTMLButtonElement | null = g.where ? h('button.hld-where', { type: 'button', onclick: () => openFromText('c', g.where!, see!) }, `See ${nameOf(g.where)}`) : null;
          return [
            h('dt', { id: `term-${slug(g.term)}`, tabIndex: -1 }, g.term),
            h(
              'dd', null, g.text,
              see ? [' ', see] : null,
              g.see ? [' ', h('a.hld-struct', { href: `#/s/${g.see.id}` }, `${g.see.label}, step by step`)] : null,
            ),
          ];
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
  let playing = false;
  let speed = 1;
  let selected: string | null = null;
  let picked: string | null = null;
  let raf = 0;
  let timer = 0;
  let followRaf = 0;
  let alive = true;
  /** Where to go back to when a detail opened from the diagram is closed with Escape. */
  let origin: { el: Element; y: number; x: number } | null = null;
  /** The running trip: when it started and how long it takes, so a speed change keeps its place. */
  let trip: { t0: number; ms: number; base: number } | null = null;
  let dwellAt = 0;
  /** The pause between pressing Play and the first step, while the stage glides into view. */
  let starting = 0;
  let dwellMs = 0;
  /** The tallest step's readout, in pixels, at the current width. */
  let reserve = 0;

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
  // Then labels, each pinned to its chip at a set distance: the side the data names if it is clear, else the next clear side.
  for (const fe of flowEls.values()) {
    const { fl, path, label } = fe;
    if (!label) continue;
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
    let spot: { x: number; y: number; anchor: string; box: Box } | null = null;
    for (const side of sides) {
      const tries: { x: number; y: number; anchor: string }[] = [];
      if (side === 'above' || side === 'below') {
        const y = side === 'above' ? c.y - LABEL_GAP - (lh - asc) : c.y + c.h + LABEL_GAP + asc;
        tries.push({ x: p.x, y, anchor: 'middle' }, { x: c.x + 6, y, anchor: 'start' }, { x: c.x + c.w - 6, y, anchor: 'end' });
      } else {
        const x = side === 'left' ? c.x - LABEL_GAP - 2 : c.x + c.w + LABEL_GAP + 2;
        const anchor = side === 'left' ? 'end' : 'start';
        for (const dy of [0, -10, 10]) tries.push({ x, y: p.y + asc / 2 - 0.5 + dy, anchor });
      }
      for (const tr of tries) {
        const x0 = tr.anchor === 'middle' ? tr.x - lw / 2 : tr.anchor === 'end' ? tr.x - lw : tr.x;
        const box = { x: x0, y: tr.y - asc, w: lw, h: lh };
        if (clear(box)) {
          spot = { ...tr, box };
          break;
        }
      }
      if (spot) break;
    }
    if (!spot) {
      const y = c.y - LABEL_GAP - (lh - asc);
      spot = { x: p.x, y, anchor: 'middle', box: { x: p.x - lw / 2, y: y - asc, w: lw, h: lh } };
    }
    label.setAttribute('x', spot.x.toFixed(1));
    label.setAttribute('y', spot.y.toFixed(1));
    label.setAttribute('text-anchor', spot.anchor);
    taken.push(spot.box);
  }

  function renderDetail(c: Component | null): void {
    if (!c) {
      detailBody.replaceChildren(h('p.hld-hint', null, 'Select a box in the diagram, or a name above, to see what it does, why it is separate, how it fails and what you could use instead. Select a chip on a line to see how two parts talk.'));
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
      h('div.hld-detail-head', null, h('h3', { tabIndex: -1 }, c.name), h('p.hld-detail-tech', null, c.tech)),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          h('h4', null, 'What it does'), h('p', null, c.what),
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
    const mode = MODES.find((m) => m.id === fl.mode)!;
    detailBody.replaceChildren(
      h('div.hld-detail-head', null, h('h3', { tabIndex: -1 }, `${nameOf(fl.from)} to ${nameOf(fl.to)}`), h('p.hld-detail-tech', null, `${fl.via}, ${mode.label.toLowerCase()}${fl.cold ? ', off the hot path' : ''}`)),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          fl.label ? [h('h4', null, 'What travels'), h('p', null, fl.label[0].toUpperCase() + fl.label.slice(1))] : null,
          h('h4', null, 'How they talk'), h('p', null, fl.how),
          h('h4', null, 'What is promised'), h('p', null, fl.delivery),
          h('h4', null, `About a ${mode.label.toLowerCase()}`), h('p', null, mode.note),
        ),
        h('div', null, h('h4', null, 'Other ways to connect them'), h('ul.hld-alts', null, fl.alts.map((a) => h('li', null, h('p', null, a))))),
      ),
    );
  }

  /** Scroll the explanation into view, remembering where the reader was so Escape can take them back. */
  function reveal(from: Element | undefined): void {
    origin = from ? { el: from, y: window.scrollY, x: canvas.scrollLeft } : null;
    detail.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function pickFlow(id: string, reveal2: boolean, from?: Element): void {
    if (playing) pause();
    picked = picked === id ? null : id;
    selected = null;
    for (const [, g] of nodeEls) {
      g.classList.remove('selected');
      g.setAttribute('aria-pressed', 'false');
    }
    for (const [, b] of indexBtns) b.setAttribute('aria-pressed', 'false');
    paintFlows();
    if (picked) renderFlow(flowById.get(picked)!);
    else renderDetail(null);
    if (picked && reveal2) reveal(from);
    else if (!picked) origin = null;
  }

  function select(id: string | null, fromDiagram: boolean, force = false, from?: Element): void {
    if (playing) pause();
    picked = null;
    selected = selected === id && !force ? null : id;
    for (const [nid, g] of nodeEls) {
      g.classList.toggle('selected', nid === selected);
      g.setAttribute('aria-pressed', String(nid === selected));
    }
    for (const [nid, b] of indexBtns) b.setAttribute('aria-pressed', String(nid === selected));
    paintFlows();
    renderDetail(selected ? byId.get(selected)! : null);
    if (selected && fromDiagram) reveal(from);
    else if (!selected) origin = null;
  }

  /** Open a box or a connection from the written sections or a link, and move focus to what opened. */
  function openFromText(kind: 'c' | 'f', id: string, from?: Element): void {
    if (kind === 'c') select(id, false, true);
    else {
      picked = null;
      pickFlow(id, false);
    }
    origin = from ? { el: from, y: window.scrollY, x: canvas.scrollLeft } : null;
    const h3 = detailBody.querySelector('h3');
    detail.scrollIntoView({ block: 'start', behavior: 'auto' });
    h3?.focus({ preventScroll: true });
  }

  /** Close an open box or connection, and take the reader back to where they opened it. */
  function close(): void {
    const back = origin;
    if (selected) select(selected, false);
    else if (picked) pickFlow(picked, false);
    origin = null;
    if (!back || !back.el.isConnected) return;
    window.scrollTo({ top: back.y, behavior: 'auto' });
    canvas.scrollLeft = back.x;
    (back.el as HTMLElement).focus({ preventScroll: true });
    const r = back.el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) (back.el as HTMLElement).scrollIntoView({ block: 'center' });
  }

  function paintFlows(light = true): void {
    const s = step >= 0 && light ? design.tour[step] : null;
    const live = new Set((s?.path ?? []).map((p) => p.replace(/^</, '')));
    const back = new Set((s?.path ?? []).filter((p) => p.startsWith('<')).map((p) => p.slice(1)));
    for (const { fl, path, chip, label } of flowEls.values()) {
      const linked = selected != null && (fl.from === selected || fl.to === selected);
      const on = fl.id === picked;
      const isLive = live.has(fl.id);
      path.classList.toggle('live', isLive);
      // A connection travelled both ways in one step gets an arrowhead at each end.
      path.classList.toggle('both', isLive && back.has(fl.id));
      path.classList.toggle('linked', (linked || on) && !isLive);
      chip.classList.toggle('live', isLive);
      chip.classList.toggle('picked', on);
      chip.setAttribute('aria-pressed', String(on));
      label?.classList.toggle('on', isLive || on || linked);
    }
  }

  function sync(light = true): void {
    const inTour = step >= 0;
    const s = inTour ? design.tour[step] : null;
    stepTitle.textContent = s ? s.title : 'Take the tour, or open any box';
    stepText.textContent = s ? s.text : design.rest;
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
    playLabel.textContent = playing ? 'Pause' : !inTour ? 'Play the tour' : atEnd ? 'Replay' : 'Play';
    playBtn.setAttribute('aria-label', playLabel.textContent);
    restartBtn.disabled = backBtn.disabled = step <= 0;
    nextBtn.disabled = atEnd;
    exploreBtn.hidden = !inTour;
    paintFlows(light);
  }

  function viaLine(path: string[]): (string | HTMLElement)[] {
    const ways = [...new Set(path.map((p) => flowById.get(p.replace(/^</, ''))!).map((x) => {
      const kind = MODES.find((m) => m.id === x.mode)!.label.toLowerCase();
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

  const tokenWidth = (label: string) => Math.max(46, label.length * 9.4 + 24);

  function place(x: number, y: number, label: string, opacity = 1): void {
    const w = tokenWidth(label);
    tokenBox.setAttribute('x', String(-w / 2));
    tokenBox.setAttribute('width', String(w));
    tokenText.textContent = label;
    token.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    token.style.opacity = opacity >= 1 ? '' : opacity.toFixed(2);
    token.style.display = '';
  }

  /**
   * The trip for one step: the connections in order, with a short faded hop
   * where one ends away from where the next begins. The trip stops short of the
   * last arrowhead so the token never covers the name in the box it reaches.
   */
  function legsFor(i: number): { legs: Leg[]; total: number } {
    const s = design.tour[i];
    const label = s.token ?? 'URL';
    const legs: Leg[] = [];
    let prev: DOMPoint | null = null;
    s.path.forEach((p, n) => {
      const back = p.startsWith('<');
      const pe = flowEls.get(p.replace(/^</, ''))!.path;
      const full = pe.getTotalLength();
      const start = pe.getPointAtLength(back ? full : 0);
      if (prev && Math.hypot(start.x - prev.x, start.y - prev.y) > 3) {
        const d = Math.hypot(start.x - prev.x, start.y - prev.y);
        legs.push({ kind: 'hop', a: prev, b: start, len: Math.min(d, 140) });
      }
      let len = full;
      if (n === s.path.length - 1) {
        // Stop before the arrowhead: half the token, plus a little air.
        const e1 = pe.getPointAtLength(back ? 0 : full);
        const e0 = pe.getPointAtLength(back ? Math.min(full, 6) : Math.max(0, full - 6));
        const across = Math.abs(e1.x - e0.x) >= Math.abs(e1.y - e0.y);
        const r = (across ? tokenWidth(label) / 2 : TOKEN_H / 2) + 7;
        len = Math.max(full * 0.45, full - r);
      }
      legs.push({ kind: 'path', el: pe, back, full, len });
      prev = pe.getPointAtLength(back ? full - len : len);
    });
    return { legs, total: legs.reduce((a, l) => a + l.len, 0) };
  }

  function pointAt(legs: Leg[], d: number): { x: number; y: number; o: number } {
    let n = 0;
    while (n < legs.length - 1 && d > legs[n].len) d -= legs[n++].len;
    const l = legs[n];
    d = Math.min(d, l.len);
    if (l.kind === 'hop') {
      const u = l.len ? d / l.len : 1;
      // Fade out, glide unseen, fade in: no jump, and no line drawn where none exists.
      const o = u < 0.3 ? 1 - u / 0.3 : u > 0.7 ? (u - 0.7) / 0.3 : 0;
      return { x: l.a.x + (l.b.x - l.a.x) * u, y: l.a.y + (l.b.y - l.a.y) * u, o };
    }
    const pt = l.el.getPointAtLength(l.back ? l.full - d : d);
    return { x: pt.x, y: pt.y, o: 1 };
  }

  /** Where the token is at the end of a step, or where it waits on a step with no path. */
  function endOf(i: number): { x: number; y: number } {
    for (let k = i; k >= 0; k--) {
      const s = design.tour[k];
      if (!s.path.length) continue;
      const { legs, total } = legsFor(k);
      return pointAt(legs, total);
    }
    const b = boxOf(design.tour[i].focus[0]);
    return { x: b.x + b.w / 2, y: b.y - 20 };
  }

  /** Everything the reader needs to see for one step, in diagram units: lit boxes, the token's whole trip and where it stops. */
  function stepBox(i: number): Box {
    const s = design.tour[i];
    let u: Box | null = null;
    for (const id of s.focus) u = union(u, boxOf(id));
    for (const p of s.path) {
      const b = flowEls.get(p.replace(/^</, ''))!.path.getBBox();
      u = union(u, { x: b.x, y: b.y, w: b.width, h: b.height });
    }
    const e = endOf(i);
    const tw = tokenWidth(s.token ?? 'URL');
    u = union(u, { x: e.x - tw / 2, y: e.y - TOKEN_H / 2, w: tw, h: TOKEN_H });
    return u!;
  }

  /**
   * Keep the step in view: scroll the page, and the diagram where it pans, so
   * the lit boxes and the token's trip sit below the readout and transport
   * (which stick to the top of the screen during the tour) and above the bottom
   * edge. Does it once at the start of each step, so nothing moves mid-trip.
   */
  function follow(i: number, force = false, whole = false): number {
    cancelAnimationFrame(followRaf);
    const sr = stage.getBoundingClientRect();
    const vh = window.innerHeight;
    if (!force && (sr.bottom < 40 || sr.top > vh - 40)) return 0;
    const u = stepBox(i);
    const k = svg.getBoundingClientRect().width / W;
    const pad = 10;
    const side = matchMedia(SIDE).matches;
    // Sideways, inside the canvas.
    const cw = canvas.clientWidth;
    const x0 = (u.x - pad) * k;
    const x1 = (u.x + u.w + pad) * k;
    let sl = canvas.scrollLeft;
    if (x1 - x0 > cw) sl = (x0 + x1) / 2 - cw / 2;
    else if (x0 < sl) sl = x0;
    else if (x1 > sl + cw) sl = x1 - cw;
    sl = Math.max(0, Math.min(sl, canvas.scrollWidth - cw));
    // Up and down: the canvas itself when it sits beside the readout, otherwise the page.
    let st = canvas.scrollTop;
    let y = window.scrollY;
    const y0 = (u.y - pad) * k;
    const y1 = (u.y + u.h + pad) * k;
    if (side) {
      y = sr.top + window.scrollY;
      const ch = canvas.clientHeight;
      if (y1 - y0 > ch) st = y0;
      else if (y0 < st) st = y0;
      else if (y1 > st + ch) st = y1 - ch;
      st = Math.max(0, Math.min(st, canvas.scrollHeight - ch));
    } else {
      const top = canvas.getBoundingClientRect().top + window.scrollY - canvas.scrollTop;
      const headH = head.offsetHeight;
      const stageTop = sr.top + window.scrollY;
      // The lowest scroll that shows the bottom of the step, and the highest that keeps its top below the stuck readout.
      const lo = top + y1 - vh + 6;
      const hi = top + y0 - headH - 6;
      // Starting the tour: if the readout, transport and the whole diagram fit on the screen, show exactly that.
      const all = top + svg.getBoundingClientRect().height - stageTop;
      if (whole && all <= vh) y = stageTop;
      else {
        y = Math.max(lo, Math.min(y, hi));
        if (lo > hi) y = hi;
      }
      y = Math.max(0, y);
    }
    const fromY = window.scrollY;
    const fromL = canvas.scrollLeft;
    const fromT = canvas.scrollTop;
    if (Math.abs(y - fromY) < 1 && Math.abs(sl - fromL) < 1 && Math.abs(st - fromT) < 1) return 0;
    if (reducedMotion()) {
      window.scrollTo(0, y);
      canvas.scrollLeft = sl;
      canvas.scrollTop = st;
      return 0;
    }
    const t0 = performance.now();
    const ms = Math.min(520, 260 + Math.max(Math.abs(y - fromY), Math.abs(sl - fromL), Math.abs(st - fromT)) * 0.6);
    const tick = (now: number) => {
      if (!alive) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      window.scrollTo(0, fromY + (y - fromY) * e);
      canvas.scrollLeft = fromL + (sl - fromL) * e;
      canvas.scrollTop = fromT + (st - fromT) * e;
      if (t < 1) followRaf = requestAnimationFrame(tick);
    };
    followRaf = requestAnimationFrame(tick);
    return ms;
  }

  function dwell(i: number, ms?: number): void {
    clearTimeout(timer);
    if (!playing) return;
    const s = design.tour[i];
    dwellMs = ms ?? Math.min(11000, Math.max(4200, s.text.length * 42)) / speed;
    dwellAt = performance.now();
    timer = window.setTimeout(() => {
      if (!alive || !playing) return;
      if (i < design.tour.length - 1) go(i + 1, false);
      else pause();
    }, dwellMs);
  }

  /** Move the token through step i. With `wait`, it holds at the start of the trip while the view glides into place. */
  function run(i: number, animate: boolean, wait = 0): void {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    trip = null;
    const s = design.tour[i];
    const label = s.token ?? 'URL';
    if (!s.path.length) {
      const r = endOf(i);
      place(r.x, r.y, label);
      dwell(i);
      return;
    }
    const { legs, total } = legsFor(i);
    if (!animate || reducedMotion()) {
      const e = pointAt(legs, total);
      place(e.x, e.y, label);
      dwell(i);
      return;
    }
    const base = Math.max(MIN_TRIP, (total / PACE) * 1000);
    trip = { t0: performance.now() + wait, ms: base / speed, base };
    // A token that was hidden (the view was moving) fades in where its trip starts, rather than appearing at once.
    const shown = token.style.display === 'none' ? performance.now() : -1e9;
    const p0 = pointAt(legs, 0);
    place(p0.x, p0.y, label, 0);
    const tick = (now: number) => {
      if (!alive || !trip) return;
      const k = Math.max(0, Math.min(1, (now - trip.t0) / trip.ms));
      const p = pointAt(legs, ease(k) * total);
      place(p.x, p.y, label, Math.min(p.o, (now - shown) / 160));
      if (k < 1) raf = requestAnimationFrame(tick);
      else {
        trip = null;
        dwell(i);
      }
    };
    raf = requestAnimationFrame(tick);
  }

  function go(i: number, manual: boolean, whole = false): void {
    if (i < 0 || i >= design.tour.length) return;
    clearTimeout(starting);
    starting = 0;
    if (manual && playing) pause();
    step = i;
    // The readout takes its touring height first, so the view is worked out with the readout as it will be.
    stage.classList.add('touring');
    if (reserve) readout.style.minHeight = `${reserve}px`;
    const ms = follow(i, manual || whole, whole);
    if (ms > 0) {
      // The view glides to the step first. The new text shows at once; the boxes, lines and token light up when the view arrives.
      sync(false);
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      trip = null;
      token.style.display = 'none';
      starting = window.setTimeout(() => {
        starting = 0;
        if (!alive || step !== i) return;
        sync();
        run(i, true);
      }, ms);
    } else {
      sync();
      run(i, true);
    }
    const s2 = design.tour[i];
    if (manual) status.textContent = `Step ${i + 1} of ${design.tour.length}. ${s2.title}. ${s2.text}`;
  }

  function pause(): void {
    playing = false;
    clearTimeout(timer);
    if (starting) {
      clearTimeout(starting);
      starting = 0;
      run(step, false);
      sync();
      return;
    }
    sync();
  }

  function toggle(): void {
    if (playing) {
      pause();
      return;
    }
    playing = true;
    if (step < 0 || step === design.tour.length - 1) {
      status.textContent = `Playing the tour, ${design.tour.length} steps.`;
      go(0, false, true);
    } else {
      sync();
      // Carry on from where the token is: finish the trip if it was cut short, then wait out the step.
      if (trip || raf) run(step, true);
      else dwell(step);
    }
  }

  function leaveTour(fromButton = false): void {
    const wasIn = step >= 0;
    clearTimeout(starting);
    playing = false;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    trip = null;
    step = -1;
    token.style.display = 'none';
    sync();
    status.textContent = wasIn ? 'Left the tour.' : '';
    if (fromButton) playBtn.focus({ preventScroll: true });
  }

  function setSpeed(s: number): void {
    const old = speed;
    speed = s;
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === s)));
    speedCycle.textContent = `${s}×`;
    speedCycle.setAttribute('aria-label', `Tour speed ${s}×. Change speed`);
    if (!playing || step < 0) return;
    const now = performance.now();
    if (trip) {
      // Keep the token where it is on its trip; only the rest of the trip changes pace.
      const k = Math.min(1, (now - trip.t0) / trip.ms);
      trip.ms = trip.base / s;
      trip.t0 = now - k * trip.ms;
    } else {
      const left = Math.max(0, dwellMs - (now - dwellAt));
      dwell(step, (left * old) / s);
    }
  }
  speedCycle.setAttribute('aria-label', 'Tour speed 1×. Change speed');

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea')) return;
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
    if (e.key === 'ArrowRight' && step < design.tour.length - 1) {
      e.preventDefault();
      go(step + 1, true);
    } else if (e.key === 'ArrowLeft' && step > 0) {
      e.preventDefault();
      go(step - 1, true);
    } else if (e.key === ' ' && !t.closest('button, a, summary, [role="button"], [tabindex]')) {
      e.preventDefault();
      toggle();
    }
  };
  document.addEventListener('keydown', onKey);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measureReserve()) : null;
  ro?.observe(readout);
  measureReserve();
  renderDetail(null);
  sync();

  // A link from search can open a box, a connection or a glossary term. Focus goes to what opened.
  if (open) {
    requestAnimationFrame(() => {
      if (!alive) return;
      if (open.kind === 'c' && byId.has(open.id)) openFromText('c', open.id);
      else if (open.kind === 'f' && flowById.has(open.id)) openFromText('f', open.id);
      else if (open.kind === 'g') {
        const term = document.getElementById(`term-${open.id}`);
        if (term) {
          term.classList.add('found');
          term.scrollIntoView({ block: 'center' });
          term.focus({ preventScroll: true });
        }
      }
    });
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(followRaf);
    clearTimeout(timer);
    clearTimeout(starting);
    ro?.disconnect();
    document.removeEventListener('keydown', onKey);
    page.remove();
  };
}
