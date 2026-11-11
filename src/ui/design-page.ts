import './design.css';
import { h, tableRoles } from '../core/dom';
import { LOCAL_RULE, MODES, type Component, type Design, type Flow } from '../designs/types';

const NS = 'http://www.w3.org/2000/svg';
const SPEEDS = [0.5, 1, 2] as const;
const SPEED_NAMES: Record<number, string> = { 0.5: 'Half speed', 1: 'Normal speed', 2: 'Double speed' };
/** Token travel at 1x, in diagram units a second. */
const PACE = 260;
/** The shortest leg at 1x, so that a short hop still reads as movement. */
const MIN_LEG = 900;
/** The shortest leg at any speed. */
const FLOOR_LEG = 450;
/** The pause at a turn (a question reaching its answer), at 1x. */
const HOLD = 250;
/** Fading the token out where it was and in where the next trip starts. */
const FADE = 120;
/** Further than this from the last stop, the token fades across rather than jumping. */
const JUMP = 30;
/** Chip height, in diagram units: tall enough that its words sit 6px inside its outline at the smallest scale. */
const CHIP_H = 37;
/** The token: a dot on the line, and its label on a pill beside it. */
const DOT_R = 6;
const PILL_H = 34;
/** Space between the dot and the nearest edge of its pill. */
const PILL_GAP = 9;
/** Purpose labels keep this far from every other line, box and chip. */
const LABEL_CLEAR = 6;
/** ...and further from lines (their white halo eats into the gap) and from chips. */
const LABEL_LINE_CLEAR = 8;
const LABEL_CHIP_CLEAR = 9;
/** From this width the opened detail shares the screen with the diagram. */
const WIDE = '(min-width: 1366px)';
/**
 * The smallest scale the diagram is drawn at before it pans: its smallest text
 * (16.5 units) is then 13px, and a 1280-unit diagram still fits a 1024px
 * screen with a scrollbar. Matches design.css. The diagram never zooms below
 * this on the tour; it pans.
 */
const BASE_SCALE = 0.788;
/** The largest scale: its smallest text is then 15.8px. Wider than that, the extra width is margin. Matches design.css. */
const MAX_SCALE = 0.96;
/** The sticky readout may take at most this share of the screen's height. */
const HEAD_SHARE = 0.4;
const COLD_KEY = 'dsv.recovery';
/** Where along a line its purpose label may hang from, middle first. */
const ANCHORS = Array.from({ length: 23 }, (_, i) => 0.06 + i * 0.04).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));

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
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // Storage can be blocked; the setting still holds for this visit.
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
/** How far apart two boxes are: 0 when they touch or overlap. */
const gapOf = (a: Box, b: Box) => {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
};
const ptGap = (p: Pt, b: Box) => Math.hypot(Math.max(0, b.x - p.x, p.x - (b.x + b.w)), Math.max(0, b.y - p.y, p.y - (b.y + b.h)));

/** Line samples are this long on screen, in pixels. */
const SAMPLE_PX = 60;
/**
 * A sample of a line style, drawn in the diagram's own classes. Drawn at the
 * diagram's own scale (see sizeSample), so its stroke and dashes are the
 * widths and lengths the reader sees on the diagram.
 */
function lineSample(mode: string, cold = false, chip = true): SVGSVGElement {
  const s2 = el('svg', { width: SAMPLE_PX, height: 24, 'aria-hidden': 'true' }, 'hld-sample');
  s2.append(el('path', {}, `hld-flow mode-${mode}${cold ? ' cold' : ''} sample`));
  if (chip) {
    const g = el('g', {}, `hld-chip mode-${mode}${cold ? ' cold' : ''} sample`);
    g.append(el('rect', {}, 'hld-chip-box'));
    s2.append(g);
  } else s2.append(el('path', {}, 'hld-tip'));
  sizeSample(s2, 0.85);
  return s2;
}
/** Redraw a line sample for the diagram's scale k: 1 unit is k pixels, as on the diagram. */
function sizeSample(s2: SVGSVGElement, k: number): void {
  const L = SAMPLE_PX / k;
  const m = 12 / k;
  s2.setAttribute('viewBox', `0 0 ${L.toFixed(2)} ${(24 / k).toFixed(2)}`);
  const [line, extra] = Array.from(s2.children) as SVGElement[];
  line.setAttribute('d', `M${(2 / k).toFixed(2)},${m.toFixed(2)} H${(L - 2 / k).toFixed(2)}`);
  if (extra.tagName === 'g') {
    // The chip sits at the start, so most of the sample shows the line's own dash.
    extra.setAttribute('transform', `translate(${(14 / k).toFixed(2)},${m.toFixed(2)})`);
    const r = extra.firstElementChild as SVGRectElement;
    for (const [a, v] of [['x', -12], ['y', -8], ['width', 24], ['height', 16], ['rx', 8]] as const) r.setAttribute(a, (v / k).toFixed(2));
  } else extra.setAttribute('d', `M${(L - 10 / k).toFixed(2)},${(m - 5 / k).toFixed(2)} L${(L - 2 / k).toFixed(2)},${m.toFixed(2)} L${(L - 10 / k).toFixed(2)},${(m + 5 / k).toFixed(2)} z`);
}
function boxSample(kind: string): SVGSVGElement {
  const s2 = el('svg', { viewBox: '0 0 40 26', width: 40, height: 26, 'aria-hidden': 'true' }, `hld-node kind-${kind} sample`);
  if (kind === 'store') {
    s2.append(el('path', { d: 'M2,7 A18,4 0 0 1 38,7 V20 A18,4 0 0 1 2,20 Z' }, 'hld-box'));
    s2.append(el('path', { d: 'M2,7 A18,4 0 0 0 38,7' }, 'hld-cap'));
  } else {
    s2.append(el('rect', { x: 2, y: 3, width: 36, height: 20, rx: kind === 'input' ? 8 : 4 }, 'hld-box'));
    if (kind === 'queue') s2.append(el('path', { d: 'M8,18 v-4 M14,18 v-4 M20,18 v-4 M26,18 v-4 M32,18 v-4' }, 'hld-shelf'));
  }
  return s2;
}

/**
 * One piece of the token's trip. A path runs along a connection; a hop fades
 * across a gap between two connections that do not touch; a hold waits at a
 * turn; a fade takes the token out where it was, or in where it starts. The
 * branch token makes its own side trip after the main one.
 */
type Who = 'main' | 'branch';
type PathSeg = { kind: 'path'; el: SVGPathElement; back: boolean; full: number; len: number; label: string; who: Who };
type Seg =
  | PathSeg
  | { kind: 'hop'; a: Pt; b: Pt; label: string; next: string }
  | { kind: 'hold'; at: Pt; label: string; next: string }
  | { kind: 'fade'; at: Pt; label: string; dir: 'out' | 'in'; who: Who };

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
  /** A reply's id names its line travelled backwards. */
  const replyOf = new Map(design.flows.filter((f) => f.reply).map((f) => [f.reply!.id, f]));
  const lineOf = (id: string) => flowById.get(id) ?? replyOf.get(id);
  const legOf = (p: string) => {
    const rev = p.startsWith('<');
    const id = p.replace(/^</, '');
    const r = replyOf.get(id);
    return r ? { fl: r, back: !rev } : { fl: flowById.get(id)!, back: rev };
  };
  const nameOf = (id: string) => byId.get(id)!.name;
  const sizeOf = (c: Component) => ({ w: c.w ?? 156, h: c.h ?? 56 });
  const boxOf = (id: string): Box => {
    const c = byId.get(id)!;
    const { w, h: hh } = sizeOf(c);
    return { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
  };
  const modeOf = (fl: Flow) => MODES.find((m) => m.id === fl.mode)!;
  /** "URL frontier to Fetchers", or "URL frontier and Fetchers, both ways" for a line that carries a reply. */
  const lineName = (fl: Flow) => (fl.reply ? `${nameOf(fl.from)} and ${nameOf(fl.to)}, both ways` : `${nameOf(fl.from)} to ${nameOf(fl.to)}`);
  const quietChip = (fl: Flow) => fl.mode === 'local';
  const DETAIL_ID = `${design.id}-detail`;

  // ---- diagram ---------------------------------------------------------------
  const fr = design.frame;
  // tabindex -1: the drawing itself is not a tab stop (Chrome would make it one); the box or chip inside it that holds the roving stop is.
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, tabindex: -1, role: 'group', 'aria-label': `${design.name}: components and the connections between them. The dashed frame is one ${fr.label.toLowerCase()}${fr.note ? `; ${fr.note.toLowerCase()}` : ''}. Arrow keys move between them, Enter opens one.` }, 'hld-svg');
  svg.style.setProperty('--hld-w', String(W));
  svg.style.setProperty('--hld-h', String(H));
  const defs = el('defs');
  // Markers scale with the stroke: a live or selected line (about 3 units against 1.6) gets a smaller marker, so its head is about 1.4 times the usual one.
  for (const [id, cls, size] of [['hld-arrow', 'hld-tip', 7], ['hld-arrow-live', 'hld-tip live', 5.2], ['hld-arrow-linked', 'hld-tip linked', 5.2], ['hld-arrow-quiet', 'hld-tip quiet', 7]] as const) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: size, markerHeight: size, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0 L10,5 L0,10 z' }, cls));
    defs.append(m);
  }
  svg.append(defs);

  svg.append(el('rect', { x: fr.x, y: fr.y, width: fr.w, height: fr.h, rx: 14 }, 'hld-frame'));
  // The frame's words are in the group's name, so they are not read twice.
  const frameLabel = el('text', { x: fr.x + 14, y: fr.y + 22, 'aria-hidden': 'true' }, 'hld-frame-label');
  frameLabel.textContent = fr.label;
  const frameNote = el('text', { x: fr.x + fr.w - 14, y: fr.y + 22, 'text-anchor': 'end', 'aria-hidden': 'true' }, 'hld-frame-label note');
  frameNote.textContent = fr.note ?? '';

  interface FlowEl {
    fl: Flow;
    path: SVGPathElement;
    hit: SVGPathElement;
    chip: SVGGElement;
    chipRect: SVGRectElement;
    ring: SVGRectElement;
    chipText: SVGTextElement;
    label: SVGTextElement;
    leader: SVGLineElement;
  }
  const flowEls = new Map<string, FlowEl>();
  const flowLayer = el('g');
  const hitLayer = el('g');
  // Purpose labels repeat what the chip, the detail and the table say: hidden from screen readers.
  const labelLayer = el('g', { 'aria-hidden': 'true' });
  const chipLayer = el('g');
  /** Every box and chip, in one roving tab stop. */
  const items: SVGGElement[] = [];
  let peeking: string | null = null;
  for (const fl of design.flows) {
    const cls = `mode-${fl.mode}${fl.cold ? ' cold' : ''}${fl.reply ? ' two-way' : ''}`;
    const path = el('path', { d: fl.d }, `hld-flow ${cls}`);
    flowLayer.append(path);
    // A wide invisible stroke makes a thin line easy to hit.
    const hit = el('path', { d: fl.d }, `hld-hit${fl.cold ? ' cold' : ''}`);
    hit.addEventListener('click', () => pickFlow(fl.id, 'pointer', hit));
    hitLayer.append(hit);
    const what = fl.reply ? `${fl.label ?? ''}, and back: ${fl.reply.label}` : fl.label ?? '';
    const chip = el(
      'g',
      { tabindex: -1, role: 'button', 'aria-expanded': 'false', 'aria-controls': DETAIL_ID, 'aria-label': `${lineName(fl)}, by ${fl.via}${what ? `: ${what}` : ''}${fl.cold ? ', off the hot path' : ''}. Connection.` },
      `hld-chip ${cls}${quietChip(fl) ? ' quiet-chip' : ''}`,
    );
    chip.dataset.flow = fl.id;
    const ring = el('rect', { y: -CHIP_H / 2 - 5, height: CHIP_H + 10, rx: CHIP_H / 2 + 5 }, 'hld-ring');
    const chipRect = el('rect', { y: -CHIP_H / 2, height: CHIP_H, rx: CHIP_H / 2 }, 'hld-chip-box');
    const chipText = el('text', { y: 4.65, 'text-anchor': 'middle' });
    chipText.textContent = fl.via;
    chip.append(ring, chipRect, chipText);
    chip.addEventListener('click', (e) => pickFlow(fl.id, e.detail === 0 ? 'key' : 'pointer', chip));
    chipLayer.append(chip);
    items.push(chip);
    const leader = el('line', {}, 'hld-leader');
    const label = el('text', {}, 'hld-flow-label');
    label.textContent = fl.reply ? `${fl.label} / ${fl.reply.label}` : fl.label ?? fl.via;
    label.dataset.flow = fl.id;
    labelLayer.append(leader, label);
    // Pointing at a line or its chip, or focusing the chip, shows its chip and what travels on it.
    // Only a pointer that moves counts: a line scrolled under a resting pointer does not light up.
    const peek = (on: boolean) => {
      if (on) peeking = fl.id;
      else if (peeking === fl.id) peeking = null;
      paintFlows(lastLight);
    };
    for (const t of [hit, chip]) {
      t.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse' && (e.movementX || e.movementY) && peeking !== fl.id) peek(true);
      });
      t.addEventListener('pointerleave', () => peek(false));
    }
    chip.addEventListener('focus', () => peek(true));
    chip.addEventListener('blur', () => peek(false));
    flowEls.set(fl.id, { fl, path, hit, chip, chipRect, ring, chipText, label, leader });
  }
  svg.append(flowLayer, hitLayer, frameLabel, frameNote);

  const nodeEls = new Map<string, SVGGElement>();
  for (const c of design.components) {
    const { w, h: hh } = sizeOf(c);
    // An input is a rounded tab, rounder than a service's box but not a full pill, so its words keep clear of the ends.
    const rx = c.kind === 'input' ? Math.min(20, hh / 2) : 10;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})`, tabindex: -1, role: 'button', 'aria-expanded': 'false', 'aria-controls': DETAIL_ID, 'aria-label': `${c.name}. ${c.tech}. Component.` }, `hld-node kind-${c.kind}`);
    g.dataset.id = c.id;
    g.append(el('rect', { x: -6, y: -6, width: w + 12, height: hh + 12, rx: rx + 6 }, 'hld-ring'));
    // A store is a cylinder, so its shape cannot be read as a box with a link under its text.
    const CAP = 6;
    if (c.kind === 'store') {
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 1 ${w},${CAP} V${hh - CAP} A${w / 2},${CAP} 0 0 1 0,${hh - CAP} Z` }, 'hld-box'));
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 0 ${w},${CAP}` }, 'hld-cap'));
    } else g.append(el('rect', { width: w, height: hh, rx }, 'hld-box'));
    // A log is drawn as a row of segments along its lower edge: messages in order.
    if (c.kind === 'queue') g.append(el('path', { d: Array.from({ length: 9 }, (_, i) => `M${18 + i * ((w - 36) / 8)},${hh - 9} v5`).join(' ') }, 'hld-shelf'));
    // Where the name sits: every text at least 6px inside its outline at the smallest scale (7.6 units), clear of a cylinder's
    // cap and a log's ticks. The subtitle is 19 units under the name.
    const top = c.lines || c.kind === 'queue' ? 23.5 : c.kind === 'store' ? 2 * CAP + 23.5 : hh / 2 - 4.5;
    const name = el('text', { x: w / 2, y: top, 'text-anchor': 'middle' }, 'hld-name');
    name.textContent = c.short ?? c.name;
    const tech = el('text', { x: w / 2, y: top + 19, 'text-anchor': 'middle' }, 'hld-tech');
    tech.textContent = c.tech;
    g.append(name, tech);
    (c.lines ?? []).forEach((line, i) => {
      const t = el('text', { x: 14, y: top + 41 + i * 18.5 }, 'hld-line');
      t.textContent = line;
      g.append(t);
    });
    g.addEventListener('click', (e) => select(c.id, e.detail === 0 ? 'key' : 'pointer', g));
    nodeEls.set(c.id, g);
    items.push(g);
    svg.append(g);
  }

  // The thing being followed: a dot on the line, in the colour this site keeps for the followed key, with its label on a pill beside it.
  function makeToken(cls: string) {
    const g = el('g', { 'aria-hidden': 'true' }, `hld-token ${cls}`);
    const dot = el('circle', { r: DOT_R }, 'hld-dot');
    const pill = el('g', {}, 'hld-pill');
    const tether = el('line', {}, 'hld-tether');
    const rect = el('rect', { y: -PILL_H / 2, height: PILL_H, rx: PILL_H / 2 });
    const text = el('text', { y: 4.5, 'text-anchor': 'middle' });
    pill.append(rect, text);
    g.append(tether, dot, pill);
    g.style.display = 'none';
    return {
      g, dot, pill, rect, text, tether,
      at: null as { x: number; y: number; label: string } | null,
      /** Which of the places round the dot the pill is going to, and for which leg it was chosen. */
      spot: -1,
      leg: null as object | null,
      /** Where the pill is drawn now, and where it is going, relative to the dot. */
      off: null as Pt | null,
      target: null as Pt | null,
      /** The places planned for this leg: from how far along each one holds. */
      plan: [] as { d: number; spot: number; hide?: boolean }[],
      /** The pill fades out on a stretch with nowhere clear to sit: how visible it is now, and where it is going. */
      pillOp: 1,
      pillHide: false,
      planW: 0,
      blockedSince: 0,
      since: 0,
      /** When the pill last moved, so it moves at most once a frame. */
      stepped: 0,
      pillW: 0,
      vertical: false,
      pillBox: null as Box | null,
    };
  }
  const token = makeToken('main');
  const branchTok = makeToken('branch');
  svg.append(token.g, branchTok.g, labelLayer, chipLayer);

  const canvas = h('div.hld-canvas', null);
  canvas.append(svg);
  const skip = h('button.hld-skip', { type: 'button', onclick: () => (index.querySelector('button') as HTMLElement).focus() }, 'Skip diagram');
  const pan = h('div.hld-pan', null, skip, canvas);
  const fitBtn = h('button.hld-fit', { type: 'button', 'aria-pressed': 'false', onclick: () => setFit(!fitted) }, 'Overview: whole diagram, small text') as HTMLButtonElement;
  const panHint = h('span.hld-pan-hint', null);
  const panBar = h('div.hld-panbar', null, panHint, fitBtn);
  panBar.hidden = true;

  // ---- tour bar ----------------------------------------------------------------
  const restText = () => (coarse() ? design.restTouch : design.rest);
  const stepTitle = h('h2.hld-step-title', { tabIndex: -1 }, 'Take the tour, or open any box');
  const stepText = h('p.hld-step-text', null, restText());
  const stepVia = h('p.hld-step-via', null);
  const moreBtn = h('button.hld-more', { type: 'button', 'aria-expanded': 'false', onclick: () => setMore(!moreOpen) }, 'More') as HTMLButtonElement;
  const readout = h('div.hld-readout', null, h('div.hld-title-row', null, stepTitle, moreBtn), stepText, stepVia);
  // A hidden copy, laid out at the same width, finds the tallest step so the readout never changes height mid-tour.
  const measure = h('div.hld-readout.hld-measure', { 'aria-hidden': 'true' }, h('h2.hld-step-title'), h('p.hld-step-text'), h('p.hld-step-via'));

  const playLabel = h('span.hld-play-text', null, 'Play the tour');
  const btn = (name: keyof typeof ICON, label: string, keys: string, fn: () => void, cls = '') =>
    h(`button.hld-icon${cls}`, { type: 'button', 'aria-label': label, title: keys ? `${label} (${keys})` : label, 'data-keys': keys, onclick: fn }, icon(name)) as HTMLButtonElement;
  const restartBtn = btn('restart', 'Back to the start', '', () => go(0, true), '.hld-restart');
  const backBtn = btn('back', 'Previous step', 'Left arrow', () => go(step - 1, true));
  const nextBtn = btn('next', 'Next step', 'Right arrow', () => go(step + 1, true));
  const playBtn = h('button.hld-play', { type: 'button', onclick: () => toggle() }, icon('play'), playLabel) as HTMLButtonElement;
  const countLong = h('span.hld-count-long', null, `${design.tour.length} steps`);
  const countShort = h('span.hld-count-short', { 'aria-hidden': 'true' }, `${design.tour.length}`);
  const counter = h('span.hld-count', null, countLong, countShort);
  const exploreBtn = h('button.hld-quiet', { type: 'button', title: 'Leave the tour (Escape)', onclick: () => leaveTour(true) }, icon('close'), h('span', null, 'Leave the tour'));
  const speedBtns: HTMLButtonElement[] = [];
  const speedGroup = h('div.hld-speed', { role: 'group', 'aria-label': 'Tour speed' }, h('span', { 'aria-hidden': 'true' }, 'Speed'));
  for (const s of SPEEDS) {
    const b = h('button', { type: 'button', 'aria-pressed': String(s === 1), 'aria-label': SPEED_NAMES[s], title: SPEED_NAMES[s], onclick: () => setSpeed(s) }, `${s}×`) as HTMLButtonElement;
    speedBtns.push(b);
    speedGroup.append(b);
  }
  // On a phone the three speeds become one button that steps through them, so the transport fits one row.
  const speedCycle = h('button.hld-speed-cycle', { type: 'button', onclick: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]) }, '1×') as HTMLButtonElement;
  // The tour's keys, on show where there is room and a keyboard; they follow the site-wide shortcut switch.
  const keyHints = h('p.hld-keys', { 'aria-hidden': 'true' }, h('kbd', null, 'Space'), ' play ', h('kbd', null, '←'), h('kbd', null, '→'), ' step ', h('kbd', null, 'R'), ' replay');
  const transport = h('div.hld-transport', null, h('div.hld-nav', null, restartBtn, backBtn, playBtn, nextBtn), counter, exploreBtn, keyHints, speedGroup, speedCycle);
  const head = h('div.hld-head', null, readout, transport, measure);
  /** Shortcut hints follow the site-wide switch. */
  function syncKeys(): void {
    const on = shortcutsOn();
    for (const [b, k] of [[playBtn, 'Space'], [backBtn, 'ArrowLeft'], [nextBtn, 'ArrowRight']] as const) {
      if (on) b.setAttribute('aria-keyshortcuts', k);
      else b.removeAttribute('aria-keyshortcuts');
    }
    for (const b of [backBtn, nextBtn]) b.title = on ? `${b.getAttribute('aria-label')} (${b.dataset.keys})` : b.getAttribute('aria-label')!;
    playBtn.title = on ? 'Play or pause (Space). R replays the step.' : '';
    keyHints.hidden = !on;
  }

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

  // ---- the key -----------------------------------------------------------------
  let showCold = stored(COLD_KEY) === 'on';
  const coldBox = h('input', { type: 'checkbox', id: `${design.id}-cold`, checked: showCold, onchange: () => setCold(coldBox.checked) }) as HTMLInputElement;
  const keyItem = (glyph: SVGSVGElement, label: string, note: string, cold = false) => h(cold ? 'li.cold' : 'li', null, glyph, h('span', null, label), h('span.visually-hidden', null, `: ${note}`));
  const legend = h(
    'div.hld-legend', null,
    h(
      'ul.hld-key', { 'aria-label': 'Line styles' },
      MODES.map((m) => keyItem(lineSample(m.id, false, m.id !== 'local'), m.id === 'local' ? LOCAL_RULE : m.label, m.note)),
    ),
    h(
      'ul.hld-key', { 'aria-label': 'Box styles, and lines off the hot path' },
      keyItem(boxSample('input'), 'Input or shared service', 'Grey fill: used by every node, or where work comes from.'),
      keyItem(boxSample('outside'), 'Outside our control', 'Dashed border: someone else runs it.'),
      keyItem(boxSample('store'), 'Storage', 'A cylinder: durable data.'),
      keyItem(boxSample('queue'), 'Log', 'Ticks along the base: messages kept in order.'),
      keyItem(lineSample('write', true), 'Off the hot path', 'Used to recover or reprocess, not on every fetch. Hidden unless shown.', true),
    ),
    h(
      'div.hld-key-row', null,
      h('p.hld-cold-toggle', null, coldBox, h('label', { for: `${design.id}-cold` }, 'Show recovery and reprocessing paths')),
      h(
        'details.hld-key-notes', null,
        h('summary', null, 'What each line promises'),
        h('dl', null, MODES.flatMap((m) => [h('dt', null, m.label), h('dd', null, m.note)]), h('dt', null, 'Off the hot path'), h('dd', null, 'Recovery and reprocessing: used after a failure or a fix, not on every fetch.')),
      ),
    ),
  );

  const stage = h('section.hld', { 'aria-label': 'Interactive design diagram' }, head, pan, panBar, legend);
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
  // Every connection, both directions of a two-way line on rows of their own.
  const flowRows: Cell[][] = design.flows.flatMap((x) => {
    const row = (a: string, b: string, delivery: string) => {
      const btn2: HTMLButtonElement = h('button.hld-where', { type: 'button', onclick: () => pickFlow(x.id, 'text', btn2) }, `${nameOf(a)} to ${nameOf(b)}`);
      // The method as the same chip the diagram draws, on one line.
      return [btn2, h(`span.hld-tag.mode-${x.mode}${x.cold ? '.cold' : ''}`, null, x.via), `${modeOf(x).label}${x.cold ? ', off the hot path' : ''}`, delivery];
    };
    return x.reply ? [row(x.from, x.to, x.delivery), row(x.to, x.from, x.reply.delivery)] : [row(x.from, x.to, x.delivery)];
  });
  const terms = [...design.glossary].sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }));
  const letterOf = (t: string) => {
    const c = t.replace(/^[^A-Za-z]+/, '')[0]?.toUpperCase() ?? '#';
    return /[A-Z]/.test(c) ? c : '#';
  };
  const letters = [...new Set(terms.map((g) => letterOf(g.term)))];
  const jump = h(
    'nav.hld-az', { 'aria-label': 'Glossary by letter' },
    letters.map((L) =>
      h('button', {
        type: 'button',
        'aria-label': `Terms starting ${L}`,
        onclick: () => {
          const first = terms.find((g) => letterOf(g.term) === L)!;
          const row = document.getElementById(`term-${slug(first.term)}`) as HTMLElement;
          row.scrollIntoView({ block: 'start', behavior: smooth() });
          row.focus({ preventScroll: true });
        },
      }, L),
    ),
  );
  const notes = h(
    'div.notes', null,
    ...design.brief.map((b) => h('section.note.hld-card', null, h('h2', null, b.heading), list(b.points))),
    h('section.note.wide.hld-card', null, h('h2', null, 'Numbers to have ready'), table(['Quantity', 'Assumption', 'Result'], design.numbers.map((n) => [n.what, n.assumption, n.result]), 'hld-table')),
    h(
      'section.note.wide.hld-card', null,
      h('h2', null, 'Three versions of the question'),
      h('div.hld-framings', null, design.framings.map((x) => h('div', null, h('h3', null, x.name), h('p.hld-scale', null, x.scale), h('p', null, x.shape)))),
    ),
    h('section.note.wide.hld-card', null, h('h2', null, 'Decisions worth defending'), table(['Choice', 'One way', 'The other way', 'The call here'], design.decisions.map((d) => [d.choice, d.a, d.b, d.call]), 'hld-table')),
    h(
      'section.note.wide.hld-card', null,
      h('h2', null, 'How the parts talk'),
      h('p.hld-lead', null, 'Inside a node everything is a function call, so the decisions that must be fast and exact never cross the network. Between nodes it is a log. To the outside world it is HTTPS with deadlines. A line that carries a request and its reply is listed once each way. Select a connection to open it under the diagram.'),
      table(['Connection', 'Method', 'Kind', 'Delivery'], flowRows, 'hld-table'),
    ),
    h('section.note.wide.hld-card', null, h('h2', null, 'Failure drills'), h('dl.hld-drills', null, design.drills.flatMap((d) => [h('dt', null, d.name), h('dd', null, d.what)]))),
    h('section.note.wide.interview', null, h('h2', null, 'Say this in the interview'), list(design.interview)),
    h(
      'section.note.wide.hld-card', { id: 'glossary' },
      h('h2', null, 'Glossary'),
      jump,
      h(
        'dl.hld-glossary', null,
        terms.map((g) => {
          const see: HTMLButtonElement | null = g.where ? h('button.hld-where', { type: 'button', onclick: () => select(g.where!, 'text', see!) }, `See ${nameOf(g.where)}`, h('span.visually-hidden', null, `, for ${g.term}`)) : null;
          const links = [see, g.see ? h('a.hld-struct', { href: `#/s/${g.see.id}` }, `${g.see.label}, step by step`) : null].filter(Boolean) as HTMLElement[];
          return h(
            'div.hld-gloss-row', { id: `term-${slug(g.term)}`, tabIndex: -1, 'data-letter': letterOf(g.term) },
            h('dt', null, g.term),
            h('dd', null, h('p', null, g.text), links.length ? h('p.hld-gloss-links', null, links.flatMap((l, i) => (i ? [h('span.hld-sep', { 'aria-hidden': 'true' }, ' · '), l] : [l]))) : null),
          );
        }),
      ),
    ),
    h(
      'section.note.wide.hld-card', null,
      h('h2', null, 'Sources'),
      h('ul.hld-sources', null, design.sources.map((s) => h('li', null, s.href ? h('a', { href: s.href, rel: 'noopener' }, s.label) : h('span.hld-source', null, s.label), h('span.hld-source-note', null, s.note)))),
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
  let moreOpen = false;
  let raf = 0;
  let timer = 0;
  let followRaf = 0;
  let resizeTimer = 0;
  let alive = true;
  let lastLight = true;
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
  /** The same for the title and the "Travels by" line alone. */
  let briefReserve = 0;
  /** The box or chip that holds the diagram's one tab stop. */
  let rove: SVGGElement = nodeEls.get(design.tour[0]?.focus[0] ?? design.components[0].id) ?? items[0];
  rove.setAttribute('tabindex', '0');

  // ---- layout that needs the browser: chip widths, line samples ------------------------
  await document.fonts?.ready;
  if (!alive) return () => undefined;

  const nodeBoxes = design.components.map((c) => boxOf(c.id));
  /**
   * Text in a box keeps inside it even when a reader's own style spaces the
   * letters out (WCAG text spacing): a line too long for its box is squeezed to
   * fit. Checked now, and whenever a style sheet is added to the page.
   */
  function fitBoxText(): void {
    for (const [id, g] of nodeEls) {
      const { w } = sizeOf(byId.get(id)!);
      for (const t of g.querySelectorAll('text')) {
        t.removeAttribute('textLength');
        t.removeAttribute('lengthAdjust');
        const room = w - (t.classList.contains('hld-line') ? 18 : 10);
        if (t.getComputedTextLength() > room) {
          t.setAttribute('textLength', room.toFixed(1));
          t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
      }
    }
  }
  fitBoxText();
  const styleWatch = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => requestAnimationFrame(() => alive && fitBoxText())) : null;
  styleWatch?.observe(document.head, { childList: true });
  const chipBox = new Map<string, Box>();
  for (const fe of flowEls.values()) {
    const { fl, path, chip, chipRect, ring, chipText } = fe;
    const p = path.getPointAtLength(path.getTotalLength() * (fl.chip ?? 0.5));
    // Room for wider letter spacing (15 per cent more than the text needs), and the words 6px clear of the rounded ends.
    const w = Math.max(52, chipText.getComputedTextLength() * 1.15 + 24);
    chipRect.setAttribute('x', String(-w / 2));
    chipRect.setAttribute('width', String(w));
    ring.setAttribute('x', String(-w / 2 - 5));
    ring.setAttribute('width', String(w + 10));
    chip.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    chipBox.set(fl.id, { x: p.x - w / 2, y: p.y - CHIP_H / 2, w, h: CHIP_H });
  }
  const textBox = (t: SVGTextElement): Box | null => {
    if (!t.textContent) return null;
    const b = t.getBBox();
    return { x: b.x - 4, y: b.y, w: b.width + 8, h: b.height };
  };
  const frameTexts = [textBox(frameLabel), textBox(frameNote)].filter(Boolean) as Box[];
  /** Points along every line, every 3 units, for keeping labels clear of lines. */
  const samples = new Map<string, Pt[]>();
  for (const fe of flowEls.values()) {
    const L = fe.path.getTotalLength();
    const pts: Pt[] = [];
    for (let d = 0; d <= L; d += 3) {
      const p = fe.path.getPointAtLength(d);
      pts.push({ x: p.x, y: p.y });
    }
    samples.set(fe.fl.id, pts);
  }
  const frameSamples: Pt[] = [];
  for (let x = fr.x; x <= fr.x + fr.w; x += 3) frameSamples.push({ x, y: fr.y }, { x, y: fr.y + fr.h });
  for (let y = fr.y; y <= fr.y + fr.h; y += 3) frameSamples.push({ x: fr.x, y }, { x: fr.x + fr.w, y });

  // ---- what is drawn: which lines, chips and labels show in the current state ------------
  const liveLegs = () => {
    const s = step >= 0 ? design.tour[step] : null;
    return s ? [...s.path, ...(s.branch?.path ?? [])].map(legOf) : [];
  };
  /** The lines a step, an open box or an open line needs, cold ones included. */
  function needed(light: boolean): Set<string> {
    const need = new Set<string>();
    if (light) for (const l of liveLegs()) need.add(l.fl.id);
    if (picked) need.add(picked);
    if (selected) for (const f of design.flows) if (f.from === selected || f.to === selected) need.add(f.id);
    return need;
  }
  const lineShown = (fl: Flow, need: Set<string>) => !fl.cold || showCold || need.has(fl.id);
  function chipShown(fl: Flow, need: Set<string>, live: Set<string>): boolean {
    if (!lineShown(fl, need)) return false;
    if (!quietChip(fl)) return true;
    return live.has(fl.id) || picked === fl.id || peeking === fl.id || (document.activeElement === flowEls.get(fl.id)!.chip);
  }

  // ---- purpose labels: placed on demand, each by its own line, clear of everything else ----
  const labelSpot = new Map<string, { x: number; y: number; box: Box; leader: [Pt, Pt] | null }>();
  const labelCache = new Map<string, Map<string, { x: number; y: number; box: Box; leader: [Pt, Pt] | null }>>();
  function placeLabels(ids: string[], lines: Set<string>, chips: Set<string>): Map<string, { x: number; y: number; box: Box; leader: [Pt, Pt] | null }> {
    const key = `${ids.join(',')}|${[...lines].sort().join(',')}|${[...chips].sort().join(',')}`;
    const hitC = labelCache.get(key);
    if (hitC) return hitC;
    const out = new Map<string, { x: number; y: number; box: Box; leader: [Pt, Pt] | null }>();
    const obstacles: Box[] = [...nodeBoxes, ...frameTexts];
    const chipObs: Box[] = [...chips].map((id) => chipBox.get(id)!);
    const pts: Pt[] = [...frameSamples];
    for (const id of lines) pts.push(...samples.get(id)!);
    // The shortest lines have the fewest places to put a label: place them first.
    const order = [...ids].sort((a, b) => samples.get(a)!.length - samples.get(b)!.length);
    for (const id of order) {
      const fe = flowEls.get(id)!;
      const t0 = fe.label;
      t0.setAttribute('x', '0');
      t0.setAttribute('y', '0');
      t0.setAttribute('text-anchor', 'middle');
      const tb = t0.getBBox();
      const lw = tb.width;
      const lh = tb.height;
      const asc = -tb.y;
      const L = fe.path.getTotalLength();
      let best: { x: number; y: number; box: Box; leader: [Pt, Pt] | null; score: number } | null = null;
      for (const t of ANCHORS) {
        const a = fe.path.getPointAtLength(L * t);
        const a1 = fe.path.getPointAtLength(Math.max(0, L * t - 4));
        const a2 = fe.path.getPointAtLength(Math.min(L, L * t + 4));
        const tl = Math.hypot(a2.x - a1.x, a2.y - a1.y) || 1;
        const n = { x: -(a2.y - a1.y) / tl, y: (a2.x - a1.x) / tl };
        // Under the chip, the leader starts from the chip's edge, since chips are drawn above it.
        const ext = Math.abs(n.x) * (lw / 2) + Math.abs(n.y) * (lh / 2);
        // The label may also slide along the line, so its leader meets it near one end.
        const tx = n.y;
        const ty = -n.x;
        const along = Math.abs(tx) * (lw / 2 - 6) + Math.abs(ty) * (lh / 2 - 3);
        for (const d of [8, 14, 20, 26, 32, 38, 44, 52, 60, 72, 88]) {
          for (const side of [1, -1])
          for (const slide of [0, along, -along]) {
            const cx = a.x + side * n.x * (d + ext) + tx * slide;
            const cy = a.y + side * n.y * (d + ext) + ty * slide;
            const box = { x: cx - lw / 2, y: cy - lh / 2, w: lw, h: lh };
            const score = d + Math.abs(t - 0.5) * 50 + (side === 1 ? 0 : 0.5) + (slide ? 6 : 0);
            if (best && score >= best.score) continue;
            if (box.x < 2 || box.y < 2 || box.x + box.w > W - 2 || box.y + box.h > H - 2) continue;
            if (obstacles.some((o) => gapOf(o, box) < LABEL_CLEAR)) continue;
            if (chipObs.some((o) => gapOf(o, box) < LABEL_CHIP_CLEAR)) continue;
            if ([...out.values()].some((o) => gapOf(o.box, box) < LABEL_CLEAR)) continue;
            if (pts.some((p) => ptGap(p, box) < LABEL_LINE_CLEAR)) continue;
            const edge = { x: a.x + side * n.x * d + tx * slide, y: a.y + side * n.y * d + ty * slide };
            best = { x: cx, y: cy - lh / 2 + asc, box, leader: d > 5 ? [{ x: a.x, y: a.y }, edge] : null, score };
          }
        }
      }
      // Nowhere clear: the label stays off the picture. The detail's "Talks to" list has it.
      if (best) out.set(id, best);
    }
    labelCache.set(key, out);
    return out;
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
  /** Hidden recovery lines are out of the roving order until they show. */
  const reachable = (g: SVGGElement) => !g.dataset.flow || lineShown(flowById.get(g.dataset.flow)!, needed(lastLight));
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
      if (g === from || !reachable(g)) continue;
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
      const sorted = items.filter(reachable).sort((p, q) => centreOf(p).y - centreOf(q).y || centreOf(p).x - centreOf(q).x);
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
  /** A chip as drawn on the diagram, for the lists in the detail. */
  const chipTag = (fl: Flow) => h(`span.hld-tag.mode-${fl.mode}${fl.cold ? '.cold' : ''}`, null, fl.via);

  function renderDetail(c: Component | null, note?: string): void {
    if (!c) {
      detailBody.replaceChildren(
        ...(note ? [h('p.hld-missing', { tabIndex: -1 }, note)] : []),
        h('p.hld-hint', null, 'Select a box, a chip or a name below to see what it does, how it fails and what else you could use.'),
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
    // Every line this box has, with what travels on it: the picture shows only these labels while the box is open.
    const talks = design.flows.filter((f) => f.from === c.id || f.to === c.id);
    const talkItem = (f: Flow) => {
      const out = f.from === c.id;
      const other = nameOf(out ? f.to : f.from);
      const words = f.reply ? `with ${other}: ${f.label} one way, ${f.reply.label} the other` : `${out ? 'to' : 'from'} ${other}${f.label ? `: ${f.label}` : ''}`;
      const b: HTMLButtonElement = h('button.hld-talk', { type: 'button', onclick: () => pickFlow(f.id, 'text', b) }, chipTag(f), h('span', null, words), f.cold ? h('span.hld-cold-note', null, 'off the hot path') : null);
      return h('li', null, b);
    };
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
        h(
          'div', null,
          h('h4', null, 'Talks to'), h('ul.hld-talks', null, talks.map(talkItem)),
          h('h4', null, 'Alternatives'), h('ul.hld-alts', null, c.alternatives.map(alt)),
        ),
      ),
      h('p.hld-say', null, h('span.hld-k', null, 'Say: '), c.say),
      ...(c.see?.length
        ? [h('p.hld-see', null, 'The data structure inside: ', c.see.flatMap((s, i) => [i ? ', ' : '', h('a', { href: `#/s/${s.id}` }, s.label)]))]
        : []),
    );
  }

  function renderFlow(fl: Flow): void {
    const mode = modeOf(fl);
    const r = fl.reply;
    const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
    const glyph = lineSample(fl.mode, !!fl.cold, !quietChip(fl));
    const kind = mode.label.toLowerCase();
    const method = kind.startsWith(fl.via.toLowerCase()) ? kind : `${fl.via}, ${kind}`;
    glyph.classList.add('hld-detail-glyph');
    detailBody.replaceChildren(
      h('div.hld-detail-head', null, glyph, h('h3', { tabIndex: -1 }, lineName(fl)), h('p.hld-detail-tech', null, `${method}${fl.cold ? ', off the hot path' : ''}`), backControl()),
      h(
        'div.hld-detail-grid', null,
        h(
          'div', null,
          ...(r
            ? [
                h('h4', null, `${nameOf(fl.from)} to ${nameOf(fl.to)}`),
                h('p.hld-first', null, h('span.hld-k', null, `${cap(fl.label ?? fl.via)}. `), fl.how),
                h('p', null, h('span.hld-k', null, 'Promised: '), fl.delivery),
                h('h4', null, `${nameOf(fl.to)} to ${nameOf(fl.from)}`),
                h('p', null, h('span.hld-k', null, `${cap(r.label)}. `), r.how),
                h('p', null, h('span.hld-k', null, 'Promised: '), r.delivery),
              ]
            : [
                fl.label ? h('h4', null, 'What travels') : null,
                fl.label ? h('p.hld-first', null, cap(fl.label)) : null,
                h('h4', null, 'How they talk'), h(`p${fl.label ? '' : '.hld-first'}`, null, fl.how),
                h('h4', null, 'What is promised'), h('p', null, fl.delivery),
              ]),
          h('h4', null, mode.about), h('p', null, mode.note),
        ),
        h(
          'div', null,
          h('h4', null, 'Ways to connect them'),
          h(
            'ul.hld-alts', null,
            h('li.chosen', null, h('p.hld-alt-name', null, method, h('span.hld-used', null, 'used here'))),
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
    const headH = step >= 0 && !stage.classList.contains('reading') && !stage.classList.contains('unstick') ? head.offsetHeight : 0;
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
    paintFlows(lastLight);
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
      status.textContent = 'Closed.';
      return;
    }
    afterOpen(how, from, wasPlaying, byId.get(id)!.name);
  }

  function pickFlow(id0: string, how: How, from?: Element): void {
    const fl = lineOf(id0)!;
    const id = fl.id;
    const wasPlaying = playing;
    if (playing) pause(false);
    selected = null;
    const closing = picked === id && how !== 'text';
    picked = closing ? null : id;
    if (picked) renderFlow(fl);
    else renderDetail(null);
    markOpen();
    if (!picked) {
      origin = null;
      status.textContent = 'Closed.';
      return;
    }
    afterOpen(how, from, wasPlaying, lineName(fl));
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
    if (back && back.el.isConnected && (back.el as HTMLElement).getClientRects().length) {
      window.scrollTo({ top: back.y, behavior: 'auto' });
      canvas.scrollLeft = back.x;
      (back.el as HTMLElement).focus({ preventScroll: true });
      const r = back.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) (back.el as HTMLElement).scrollIntoView({ block: 'center' });
    } else {
      stage.scrollIntoView({ block: 'start', behavior: 'auto' });
      if (step >= 0) follow(step, true);
      if (!reachable(rove)) setRove(nodeEls.get(design.components[0].id)!, false);
      rove.focus({ preventScroll: true });
    }
    syncHead();
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
    status.textContent = step >= 0 ? `Closed. Back at step ${step + 1}, ${playing ? 'playing' : 'paused'}.` : 'Closed.';
  }

  function paintFlows(light = true): void {
    lastLight = light;
    const legs = light ? liveLegs() : [];
    const live = new Set(legs.map((l) => l.fl.id));
    const need = needed(light);
    const chipsOn = new Set<string>();
    for (const { fl, path, hit, chip } of flowEls.values()) {
      const linked = selected != null && (fl.from === selected || fl.to === selected);
      const on = fl.id === picked;
      const isLive = live.has(fl.id);
      const shown = lineShown(fl, need);
      for (const e of [path, hit, chip]) e.classList.toggle('need', shown);
      path.classList.toggle('live', isLive);
      path.classList.toggle('linked', (linked || on) && !isLive);
      path.classList.toggle('peek', peeking === fl.id && !isLive);
      const cs = chipShown(fl, need, live);
      if (cs) chipsOn.add(fl.id);
      chip.classList.toggle('show', cs);
      chip.classList.toggle('live', isLive);
      chip.classList.toggle('picked', on);
      chip.setAttribute('aria-expanded', String(on));
      // A recovery line that hides while its chip has focus hands focus to the box it starts from.
      if (!shown && document.activeElement === chip) setRove(nodeEls.get(fl.from)!, true);
    }
    // Purpose labels: an open box's own lines, or the one line open or pointed at. Never on the tour: the token carries the words there.
    const want = selected
      ? design.flows.filter((f) => (f.from === selected || f.to === selected) && f.label).map((f) => f.id)
      : picked
        ? [picked]
        : peeking && !live.has(peeking)
          ? [peeking]
          : [];
    const lines = new Set(design.flows.filter((f) => lineShown(f, need)).map((f) => f.id));
    const spots = want.length ? placeLabels(want, lines, chipsOn) : new Map();
    labelSpot.clear();
    for (const { fl, label, leader } of flowEls.values()) {
      const sp = spots.get(fl.id);
      label.classList.toggle('on', !!sp);
      leader.classList.toggle('on', !!sp?.leader);
      if (!sp) continue;
      labelSpot.set(fl.id, sp);
      label.setAttribute('x', sp.x.toFixed(1));
      label.setAttribute('y', sp.y.toFixed(1));
      label.setAttribute('text-anchor', 'middle');
      if (sp.leader) {
        leader.setAttribute('x1', sp.leader[0].x.toFixed(1));
        leader.setAttribute('y1', sp.leader[0].y.toFixed(1));
        leader.setAttribute('x2', sp.leader[1].x.toFixed(1));
        leader.setAttribute('y2', sp.leader[1].y.toFixed(1));
      }
    }
  }

  function setCold(on: boolean): void {
    showCold = on;
    coldBox.checked = on;
    store(COLD_KEY, on ? 'on' : 'off');
    svg.classList.toggle('show-cold', on);
    paintFlows(lastLight);
    status.textContent = on ? 'Recovery and reprocessing paths shown.' : 'Recovery and reprocessing paths hidden.';
  }
  svg.classList.toggle('show-cold', showCold);

  /** A control that is about to be disabled hands focus to Play first, so focus is never dropped on the page. */
  function disable(b: HTMLButtonElement, off: boolean): void {
    if (off && document.activeElement === b) playBtn.focus({ preventScroll: true });
    b.disabled = off;
  }

  function sync(light = true): void {
    const inTour = step >= 0;
    const s = inTour ? design.tour[step] : null;
    stepTitle.textContent = s ? s.title : 'Take the tour, or open any box';
    stepText.textContent = s ? s.text : restText();
    countLong.textContent = inTour ? `Step ${step + 1} of ${design.tour.length}` : `${design.tour.length} steps`;
    countShort.textContent = inTour ? `${step + 1}/${design.tour.length}` : `${design.tour.length} steps`;
    stepVia.replaceChildren(...(s ? viaLine(s) : []));
    // On the tour the diagram's one tab stop is the part this step is about: where its trip ends, if that is lit.
    if (s && !(document.activeElement && svg.contains(document.activeElement))) {
      const legs = s.path.map(legOf);
      const last = legs[legs.length - 1];
      const endId = last ? (last.back ? last.fl.from : last.fl.to) : s.focus[0];
      const part = nodeEls.get(s.focus.includes(endId) ? endId : s.focus[0]);
      if (part && part !== rove) setRove(part, false);
    }
    const focus = new Set(light ? (s?.focus ?? []) : []);
    for (const [id, g] of nodeEls) {
      g.classList.toggle('lit', focus.has(id));
      g.classList.toggle('quiet', inTour && !focus.has(id));
    }
    stage.classList.toggle('touring', inTour);
    stage.classList.toggle('playing', playing);
    const atEnd = step === design.tour.length - 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), playLabel);
    playLabel.textContent = playing ? 'Pause' : !inTour ? (leftAt > 0 ? `Resume at step ${leftAt + 1}` : 'Play the tour') : atEnd && !trip && !starting ? 'Replay' : 'Play';
    playBtn.setAttribute('aria-label', playLabel.textContent);
    disable(restartBtn, inTour ? step <= 0 : leftAt <= 0);
    disable(backBtn, step <= 0);
    disable(nextBtn, atEnd);
    if (!inTour && document.activeElement === exploreBtn) playBtn.focus({ preventScroll: true });
    exploreBtn.hidden = !inTour;
    syncHead();
    paintFlows(light);
    // Chips may have come or gone: each pill checks it still covers nothing.
    for (const tk of [token, branchTok]) if (tk.at && tk.g.style.display !== 'none') placePill(tk, tk.at.x, tk.at.y, pillWidth(tk.at.label), null, false);
  }

  /**
   * The readout sticks to the top of the screen during the tour, but never
   * takes more than 40 per cent of its height: when the whole step would, only
   * its title shows, with a More button for the rest; if even that is too tall,
   * or the reader opens More, it stops sticking.
   */
  function syncHead(): void {
    const inTour = step >= 0;
    const limit = innerHeight * HEAD_SHARE;
    const tH = transport.offsetHeight;
    const brief = inTour && reserve + tH > limit;
    stage.classList.toggle('brief', brief);
    if (!brief && moreOpen) setMore(false, true);
    if (!brief && document.activeElement === moreBtn) playBtn.focus({ preventScroll: true });
    moreBtn.hidden = !brief;
    readout.style.minHeight = inTour && reserve ? `${brief ? (moreOpen ? 0 : briefReserve) : reserve}px` : '';
    const tall = inTour && (moreOpen || head.offsetHeight > limit + 1);
    stage.classList.toggle('unstick', tall);
    document.documentElement.style.scrollPaddingTop = inTour && !tall && !stage.classList.contains('reading') ? `${head.offsetHeight + 8}px` : '';
  }
  function setMore(on: boolean, quiet = false): void {
    moreOpen = on;
    moreBtn.setAttribute('aria-expanded', String(on));
    moreBtn.textContent = on ? 'Less' : 'More';
    stage.classList.toggle('more', on);
    if (!quiet) syncHead();
  }

  function viaLine(s: (typeof design.tour)[number]): (string | HTMLElement)[] {
    const legs = [...s.path, ...(s.branch?.path ?? [])].map(legOf);
    const ways = [...new Set(legs.map(({ fl: x }) => {
      const kind = modeOf(x).label.toLowerCase();
      return kind.startsWith(x.via.toLowerCase()) ? kind : `${x.via} (${kind})`;
    }))];
    // A step with no trip says so, so the line is always there to read.
    return [h('span.hld-k', null, 'Travels by: '), ways.length ? ways.join(', then ') : `nothing this step; it waits in the ${nameOf(s.focus[0])}`];
  }

  /** Find the tallest readout of all the steps at the current width. */
  let measuredAt = '';
  function measureReserve(): void {
    // Only a change of width (or of the type size) changes the tallest step: skip the work otherwise.
    const key = `${readout.clientWidth}|${getComputedStyle(stepText).fontSize}|${innerHeight}`;
    if (key === measuredAt) {
      syncHead();
      return;
    }
    measuredAt = key;
    const [t, p, v] = Array.from(measure.children) as HTMLElement[];
    measure.style.width = `${readout.clientWidth}px`;
    let most = 0;
    let mostBrief = 0;
    for (const s of design.tour) {
      t.textContent = s.title;
      p.textContent = s.text;
      v.replaceChildren(...viaLine(s));
      p.style.display = '';
      most = Math.max(most, measure.offsetHeight);
      // The title and how it travels alone, as a short screen shows them.
      p.style.display = 'none';
      mostBrief = Math.max(mostBrief, measure.offsetHeight);
    }
    p.style.display = '';
    reserve = Math.ceil(most);
    briefReserve = Math.ceil(mostBrief);
    syncHead();
  }

  // ---- the token -----------------------------------------------------------------
  /** The pill's width for a label: its words at least 6px clear of the rounded ends at the smallest scale. */
  const pillMeasure = el('text', {}, '');
  // Measured in a hidden drawing of its own beside the diagram, in the pill's own style.
  const pillMeasureG = el('g', {}, 'hld-pill');
  const measureSvg = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' }, 'hld-measure-svg');
  measureSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
  pillMeasureG.append(pillMeasure);
  measureSvg.append(pillMeasureG);
  pan.append(measureSvg);
  const pillWidths = new Map<string, number>();
  const pillWidth = (label: string) => {
    let w = pillWidths.get(label);
    if (w == null) {
      pillMeasure.textContent = label;
      w = Math.max(48, pillMeasure.getComputedTextLength() * 1.1 + 26);
      pillWidths.set(label, w);
    }
    return w;
  };
  type Tok = ReturnType<typeof makeToken>;

  /**
   * Where a pill may not go, as a grid of 2-unit cells summed for quick box
   * queries: boxes (their names included), chips on show, purpose labels, the
   * frame's words, and every line on show and the frame's own outline, each
   * with 4 units to spare. Rebuilt only when what is drawn changes.
   */
  const CELL = 2;
  const LINE_CLEAR = 4;
  const gw = Math.ceil(W / CELL) + 1;
  const gh = Math.ceil(H / CELL) + 1;
  let occKey = '';
  let sat = new Int32Array((gw + 1) * (gh + 1));
  /** Boxes alone, which a pill's tie must not cross (chips are drawn over it). */
  let solid = new Int32Array((gw + 1) * (gh + 1));
  const summed = (occ: Uint8Array) => {
    const t = new Int32Array((gw + 1) * (gh + 1));
    for (let yy = 0; yy < gh; yy++) {
      let row = 0;
      for (let xx = 0; xx < gw; xx++) {
        row += occ[yy * gw + xx];
        t[(yy + 1) * (gw + 1) + xx + 1] = t[yy * (gw + 1) + xx + 1] + row;
      }
    }
    return t;
  };
  function occupancy(): Int32Array {
    const chips = [...flowEls.values()].filter((fe) => fe.chip.classList.contains('show') && fe.chip.classList.contains('need')).map((fe) => fe.fl.id);
    const lines = [...flowEls.values()].filter((fe) => fe.path.classList.contains('need')).map((fe) => fe.fl.id);
    const key = `${chips.join(',')}|${lines.join(',')}|${[...labelSpot.keys()].join(',')}`;
    if (key === occKey) return sat;
    occKey = key;
    let occ = new Uint8Array(gw * gh);
    const mark = (b: Box) => {
      const x0 = Math.max(0, Math.floor(b.x / CELL));
      const x1 = Math.min(gw, Math.ceil((b.x + b.w) / CELL));
      const y0 = Math.max(0, Math.floor(b.y / CELL));
      const y1 = Math.min(gh, Math.ceil((b.y + b.h) / CELL));
      for (let yy = y0; yy < y1; yy++) occ.fill(1, yy * gw + x0, yy * gw + Math.max(x0, x1));
    };
    const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
    for (const b of nodeBoxes) mark(b);
    solid = summed(occ);
    occ = new Uint8Array(gw * gh);
    for (const b of [...nodeBoxes, ...frameTexts]) mark(grow(b, 1));
    for (const id of chips) mark(grow(chipBox.get(id)!, 1));
    for (const sp of labelSpot.values()) mark(grow(sp.box, 1));
    const dot = (p: Pt) => mark({ x: p.x - LINE_CLEAR, y: p.y - LINE_CLEAR, w: 2 * LINE_CLEAR, h: 2 * LINE_CLEAR });
    for (const id of lines) samples.get(id)!.forEach(dot);
    frameSamples.forEach(dot);
    sat = summed(occ);
    return sat;
  }
  /** How many blocked cells a box covers. */
  const covered = (t: Int32Array, b: Box) => {
    const x0 = Math.max(0, Math.min(gw, Math.floor(b.x / CELL)));
    const x1 = Math.max(0, Math.min(gw, Math.ceil((b.x + b.w) / CELL)));
    const y0 = Math.max(0, Math.min(gh, Math.floor(b.y / CELL)));
    const y1 = Math.max(0, Math.min(gh, Math.ceil((b.y + b.h) / CELL)));
    const r = gw + 1;
    return t[y1 * r + x1] - t[y0 * r + x1] - t[y1 * r + x0] + t[y0 * r + x0];
  };

  /**
   * What the pill is placed against, read once per decision: the grid of
   * what it must not cover, what of the diagram the reader can see now (inside
   * the canvas, below the stuck readout, on the screen, in diagram units), and
   * how the view follows the token.
   */
  interface Ctx {
    t: Int32Array;
    view: Box;
    follows: boolean;
    panX: boolean;
    panY: boolean;
    mx: number;
    my: number;
    other: Tok;
    /** Placing a pill where the token rests: it needs only to fit on screen with its dot, since the view settles on both. */
    rest: boolean;
  }
  function context(tk: Tok, rest = false): Ctx {
    const sr = svg.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const v = viewport();
    const k = sr.width / W || 1;
    const l = Math.max(cr.left, 0);
    const r = Math.min(cr.right, innerWidth);
    const top = Math.max(cr.top, v.top);
    const b = Math.min(cr.bottom, v.bottom);
    return {
      t: occupancy(),
      view: { x: (l - sr.left) / k, y: (top - sr.top) / k, w: Math.max(0, r - l) / k, h: Math.max(0, b - top) / k },
      // The view follows whichever token is moving: the main one, then the branch on its own trip.
      follows: (tk === token || !!trip) && followsToken(),
      panX: canvas.scrollWidth > canvas.clientWidth + 1,
      panY: !(sr.top >= v.top - 1 && sr.bottom <= v.bottom + 1),
      mx: Math.min(90, canvas.clientWidth * 0.25) / k,
      my: Math.min(48, (v.bottom - v.top) * 0.25) / k,
      other: tk === token ? branchTok : token,
      rest,
    };
  }
  /** What will be visible when the token is at p, once the view has followed it there (see keepInView). */
  function visibleAt(p: Pt, c: Ctx): Box {
    if (!c.follows) return c.view;
    const out = { ...c.view };
    if (c.panX) {
      if (p.x < out.x + c.mx) out.x = Math.max(Math.min(out.x, 0), p.x - c.mx);
      else if (p.x > out.x + out.w - c.mx) out.x = Math.min(Math.max(out.x, W - out.w), p.x + c.mx - out.w);
    }
    if (c.panY) {
      if (p.y < out.y + c.my) out.y = p.y - c.my;
      else if (p.y > out.y + out.h - c.my) out.y = p.y + c.my - out.h;
    }
    return out;
  }

  /**
   * Places a pill can take around its dot, nearest first: above or below a line
   * that runs across, beside one that runs up and down; then, further out, any
   * place within reach of a short tie, nearest first.
   */
  const spotCache = new Map<string, Pt[]>();
  const pillSpots = (w: number, vertical: boolean): Pt[] => {
    const key = `${w.toFixed(1)}|${vertical}`;
    const hit = spotCache.get(key);
    if (hit) return hit;
    const out: Pt[] = [];
    const ph = PILL_H;
    for (const r of [0, 14, 30]) {
      const near: Pt[] = [
        { x: 0, y: -(PILL_GAP + r + ph / 2) },
        { x: 0, y: PILL_GAP + r + ph / 2 },
        { x: w / 2 - 4, y: -(PILL_GAP + r + ph / 2) },
        { x: -(w / 2 - 4), y: -(PILL_GAP + r + ph / 2) },
        { x: w / 2 - 4, y: PILL_GAP + r + ph / 2 },
        { x: -(w / 2 - 4), y: PILL_GAP + r + ph / 2 },
      ];
      const side: Pt[] = [
        { x: PILL_GAP + r + w / 2, y: 0 },
        { x: -(PILL_GAP + r + w / 2), y: 0 },
        { x: PILL_GAP + r + w / 2, y: -(ph / 2 + 6) },
        { x: -(PILL_GAP + r + w / 2), y: -(ph / 2 + 6) },
        { x: PILL_GAP + r + w / 2, y: ph / 2 + 6 },
        { x: -(PILL_GAP + r + w / 2), y: ph / 2 + 6 },
      ];
      out.push(...(vertical ? [...side, ...near] : [...near, ...side]));
    }
    const far: { o: Pt; d: number }[] = [];
    for (let dy = -150; dy <= 150; dy += 8) {
      for (let dx = -190; dx <= 190; dx += 10) {
        const b = { x: dx - w / 2, y: dy - ph / 2, w, h: ph };
        const d = ptGap({ x: 0, y: 0 }, b);
        if (d < PILL_GAP || d > 110) continue;
        far.push({ o: { x: dx, y: dy }, d: d + (vertical ? Math.abs(dy) : Math.abs(dx)) * 0.15 });
      }
    }
    far.sort((a, b) => a.d - b.d);
    out.push(...far.map((f) => f.o));
    spotCache.set(key, out);
    return out;
  };

  /**
   * What the token is doing, for its pill: the points still ahead on this leg
   * of its trip with how far along each is (or the one point it waits at), how
   * far along it is now, and which way the leg mostly runs.
   */
  interface Leg {
    key: object;
    at: number;
    ahead: () => { p: Pt; d: number }[];
    vertical: boolean;
    /** The pill may fade out here if nowhere is clear (on the move, at a turn, or fading in; never where the token rests). */
    mayHide?: boolean;
  }

  /**
   * How badly placed the pill would be with its dot at p and offset o: 0 when
   * it is clear of every box, chip, label, line and the frame, inside what the
   * reader can see, off the other pill, and tied by a line that crosses no box.
   */
  function spotCost(p: Pt, o: Pt, w: number, c: Ctx): number {
    const b: Box = { x: p.x + o.x - w / 2, y: p.y + o.y - PILL_H / 2, w, h: PILL_H };
    let cost = 0;
    if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) cost += 100;
    if (c.rest) {
      const both = union({ x: p.x - DOT_R, y: p.y - DOT_R, w: 2 * DOT_R, h: 2 * DOT_R }, b);
      if (both.w > c.view.w - 24 || both.h > c.view.h - 24) cost += 40;
    } else {
      const v = visibleAt(p, c);
      const iw = Math.max(0, Math.min(b.x + b.w, v.x + v.w) - Math.max(b.x, v.x));
      const ih = Math.max(0, Math.min(b.y + b.h, v.y + v.h) - Math.max(b.y, v.y));
      if (iw * ih < b.w * b.h - 0.5) cost += 40 + 200 * (1 - (iw * ih) / (b.w * b.h));
    }
    const n0 = covered(c.t, b);
    if (n0 > 0) cost += 10 + Math.min(n0, 300) / 6;
    const ob = c.other.g.style.display !== 'none' ? c.other.pillBox : null;
    if (ob && gapOf(ob, b) < 2) cost += 60;
    // A pill set further out is tied to its dot: the tie must not cross a box.
    const ex = Math.max(b.x, Math.min(p.x, b.x + b.w));
    const ey = Math.max(b.y, Math.min(p.y, b.y + b.h));
    const len = Math.hypot(ex - p.x, ey - p.y);
    const n = Math.ceil(len / 4);
    for (let i = Math.ceil((8 / Math.max(len, 1)) * n); i < n; i++) {
      const q = { x: p.x + ((ex - p.x) * i) / n, y: p.y + ((ey - p.y) * i) / n };
      if (covered(solid, { x: q.x - 0.5, y: q.y - 0.5, w: 1, h: 1 }) > 0) {
        cost += 20;
        break;
      }
    }
    return cost;
  }

  /** A switch of place starts this far ahead of where it is needed, so the glide is over by then. */
  const LEAD = 26;
  /**
   * Plan the pill's places for what is ahead on this leg: one place for the
   * whole leg when one is clear all the way (the place it has already wins),
   * otherwise the place clear for longest, then the next, and so on; where
   * nothing is clear, the place least in the way.
   */
  function planLeg(tk: Tok, leg: Leg, w: number, keep: number, rest = false): { d: number; spot: number; hide?: boolean }[] {
    const spots = pillSpots(w, leg.vertical);
    const pts = leg.ahead();
    const c = context(tk, rest);
    const plan: { d: number; spot: number; hide?: boolean }[] = [];
    let i = 0;
    let hiding = false;
    let cur = keep >= 0 && keep < spots.length ? keep : -1;
    while (i < pts.length) {
      const run = (sIdx: number, need: number) => {
        // A move starts a little before the place is needed (see LEAD): the new place must be clear there too.
        if (sIdx !== cur) for (let b = Math.max(0, i - 4); b < i; b++) if (spotCost(pts[b].p, spots[sIdx], w, c) > 0) return 0;
        let n = 0;
        while (i + n < pts.length && spotCost(pts[i + n].p, spots[sIdx], w, c) === 0) {
          n++;
          if (n > need && i + n >= pts.length) break;
        }
        return n;
      };
      let best = -1;
      let bestRun = 0;
      if (cur >= 0) {
        bestRun = run(cur, 0);
        best = cur;
      }
      if (i + bestRun < pts.length) {
        for (let sIdx = 0; sIdx < spots.length; sIdx++) {
          if (sIdx === cur) continue;
          // A different place has to be clear for clearly longer to be worth a move.
          const r = run(sIdx, bestRun);
          if (r > bestRun + (best === cur && cur >= 0 ? 3 : 0)) {
            bestRun = r;
            best = sIdx;
            if (i + r >= pts.length) break;
          }
        }
      }
      if (bestRun === 0) {
        let least = Infinity;
        spots.forEach((o, sIdx) => {
          const q = spotCost(pts[i].p, o, w, c) + (sIdx === cur ? -0.5 : 0);
          if (q < least) {
            least = q;
            best = sIdx;
          }
        });
        bestRun = 1;
      }
      // On the move, a stretch with no clear place at all: the pill fades out there and the dot travels alone, rather than sit on something.
      const hide = bestRun === 1 && (pts.length > 1 || !!leg.mayHide) && spotCost(pts[i].p, spots[best], w, c) > 0;
      if (best !== cur || hide !== hiding) plan.push({ d: pts[i].d, spot: best, hide });
      cur = best;
      hiding = hide;
      i += bestRun;
    }
    if (!plan.length) plan.push({ d: pts[0]?.d ?? 0, spot: Math.max(0, cur) });
    return plan;
  }

  /** The most a pill moves against its dot in one frame, in pixels: a change of place is a short glide, never a jump. */
  const PILL_STEP_PX = 9;
  let pillRaf = 0;
  /**
   * Put the pill beside the dot. Its places for a leg are planned when the
   * leg starts, from the whole leg, and kept; a place that something
   * unforeseen blocks for 150ms is planned again from there. Any move glides
   * there over about 120ms.
   */
  function placePill(tk: Tok, x: number, y: number, w: number, leg: Leg | null, snap: boolean): void {
    const now = performance.now();
    const vertical = leg ? leg.vertical : tk.vertical;
    const here: Leg = leg ?? { key: tk, at: 0, ahead: () => [{ p: { x, y }, d: 0 }], vertical };
    const replan = (keep: number) => {
      tk.plan = planLeg(tk, here, w, keep, !leg);
      tk.leg = here.key;
      tk.vertical = vertical;
      tk.planW = w;
      tk.blockedSince = 0;
      tk.since = now;
    };
    if (tk.spot < 0 || (leg && (tk.leg !== leg.key || tk.vertical !== vertical || tk.planW !== w))) replan(tk.spot >= 0 && tk.vertical === vertical ? tk.spot : -1);
    const planned = () => {
      let sp = tk.plan[0].spot;
      let hide = !!tk.plan[0].hide;
      // A fade starts further ahead than a move, so the pill is gone before it would cover anything; it shows again only once it is clear.
      tk.plan.forEach((e, n) => {
        const afterHidden = n > 0 && !!tk.plan[n - 1].hide;
        if (e.d <= here.at + (e.hide ? 2.4 * LEAD : afterHidden ? 0 : LEAD)) {
          sp = e.spot;
          hide = !!e.hide;
        }
      });
      tk.pillHide = !!leg && hide;
      return sp;
    };
    // Re-checked where it rests (a chip came or went): it keeps its place unless that is now blocked.
    if (!leg) tk.pillHide = false;
    let spot = leg || tk.spot < 0 ? planned() : tk.spot;
    const c = context(tk, !leg);
    if (spotCost({ x, y }, pillSpots(w, vertical)[spot], w, c) > 0) {
      if (!tk.blockedSince) tk.blockedSince = now;
      const moving = !!leg && !!trip;
      if (!moving || (now - tk.blockedSince >= 150 && now - tk.since >= 200)) {
        replan(spot);
        spot = planned();
      }
    } else tk.blockedSince = 0;
    if (spot !== tk.spot) tk.since = now;
    tk.spot = spot;
    tk.pillW = w;
    tk.target = pillSpots(w, vertical)[spot];
    if (snap || !tk.off) {
      // Unseen, it takes its place and its visibility at once.
      tk.off = { ...tk.target };
      if (tk.pillHide) tk.pillOp = 0;
    }
    stepPill(tk, x, y, w);
  }
  /** Move the pill part of the way to where it should be, and draw it and its tie. */
  function stepPill(tk: Tok, x: number, y: number, w: number): void {
    if (!tk.off || !tk.target) return;
    const dx = tk.target.x - tk.off.x;
    const dy = tk.target.y - tk.off.y;
    const d = Math.hypot(dx, dy);
    const now = performance.now();
    const wantOp = tk.pillHide ? 0 : 1;
    // Faded right out, the pill takes its next place at once and fades in there: nothing is seen to move.
    if (tk.pillOp < 0.05 && d > 0.3) {
      tk.off = { ...tk.target };
      return stepPill(tk, x, y, w);
    }
    if (Math.abs(tk.pillOp - wantOp) > 0.01) {
      if (now - tk.stepped > 8 || d <= 0.3) tk.pillOp += Math.sign(wantOp - tk.pillOp) * Math.min(0.25, Math.abs(wantOp - tk.pillOp));
      if (!pillRaf) pillRaf = requestAnimationFrame(pillFrame);
    }
    const op = tk.pillOp >= 0.99 ? '' : tk.pillOp.toFixed(2);
    if (tk.pill.style.opacity !== op) {
      tk.pill.style.opacity = op;
      tk.tether.style.opacity = op;
    }
    if (d > 0.3) {
      if (now - tk.stepped > 8) {
        const k = svg.getBoundingClientRect().width / W || 1;
        const go = Math.min(d * 0.3 + 0.5, PILL_STEP_PX / k, d);
        tk.off = { x: tk.off.x + (dx / d) * go, y: tk.off.y + (dy / d) * go };
        tk.stepped = now;
      }
      if (!pillRaf) pillRaf = requestAnimationFrame(pillFrame);
    } else tk.off = { ...tk.target };
    const o = tk.off;
    tk.pillBox = { x: x + o.x - w / 2, y: y + o.y - PILL_H / 2, w, h: PILL_H };
    tk.pill.setAttribute('transform', `translate(${o.x.toFixed(1)},${o.y.toFixed(1)})`);
    // A pill set further out is tied to its dot by a short line.
    const b = tk.pillBox;
    const ex = Math.max(b.x, Math.min(x, b.x + b.w));
    const ey = Math.max(b.y, Math.min(y, b.y + b.h));
    const far = Math.hypot(ex - x, ey - y) > PILL_GAP + 3;
    tk.tether.setAttribute('x1', '0');
    tk.tether.setAttribute('y1', '0');
    tk.tether.setAttribute('x2', (ex - x).toFixed(1));
    tk.tether.setAttribute('y2', (ey - y).toFixed(1));
    tk.tether.style.display = far ? '' : 'none';
  }
  /** Between trips nothing else draws a frame: a pill still gliding to its place finishes on its own frames. */
  function pillFrame(): void {
    pillRaf = 0;
    if (!alive || raf) return;
    for (const tk of [token, branchTok]) if (tk.at && tk.g.style.display !== 'none') stepPill(tk, tk.at.x, tk.at.y, tk.pillW);
  }

  function place(tk: Tok, x: number, y: number, label: string, opacity = 1, leg: Leg | null = null): void {
    const w = pillWidth(label);
    const wasHidden = tk.g.style.display === 'none' || !tk.at;
    tk.rect.setAttribute('x', String(-w / 2));
    tk.rect.setAttribute('width', String(w));
    tk.text.textContent = label;
    tk.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    tk.g.style.opacity = opacity >= 1 ? '' : Math.max(0, opacity).toFixed(2);
    tk.g.style.display = '';
    tk.at = { x, y, label };
    // An unseen pill takes its place at once: there is nothing to glide from.
    placePill(tk, x, y, w, leg, wasHidden || opacity < 0.3);
    if (tk === token || trip) keepInView(x, y, tk);
  }
  function hideToken(tk: Tok = token): void {
    tk.g.style.display = 'none';
    tk.at = null;
    tk.spot = -1;
    tk.leg = null;
    tk.plan = [];
    tk.pillHide = false;
    tk.pillOp = 1;
    tk.pill.style.opacity = '';
    tk.tether.style.opacity = '';
    tk.off = null;
    tk.target = null;
    tk.pillBox = null;
  }
  const tokenShown = () => token.g.style.display !== 'none' && !token.g.classList.contains('away') && (token.g.style.opacity === '' || +token.g.style.opacity > 0.05);

  /**
   * The connections of one step in order, each with the label the token
   * carries on it. The last leg stops just short of its arrowhead.
   */
  function pathLegs(i: number, which: 'main' | 'branch' = 'main'): PathSeg[] {
    const s = design.tour[i];
    const ps = which === 'main' ? s.path : s.branch?.path ?? [];
    const labels = which === 'main' ? s.labels : [s.branch!.label];
    return ps.map((p, n) => {
      const { fl, back } = legOf(p);
      const label = labels[Math.min(n, labels.length - 1)] ?? 'URL';
      const pe = flowEls.get(fl.id)!.path;
      const full = pe.getTotalLength();
      const len = n === ps.length - 1 ? Math.max(full * 0.5, full - (DOT_R + 8)) : full;
      return { kind: 'path', el: pe, back, full, len, label, who: which } as PathSeg;
    });
  }
  const legStart = (l: PathSeg): Pt => l.el.getPointAtLength(l.back ? l.full : 0);
  const legEnd = (l: PathSeg): Pt => l.el.getPointAtLength(l.back ? l.full - l.len : l.len);

  /** The whole trip for step i, from wherever the token is now. */
  function tripFor(i: number): Seg[] {
    const legs = pathLegs(i);
    const segs: Seg[] = [];
    const s = design.tour[i];
    const firstAt = legs.length ? legStart(legs[0]) : endOf(i);
    const firstLabel = legs.length ? legs[0].label : s.labels[0] ?? 'URL';
    // Never jump: fade out where it was, and in where it starts.
    const tAt = token.at;
    if (tAt && tokenShown() && Math.hypot(tAt.x - firstAt.x, tAt.y - firstAt.y) > JUMP) {
      segs.push({ kind: 'fade', at: { x: tAt.x, y: tAt.y }, label: tAt.label, dir: 'out', who: 'main' });
      segs.push({ kind: 'fade', at: firstAt, label: firstLabel, dir: 'in', who: 'main' });
    } else if (!tAt || !tokenShown()) segs.push({ kind: 'fade', at: firstAt, label: firstLabel, dir: 'in', who: 'main' });
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
    // The branch: a second token splits off where the main path ends and makes its own trip.
    const br = s.branch ? pathLegs(i, 'branch') : [];
    if (br.length) {
      segs.push({ kind: 'fade', at: legStart(br[0]), label: br[0].label, dir: 'in', who: 'branch' });
      segs.push(...br);
    }
    return segs;
  }

  /** How long a piece of the trip takes, in real milliseconds at the current speed. */
  function durOf(sg: Seg): number {
    if (sg.kind === 'path') return Math.max(FLOOR_LEG, Math.max(MIN_LEG, (sg.len / PACE) * 1000) / speed);
    if (sg.kind === 'hold') return Math.max(160, HOLD / speed);
    if (sg.kind === 'hop') return 2 * FADE + 80;
    return FADE;
  }

  /** Which way a leg mostly runs, worked out once per leg. */
  const legVertical = new WeakMap<PathSeg, boolean>();
  function pathLeg(sg: PathSeg, d: number): Leg {
    let vertical = legVertical.get(sg);
    if (vertical == null) {
      let up = 0;
      let across = 0;
      for (let a = 0; a + 4 <= sg.len; a += 4) {
        const p = sg.el.getPointAtLength(sg.back ? sg.full - a : a);
        const q = sg.el.getPointAtLength(sg.back ? sg.full - a - 4 : a + 4);
        up += Math.abs(q.y - p.y);
        across += Math.abs(q.x - p.x);
      }
      vertical = up > across;
      legVertical.set(sg, vertical);
    }
    return {
      key: sg,
      vertical,
      at: d,
      ahead: () => {
        const pts: { p: Pt; d: number }[] = [];
        for (let a = d; a < sg.len + 8; a += 8) {
          const at = Math.min(a, sg.len);
          const q = sg.el.getPointAtLength(sg.back ? sg.full - at : at);
          pts.push({ p: { x: q.x, y: q.y }, d: at });
          if (at >= sg.len) break;
        }
        return pts;
      },
    };
  }
  const pointLeg = (key: object, p: Pt, vertical: boolean, mayHide = false): Leg => ({ key, vertical, at: 0, mayHide, ahead: () => [{ p, d: 0 }] });

  function drawSeg(sg: Seg, u: number): void {
    if (sg.kind === 'path') {
      const d = ease(u) * sg.len;
      const at = sg.back ? sg.full - d : d;
      const pt = sg.el.getPointAtLength(at);
      place(sg.who === 'main' ? token : branchTok, pt.x, pt.y, sg.label, 1, pathLeg(sg, d));
    } else if (sg.kind === 'hold') place(token, sg.at.x, sg.at.y, u < 0.5 ? sg.label : sg.next, 1, pointLeg(sg, sg.at, token.vertical, true));
    else if (sg.kind === 'hop') {
      // Fade out, glide unseen, fade in: no jump, and no line drawn where none exists.
      const o = u < 0.38 ? 1 - u / 0.38 : u > 0.62 ? (u - 0.62) / 0.38 : 0;
      const k = Math.min(1, Math.max(0, (u - 0.38) / 0.24));
      const p = { x: sg.a.x + (sg.b.x - sg.a.x) * k, y: sg.a.y + (sg.b.y - sg.a.y) * k };
      place(token, p.x, p.y, u < 0.5 ? sg.label : sg.next, o, pointLeg(u < 0.5 ? sg.a : sg.b, u < 0.5 ? sg.a : sg.b, token.vertical, true));
    } else {
      const tk = sg.who === 'main' ? token : branchTok;
      place(tk, sg.at.x, sg.at.y, sg.label, sg.dir === 'out' ? 1 - u : u, sg.dir === 'out' ? null : pointLeg(sg, sg.at, tk.vertical, true));
    }
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
        // A piece finished between frames is drawn at its end, so the last frame of every leg is exact.
        drawSeg(trip.segs[trip.i], 1);
        trip.i++;
        trip.u = 0;
      } else {
        trip.u += dt / dur;
        dt = 0;
      }
    }
    if (trip.i >= trip.segs.length) {
      trip = null;
      sync();
      arrived(step);
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
  /** The label the token rests with at the end of step i. */
  const endLabel = (i: number) => {
    const legs = pathLegs(i);
    return legs.length ? legs[legs.length - 1].label : design.tour[i].labels[0] ?? 'URL';
  };

  /** Everything the reader needs to see for one step, in diagram units: lit boxes, the trip and where it stops. */
  function stepBox(i: number): Box {
    const s = design.tour[i];
    let u: Box | null = null;
    for (const id of s.focus) u = union(u, boxOf(id));
    for (const p of [...s.path, ...(s.branch?.path ?? [])]) {
      const { fl } = legOf(p);
      const b = flowEls.get(fl.id)!.path.getBBox();
      u = union(u, { x: b.x, y: b.y, w: b.width, h: b.height });
    }
    const e = endOf(i);
    const tw = pillWidth(endLabel(i));
    u = union(u, { x: e.x - tw / 2, y: e.y - PILL_H - PILL_GAP, w: tw, h: 2 * (PILL_H + PILL_GAP) });
    return u!;
  }
  /** Where the trip of step i begins, so a step too big for the screen is shown from its start. */
  function startOf(i: number): Pt {
    const legs = pathLegs(i);
    return legs.length ? legStart(legs[0]) : endOf(i);
  }

  /** The diagram's scale, in pixels per unit. It never changes on the tour: wider than the screen, the diagram pans. */
  function zoomFor(): number {
    const cw = canvas.clientWidth;
    // The overview shows the whole diagram, however small that makes it.
    const k = fitted ? Math.min(cw / W, MAX_SCALE) : Math.min(MAX_SCALE, Math.max(cw / W, BASE_SCALE));
    const want = k * W > cw + 0.5 || fitted ? `${(W * k).toFixed(1)}px` : '';
    if (svg.style.minWidth !== want) {
      svg.style.minWidth = want;
      svg.style.width = want;
    }
    return k;
  }

  /** The part of the screen the diagram can be seen in: below the stuck readout, inside the canvas. */
  function viewport(): { top: number; bottom: number } {
    const stuck = step >= 0 && !stage.classList.contains('reading') && !stage.classList.contains('unstick');
    return { top: stuck ? head.getBoundingClientRect().bottom : 0, bottom: innerHeight };
  }

  /**
   * Keep the moving token on screen: when it nears an edge of the visible part
   * of the diagram, the diagram pans (and the page scrolls) a little each frame
   * to follow it. Never a jump, never a zoom.
   */
  function followsToken(): boolean {
    if (!alive || step < 0 || stage.classList.contains('reading') || reducedMotion()) return false;
    // A reader who has scrolled away from the diagram is left where they are.
    const cv = canvas.getBoundingClientRect();
    return !(cv.bottom < 60 || cv.top > innerHeight - 60);
  }
  function keepInView(x: number, y: number, tk: Tok = token): void {
    if (!followsToken()) return;
    const k = svg.getBoundingClientRect().width / W;
    const cw = canvas.clientWidth;
    const margin = Math.min(90, cw * 0.25);
    const pb = tk.pillBox;
    if (canvas.scrollWidth > cw + 1) {
      const px = x * k - canvas.scrollLeft;
      let target = canvas.scrollLeft;
      if (px < margin) target = x * k - margin;
      else if (px > cw - margin) target = x * k - cw + margin;
      // The pill comes too, 8px inside the edge.
      if (pb) {
        if (pb.x * k - target < 8) target = pb.x * k - 8;
        else if ((pb.x + pb.w) * k - target > cw - 8) target = (pb.x + pb.w) * k - cw + 8;
        // The dot itself always stays on screen, 16px inside the edge.
        target = Math.min(Math.max(target, x * k - cw + 16), x * k - 16);
      }
      target = Math.max(0, Math.min(target, canvas.scrollWidth - cw));
      if (Math.abs(target - canvas.scrollLeft) > 0.5) canvas.scrollLeft += (target - canvas.scrollLeft) * 0.35;
    }
    const v = viewport();
    const sr = svg.getBoundingClientRect();
    // The whole diagram already on screen: the page stays still.
    if (sr.top >= v.top - 1 && sr.bottom <= v.bottom + 1) return;
    const sy = sr.top + y * k;
    const m2 = Math.min(48, (v.bottom - v.top) * 0.25);
    let dy = 0;
    if (sy < v.top + m2) dy = sy - v.top - m2;
    else if (sy > v.bottom - m2) dy = sy - v.bottom + m2;
    if (pb) {
      const pt = sr.top + pb.y * k - dy;
      const pbm = sr.top + (pb.y + pb.h) * k - dy;
      if (pt < v.top + 8) dy += pt - v.top - 8;
      else if (pbm > v.bottom - 8) dy += pbm - v.bottom + 8;
      dy = Math.min(Math.max(dy, sy - v.bottom + 16), sy - v.top - 16);
    }
    if (Math.abs(dy) > 0.5) window.scrollBy(0, dy * 0.35);
  }

  /**
   * When a trip ends, bring the step's lit boxes fully into view if they fit:
   * following the token may have left one partly under the readout or past an edge.
   */
  /** The box a step's trip ends at (or its first lit box, for a step with no trip). */
  function endBox(i: number): Box {
    const s0 = design.tour[i];
    if (!s0.path.length) return boxOf(s0.focus[0]);
    const last = legOf(s0.path[s0.path.length - 1]);
    return boxOf(last.back ? last.fl.from : last.fl.to);
  }
  function settle(i: number): { sl: number; y: number; ms: number } | null {
    if (!alive || stage.classList.contains('reading')) return null;
    const cv = canvas.getBoundingClientRect();
    if (cv.bottom < 60 || cv.top > innerHeight - 60) return null;
    let u: Box | null = null;
    for (const id of design.tour[i].focus) u = union(u, boxOf(id));
    if (!u) return null;
    const k = svg.getBoundingClientRect().width / W;
    const sr = svg.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const v = viewport();
    const top = Math.max(v.top, cr.top);
    // Too big to show whole: at least the box the trip ended at.
    const legs = pathLegs(i);
    if (legs.length && (u.w * k > cr.width || u.h * k > v.bottom - top)) u = endBox(i);
    // The token's pill comes too, when it fits with them: the reader sees what arrived as well as where.
    let pb = token.g.style.display !== 'none' ? token.pillBox : null;
    if (pb && branchTok.g.style.display !== 'none' && branchTok.pillBox) pb = union(pb, branchTok.pillBox);
    if (pb) {
      const both = union(u, pb);
      if (both.w * k <= cr.width - 12 && both.h * k <= v.bottom - top - 12) u = both;
      else {
        const end = union(endBox(i), pb);
        const at = token.at;
        const dot = at ? union({ x: at.x - DOT_R, y: at.y - DOT_R, w: 2 * DOT_R, h: 2 * DOT_R }, pb) : null;
        if (end.w * k <= cr.width - 12 && end.h * k <= v.bottom - top - 12) u = end;
        // Not even with the box: the token and its pill, at least.
        else if (dot && dot.w * k <= cr.width - 12 && dot.h * k <= v.bottom - top - 12) u = dot;
      }
    }
    // A margin of up to 6px, less when the boxes only just fit.
    const pad = Math.max(0, Math.min(6, (v.bottom - top - u.h * k) / 2, (cr.width - u.w * k) / 2));
    let dx = 0;
    const left = sr.left + u.x * k;
    const right = sr.left + (u.x + u.w) * k;
    if (u.w * k <= cr.width) {
      if (left < cr.left + pad) dx = left - cr.left - pad;
      else if (right > cr.right - pad) dx = right - cr.right + pad;
    }
    let dy = 0;
    const t0 = sr.top + u.y * k;
    const b0 = sr.top + (u.y + u.h) * k;
    if (u.h * k <= v.bottom - top) {
      if (t0 < top + pad) dy = t0 - top - pad;
      else if (b0 > v.bottom - pad) dy = b0 - v.bottom + pad;
    }
    const to = { sl: Math.max(0, Math.min(canvas.scrollLeft + (Math.abs(dx) > 1 ? dx : 0), canvas.scrollWidth - canvas.clientWidth)), y: Math.max(0, Math.min(window.scrollY + (Math.abs(dy) > 1 ? dy : 0), document.documentElement.scrollHeight - innerHeight)) };
    return { ...to, ms: glide(to.sl, to.y) };
  }

  /** The token has arrived: bring the end into view, then show any lit part still out of sight, and wait to read. */
  function arrived(i: number): void {
    stage.dataset.phase = 'rest';
    const end = settle(i);
    const extra = end ? glance(i, end, end.ms + 700) : 0;
    dwell(i, undefined, extra ? extra + 1200 : 0);
  }

  /**
   * Keep the step in view. When the readout, the transport and the whole
   * diagram fit on the screen together, the page sits with the stage at the
   * top for the whole tour and never moves. Otherwise the page scrolls, and the
   * diagram pans, so the step sits below the readout (which sticks to the top
   * of the screen) and above the bottom edge; a step too big for the screen is
   * shown from where its trip begins.
   */
  function follow(i: number, force = false): number {
    cancelAnimationFrame(followRaf);
    const sr = stage.getBoundingClientRect();
    const vh = innerHeight;
    if (!force && (sr.bottom < 40 || sr.top > vh - 40)) return 0;
    const u = stepBox(i);
    const st = startOf(i);
    const k = zoomFor();
    const pad = 10;
    const cw = canvas.clientWidth;
    const x0 = (u.x - pad) * k;
    const x1 = (u.x + u.w + pad) * k;
    let sl = canvas.scrollLeft;
    if (x1 - x0 > cw) sl = Math.min(Math.max(x0, st.x * k - cw * 0.3), x1 - cw);
    else if (x0 < sl) sl = x0;
    else if (x1 > sl + cw) sl = x1 - cw;
    sl = Math.max(0, Math.min(sl, canvas.scrollWidth - cw));
    const stageTop = sr.top + window.scrollY;
    const top = canvas.getBoundingClientRect().top + window.scrollY;
    const stuck = !stage.classList.contains('unstick');
    const headH = stuck ? head.offsetHeight : 0;
    let y = window.scrollY;
    if (head.offsetHeight + canvas.offsetHeight <= vh) y = stageTop;
    else {
      // The lowest scroll that shows the bottom of the step, and the highest that keeps its top below the stuck readout.
      const lo = top + (u.y + u.h + pad) * k - vh + 6;
      const hi = top + (u.y - pad) * k - headH - 6;
      y = Math.max(lo, Math.min(y, hi));
      if (lo > hi) y = Math.min(hi, Math.max(lo, top + st.y * k - headH - (vh - headH) * 0.4));
      // A short screen (a phone on its side): the readout sticks at the very top, so the diagram has all the height left below it.
      if (vh < 500 && stuck) y = Math.max(y, stageTop);
    }
    return glide(sl, y);
  }

  /** Glide the page and the canvas together to a place: returns how long that takes (0 when already there, or with reduced motion). */
  function glide(sl0: number, y0: number): number {
    cancelAnimationFrame(followRaf);
    const sl = Math.max(0, Math.min(sl0, canvas.scrollWidth - canvas.clientWidth));
    const y = Math.max(0, Math.min(y0, document.documentElement.scrollHeight - innerHeight));
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
   * What of the diagram the reader would see with the page scrolled to y and
   * the canvas to sl, in diagram units: inside the canvas, below the stuck
   * readout, on the screen.
   */
  function viewAt(sl: number, y: number): Box {
    const sr = svg.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const k = sr.width / W;
    const svgLeft = sr.left - cr.left + canvas.scrollLeft;
    const svgTop = sr.top + window.scrollY - y;
    const stuck = step >= 0 && !stage.classList.contains('reading') && !stage.classList.contains('unstick');
    const headBottom = stuck ? Math.max(head.offsetHeight, stage.getBoundingClientRect().top + window.scrollY - y + head.offsetHeight) : 0;
    const top = Math.max(cr.top + window.scrollY - y, headBottom, 0);
    const bottom = Math.min(cr.top + window.scrollY - y + cr.height, innerHeight);
    const left = Math.max(0, cr.left);
    const right = Math.min(innerWidth, cr.right);
    return { x: (left - cr.left + sl - svgLeft) / k, y: (top - svgTop) / k, w: (right - left) / k, h: Math.max(0, bottom - top) / k };
  }
  /** The scroll that puts a region of the diagram in the middle of what can be seen. */
  function centreOn(u: Box): { sl: number; y: number } {
    const sr = svg.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const k = sr.width / W;
    const svgLeft = sr.left - cr.left + canvas.scrollLeft;
    const left = Math.max(0, cr.left);
    const visW = Math.min(innerWidth, cr.right) - left;
    const sl = svgLeft + (u.x + u.w / 2) * k - (left - cr.left) - visW / 2;
    const stuck = step >= 0 && !stage.classList.contains('reading') && !stage.classList.contains('unstick');
    const headH = stuck ? head.offsetHeight : 0;
    const svgDocTop = sr.top + window.scrollY;
    let y = svgDocTop + (u.y + u.h / 2) * k - (headH + (innerHeight - headH) / 2);
    // When the whole diagram is in view anyway, the page stays where it is.
    const v = viewAt(canvas.scrollLeft, window.scrollY);
    if (u.y >= v.y && u.y + u.h <= v.y + v.h) y = window.scrollY;
    return { sl: Math.max(0, Math.min(sl, canvas.scrollWidth - canvas.clientWidth)), y: Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)) };
  }
  const within = (b: Box, v: Box, pad = 0) => b.x >= v.x - pad && b.y >= v.y - pad && b.x + b.w <= v.x + v.w + pad && b.y + b.h <= v.y + v.h + pad;

  /**
   * At the end of a step, every part it lights must have been seen. When they
   * do not all fit the screen at reading size (a phone, or a short window), the
   * view glides to the ones out of sight, a group at a time, waits there, and
   * glides back to where the trip ended. Returns how long all that takes.
   */
  let glanceTimer = 0;
  function cancelGlance(): void {
    clearTimeout(glanceTimer);
    glanceTimer = 0;
    if (stage.dataset.phase === 'glance') stage.dataset.phase = 'rest';
  }
  function glance(i: number, end: { sl: number; y: number }, after: number): number {
    cancelGlance();
    if (!alive || stage.classList.contains('reading') || !followsTokenOrStill()) return 0;
    const endView = viewAt(end.sl, end.y);
    const lit = design.tour[i].focus.map(boxOf);
    let unseen = lit.filter((b) => !within(b, endView, 1));
    if (!unseen.length) return 0;
    const stops: { sl: number; y: number }[] = [];
    let from = endView;
    while (unseen.length && stops.length < 3) {
      const c = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
      unseen.sort((a, b) => Math.hypot(a.x + a.w / 2 - c.x, a.y + a.h / 2 - c.y) - Math.hypot(b.x + b.w / 2 - c.x, b.y + b.h / 2 - c.y));
      let u = unseen[0];
      for (const o of unseen.slice(1)) {
        const t = union(u, o);
        if (t.w + 8 <= endView.w && t.h + 8 <= endView.h) u = t;
      }
      const at = centreOn(u);
      const v = viewAt(at.sl, at.y);
      stops.push(at);
      unseen = unseen.filter((b) => !within(b, v, 1));
      if (unseen.length && stops.length && within(u, v, 1) === false) break;
      from = v;
    }
    const HOLD_MS = 1500;
    const GLIDE_MS = 480;
    let t = after;
    const plan: [number, () => void][] = [];
    for (const st of stops) {
      plan.push([t, () => {
        stage.dataset.phase = 'glance';
        glide(st.sl, st.y);
      }]);
      t += GLIDE_MS + HOLD_MS;
    }
    plan.push([t, () => {
      glide(end.sl, end.y);
    }]);
    t += GLIDE_MS;
    plan.push([t, () => {
      if (stage.dataset.phase === 'glance') stage.dataset.phase = 'rest';
    }]);
    let n = 0;
    const next = () => {
      glanceTimer = 0;
      if (!alive || step !== i) return;
      const [, fn] = plan[n++];
      fn();
      if (n < plan.length) glanceTimer = window.setTimeout(next, plan[n][0] - plan[n - 1][0]);
    };
    glanceTimer = window.setTimeout(next, plan[0][0]);
    return t;
  }
  /** The view follows the tour unless the reader is reading a detail or has scrolled the diagram away. */
  function followsTokenOrStill(): boolean {
    if (!alive || step < 0 || stage.classList.contains('reading')) return false;
    const cv = canvas.getBoundingClientRect();
    return !(cv.bottom < 60 || cv.top > innerHeight - 60);
  }

  /** Whether the reader has had the diagram in view at any time during this step: if not, the tour pauses rather than run on unseen. */
  let seenStep = true;
  const stageVisible = () => {
    const r = canvas.getBoundingClientRect();
    return r.bottom > 40 && r.top < innerHeight - 40;
  };
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) seenStep = true;
  }) : null;
  io?.observe(canvas);
  function dwell(i: number, ms?: number, least = 0): void {
    clearTimeout(timer);
    timer = 0;
    dwellLeft = 0;
    if (!playing) return;
    const s = design.tour[i];
    // Long enough to read at any speed: double speed shortens the wait, but never below 3.5 seconds. Half speed slows only
    // the motion: the wait to read stays as at normal speed. Never shorter than the glance at the parts out of sight.
    dwellMs = ms ?? Math.max(least, Math.max(3500, Math.min(11000, Math.max(4200, s.text.length * 42)) / Math.max(1, speed)));
    dwellAt = performance.now();
    timer = window.setTimeout(() => {
      timer = 0;
      if (!alive || !playing) return;
      if (!seenStep && !stageVisible()) {
        pause(false);
        status.textContent = `Paused at step ${i + 1}: the diagram is out of view.`;
        return;
      }
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
    cancelGlance();
    hideToken(branchTok);
    // Faded out during the glide: it starts afresh where this trip starts, with no fade-out where it was.
    if (token.g.classList.contains('away')) hideToken();
    token.g.classList.remove('away');
    token.g.classList.toggle('waiting', !design.tour[i].path.length);
    if (!animate || reducedMotion()) {
      const e = endOf(i);
      place(token, e.x, e.y, endLabel(i));
      const br = design.tour[i].branch ? pathLegs(i, 'branch') : [];
      if (br.length) {
        const be = legEnd(br[br.length - 1]);
        place(branchTok, be.x, be.y, br[br.length - 1].label);
      }
      arrived(i);
      return;
    }
    const segs = tripFor(i);
    if (!segs.length) {
      // A step with no connection, and the token already where it waits.
      const e = endOf(i);
      place(token, e.x, e.y, endLabel(i));
      arrived(i);
      return;
    }
    stage.dataset.phase = 'trip';
    trip = { segs, i: 0, u: 0, last: null };
    if (frozen) {
      // Waiting at the start: the token shows where it will set off, not faded out.
      while (trip.i < segs.length - 1 && segs[trip.i].kind === 'fade') {
        drawSeg(segs[trip.i], 1);
        trip.i++;
      }
      drawSeg(segs[trip.i], 0);
    } else {
      drawSeg(segs[0], 0);
      raf = requestAnimationFrame(tick);
    }
  }

  function announce(i: number, manual: boolean): void {
    const s = design.tour[i];
    const via = viaLine(s).map((x) => (typeof x === 'string' ? x : x.textContent)).join('');
    status.textContent = manual ? `Step ${i + 1} of ${design.tour.length}. ${s.title}. ${s.text}${via ? ` ${via}.` : ''}` : `Step ${i + 1} of ${design.tour.length}. ${s.title}.`;
  }

  function go(i: number, manual: boolean, whole = false): void {
    if (i < 0 || i >= design.tour.length) return;
    clearTimeout(starting);
    starting = 0;
    holdTrip = false;
    if (manual && playing) pause(false);
    step = i;
    leftAt = -1;
    seenStep = stageVisible();
    stage.classList.remove('reading');
    // The readout takes its touring height first, so the view is worked out with the readout as it will be.
    stage.classList.add('touring');
    syncHead();
    const ms = follow(i, manual || whole);
    if (ms > 0) {
      // The view glides to the step first. The new text shows at once; the boxes, lines and token light up when the view arrives.
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(timer);
      timer = 0;
      trip = null;
      cancelGlance();
      // The token fades where it was while the view glides, rather than blinking out; the new trip fades it in where it starts.
      hideToken(branchTok);
      token.g.classList.add('away');
      stage.dataset.phase = 'glide';
      starting = window.setTimeout(() => {
        starting = 0;
        if (!alive || step !== i) return;
        run(i, true, holdTrip);
        holdTrip = false;
        sync();
      }, ms);
      sync(false);
    } else {
      run(i, true);
      sync();
    }
    announce(i, manual);
    if (!selected && !picked) setUrl();
  }

  function pause(say = true): void {
    if (!playing) return;
    playing = false;
    cancelGlance();
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
    sync(!starting);
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
    sync(!starting);
    status.textContent = `Playing from step ${step + 1}.`;
    if (starting) holdTrip = false;
    else if (trip) {
      trip.last = null;
      if (!raf) raf = requestAnimationFrame(tick);
    } else dwell(step, dwellLeft > 0 ? dwellLeft : undefined);
  }

  /** Run the current step's trip again, from its start. */
  function replayStep(): void {
    if (step < 0) return;
    hideToken();
    run(step, true);
    sync();
    status.textContent = `Step ${step + 1} again.`;
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
    cancelGlance();
    delete stage.dataset.phase;
    if (wasIn) leftAt = step < design.tour.length - 1 ? step : -1;
    step = -1;
    hideToken();
    hideToken(branchTok);
    token.g.classList.remove('away', 'waiting');
    if (moreOpen) setMore(false, true);
    if (fromButton) playBtn.focus({ preventScroll: true });
    sync();
    zoomFor();
    // The readout drops its touring height: keep the diagram where it was on screen.
    const after = canvas.getBoundingClientRect().top;
    if (Math.abs(after - before) > 0.5 && before < innerHeight && canvas.getBoundingClientRect().bottom > 0) window.scrollBy(0, after - before);
    status.textContent = wasIn ? 'Left the tour.' : '';
    if (!selected && !picked) setUrl();
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
      dwell(step, Math.max(0, (left * Math.max(1, old)) / Math.max(1, s)));
    } else if (!playing && dwellLeft) dwellLeft = (dwellLeft * Math.max(1, old)) / Math.max(1, s);
  }
  speedCycle.setAttribute('aria-label', 'Normal speed. Change speed');

  function setFit(on: boolean): void {
    fitted = on;
    svg.classList.toggle('fit', on);
    zoomFor();
    fitBtn.setAttribute('aria-pressed', String(on));
    syncPan();
    if (step >= 0) follow(step, true);
  }

  /** The cues for a diagram wider than its box: a fade at each edge with more to see, and a line saying so. */
  function syncPan(): void {
    const k0 = zoomFor();
    const k = fitted ? svg.getBoundingClientRect().width / W || k0 : k0;
    for (const sm of legend.querySelectorAll<SVGSVGElement>('svg.hld-sample')) sizeSample(sm, k);
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
      ? 'Overview: the text is too small to read. Turn this off to read the labels.'
      : coarse()
        ? 'The diagram is wider than the screen: drag it sideways to see the rest.'
        : 'The diagram is wider than its box: scroll it sideways, or focus it and use the arrow keys.';
  }
  // A reader who takes hold of the diagram stops the glance at the parts out of sight.
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) canvas.addEventListener(ev, () => glanceTimer && cancelGlance(), { passive: true });
  canvas.addEventListener('scroll', () => {
    pan.classList.toggle('more-left', canvas.scrollLeft > 2);
    pan.classList.toggle('more-right', canvas.scrollLeft < canvas.scrollWidth - canvas.clientWidth - 2);
  }, { passive: true });

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
        const onHead = head.contains(t);
        leaveTour(onHead);
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
    } else if ((e.key === 'r' || e.key === 'R') && step >= 0) {
      e.preventDefault();
      replayStep();
    }
  };
  document.addEventListener('keydown', onKey);

  // While the readout sticks to the top, nothing focused may hide under it.
  const onFocusIn = (e: FocusEvent) => {
    if (step < 0 || stage.classList.contains('reading') || stage.classList.contains('unstick')) return;
    const t = e.target as Element;
    // Only this page's own controls: the site's sidebar has its own place on screen.
    if (!t || head.contains(t) || !page.contains(t)) return;
    const r = t.getBoundingClientRect();
    const hb = head.getBoundingClientRect().bottom;
    if (r.top < hb + 4 && r.bottom > 0) window.scrollBy(0, r.top - hb - 8);
  };
  document.addEventListener('focusin', onFocusIn);
  // The shortcut switch lives in the sidebar: keep the hints in step with it.
  const onKeysSwitch = (e: Event) => {
    if ((e.target as HTMLElement).id === 'site-keys') syncKeys();
  };
  document.addEventListener('change', onKeysSwitch);

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
      // The readout settles its height (title only, or the whole step) first; then the view follows the step.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (alive && step >= 0 && !stage.classList.contains('reading')) follow(step, true);
        }),
      );
    }, 160);
  };
  window.addEventListener('resize', onResize);
  syncKeys();
  measureReserve();
  renderDetail(null);
  sync();
  syncPan();

  /** Focus moved by a link, not a key: no mark is drawn for it until the reader presses a key there. */
  function quietFocus(e: HTMLElement): void {
    e.classList.add('by-link');
    e.focus({ preventScroll: true });
    const off = () => {
      e.classList.remove('by-link');
      e.removeEventListener('blur', off);
      e.removeEventListener('keydown', off);
    };
    e.addEventListener('blur', off);
    e.addEventListener('keydown', off);
  }

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
      const h3 = () => detailBody.querySelector('h3') as HTMLElement | null;
      if (open.kind === 'c') {
        if (byId.has(open.id)) {
          select(open.id, 'text');
          if (h3()) quietFocus(h3()!);
        } else missing('component');
      } else if (open.kind === 'f') {
        if (lineOf(open.id)) {
          pickFlow(open.id, 'text');
          if (h3()) quietFocus(h3()!);
        } else missing('connection');
      } else if (open.kind === 't') {
        const n = Number(open.id);
        // The step shows and is announced, and focus goes to its title (no ring for a pointer user: see :focus-visible).
        if (Number.isInteger(n) && n >= 1 && n <= design.tour.length) {
          go(n - 1, true, true);
          quietFocus(stepTitle);
        }
        else missing('tour step');
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
    clearTimeout(glanceTimer);
    cancelAnimationFrame(pillRaf);
    ro?.disconnect();
    panRo?.disconnect();
    io?.disconnect();
    styleWatch?.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('change', onKeysSwitch);
    window.removeEventListener('resize', onResize);
    document.documentElement.style.scrollPaddingTop = '';
    page.remove();
  };
}
