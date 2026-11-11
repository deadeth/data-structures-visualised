import './design.css';
import { h, tableRoles } from '../core/dom';
import type { Extras } from '../designs/extras/types';
import { extrasParts } from './design-extras';
import { MODES, type Component, type Design, type Flow } from '../designs/types';

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
const LABEL_CLEAR = 7;
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
/** The token's pace along a leg: eased, but never so slow at either end that it seems to stand still where it sets off or arrives. */
const easeLeg = (t: number) => 0.5 * t + 0.5 * ease(t);

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
const SAMPLE_PX = 68;
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
    if (mode === 'async') g.append(el('path', {}, 'hld-chip-glyph'));
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
    const gl = r.nextElementSibling;
    // The log glyph, three bars, at the size the diagram draws it.
    if (gl) gl.setAttribute('d', [-5, -1.1, 2.8].map((dx) => `M${(dx / k).toFixed(2)},${(-3.5 / k).toFixed(2)} h${(2.2 / k).toFixed(2)} v${(7 / k).toFixed(2)} h${(-2.2 / k).toFixed(2)} z`).join(' '));
  } else extra.setAttribute('d', `M${(L - 10 / k).toFixed(2)},${(m - 5 / k).toFixed(2)} L${(L - 2 / k).toFixed(2)},${m.toFixed(2)} L${(L - 10 / k).toFixed(2)},${(m + 5 / k).toFixed(2)} z`);
}
function boxSample(kind: string): SVGSVGElement {
  const s2 = el('svg', { viewBox: '0 0 40 26', width: 40, height: 26, 'aria-hidden': 'true' }, `hld-node kind-${kind} sample`);
  if (kind === 'store') {
    s2.append(el('path', { d: 'M2,7 A18,4 0 0 1 38,7 V20 A18,4 0 0 1 2,20 Z' }, 'hld-box'));
    s2.append(el('path', { d: 'M2,7 A18,4 0 0 0 38,7' }, 'hld-cap'));
  } else {
    s2.append(el('rect', { x: 2, y: 3, width: 36, height: 20, rx: kind === 'input' ? 8 : 4 }, 'hld-box'));
    // A shared service or an input carries a bar down its left side, so the kind does not rest on the fill alone.
    if (kind === 'input' || kind === 'shared') {
      const clip = el('clipPath', { id: 'hld-key-bar-clip' });
      clip.append(el('rect', { x: 2.8, y: 3.8, width: 34.4, height: 18.4, rx: kind === 'input' ? 7.2 : 3.2 }));
      s2.append(clip, el('rect', { x: 2.8, y: 3, width: 4, height: 20, 'clip-path': 'url(#hld-key-bar-clip)' }, 'hld-bar'));
    }
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
/** A leg along a connection, with the one place its pill keeps for the whole leg (`off`, from the dot). */
type PathSeg = { kind: 'path'; el: SVGPathElement; back: boolean; full: number; from: number; len: number; label: string; who: Who; vertical: boolean; off: Pt };
type Seg =
  | PathSeg
  | { kind: 'hop'; a: Pt; b: Pt; label: string; next: string; offA: Pt; offB: Pt; noPillB?: boolean }
  | { kind: 'hold'; at: Pt; label: string; next: string; offA: Pt; offB: Pt; who?: Who; hideA?: boolean; hideB?: boolean; seen?: boolean }
  | { kind: 'fade'; at: Pt; label: string; who: Who; off: Pt; noPill?: boolean };

/**
 * A system design as an interactive diagram: a guided tour that follows one
 * URL round the loop, and boxes that open to explain themselves.
 */
export async function mountDesign(host: HTMLElement, design: Design, open?: { kind: string; id: string }, extras?: Extras): Promise<() => void> {
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
  for (const [id, cls, size] of [['hld-arrow', 'hld-tip', 7], ['hld-arrow-live', 'hld-tip live', 5.2], ['hld-arrow-linked', 'hld-tip linked', 5.2], ['hld-arrow-picked', 'hld-tip linked', 4.4], ['hld-arrow-failed', 'hld-tip failed', 5.6], ['hld-arrow-quiet', 'hld-tip quiet', 7]] as const) {
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
    /** A message log's chip carries a small log glyph before its words. */
    glyph: SVGPathElement | null;
    /** The open connection's chip: a band in the focus colour round it. */
    halo: SVGRectElement;
    label: SVGTextElement;
    /** A paper-coloured plate behind a purpose label, so it reads where it crosses a line or a frame. */
    labelBg: SVGRectElement;
    leader: SVGLineElement;
  }
  const flowEls = new Map<string, FlowEl>();
  const lineIdOf = new Map<SVGPathElement, string>();
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
    const halo = el('rect', { y: -CHIP_H / 2 - 4, height: CHIP_H + 8, rx: CHIP_H / 2 + 4 }, 'hld-halo');
    const chipRect = el('rect', { y: -CHIP_H / 2, height: CHIP_H, rx: CHIP_H / 2 }, 'hld-chip-box');
    const chipText = el('text', { y: 4.65, 'text-anchor': 'middle' });
    chipText.textContent = fl.via;
    const glyph = fl.mode === 'async' ? el('path', {}, 'hld-chip-glyph') : null;
    chip.append(halo, ring, chipRect, ...(glyph ? [glyph] : []), chipText);
    chip.addEventListener('click', (e) => pickFlow(fl.id, e.detail === 0 ? 'key' : 'pointer', chip));
    chipLayer.append(chip);
    items.push(chip);
    const leader = el('line', {}, 'hld-leader');
    const labelBg = el('rect', { rx: 5 }, 'hld-label-bg');
    const label = el('text', {}, 'hld-flow-label');
    label.textContent = fl.reply ? `${fl.label} / ${fl.reply.label}` : fl.label ?? fl.via;
    label.dataset.flow = fl.id;
    labelLayer.append(leader, labelBg, label);
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
    flowEls.set(fl.id, { fl, path, hit, chip, chipRect, ring, chipText, glyph, halo, label, labelBg, leader });
    lineIdOf.set(path, fl.id);
  }
  svg.append(flowLayer, hitLayer, frameLabel, frameNote);

  const nodeEls = new Map<string, SVGGElement>();
  for (const c of design.components) {
    const { w, h: hh } = sizeOf(c);
    // An input is a rounded tab, rounder than a service's box but not a full pill, so its words keep clear of the ends.
    const rx = c.kind === 'input' ? Math.min(20, hh / 2) : 10;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})`, tabindex: -1, role: 'button', 'aria-expanded': 'false', 'aria-controls': DETAIL_ID, 'aria-label': `${[c.short ?? c.name, c.tech, ...(c.lines ?? [])].join(' ')}${c.short ? `. ${c.name}` : ''}. Component.` }, `hld-node kind-${c.kind}`);
    g.dataset.id = c.id;
    g.append(el('rect', { x: -6, y: -6, width: w + 12, height: hh + 12, rx: rx + 6 }, 'hld-ring'));
    // A store is a cylinder, so its shape cannot be read as a box with a link under its text.
    const CAP = 6;
    if (c.kind === 'store') {
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 1 ${w},${CAP} V${hh - CAP} A${w / 2},${CAP} 0 0 1 0,${hh - CAP} Z` }, 'hld-box'));
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 0 ${w},${CAP}` }, 'hld-cap'));
    } else g.append(el('rect', { width: w, height: hh, rx }, 'hld-box'));
    // An input or a shared service: a 4-unit bar inside its left edge, a second cue beside the fill that needs no colour.
    if (c.kind === 'input' || c.kind === 'shared') {
      const clipId = `${design.id}-bar-${c.id}`;
      const clip = el('clipPath', { id: clipId });
      clip.append(el('rect', { x: 0.8, y: 0.8, width: w - 1.6, height: hh - 1.6, rx: Math.max(0, rx - 0.8) }));
      defs.append(clip);
      g.append(el('rect', { x: 0.8, y: 0, width: 4, height: hh, 'clip-path': `url(#${clipId})` }, 'hld-bar'));
    }
    // A log is drawn as a row of segments along its lower edge: messages in order.
    if (c.kind === 'queue') g.append(el('path', { d: Array.from({ length: 9 }, (_, i) => `M${18 + i * ((w - 36) / 8)},${hh - 9} v5`).join(' ') }, 'hld-shelf'));
    // Where the name sits: every text at least 6px inside its outline at the smallest scale (7.6 units), clear of a cylinder's
    // cap and a log's ticks. The subtitle is 19 units under the name.
    const top = c.lines || c.kind === 'queue' ? 23.5 : c.kind === 'store' ? 2 * CAP + 23.5 : hh / 2 - 4.5;
    const name = el('text', { x: w / 2, y: top, 'text-anchor': 'middle' }, 'hld-name');
    name.textContent = c.short ?? c.name;
    const tech = el('text', { x: w / 2, y: top + 19, 'text-anchor': 'middle' }, 'hld-tech');
    tech.textContent = c.tech;
    // A space between the box's words in its text, drawn too small to see, so its words read as the box's name does (label in name).
    const spaced = (t: SVGTextElement) => {
      const sp = el('tspan', { 'font-size': 0.01 }, 'hld-gap');
      sp.textContent = ' ';
      t.append(sp);
    };
    spaced(name);
    if (c.lines) spaced(tech);
    g.append(name, tech);
    (c.lines ?? []).forEach((line, i) => {
      const t = el('text', { x: 14, y: top + 41 + i * 18.5 }, 'hld-line');
      t.textContent = line;
      if (i < c.lines!.length - 1) spaced(t);
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
      /** Where the pill sits against the dot (fixed for a leg), and where a cross-fade at rest is taking it. */
      off: null as Pt | null,
      target: null as Pt | null,
      /** The pill's own opacity: below 1 only in a cross-fade while the token is still. */
      pillOp: 1,
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
  // On a small screen the tour zooms the diagram out to show each step whole: said once, here, before it starts.
  const restText = () => `${coarse() ? design.restTouch : design.rest}${innerWidth < 600 || innerHeight < 500 ? ' The diagram zooms to show each step.' : ''}`;
  const stepTitle = h('h2.hld-step-title', { tabIndex: -1 }, 'Take the tour, or open any box');
  const stepText = h('p.hld-step-text', null, restText());
  const stepVia = h('p.hld-step-via', null);
  const moreBtn = h('button.hld-more', { type: 'button', 'aria-expanded': 'false', onclick: () => setMore(!moreOpen) }, 'More') as HTMLButtonElement;
  const readout = h('div.hld-readout', null, h('div.hld-title-row', null, stepTitle, moreBtn), stepText, stepVia);

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
  // With reduced motion nothing moves, so the speeds set only how long each step waits: the group says so.
  const speedName = h('span', { 'aria-hidden': 'true' }, reducedMotion() ? 'Dwell' : 'Speed');
  const speedGroup = h('div.hld-speed', { role: 'group', 'aria-label': reducedMotion() ? 'Time on each step' : 'Tour speed' }, speedName);
  for (const s of SPEEDS) {
    // The name starts with the words on the button, so a voice user can say what they see.
    const b = h('button', { type: 'button', 'aria-pressed': String(s === 1), 'aria-label': `${s}×, ${SPEED_NAMES[s].toLowerCase()}`, title: SPEED_NAMES[s], onclick: () => setSpeed(s) }, `${s}×`) as HTMLButtonElement;
    speedBtns.push(b);
    speedGroup.append(b);
  }
  // On a phone the three speeds become one button that steps through them, so the transport fits one row.
  const speedCycle = h('button.hld-speed-cycle', { type: 'button', onclick: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]) }, '1×') as HTMLButtonElement;
  // The tour's keys, on show where there is room and a keyboard; they follow the site-wide shortcut switch.
  const keyHints = h('p.hld-keys', { 'aria-hidden': 'true' }, h('kbd', null, 'Space'), ' play ', h('kbd', null, '←'), h('kbd', null, '→'), ' step ', h('kbd', null, 'R'), ' replay');
  const transport = h('div.hld-transport', null, h('div.hld-nav', null, restartBtn, backBtn, playBtn, nextBtn), counter, exploreBtn, keyHints, speedGroup, speedCycle);
  const head = h('div.hld-head', null, readout, transport);
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
      MODES.map((m) => keyItem(lineSample(m.id, false, m.id !== 'local'), m.label, m.note)),
    ),
    h(
      'ul.hld-key', { 'aria-label': 'Box styles, and lines off the hot path' },
      keyItem(boxSample('input'), 'Input or shared service', 'Grey fill and a bar down the left side: used by every node, or where work comes from.'),
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
  /** A table, named by the heading of its section. */
  const table = (head2: string[], rows: Cell[][], cls: string, named: string) =>
    h(
      'div.table-wrap', null,
      // `stack` is the site's rule for restacking a table into labelled blocks on a phone.
      tableRoles(
        h(
          `table.${cls}.stack`, { 'aria-labelledby': named },
          h('thead', null, h('tr', null, head2.map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows.map((r) => h('tr', null, r.map((t, i) => (i === 0 ? h('th', { scope: 'row' }, t) : h('td', { 'data-label': head2[i] }, t)))))),
        ),
      ),
    );
  // Every connection, both directions of a two-way line on rows of their own.
  const flowRows: Cell[][] = design.flows.flatMap((x) => {
    const row = (a: string, b: string, delivery: string) => {
      // A real link to the connection's own address, so it reads as one and opens in a new tab too; a plain click opens it here.
      const btn2: HTMLAnchorElement = h('a.hld-where', {
        href: `${base}/f/${x.id}`,
        onclick: (e: MouseEvent) => {
          if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          pickFlow(x.id, 'text', btn2);
        },
      }, `${nameOf(a)} to ${nameOf(b)}`);
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
          (row.querySelector('dt') as HTMLElement).focus({ preventScroll: true });
        },
      }, L),
    ),
  );
  // The interview extras, when written: "Lead it" and "Likely pushes" go after the notes and before the glossary.
  const ex = extras ? extrasParts(design, extras) : null;
  const notes = h(
    'div.notes', null,
    ...design.brief.map((b) => h('section.note.hld-card', null, h('h2', null, b.heading), list(b.points))),
    h('section.note.wide.hld-card', null, h('h2', { id: `${design.id}-numbers` }, 'Numbers to have ready'), table(['Quantity', 'Assumption', 'Result'], design.numbers.map((n) => [n.what, n.assumption, n.result]), 'hld-table', `${design.id}-numbers`)),
    h(
      'section.note.wide.hld-card', null,
      h('h2', null, 'Other versions of the question'),
      h('div.hld-framings', null, design.framings.map((x) => h('div', null, h('h3', null, x.name), h('p.hld-scale', null, x.scale), h('p', null, x.shape)))),
    ),
    h('section.note.wide.hld-card', null, h('h2', { id: `${design.id}-decisions` }, 'Decisions worth defending'), table(['Choice', 'One way', 'The other way', 'The call here'], design.decisions.map((d) => [d.choice, d.a, d.b, d.call]), 'hld-table', `${design.id}-decisions`)),
    h(
      'section.note.wide.hld-card', null,
      h('h2', { id: `${design.id}-talk` }, 'How the parts talk'),
      h('p.hld-lead', null, 'Every connection, with how it travels and what it promises. A line that carries a request and its reply is listed once each way. Select a connection to open it under the diagram.'),
      table(['Connection', 'Method', 'Kind', 'Delivery'], flowRows, 'hld-table', `${design.id}-talk`),
    ),
    h('section.note.wide.hld-card', null, h('h2', null, 'Failure drills'), h('dl.hld-drills', null, design.drills.flatMap((d) => [h('dt', null, d.name), h('dd', null, d.what)]))),
    h('section.note.wide.interview', null, h('h2', null, 'Say this in the interview'), list(design.interview)),
    ...(ex?.sections ?? []),
    h(
      'section.note.wide.hld-card', { id: 'glossary' },
      h('h2', null, 'Glossary'),
      jump,
      h(
        'dl.hld-glossary', null,
        terms.map((g) => {
          // The name starts with the words on the button, and says which term it is for, with no stray space before the comma.
          const see: HTMLButtonElement | null = g.where ? h('button.hld-where', { type: 'button', 'aria-label': `See ${nameOf(g.where)}, for ${g.term}`, onclick: () => select(g.where!, 'text', see!) }, `See ${nameOf(g.where)}`) : null;
          const links = [see, g.see ? h('a.hld-struct', { href: `#/s/${g.see.id}` }, `${g.see.label}, step by step`) : null].filter(Boolean) as HTMLElement[];
          return h(
            'div.hld-gloss-row', { id: `term-${slug(g.term)}`, 'data-letter': letterOf(g.term) },
            // A link to a term focuses the term itself, so it is read out as the term and not as a bare group.
            h('dt', { tabIndex: -1 }, g.term),
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

  const page = h('article.design', null, h('header.page-head', null, h('h1', null, design.name), h('p.lede', null, design.blurb), ex?.links), stage, status, detail, notes);
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
  /** The same for the title alone. */
  let titleReserve = 0;
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
    const { fl, path, chip, chipRect, ring, chipText, glyph, halo } = fe;
    const p = path.getPointAtLength(path.getTotalLength() * (fl.chip ?? 0.5));
    // Room for wider letter spacing (15 per cent more than the text needs), and the words 6px clear of the rounded ends.
    // A log's glyph takes 18 units before the words.
    const G = glyph ? 18 : 0;
    const w = Math.max(52, chipText.getComputedTextLength() * 1.15 + 24 + G);
    chipRect.setAttribute('x', String(-w / 2));
    chipRect.setAttribute('width', String(w));
    ring.setAttribute('x', String(-w / 2 - 5));
    ring.setAttribute('width', String(w + 10));
    halo.setAttribute('x', String(-w / 2 - 4));
    halo.setAttribute('width', String(w + 8));
    if (glyph) {
      chipText.setAttribute('x', String(G / 2));
      const gx = -w / 2 + 13;
      // Three short bars: messages in a row, as the log box draws them along its base.
      glyph.setAttribute('d', [0, 4.8, 9.6].map((dx) => `M${(gx + dx).toFixed(1)},-5.5 h3 v11 h-3 z`).join(' '));
    }
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
  /** Recovery lines show when the reader asks for them, or on a step that is about recovery. */
  const coldOn = (i: number) => showCold || (i >= 0 && !!design.tour[i]?.recovery);
  const lineShown = (fl: Flow, need: Set<string>) => !fl.cold || coldOn(lastLight ? step : -1) || need.has(fl.id);
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
      // A label on its own (the open line, or the one pointed at) must show: if nowhere is clear of every line, it may
      // cross a line or the frame, on its paper plate, and sit a little nearer the chips.
      const own = new Set(samples.get(id)!);
      for (const strict of ids.length === 1 ? [true, false] : [true]) {
      if (best) break;
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
            if (chipObs.some((o) => gapOf(o, box) < (strict ? LABEL_CHIP_CLEAR : 5))) continue;
            if ([...out.values()].some((o) => gapOf(o.box, box) < LABEL_CLEAR)) continue;
            if (strict ? pts.some((p) => ptGap(p, box) < LABEL_LINE_CLEAR) : [...own].some((p) => ptGap(p, box) < 4)) continue;
            const edge = { x: a.x + side * n.x * d + tx * slide, y: a.y + side * n.y * d + ty * slide };
            // Close to its line a label needs no leader (a short stub would read as a dash in front of the words); further out, a leader with a gap at each end.
            const lead: [Pt, Pt] | null = d >= 20 ? [{ x: a.x + side * n.x * 4, y: a.y + side * n.y * 4 }, { x: edge.x - side * n.x * 3, y: edge.y - side * n.y * 3 }] : null;
            best = { x: cx, y: cy - lh / 2 + asc, box, leader: lead, score };
          }
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
        h('p.hld-hint', null, 'Select a box, a chip or a name below to see what it does, how it fails and what else you could use. Opening one changes the address so it can be shared, but adds nothing to your history: Back leaves this page.'),
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
                fl.label ? h('p.hld-first', null, cap(fl.travels ?? fl.label)) : null,
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
    // A pointer moves focus too (the box it came from is now off screen), but without a focus mark until a key is pressed.
    if (how !== 'pointer') h3?.focus({ preventScroll: true });
    else if (h3) quietFocus(h3);
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
    // A connection that fails on this step: red and dashed, for the whole step.
    const failed = new Set(light && step >= 0 ? design.tour[step].failed ?? [] : []);
    const pickedFl = picked ? flowById.get(picked) ?? null : null;
    // The open connection's two boxes are outlined.
    for (const [nid, g] of nodeEls) g.classList.toggle('end', !!pickedFl && (pickedFl.from === nid || pickedFl.to === nid));
    for (const { fl, path, hit, chip } of flowEls.values()) {
      const linked = selected != null && (fl.from === selected || fl.to === selected);
      const on = fl.id === picked;
      const isLive = live.has(fl.id);
      const shown = lineShown(fl, need);
      for (const e of [path, hit, chip]) e.classList.toggle('need', shown);
      path.classList.toggle('live', isLive);
      // An open box's lines, or the open line, are drawn in ink even on the tour: the selection wins over the step.
      path.classList.toggle('linked', linked || on);
      path.classList.toggle('picked', on);
      path.classList.toggle('failed', failed.has(fl.id));
      path.classList.toggle('peek', peeking === fl.id && !isLive);
      const cs = chipShown(fl, need, live);
      if (cs) chipsOn.add(fl.id);
      chip.classList.toggle('show', cs);
      chip.classList.toggle('live', isLive);
      chip.classList.toggle('failed', failed.has(fl.id));
      chip.classList.toggle('peek', peeking === fl.id);
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
    for (const { fl, label, labelBg, leader } of flowEls.values()) {
      const sp = spots.get(fl.id);
      label.classList.toggle('on', !!sp);
      labelBg.classList.toggle('on', !!sp);
      leader.classList.toggle('on', !!sp?.leader);
      if (!sp) continue;
      labelSpot.set(fl.id, sp);
      for (const [a, v] of [['x', sp.box.x - 3], ['y', sp.box.y - 1], ['width', sp.box.w + 6], ['height', sp.box.h + 2]] as const) labelBg.setAttribute(a, v.toFixed(1));
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
    if (s) stepText.replaceChildren(...stepWords(s.text));
    else stepText.textContent = restText();
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
    restCheck();
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
    // Very narrow (a 320px phone): the readout shows only the step's title until More is pressed, so the diagram keeps most of the screen.
    const tiny = inTour && small() && innerWidth < 360;
    const brief = inTour && (tiny || reserve + tH > limit);
    stage.classList.toggle('brief', brief);
    stage.classList.toggle('tiny', tiny);
    if (!brief && moreOpen) setMore(false, true);
    if (!brief && document.activeElement === moreBtn) playBtn.focus({ preventScroll: true });
    moreBtn.hidden = !brief;
    readout.style.minHeight = inTour && reserve ? `${brief ? (moreOpen ? 0 : tiny ? titleReserve : briefReserve) : reserve}px` : '';
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

  /** A step's text as its first sentence and the rest, so a short screen can show the first sentence alone. */
  function stepWords(text: string): HTMLElement[] {
    const m = /^.*?[.!?](?=\s|$)/.exec(text);
    const first = m ? m[0] : text;
    const rest = text.slice(first.length);
    return [h('span.hld-step-first', null, first), h('span.hld-step-rest', null, rest)];
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
    const key = `${head.clientWidth}|${getComputedStyle(stepText).fontSize}|${innerHeight}|${innerWidth}`;
    if (key === measuredAt) {
      syncHead();
      return;
    }
    measuredAt = key;
    // Play keeps one width whatever it says, so the buttons beside it never move.
    if (getComputedStyle(playLabel).position !== 'absolute') {
      const was = playLabel.textContent;
      playBtn.style.removeProperty('--play-w');
      let most = 0;
      // "Resume at step 12", shown only off the tour, may make it wider still.
      for (const t of ['Play the tour', 'Pause', 'Play', 'Replay']) {
        playLabel.textContent = t;
        most = Math.max(most, playBtn.offsetWidth);
      }
      playLabel.textContent = was;
      playBtn.style.setProperty('--play-w', `${Math.ceil(most)}px`);
    }
    // The readout itself is filled with every step in turn, in each of its three states, and measured; then put back.
    // All of it happens between two frames, so none of it is ever drawn.
    const n = design.tour.length;
    const was = { title: stepTitle.textContent, text: Array.from(stepText.childNodes), via: Array.from(stepVia.childNodes), cls: stage.className, more: moreBtn.hidden, min: readout.style.minHeight, count: countLong.textContent, short: countShort.textContent, more2: moreBtn.textContent };
    readout.style.minHeight = '';
    stage.classList.add('touring');
    stage.classList.remove('more', 'reading', 'unstick');
    // On a phone on its side the transport sits on the title's line: the title keeps clear of it, at its widest.
    countLong.textContent = `Step ${n} of ${n}`;
    countShort.textContent = `${n}/${n}`;
    head.style.setProperty('--hld-tw', `${Math.ceil(transport.offsetWidth)}px`);
    const most = { full: 0, brief: 0, tiny: 0 };
    for (const mode of ['full', 'brief', 'tiny'] as const) {
      stage.classList.toggle('brief', mode !== 'full');
      stage.classList.toggle('tiny', mode === 'tiny');
      moreBtn.hidden = mode === 'full';
      moreBtn.textContent = 'More';
      for (const st of design.tour) {
        stepTitle.textContent = st.title;
        stepText.replaceChildren(...stepWords(st.text));
        stepVia.replaceChildren(...viaLine(st));
        most[mode] = Math.max(most[mode], readout.getBoundingClientRect().height);
      }
    }
    stepTitle.textContent = was.title;
    stepText.replaceChildren(...was.text);
    stepVia.replaceChildren(...was.via);
    stage.className = was.cls;
    moreBtn.hidden = was.more;
    moreBtn.textContent = was.more2;
    readout.style.minHeight = was.min;
    countLong.textContent = was.count;
    countShort.textContent = was.short;
    reserve = Math.ceil(most.full);
    briefReserve = Math.ceil(most.brief);
    titleReserve = Math.ceil(most.tiny);
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
   * Where a pill may not go, as grids of 2-unit cells summed for quick box
   * queries, one grid per kind of thing: boxes (their names included) and the
   * frame's words; chips on show; and lines on show with the frame's outline.
   */
  const CELL = 2;
  const LINE_CLEAR = 4;
  const gw = Math.ceil(W / CELL) + 1;
  const gh = Math.ceil(H / CELL) + 1;
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
  const markInto = (occ: Uint8Array, b: Box) => {
    const x0 = Math.max(0, Math.floor(b.x / CELL));
    const x1 = Math.min(gw, Math.ceil((b.x + b.w) / CELL));
    const y0 = Math.max(0, Math.floor(b.y / CELL));
    const y1 = Math.min(gh, Math.ceil((b.y + b.h) / CELL));
    for (let yy = y0; yy < y1; yy++) occ.fill(1, yy * gw + x0, yy * gw + Math.max(x0, x1));
  };
  const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
  const gridCache = new Map<string, Int32Array>();
  /**
   * A pill at rest keeps this far from every chip (in units, before the grid's rounding of up to 2): at least 6px at
   * the smallest scale the tour draws.
   */
  const CHIP_REST = 12;
  function grid(kind: 'boxes' | 'chips' | 'rest' | 'lines', ids: string[] = []): Int32Array {
    const key = `${kind}|${ids.join(',')}`;
    const hit = gridCache.get(key);
    if (hit) return hit;
    const occ = new Uint8Array(gw * gh);
    if (kind === 'boxes') for (const b of [...nodeBoxes, ...frameTexts]) markInto(occ, grow(b, 1));
    else if (kind === 'chips') for (const id of ids) markInto(occ, grow(chipBox.get(id)!, 2));
    else if (kind === 'rest') for (const id of ids) markInto(occ, grow(chipBox.get(id)!, CHIP_REST));
    else {
      const dot = (p: Pt) => markInto(occ, { x: p.x - LINE_CLEAR, y: p.y - LINE_CLEAR, w: 2 * LINE_CLEAR, h: 2 * LINE_CLEAR });
      for (const id of ids) samples.get(id)!.forEach(dot);
      frameSamples.forEach(dot);
    }
    const t = summed(occ);
    gridCache.set(key, t);
    return t;
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
  const pillAt = (p: Pt, o: Pt, w: number): Box => ({ x: p.x + o.x - w / 2, y: p.y + o.y - PILL_H / 2, w, h: PILL_H });

  /** The chips and lines drawn on step i (recovery lines as the reader has set them), as the diagram will show them. */
  function drawnFor(i: number): { chips: string[]; lines: string[] } {
    const s = design.tour[i];
    const live = new Set([...s.path, ...(s.branch?.path ?? [])].map((p) => legOf(p).fl.id));
    const shown = design.flows.filter((f) => !f.cold || coldOn(i) || live.has(f.id));
    return { lines: shown.map((f) => f.id), chips: shown.filter((f) => !quietChip(f) || live.has(f.id)).map((f) => f.id) };
  }

  /**
   * Places a pill can take beside its dot, fixed for a whole leg: above or
   * below a line that runs across, right or left of one that runs up and down;
   * close, or further out on a short tie; and slid along the line a little.
   */
  type Side = 'above' | 'below' | 'left' | 'right';
  function candidates(w: number, vertical: boolean): { o: Pt; side: Side; extra: number }[] {
    const out: { o: Pt; side: Side; extra: number }[] = [];
    for (const r of [0, 12, 26, 40, 50, 60, 70, 80]) {
      if (!vertical) {
        for (const side of ['above', 'below'] as const) {
          const y = (side === 'above' ? -1 : 1) * (PILL_GAP + r + PILL_H / 2);
          for (const sx of [0, -w / 4, w / 4, -(w / 2 - 4), w / 2 - 4, -(w / 2 + 14), w / 2 + 14]) out.push({ o: { x: sx, y }, side, extra: r * 1.5 + Math.abs(sx) * 0.15 + (side === 'below' ? 1 : 0) });
        }
      } else {
        for (const side of ['right', 'left'] as const) {
          const x = (side === 'right' ? 1 : -1) * (PILL_GAP + r + w / 2);
          for (const sy of [0, -PILL_H / 4, PILL_H / 4, -(PILL_H / 2 + 6), PILL_H / 2 + 6, -(PILL_H + 12), PILL_H + 12]) out.push({ o: { x, y: sy }, side, extra: r * 1.5 + Math.abs(sy) * 0.15 + (side === 'left' ? 1 : 0) });
        }
      }
    }
    return out;
  }
  /** A pill's tie, from its dot to the pill's nearest edge, crosses a box. */
  function tieCrosses(p: Pt, b: Box): boolean {
    const ex = Math.max(b.x, Math.min(p.x, b.x + b.w));
    const ey = Math.max(b.y, Math.min(p.y, b.y + b.h));
    const len = Math.hypot(ex - p.x, ey - p.y);
    const n = Math.ceil(len / 3);
    const boxes = grid('boxes');
    for (let i = Math.ceil((8 / Math.max(len, 1)) * n); i < n; i++) {
      const q = { x: p.x + ((ex - p.x) * i) / n, y: p.y + ((ey - p.y) * i) / n };
      if (covered(boxes, { x: q.x - 0.5, y: q.y - 0.5, w: 1, h: 1 }) > 0) return true;
    }
    return false;
  }

  /**
   * One pill place for a whole leg, chosen once from the leg's whole path: the
   * place with least under it along the way, where it rests at either end clear
   * of every box, chip and the other token's pill. On the move it may pass over
   * a thin line (its halo keeps it legible) or slip under a chip (chips are
   * drawn above it), but it never fades and never changes side mid-leg.
   */
  const sideCache = new Map<string, Pt>();
  function legPlace(i: number, which: Who, n: number, l: Omit<PathSeg, 'off'>, avoid: Box | null): Pt {
    const key = `${i}|${which}|${n}|${coldOn(i) ? 1 : 0}`;
    const hit = sideCache.get(key);
    if (hit) return hit;
    const s = design.tour[i];
    const { chips, lines } = drawnFor(i);
    // The leg's own chip sits on its way: the pill may slip under it on the move, but not rest under it.
    const own = legOf((which === 'main' ? s.path : s.branch!.path)[n]).fl.id;
    const gBoxes = grid('boxes');
    const gChips = grid('rest', chips);
    const gOthers = grid('chips', chips.filter((c) => c !== own));
    const gLines = grid('lines', lines);
    const w = pillWidth(l.label);
    const want = which === 'main' ? s.pill?.[n] : s.branch?.pill;
    const pts: Pt[] = [];
    for (let a = l.from; a < l.len; a += 6) pts.push(l.el.getPointAtLength(l.back ? l.full - a : a));
    const start = l.el.getPointAtLength(l.back ? l.full - l.from : l.from);
    const end = l.el.getPointAtLength(l.back ? l.full - l.len : l.len);
    let best: { o: Pt; cost: number } | null = null;
    for (const c of candidates(w, l.vertical)) {
      if (want && c.side !== want) continue;
      let cost = c.extra;
      for (const p of [start, end]) {
        const b = pillAt(p, c.o, w);
        // An end where it would sit on something costs a cross-fade to a clear place while the token holds (see restPlace).
        const hard = covered(gBoxes, b) + covered(gChips, b) + (avoid && gapOf(avoid, b) < 1 ? 50 : 0);
        if (hard) cost += 60 + Math.min(hard, 200) / 10;
        if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) cost += 5000;
        if (tieCrosses(p, b)) cost += 3000;
        cost += covered(gLines, b) * 0.5;
      }
      let moving = 0;
      for (const p of pts) {
        const b = pillAt(p, c.o, w);
        moving += covered(gBoxes, b) * 2 + covered(gOthers, b) + covered(gLines, b) * 0.3 + (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H ? 40 : 0);
      }
      cost += moving / Math.max(1, pts.length);
      if (!best || cost < best.cost) best = { o: c.o, cost };
    }
    sideCache.set(key, best!.o);
    return best!.o;
  }

  /**
   * Where a pill rests at a point (the start of a trip, or its end): the
   * leg's own place if that is clear of every box, chip and the other pill,
   * otherwise the nearest clear one, either side.
   */
  const restCache = new Map<string, Pt>();
  /** Rest places that are not clear: nowhere near the point is (see restClear). */
  const restBlocked = new Set<string>();
  let lastRestKey = '';
  /** Whether the place restPlace last returned is clear: where nothing is, the pill does not show until the token moves off. */
  const restClear = () => !restBlocked.has(lastRestKey);
  function restPlace(i: number, p: Pt, w: number, own: Pt, vertical: boolean, avoid: Box | null, line: SVGPathElement | null = null): Pt {
    const ownLine = line ? lineIdOf.get(line) ?? '' : '';
    const key = `${i}|${p.x.toFixed(1)},${p.y.toFixed(1)}|${w}|${own.x},${own.y}|${avoid ? `${avoid.x},${avoid.y}` : ''}|${coldOn(i) ? 1 : 0}|${ownLine}`;
    lastRestKey = key;
    const hit = restCache.get(key);
    if (hit) return hit;
    const { chips, lines } = drawnFor(i);
    const gB = grid('boxes');
    const gC = grid('rest', chips);
    const gL = grid('lines', lines);
    // Lines other than its own, and the frame's outline: a pill resting on one reads as travelling by it.
    const gO = grid('lines', lines.filter((id) => id !== ownLine));
    /** How many points along the pill's tie (from the dot to the pill's nearest edge, past its first few units) fall on a grid. */
    // The tie leaves the dot past the chip of its own line, which may sit right by it: that chip does not count here.
    const gChipsOnly = grid('chips', chips.filter((id) => id !== ownLine));
    const tieOn = (b: Box, g: Int32Array) => {
      const ex = Math.max(b.x, Math.min(p.x, b.x + b.w));
      const ey = Math.max(b.y, Math.min(p.y, b.y + b.h));
      const len = Math.hypot(ex - p.x, ey - p.y);
      let n = 0;
      for (let d = 8; d < len; d += 3) {
        const q = { x: p.x + ((ex - p.x) * d) / len, y: p.y + ((ey - p.y) * d) / len };
        if (covered(g, { x: q.x - 0.5, y: q.y - 0.5, w: 1, h: 1 })) n++;
      }
      return n;
    };
    const bad = (o: Pt) => {
      const b = pillAt(p, o, w);
      return covered(gB, b) + covered(gC, b) + (avoid && gapOf(avoid, b) < 1 ? 50 : 0) + (b.x < 2 || b.y < 2 || b.x + b.w > W - 2 || b.y + b.h > H - 2 ? 4000 : 0) + (tieCrosses(p, b) ? 50 : 0) + tieOn(b, gChipsOnly) * 10;
    };
    // Another line under the pill, or under its tie, reads as the way it travelled: avoided where there is room.
    const across = (o: Pt) => {
      const b = pillAt(p, o, w);
      return covered(gO, b) * 25 + tieOn(b, gO) * 60;
    };
    let best = { o: own, cost: bad(own) ? 1e9 : across(own) };
    if (best.cost) {
      for (const v of [vertical, !vertical]) {
        for (const c of candidates(w, v)) {
          const b = bad(c.o);
          const cost = (b ? 10000 + b : 0) + across(c.o) + c.extra + (v === vertical ? 0 : 10) + covered(gL, pillAt(p, c.o, w)) * 0.3;
          if (cost < best.cost) best = { o: c.o, cost };
        }
      }
    }
    // Nothing near the leg's own places is clear: look all round the dot, nearest first, for the closest clear place.
    if (best.cost >= 150) {
      const ownSide = (o: Pt) => (vertical ? Math.sign(o.x) === Math.sign(own.x) : Math.sign(o.y) === Math.sign(own.y));
      for (let dy = -150; dy <= 150; dy += 4) {
        for (let dx = -240; dx <= 240; dx += 4) {
          const o = { x: dx, y: dy };
          const b = pillAt(p, o, w);
          const near = ptGap(p, b);
          if (near < PILL_GAP - 0.5) continue;
          const base = near * 1.5 + (ownSide(o) ? 0 : 6);
          if (base >= best.cost) continue;
          const hard = bad(o);
          const cost = (hard ? 10000 + hard : 0) + base + covered(gL, b) * 0.3;
          if (cost >= best.cost) continue;
          const cr = across(o);
          if (cost + cr < best.cost) best = { o, cost: cost + cr };
        }
      }
    }
    restCache.set(key, best.o);
    if (best.cost >= 10000) restBlocked.add(key);
    return best.o;
  }

  const sameOff = (a: Pt | null, b: Pt | null) => !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  /** Draw the pill where it sits against its dot, and its tie when it sits further out. */
  function drawPill(tk: Tok): void {
    if (!tk.at || !tk.off) return;
    const { x, y } = tk.at;
    const o = tk.off;
    const w = tk.pillW;
    const op = tk.pillOp >= 0.99 ? '' : Math.max(0, tk.pillOp).toFixed(2);
    if (tk.pill.style.opacity !== op) {
      tk.pill.style.opacity = op;
      tk.tether.style.opacity = op;
    }
    tk.pillBox = pillAt({ x, y }, o, w);
    tk.pill.setAttribute('transform', `translate(${o.x.toFixed(1)},${o.y.toFixed(1)})`);
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

  /**
   * At rest, something may come to sit under the pill (a chip shown on focus,
   * the recovery lines switched on). The token is still, so the pill
   * cross-fades to the nearest clear place.
   */
  let pillRaf = 0;
  function restCheck(): void {
    if (trip || starting) return;
    const chips = [...flowEls.values()].filter((fe) => fe.chip.classList.contains('show') && fe.chip.classList.contains('need')).map((fe) => fe.fl.id);
    for (const tk of [token, branchTok]) {
      if (!tk.at || !tk.off || tk.g.style.display === 'none') continue;
      const other = tk === token ? branchTok : token;
      const avoid = other.g.style.display !== 'none' ? other.pillBox : null;
      const blocked = (o: Pt) => {
        const b = pillAt(tk.at!, o, tk.pillW);
        // Off the drawing is worst: the pill would be cut off.
        return covered(grid('boxes'), b) + covered(grid('rest', chips), b) + (avoid && gapOf(avoid, b) < 1 ? 1 : 0) + (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H ? 4000 : 0);
      };
      if (!blocked(tk.target ?? tk.off)) continue;
      let best: { o: Pt; cost: number } | null = null;
      for (const vertical of [tk.vertical, !tk.vertical]) {
        for (const c of candidates(tk.pillW, vertical)) {
          const cost = blocked(c.o) * 1000 + c.extra + (vertical === tk.vertical ? 0 : 20) + (tieCrosses(tk.at, pillAt(tk.at, c.o, tk.pillW)) ? 500 : 0);
          if (!best || cost < best.cost) best = { o: c.o, cost };
        }
      }
      if (best && !sameOff(best.o, tk.off)) {
        tk.target = best.o;
        if (!pillRaf) pillRaf = requestAnimationFrame(pillFrame);
      }
    }
  }
  /** The rest cross-fade: out where it is, across unseen, in where it is clear. */
  function pillFrame(): void {
    pillRaf = 0;
    if (!alive) return;
    let more = false;
    for (const tk of [token, branchTok]) {
      if (!tk.target || !tk.at) continue;
      if (raf || trip) {
        tk.target = null;
        continue;
      }
      if (!sameOff(tk.target, tk.off)) {
        tk.pillOp = Math.max(0, tk.pillOp - 0.2);
        if (tk.pillOp <= 0) tk.off = tk.target;
      } else {
        tk.pillOp = Math.min(1, tk.pillOp + 0.2);
        if (tk.pillOp >= 1) tk.target = null;
      }
      drawPill(tk);
      more ||= !!tk.target;
    }
    if (more) pillRaf = requestAnimationFrame(pillFrame);
  }

  /** Draw a token: its dot at (x, y), its pill at `off` from it, the whole at `opacity`, the pill at `pillOp` on top of that. */
  function place(tk: Tok, x: number, y: number, label: string, opacity = 1, off: Pt | null = null, pillOp = 1): void {
    const w = pillWidth(label);
    tk.rect.setAttribute('x', String(-w / 2));
    tk.rect.setAttribute('width', String(w));
    if (tk.text.textContent !== label) tk.text.textContent = label;
    tk.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    tk.g.style.opacity = opacity >= 1 ? '' : Math.max(0, opacity).toFixed(2);
    tk.g.style.display = '';
    tk.at = { x, y, label };
    if (off) {
      tk.off = off;
      tk.target = null;
    }
    tk.pillW = w;
    if (!tk.target) tk.pillOp = pillOp;
    drawPill(tk);
    if (tk === token || trip) keepInView(x, y, tk);
  }
  function hideToken(tk: Tok = token): void {
    tk.g.style.display = 'none';
    tk.at = null;
    tk.pillOp = 1;
    tk.pill.style.opacity = '';
    tk.tether.style.opacity = '';
    tk.off = null;
    tk.target = null;
    tk.pillBox = null;
  }
  const tokenShown = () => token.g.style.display !== 'none' && (token.g.style.opacity === '' || +token.g.style.opacity > 0.05);

  /**
   * The connections of one step in order, each with the label the token
   * carries on it and the one place its pill keeps on it. The last leg stops
   * just short of its arrowhead.
   */
  function pathLegs(i: number, which: Who = 'main'): PathSeg[] {
    const s = design.tour[i];
    const ps = which === 'main' ? s.path : s.branch?.path ?? [];
    const labels = which === 'main' ? s.labels : [s.branch!.label];
    // The branch rests clear of where the main token has stopped.
    const mainRest = which === 'branch' ? restBox(i, 'main') : null;
    const turn = (a?: string, b?: string) => !!a && !!b && legOf(a).fl === legOf(b).fl && legOf(a).back !== legOf(b).back;
    let prevEnd: Pt | null = null;
    return ps.map((p, n) => {
      const { fl, back } = legOf(p);
      const label = labels[Math.min(n, labels.length - 1)] ?? 'URL';
      const pe = flowEls.get(fl.id)!.path;
      const full = pe.getTotalLength();
      // The last leg, and a leg that turns back along its own line, stop short of the box, so the dot never sits on its edge.
      const short = DOT_R + 8;
      const len = n === ps.length - 1 || turn(p, ps[n + 1]) ? Math.max(full * 0.5, full - short) : full;
      // The first leg sets off a little way out from its box too, where the pill has room to show.
      // So does a leg the token reaches by fading across from somewhere else (a hop).
      const start0 = pe.getPointAtLength(back ? full : 0);
      const hop = !!prevEnd && Math.hypot(start0.x - prevEnd.x, start0.y - prevEnd.y) > 8;
      const from = turn(ps[n - 1], p) || ((n === 0 || hop) && full > 60) ? Math.min(short, full * 0.25) : 0;
      prevEnd = pe.getPointAtLength(back ? full - len : len);
      let up = 0;
      let across = 0;
      for (let a = from; a + 4 <= len; a += 4) {
        const q0 = pe.getPointAtLength(back ? full - a : a);
        const q1 = pe.getPointAtLength(back ? full - a - 4 : a + 4);
        up += Math.abs(q1.y - q0.y);
        across += Math.abs(q1.x - q0.x);
      }
      const raw = { kind: 'path' as const, el: pe, back, full, from, len, label, who: which, vertical: up > across };
      return { ...raw, off: legPlace(i, which, n, raw, mainRest) };
    });
  }
  const legStart = (l: PathSeg): Pt => l.el.getPointAtLength(l.back ? l.full - l.from : l.from);
  const legEnd = (l: PathSeg): Pt => l.el.getPointAtLength(l.back ? l.full - l.len : l.len);
  /** Where a token's pill rests at the end of step i. */
  function restBox(i: number, which: Who): Box | null {
    const legs = pathLegs(i, which);
    const l = legs[legs.length - 1];
    if (!l) return null;
    return pillAt(legEnd(l), endPlace(i, which), pillWidth(l.label));
  }
  /** Where the pill of a step's last leg rests at its end. */
  function endPlace(i: number, which: Who): Pt {
    const legs = pathLegs(i, which);
    const l = legs[legs.length - 1];
    return restPlace(i, legEnd(l), pillWidth(l.label), l.off, l.vertical, which === 'branch' ? restBox(i, 'main') : null, l.el);
  }
  /** The pill's place at the end of step i, or where it waits on a step with no trip: as the last leg left it. */
  function restOff(i: number): Pt {
    for (let k = i; k >= 0; k--) {
      const legs = pathLegs(k);
      if (legs.length) return endPlace(k, 'main');
    }
    return { x: 0, y: -(PILL_GAP + PILL_H / 2) };
  }

  /** The whole trip for step i, from wherever the token is now. */
  function tripFor(i: number): Seg[] {
    const segs: Seg[] = [];
    const s = design.tour[i];
    /** The pill at offset o from point p would sit on a box, a chip or the other pill. */
    const blocked = (p: Pt, o: Pt, label: string, avoid: Box | null) => {
      const b = pillAt(p, o, pillWidth(label));
      const { chips } = drawnFor(i);
      return covered(grid('boxes'), b) + covered(grid('chips', chips), b) > 0 || (!!avoid && gapOf(avoid, b) < 1);
    };
    const turnAt = (at: Pt, label: string, next: string, offA: Pt, offB: Pt, who: Who, avoid: Box | null): Seg => ({ kind: 'hold', at, label, next, offA, offB, who, hideA: blocked(at, offA, label, avoid), hideB: blocked(at, offB, next, avoid) });
    /** One token's legs, from its fade-in (or from where it stands) to its rest. */
    const run1 = (legs: PathSeg[], who: Who, avoid: Box | null) => {
      const tk = who === 'main' ? token : branchTok;
      const first = legs[0];
      const st = legStart(first);
      const sp = restPlace(i, st, pillWidth(first.label), first.off, first.vertical, avoid, first.el);
      const tAt = tk.at;
      if (who === 'main' && tAt && tokenShown()) {
        // Carrying on from where it stopped: a turn, if its words or its side change.
        if (tAt.label !== first.label || !sameOff(token.off, first.off)) segs.push(turnAt({ x: tAt.x, y: tAt.y }, tAt.label, first.label, token.off ?? first.off, first.off, who, avoid));
      } else {
        // It shows clear of anything at its start; if its place on the line sits on something there, it crosses to it as it sets off.
        // Nowhere clear here at all: the dot fades in alone, and the pill shows with the first move.
        if (!restClear()) segs.push({ kind: 'fade', at: st, label: first.label, who, off: first.off, noPill: true });
        else {
          segs.push({ kind: 'fade', at: st, label: first.label, who, off: sp });
          if (!sameOff(sp, first.off)) segs.push(turnAt(st, first.label, first.label, sp, first.off, who, avoid));
        }
      }
      legs.forEach((l, n) => {
        if (n > 0) {
          const prev = legEnd(legs[n - 1]);
          const start = legStart(l);
          const d = Math.hypot(start.x - prev.x, start.y - prev.y);
          if (d > 8 && who === 'main') {
            const bp0 = restPlace(i, start, pillWidth(l.label), l.off, l.vertical, avoid, l.el);
            const noB = !restClear();
            const bp = noB ? l.off : bp0;
            const ap = restPlace(i, prev, pillWidth(legs[n - 1].label), legs[n - 1].off, legs[n - 1].vertical, avoid, legs[n - 1].el);
            // Out where it arrived (from a clear place), in where the next line starts (at a clear place), then to its place on the line.
            if (!sameOff(ap, legs[n - 1].off)) segs.push(turnAt(prev, legs[n - 1].label, legs[n - 1].label, legs[n - 1].off, ap, who, avoid));
            segs.push({ kind: 'hop', a: prev, b: start, label: legs[n - 1].label, next: l.label, offA: ap, offB: bp, noPillB: noB });
            if (!noB && !sameOff(bp, l.off)) segs.push(turnAt(start, l.label, l.label, bp, l.off, who, avoid));
          } else segs.push(turnAt(prev, legs[n - 1].label, l.label, legs[n - 1].off, l.off, who, avoid));
        }
        segs.push(l);
      });
      // Arrived: if its place on the line sits on something here, it crosses to a clear place while the token holds.
      const last = legs[legs.length - 1];
      const ep = restPlace(i, legEnd(last), pillWidth(last.label), last.off, last.vertical, avoid, last.el);
      if (!sameOff(ep, last.off)) segs.push(turnAt(legEnd(last), last.label, last.label, last.off, ep, who, avoid));
    };
    const legs = pathLegs(i);
    if (legs.length) run1(legs, 'main', null);
    else {
      const tAt = token.at;
      const firstAt = endOf(i);
      const firstLabel = s.labels[0] ?? 'URL';
      const off = restOff(i);
      if (tAt && tokenShown()) {
        if (tAt.label !== firstLabel || !sameOff(token.off, off)) segs.push(turnAt({ x: tAt.x, y: tAt.y }, tAt.label, firstLabel, token.off ?? off, off, 'main', null));
      } else segs.push({ kind: 'fade', at: firstAt, label: firstLabel, who: 'main', off });
    }
    // The branch: a second token splits off where the main path ends and makes its own trip.
    const br = s.branch ? pathLegs(i, 'branch') : [];
    if (br.length) run1(br, 'branch', restBox(i, 'main'));
    return segs;
  }

  /** How long a piece of the trip takes, in real milliseconds at the current speed. */
  function durOf(sg: Seg): number {
    if (sg.kind === 'path') return Math.max(FLOOR_LEG, Math.max(MIN_LEG, ((sg.len - sg.from) / PACE) * 1000) / speed);
    // A turn that changes the pill is never shorter than 220ms, so its cross-fade is seen as one and never starts on the frame the token stops.
    if (sg.kind === 'hold') return Math.max(sg.label !== sg.next || !sameOff(sg.offA, sg.offB) ? 220 : 160, HOLD / speed);
    if (sg.kind === 'hop') return 2 * FADE + 80;
    return FADE;
  }

  function drawSeg(sg: Seg, u: number): void {
    if (sg.kind === 'path') {
      const d = sg.from + easeLeg(u) * (sg.len - sg.from);
      const pt = sg.el.getPointAtLength(sg.back ? sg.full - d : d);
      const tk = sg.who === 'main' ? token : branchTok;
      tk.vertical = sg.vertical;
      place(tk, pt.x, pt.y, sg.label, 1, sg.off);
    } else if (sg.kind === 'hold') {
      // A turn: the token is still. If its words or its side change, the pill fades out, moves unseen and fades in.
      const change = sg.label !== sg.next || !sameOff(sg.offA, sg.offB);
      const tk = sg.who === 'branch' ? branchTok : token;
      // Quick: out over the first third, unseen for the middle third, in over the last.
      // A place that sits on something is never shown at a turn: the pill is gone at once there, or comes in only as the token moves off.
      // Its first few hundredths it stays as it arrived, so the frame the token comes to a stop never shows a fading pill.
      // (and on the first frame drawn in the turn whatever u is, so a slow frame cannot skip that).
      const first = !sg.seen;
      sg.seen = true;
      // Same words, a new side, both places clear: the pill slides across instead of fading.
      if (change && sg.label === sg.next && !sg.hideA && !sg.hideB) {
        const e = ease(Math.min(1, Math.max(0, u)));
        place(tk, sg.at.x, sg.at.y, sg.label, 1, { x: sg.offA.x + (sg.offB.x - sg.offA.x) * e, y: sg.offA.y + (sg.offB.y - sg.offA.y) * e }, 1);
        return;
      }
      const op = change ? (u < 0.1 || first ? 1 : u < 0.5 ? (sg.hideA ? 0 : Math.max(0, 1 - (u - 0.1) / 0.28)) : sg.hideB ? 0 : Math.max(0, (u - 0.66) / 0.34)) : 1;
      place(tk, sg.at.x, sg.at.y, u < 0.5 ? sg.label : sg.next, 1, u < 0.5 ? sg.offA : sg.offB, op);
    } else if (sg.kind === 'hop') {
      // Fade out where it is, cross unseen in one step, fade in where the next line starts: it never moves while faded.
      const o = u < 0.45 ? 1 - u / 0.45 : u > 0.55 ? (u - 0.55) / 0.45 : 0;
      const p = u < 0.5 ? sg.a : sg.b;
      place(token, p.x, p.y, u < 0.5 ? sg.label : sg.next, o, u < 0.5 ? sg.offA : sg.offB, u >= 0.5 && sg.noPillB ? 0 : 1);
      // Fully faded, it is not drawn at all, so the step across is never seen as movement.
      if (o <= 0) token.g.style.display = 'none';
    } else {
      const tk = sg.who === 'main' ? token : branchTok;
      place(tk, sg.at.x, sg.at.y, sg.label, u, sg.off, sg.noPill ? 0 : 1);
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

  /**
   * Everything the reader needs to see for one step, in diagram units: the lit
   * boxes, and every place the token and its pill pass through, both ends included.
   */
  const stepBoxes = new Map<string, Box>();
  function stepBox(i: number): Box {
    const key = `${i}|${coldOn(i) ? 1 : 0}`;
    const hit = stepBoxes.get(key);
    if (hit) return hit;
    const s = design.tour[i];
    let u: Box | null = null;
    for (const id of s.focus) u = union(u, boxOf(id));
    for (const l of [...pathLegs(i), ...(s.branch ? pathLegs(i, 'branch') : [])]) {
      const w = pillWidth(l.label);
      for (let a = l.from; ; a = Math.min(l.len, a + 10)) {
        const p = l.el.getPointAtLength(l.back ? l.full - a : a);
        u = union(u, { x: p.x - DOT_R, y: p.y - DOT_R, w: 2 * DOT_R, h: 2 * DOT_R });
        u = union(u, pillAt(p, l.off, w));
        if (a >= l.len) break;
      }
    }
    const e = endOf(i);
    u = union(u, pillAt(e, restOff(i), pillWidth(endLabel(i))));
    stepBoxes.set(key, u!);
    return u!;
  }
  /** Where the trip of step i begins, so a step too big for the screen is shown from its start. */
  function startOf(i: number): Pt {
    const legs = pathLegs(i);
    return legs.length ? legStart(legs[0]) : endOf(i);
  }

  /** A phone, upright or sideways: the tour zooms the diagram to fit each step. */
  const small = () => innerWidth < 600 || innerHeight < 500;
  /**
   * The smallest scale the tour zooms to on a small screen: the diagram's
   * smallest text (16.5 units) is then 11px. A step that does not fit at it is
   * not shrunk further; the view pans with the token instead.
   */
  const FLOOR_SCALE = 0.67;
  /** The scale the tour has zoomed to for this step on a small screen (null: the reading scale), and whether the step fits at it. */
  let tourK: number | null = null;
  let stepFits = true;
  /** The reading scale: the diagram's scale when the tour is not zooming it. */
  function baseK(): number {
    const cw = canvas.clientWidth;
    return fitted ? Math.min(cw / W, MAX_SCALE) : Math.min(MAX_SCALE, Math.max(cw / W, BASE_SCALE));
  }
  /** Size the diagram for its scale, in pixels per unit: the reading scale, the overview, or the tour's zoom on a small screen. */
  function zoomFor(): number {
    const cw = canvas.clientWidth;
    const k = !fitted && tourK != null ? tourK : baseK();
    const want = k * W > cw + 0.5 || fitted || tourK != null ? `${(W * k).toFixed(1)}px` : '';
    if (svg.style.minWidth !== want) {
      svg.style.minWidth = want;
      svg.style.width = want;
    }
    // The pill's paper halo stays about 2.5px wide at any scale.
    svg.style.setProperty('--halo', (5 / k).toFixed(2));
    return k;
  }

  // ---- the tour on a small screen: one fixed canvas, the diagram zoomed and panned inside it ----
  /**
   * On a phone the tour draws the diagram in a canvas of one height for the
   * whole tour, filling the screen under the stuck readout, so nothing below it
   * moves from step to step. The diagram is zoomed to each step (never below
   * FLOOR_SCALE) and letterboxed in the canvas when it is smaller.
   */
  let cam = false;
  /** The screen size the canvas height was worked out for: it is worked out once for the tour, and again only if the screen changes. */
  let camFor = '';
  const CAM_PAD = 10;
  function setCam(on: boolean): void {
    if (cam !== on) {
      cam = on;
      canvas.classList.toggle('cam', on);
      stage.classList.toggle('cam', on);
      if (!on) {
        canvas.style.height = '';
        canvas.scrollTop = 0;
      }
      syncPan();
    }
    if (!on) camFor = '';
    // The readout as it stands collapsed: More opened does not shrink the canvas.
    if (on && !moreOpen && camFor !== `${innerWidth}x${innerHeight}`) {
      camFor = `${innerWidth}x${innerHeight}`;
      const pb = panBar.hidden ? 0 : panBar.offsetHeight;
      canvas.style.height = `${Math.max(140, Math.floor(innerHeight - head.offsetHeight - pb))}px`;
    }
  }
  /** Put the view's centre at (cx, cy) at scale k: the canvas scrolls, and where the diagram is smaller than the canvas it sits in the middle. */
  function camApply(k: number, cx: number, cy: number): void {
    tourK = k;
    zoomFor();
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const sw = W * k;
    const sh = H * k;
    canvas.scrollLeft = sw <= cw ? 0 : Math.max(0, Math.min(cx * k - cw / 2, sw - cw));
    canvas.scrollTop = sh <= ch ? 0 : Math.max(0, Math.min(cy * k - ch / 2, sh - ch));
  }
  /** What the canvas shows now, in diagram units. */
  function camView(): Box {
    const k = tourK ?? baseK();
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const ox = Math.max(0, (cw - W * k) / 2);
    const oy = Math.max(0, (ch - H * k) / 2);
    return { x: (canvas.scrollLeft - ox) / k, y: (canvas.scrollTop - oy) / k, w: cw / k, h: ch / k };
  }
  /** The view centre that shows a region, at scale k. */
  const camCentre = (u: Box): Pt => ({ x: u.x + u.w / 2, y: u.y + u.h / 2 });
  /** Whether a region fits the canvas at scale k, with a margin. */
  const camFits = (u: Box, k: number) => u.w * k <= canvas.clientWidth - 2 * CAM_PAD && u.h * k <= canvas.clientHeight - 2 * CAM_PAD;
  /** The first of the regions that fits, or the last one. */
  const firstFit = (us: (Box | null)[], k: number) => {
    const ok = us.filter(Boolean) as Box[];
    return ok.find((u) => camFits(u, k)) ?? ok[ok.length - 1];
  };
  const chipOf = (l: PathSeg | undefined, i: number): Box | null => {
    if (!l) return null;
    const id = lineIdOf.get(l.el)!;
    return drawnFor(i).chips.includes(id) ? chipBox.get(id)! : null;
  };
  const dotBox = (p: Pt): Box => ({ x: p.x - DOT_R, y: p.y - DOT_R, w: 2 * DOT_R, h: 2 * DOT_R });
  const fromBoxOf = (l: PathSeg) => {
    const fl = flowById.get(lineIdOf.get(l.el)!)!;
    return boxOf(l.back ? fl.to : fl.from);
  };
  /** Where a step comes to rest: the box the trip ends at, the chip of its last leg and the token's label, and the branch too when they all fit. */
  function camRestRegion(i: number, k: number): Box {
    const legs = pathLegs(i);
    const last = legs[legs.length - 1];
    const pill = restBox(i, 'main');
    const must = pill ? union(union(endBox(i), pill), dotBox(endOf(i))) : endBox(i);
    const withChip = chipOf(last, i) ? union(must, chipOf(last, i)!) : must;
    let all: Box | null = null;
    if (design.tour[i].branch) {
      const br = pathLegs(i, 'branch');
      const bl = br[br.length - 1];
      const bp = restBox(i, 'branch');
      if (bl && bp) {
        const fl = flowById.get(lineIdOf.get(bl.el)!)!;
        all = union(union(withChip, bp), boxOf(bl.back ? fl.from : fl.to));
      }
    }
    return firstFit([all, withChip, must], k);
  }
  /** Where a step too big for the canvas starts: the box and chip of its first leg and the token's label, placed so that the way it goes is in view. */
  function camStartRegion(i: number, k: number): Box {
    const legs = pathLegs(i);
    const first = legs[0];
    if (!first) return camRestRegion(i, k);
    const st = legStart(first);
    const sp = union(dotBox(st), pillAt(st, first.off, pillWidth(first.label)));
    const s0 = union(fromBoxOf(first), sp);
    const s1 = chipOf(first, i) ? union(s0, chipOf(first, i)!) : s0;
    const r = firstFit([union(s1, endBox(i)), s1, sp], k);
    if (r !== s1 && r !== s0) return r;
    // Slide the view towards where the trip goes, keeping the start in it.
    const vw = (canvas.clientWidth - 2 * CAM_PAD) / k;
    const vh = (canvas.clientHeight - 2 * CAM_PAD) / k;
    const e = endBox(i);
    const toRight = e.x + e.w / 2 >= r.x + r.w / 2;
    const toDown = e.y + e.h / 2 >= r.y + r.h / 2;
    const w = Math.max(r.w, vw);
    const hh = Math.max(r.h, vh);
    return { x: toRight ? r.x : r.x + r.w - w, y: toDown ? r.y : r.y + r.h - hh, w, h: hh };
  }
  /** Glide the zoom and the view centre together, and the page to y, in about 280ms (at once with reduced motion). Returns how long it takes. */
  function camGlide(k1: number, c1: Pt, y1: number): number {
    cancelAnimationFrame(followRaf);
    const k0 = tourK ?? k1;
    const v = camView();
    const c0 = tourK == null ? c1 : { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    const y0 = window.scrollY;
    if (tourK == null || reducedMotion() || (Math.abs(k1 - k0) < 0.002 && Math.hypot(c1.x - c0.x, c1.y - c0.y) * k1 < 1 && Math.abs(y1 - y0) < 1)) {
      camApply(k1, c1.x, c1.y);
      if (Math.abs(y1 - window.scrollY) > 0.5) window.scrollTo(0, y1);
      return 0;
    }
    const t0 = performance.now();
    const ms = 280;
    const step2 = (now: number) => {
      if (!alive || !cam) return;
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      camApply(k0 + (k1 - k0) * e, c0.x + (c1.x - c0.x) * e, c0.y + (c1.y - c0.y) * e);
      window.scrollTo(0, y0 + (y1 - y0) * e);
      if (t < 1) followRaf = requestAnimationFrame(step2);
    };
    followRaf = requestAnimationFrame(step2);
    return ms;
  }
  /** The page sits with the stage at the top of the screen for the whole tour: the readout, then the canvas. */
  const camPageY = () => Math.max(0, Math.min(stage.getBoundingClientRect().top + window.scrollY, document.documentElement.scrollHeight - innerHeight));
  /** The step's first view on a small screen: the whole step if it fits at or above the floor, otherwise where its trip starts. */
  function camStep(i: number): number {
    setCam(true);
    const u = stepBox(i);
    const kFit = Math.min((canvas.clientWidth - 2 * CAM_PAD) / u.w, (canvas.clientHeight - 2 * CAM_PAD) / u.h);
    stepFits = kFit >= FLOOR_SCALE;
    const k = stepFits ? Math.min(BASE_SCALE, kFit) : FLOOR_SCALE;
    const r = stepFits ? u : camStartRegion(i, k);
    return camGlide(k, camCentre(r), camPageY());
  }
  /** The trip has ended: a step too big for the canvas comes to rest on where it ended. */
  function camRest(i: number): number {
    if (!cam || stepFits || tourK == null) return 0;
    return camGlide(tourK, camCentre(camRestRegion(i, tourK)), window.scrollY);
  }
  /** While the token moves through a step too big for the canvas, the view pans with it, a little each frame. */
  function camFollow(x: number, y: number, tk: Tok): void {
    if (stepFits || tourK == null || reducedMotion() || !followsTokenOrStill()) return;
    const k = tourK;
    const dot = union(dotBox({ x, y }), tk.pillBox ?? dotBox({ x, y }));
    const s0 = design.tour[step];
    const bl = s0.branch?.path.length ? legOf(s0.branch.path[s0.branch.path.length - 1]) : null;
    const dest = tk === branchTok && bl ? boxOf(bl.back ? bl.fl.from : bl.fl.to) : endBox(step);
    const r = firstFit([union(dot, dest), dot], k);
    const v = camView();
    const m = CAM_PAD / k;
    let dx = 0;
    let dy = 0;
    if (r.x < v.x + m) dx = r.x - v.x - m;
    else if (r.x + r.w > v.x + v.w - m) dx = r.x + r.w - (v.x + v.w - m);
    if (r.y < v.y + m) dy = r.y - v.y - m;
    else if (r.y + r.h > v.y + v.h - m) dy = r.y + r.h - (v.y + v.h - m);
    if (Math.abs(dx) * k < 0.5 && Math.abs(dy) * k < 0.5) return;
    camApply(k, v.x + v.w / 2 + dx * 0.35, v.y + v.h / 2 + dy * 0.35);
  }

  /** The part of the screen the diagram can be seen in: below the stuck readout, inside the canvas. */
  function viewport(): { top: number; bottom: number } {
    const stuck = step >= 0 && !stage.classList.contains('reading') && !stage.classList.contains('unstick');
    return { top: stuck ? head.getBoundingClientRect().bottom : 0, bottom: innerHeight };
  }

  /**
   * Keep the moving token on screen: when it nears an edge of the visible part
   * of the diagram, the diagram pans (and the page scrolls) a little each frame
   * to follow it. Never a jump. On a small screen the view stays where the step
   * put it, unless the step is too big to show whole: then it follows the
   * token, with the box it is going to when both fit.
   */
  function followsToken(): boolean {
    if (!alive || step < 0 || stage.classList.contains('reading') || reducedMotion()) return false;
    // A reader who has scrolled away from the diagram is left where they are.
    const cv = canvas.getBoundingClientRect();
    return !(cv.bottom < 60 || cv.top > innerHeight - 60);
  }
  function keepInView(x: number, y: number, tk: Tok = token): void {
    if (cam) {
      camFollow(x, y, tk);
      return;
    }
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
  /** The box a step's trip ends at (or its first lit box, for a step with no trip). */
  function endBox(i: number): Box {
    const s0 = design.tour[i];
    if (!s0.path.length) return boxOf(s0.focus[0]);
    const last = legOf(s0.path[s0.path.length - 1]);
    return boxOf(last.back ? last.fl.from : last.fl.to);
  }
  /**
   * When a trip ends, bring the step's lit boxes fully into view if they fit:
   * following the token may have left one partly under the readout or past an edge.
   */
  function settle(i: number): { sl: number; y: number; ms: number } | null {
    if (!alive || stage.classList.contains('reading')) return null;
    // Zoomed to fit the step: everything is in view already, and the view stays put.
    if (tourK != null && !fitted && stepFits) return null;
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

  /** The token has arrived: bring the end into view, then (on a larger screen) show any lit part still out of sight, and wait to read. */
  function arrived(i: number): void {
    stage.dataset.phase = 'rest';
    if (cam) {
      camRest(i);
      dwell(i);
      return;
    }
    const end = settle(i);
    const extra = end && tourK == null ? glance(i, end, end.ms + 700) : 0;
    dwell(i, undefined, extra ? extra + 1200 : 0);
  }

  /**
   * Keep the step in view. When the readout, the transport and the whole
   * diagram fit on the screen together, the page sits with the stage at the
   * top for the whole tour and never moves. Otherwise the page scrolls, and the
   * diagram pans, so the step sits below the readout (which sticks to the top
   * of the screen) and above the bottom edge; a step too big for the screen is
   * shown from where its trip begins. On a small screen the diagram zooms to
   * fit the step instead (see fitStep).
   */
  function follow(i: number, force = false): number {
    cancelAnimationFrame(followRaf);
    const sr = stage.getBoundingClientRect();
    const vh = innerHeight;
    if (!force && (sr.bottom < 40 || sr.top > vh - 40)) return 0;
    if (small() && !fitted) return camStep(i);
    if (cam || tourK != null) {
      tourK = null;
      stepFits = true;
      setCam(false);
      zoomFor();
    }
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
    // Long enough to read at any speed: double speed shortens the wait, but never below 3.5 seconds, nor below 4.5 seconds
    // for every 200 characters of the step. Half speed slows only the motion, so the wait stays as at normal speed; with
    // reduced motion there is no motion to slow, so the speed sets the wait alone and half speed doubles it.
    // Never shorter than the glance at the parts out of sight.
    const by = reducedMotion() ? speed : Math.max(1, speed);
    dwellMs = ms ?? Math.max(least, 3500, (s.text.length / 200) * 4500, Math.min(reducedMotion() ? 22000 : 11000, Math.max(4200, s.text.length * 42) / by));
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
      else {
        pause(false);
        status.textContent = 'End of the tour.';
      }
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
    // A token far from where this trip starts goes at once (no fade where it was): the trip fades it in at its start.
    const first = startOf(i);
    if (token.at && Math.hypot(token.at.x - first.x, token.at.y - first.y) > JUMP) hideToken();
    token.g.classList.toggle('waiting', !design.tour[i].path.length);
    if (!animate || reducedMotion()) {
      const e = endOf(i);
      place(token, e.x, e.y, endLabel(i), 1, restOff(i));
      const br = design.tour[i].branch ? pathLegs(i, 'branch') : [];
      if (br.length) {
        const be = legEnd(br[br.length - 1]);
        place(branchTok, be.x, be.y, br[br.length - 1].label, 1, endPlace(i, 'branch'));
      }
      arrived(i);
      return;
    }
    const segs = tripFor(i);
    if (!segs.length) {
      // A step with no connection, and the token already where it waits.
      const e = endOf(i);
      place(token, e.x, e.y, endLabel(i), 1, restOff(i));
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
    countLong.textContent = `Step ${i + 1} of ${design.tour.length}`;
    countShort.textContent = `${i + 1}/${design.tour.length}`;
    measureReserve();
    const ms = follow(i, manual || whole);
    if (ms > 0) {
      // The view glides to the step first. The readout, the lit boxes and lines change on the frame the glide starts,
      // and the old token goes on that frame too; the new trip fades the token in where it starts once the view is there.
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(timer);
      timer = 0;
      trip = null;
      cancelGlance();
      hideToken(branchTok);
      hideToken();
      stage.dataset.phase = 'glide';
      starting = window.setTimeout(() => {
        starting = 0;
        if (!alive || step !== i) return;
        run(i, true, holdTrip);
        holdTrip = false;
        sync();
      }, ms);
      sync();
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
    token.g.classList.remove('waiting');
    if (moreOpen) setMore(false, true);
    if (fromButton) playBtn.focus({ preventScroll: true });
    // Back to the reading scale.
    tourK = null;
    stepFits = true;
    setCam(false);
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
    speedCycle.setAttribute('aria-label', `${s}×, ${SPEED_NAMES[s].toLowerCase()}. Change speed`);
    // A running trip reads the speed on every frame, and the glide has no timer of its own: only a running wait needs re-arming.
    if (playing && timer) {
      const left = Math.max(0, dwellMs - (performance.now() - dwellAt));
      dwell(step, Math.max(0, (left * Math.max(1, old)) / Math.max(1, s)));
    } else if (!playing && dwellLeft) dwellLeft = (dwellLeft * Math.max(1, old)) / Math.max(1, s);
  }
  speedCycle.setAttribute('aria-label', '1×, normal speed. Change speed');

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
    const over = !cam && canvas.scrollWidth > canvas.clientWidth + 1;
    // On the tour on a phone the overview button stays on show under the canvas.
    panBar.hidden = !over && !fitted && !cam;
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
    // Floating in the corner of the tour's canvas on a phone, the button says less.
    const fitText = cam ? 'Whole diagram' : 'Overview: whole diagram, small text';
    if (fitBtn.textContent !== fitText) fitBtn.textContent = fitText;
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

  // Tabbing into the stuck readout or transport must not scroll the page (Chrome would scroll the sticky head back to its place in the page).
  let tabY = -1;
  let tabAt = 0;
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      tabY = window.scrollY;
      tabAt = performance.now();
    }
  };
  document.addEventListener('keydown', onTabKey, true);
  // While the readout sticks to the top, nothing focused may hide under it.
  const onFocusIn = (e: FocusEvent) => {
    if (head.contains(e.target as Node) && tabY >= 0 && performance.now() - tabAt < 600) {
      const y = tabY;
      if (Math.abs(window.scrollY - y) > 0.5) window.scrollTo(window.scrollX, y);
      requestAnimationFrame(() => {
        if (Math.abs(window.scrollY - y) > 0.5) window.scrollTo(window.scrollX, y);
      });
      tabY = -1;
      return;
    }
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
        // The address goes back to the page itself, so it never names something that is not there.
        history.replaceState(history.state, '', base);
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
          (term.querySelector('dt') as HTMLElement).focus({ preventScroll: true });
        } else missing('glossary term');
      } else if (ex) ex.open(open);
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
    document.removeEventListener('keydown', onTabKey, true);
    document.removeEventListener('change', onKeysSwitch);
    window.removeEventListener('resize', onResize);
    document.documentElement.style.scrollPaddingTop = '';
    page.remove();
  };
}
