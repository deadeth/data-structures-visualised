import './reading.css';
import { h, scrollRegion } from '../core/dom';
import { DESIGNS, design as designEntry } from '../designs';
import type { Component, Design, Flow } from '../designs/types';
import { concept, plain, walkthrough } from '../reading';
import type { Block, Concept, Diagram, DiagramNode, Reading, Sequence, Tone } from '../reading/types';

/**
 * A reading page: prose with diagrams. Concept pages live at `#/c/<id>`, design walkthroughs at
 * `#/d/<design id>/read`. Either can be opened at a section (`.../<section id>`).
 */

const NS = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}
const svgText = (x: number, y: number, text: string, cls: string, attrs: Record<string, string | number> = {}) => {
  const t = el('text', { x, y, ...attrs }, cls);
  t.textContent = text;
  return t;
};

/** Each figure's markers and clip paths need ids no other figure on the page uses. */
let uid = 0;

// ---- inline markup ------------------------------------------------------------

/** **bold**, `code` and [label](#/...) links. Nothing else is parsed; a link that is not a site address stays as text. */
export function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h('strong', null, inline(m[1])));
    else if (m[2] !== undefined) out.push(h('code', null, m[2]));
    else if (m[4].startsWith('#/')) out.push(h('a', { href: m[4] }, inline(m[3])));
    else out.push(...inline(m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs inside one string, split at blank lines. */
/** Cut a line to a width, ending it with an ellipsis. */
function clip(line: string, size: number, weight: number, max: number): string {
  if (measure(line, size, weight) <= max) return line;
  let t = line;
  while (t.length > 1 && measure(`${t}…`, size, weight) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const paras = (text: string) => text.split(/\n\s*\n/).map((t) => h('p', null, inline(t.trim())));

// ---- measuring text -----------------------------------------------------------

const FONT = '"Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif';
let ctx: CanvasRenderingContext2D | null = null;
function measure(text: string, size: number, weight = 400): number {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * size * 0.56;
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(text).width;
}
/** Greedy word wrap to a width. A word longer than the width keeps a line to itself. */
function wrap(text: string, size: number, weight: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size, weight) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
const widest = (lines: string[], size: number, weight: number) => Math.max(0, ...lines.map((l) => measure(l, size, weight)));

// ---- figures --------------------------------------------------------------------

const TONES: (Tone | 'plain')[] = ['plain', 'follow', 'compare', 'visited', 'ok', 'bad', 'muted'];

/** Arrowheads, one per tone, so a head takes its line's colour. Fixed size in diagram units. */
function markers(id: string): SVGDefsElement {
  const defs = el('defs');
  for (const t of TONES) {
    const m = el('marker', { id: `${id}-tip-${t}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0.8 L10,5 L0,9.2 z' }, `rd-tip tone-${t}`));
    defs.append(m);
  }
  return defs;
}
const arrowAttrs = (id: string, tone: Tone | undefined, both?: boolean): Record<string, string> => {
  const url = `url(#${id}-tip-${tone ?? 'plain'})`;
  return both ? { 'marker-end': url, 'marker-start': url } : { 'marker-end': url };
};

/**
 * The frame round a drawing: shown at its own size where there is room, shrunk to fit down to
 * `least` of it, and past that it keeps that size and scrolls sideways inside the frame.
 */
function figure(svg: SVGSVGElement, w: number, caption: string, least: number, cls: string, extra?: HTMLElement): HTMLElement {
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', plain(caption));
  svg.setAttribute('class', 'rd-svg');
  svg.style.maxWidth = `${w}px`;
  svg.style.minWidth = `${Math.round(w * least)}px`;
  const scroller = scrollRegion(h('div.rd-figure-scroll', null, svg), 'Figure');
  return h(`figure.rd-figure.${cls}`, null, scroller, h('figcaption', null, h('span.rd-scroll-hint', { 'aria-hidden': 'true' }, 'Scroll sideways to see all of it. '), inline(caption), extra ?? null));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const nodeRect = (n: DiagramNode): Rect => ({ x: n.x, y: n.y, w: n.w ?? 140, h: n.h ?? 56 });
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** Where a line from the box's centre towards (tx, ty) leaves the box, `pad` units outside it. */
function exitPoint(r: Rect, tx: number, ty: number, pad: number) {
  const c = centre(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? (r.w / 2 + pad) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + pad) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}
/** The visible part of an edge: from the edge of one box to the edge of the other. Shared with the validation test. */
export function edgeLine(a: Rect, b: Rect, pad = 0) {
  const ca = centre(a);
  const cb = centre(b);
  return { a: exitPoint(a, cb.x, cb.y, pad), b: exitPoint(b, ca.x, ca.y, pad) };
}

const LABEL = 15;
const SUB = 13;
const CHIP = 12.5;

/** A boxes-and-arrows picture, drawn from its data. */
function drawDiagram(d: Diagram, caption: string): HTMLElement {
  const id = `rd${++uid}`;
  const svg = el('svg', { viewBox: `0 0 ${d.w} ${d.h}`, width: d.w });
  svg.append(markers(id));
  const rects = new Map(d.nodes.map((n) => [n.id, nodeRect(n)]));

  // Group labels sit on a plate of the group's own fill, drawn above the lines, so an edge entering near the corner passes under the words.
  const groupLabels = el('g');
  for (const g of d.groups ?? []) {
    const tone = g.tone ?? 'plain';
    svg.append(el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 12 }, `rd-group tone-${tone}`));
    const label = clip(g.label, 13, 700, g.w - 20);
    const lw = measure(label, 13, 700);
    groupLabels.append(el('rect', { x: g.x + 7, y: g.y + 5, width: lw + 10, height: 19, rx: 4 }, `rd-group-plate tone-${tone}`), svgText(g.x + 12, g.y + 19, label, `rd-group-label tone-${tone}`));
  }

  const lines = el('g');
  const chips = el('g');
  for (const e of d.edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    const { a: p, b: q } = edgeLine(a, b, 2);
    lines.append(el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, ...arrowAttrs(id, e.tone, e.both) }, `rd-edge tone-${e.tone ?? 'plain'}${e.dashed ? ' dashed' : ''}`));
    if (e.label) {
      const ls = wrap(e.label, CHIP, 600, 150);
      const cw = widest(ls, CHIP, 600) + 14;
      const ch = ls.length * 15 + 8;
      // At the middle of the line, or slid toward its start so the arrowhead (10 units) stays clear of the chip.
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const ux = (q.x - p.x) / len;
      const uy = (q.y - p.y) / len;
      const along = cw * Math.abs(ux) + ch * Math.abs(uy);
      let at = len / 2;
      if (at + along / 2 > len - 11) at = Math.max(along / 2, len - 11 - along / 2);
      if (e.both && at - along / 2 < 11) at = len / 2;
      const mx = p.x + ux * at;
      const my = p.y + uy * at;
      const chip = el('g', { transform: `translate(${mx},${my})` }, `rd-chip tone-${e.tone ?? 'plain'}`);
      chip.append(el('rect', { x: -cw / 2, y: -ch / 2, width: cw, height: ch, rx: 6 }));
      ls.forEach((l, i) => chip.append(svgText(0, -ch / 2 + 4 + 11.5 + i * 15, l, '', { 'text-anchor': 'middle' })));
      chips.append(chip);
    }
  }
  svg.append(lines, groupLabels);

  for (const n of d.nodes) {
    const r = rects.get(n.id)!;
    const kind = n.kind ?? 'box';
    const g = el('g', { transform: `translate(${r.x},${r.y})` }, `rd-node kind-${kind} tone-${n.tone ?? 'plain'}`);
    const CAP = 7;
    let top = 0;
    let bottom = r.h;
    if (kind === 'store') {
      g.append(el('path', { d: `M0,${CAP} A${r.w / 2},${CAP} 0 0 1 ${r.w},${CAP} V${r.h - CAP} A${r.w / 2},${CAP} 0 0 1 0,${r.h - CAP} Z` }, 'rd-shape'));
      g.append(el('path', { d: `M0,${CAP} A${r.w / 2},${CAP} 0 0 0 ${r.w},${CAP}` }, 'rd-cap'));
      top = CAP * 2;
      bottom = r.h - CAP / 2;
    } else if (kind === 'queue') {
      g.append(el('rect', { width: r.w, height: r.h, rx: 6 }, 'rd-shape'));
      const n = Math.max(4, Math.floor((r.w - 24) / 14));
      g.append(el('path', { d: Array.from({ length: n + 1 }, (_, i) => `M${12 + (i * (r.w - 24)) / n},${r.h - 10} v6`).join(' ') }, 'rd-cap'));
      bottom = r.h - 10;
    } else if (kind === 'client') {
      const rx = Math.min(18, r.h / 2);
      g.append(el('rect', { width: r.w, height: r.h, rx }, 'rd-shape'));
      const clip = el('clipPath', { id: `${id}-clip-${n.id}` });
      clip.append(el('rect', { x: 0.8, y: 0.8, width: r.w - 1.6, height: r.h - 1.6, rx: rx - 0.8 }));
      g.append(clip, el('rect', { x: 0.8, y: 0, width: 4, height: r.h, 'clip-path': `url(#${id}-clip-${n.id})` }, 'rd-bar'));
    } else if (kind === 'box') g.append(el('rect', { width: r.w, height: r.h, rx: 8 }, 'rd-shape'));
    // Words: the label and subtitle wrap to the shape. If they do not fit its height, both step down a size at a
    // time (label to 12, subtitle to 11.5); past that the subtitle loses lines and its last line ends in an ellipsis.
    const room = r.w - (kind === 'client' ? 20 : kind === 'note' ? 4 : 14);
    const weight = kind === 'note' ? 650 : 700;
    const avail = bottom - top - 2;
    let size = kind === 'note' ? 14 : LABEL;
    let sub = SUB;
    const lay = () => {
      const ls = wrap(n.label, size, weight, room);
      const ss = n.sub ? wrap(n.sub, sub, 400, room) : [];
      return { ls, ss, need: ls.length * (size + 3) + ss.length * (sub + 3) - 3, wide: Math.max(widest(ls, size, weight), widest(ss, sub, 400)) > room };
    };
    let fit = lay();
    while ((fit.need > avail || fit.wide) && (size > 12 || sub > 11.5)) {
      if (size > 12) size -= 1;
      if (sub > 11.5) sub -= 0.5;
      fit = lay();
    }
    let { ls, ss } = fit;
    while (ss.length && ls.length * (size + 3) + ss.length * (sub + 3) - 3 > avail) {
      const keep = ss.slice(0, -1);
      if (!keep.length) {
        ss = [];
        break;
      }
      keep[keep.length - 1] = clip(`${keep[keep.length - 1]} ${ss[ss.length - 1]}`, sub, 400, room);
      ss = keep;
    }
    ls = ls.map((l) => clip(l, size, weight, room));
    ss = ss.map((l) => clip(l, sub, 400, room));
    const lh = size + 3;
    const block = ls.length * lh + ss.length * (sub + 3) - 3;
    let y = top + (bottom - top - block) / 2 + size * 0.8;
    const cx = r.w / 2 + (kind === 'client' ? 2 : 0);
    for (const l of ls) {
      g.append(svgText(cx, y, l, kind === 'note' ? 'rd-note' : 'rd-label', { 'text-anchor': 'middle', 'font-size': size }));
      y += lh;
    }
    y += sub + 3 - lh;
    for (const l of ss) {
      g.append(svgText(cx, y, l, 'rd-sub', { 'text-anchor': 'middle', 'font-size': sub }));
      y += sub + 3;
    }
    svg.append(g);
  }
  svg.append(chips);
  return figure(svg, d.w, caption, 0.75, 'rd-diagram');
}

/** A message sequence chart: actors across the top, lifelines down, one arrow per message in time order. */
function drawSequence(s: Sequence, caption: string): HTMLElement {
  const id = `rd${++uid}`;
  const n = s.actors.length;
  const colW = n >= 4 ? 140 : 170;
  const left = 6;
  const noteW = 176;
  const hasNotes = s.messages.some((m) => m.note);
  const width = left * 2 + n * colW + (hasNotes ? noteW + 14 : 0);
  const cx = (a: string) => left + colW / 2 + Math.max(0, s.actors.indexOf(a)) * colW;
  const svg = el('svg', { width });
  svg.append(markers(id));

  const headLines = s.actors.map((a) => wrap(a, 14.5, 700, colW - 34));
  const headH = Math.max(40, ...headLines.map((l) => l.length * 18 + 16));
  const heads = el('g');
  s.actors.forEach((a, i) => {
    const x = cx(a);
    const bw = colW - 20;
    heads.append(el('rect', { x: x - bw / 2, y: 2, width: bw, height: headH, rx: 8 }, 'rd-actor'));
    const ls = headLines[i];
    ls.forEach((l, j) => heads.append(svgText(x, 2 + headH / 2 - ((ls.length - 1) * 18) / 2 + 5 + j * 18, l, 'rd-label', { 'text-anchor': 'middle', 'font-size': 14.5 })));
  });

  const rows = el('g');
  let y = headH + 20;
  for (const m of s.messages) {
    const x1 = cx(m.from);
    const x2 = cx(m.to);
    const self = m.from === m.to;
    // A label may run past the lifelines it spans (it has a halo), up to about one and a half columns.
    const span = self ? colW - 30 : Math.max(colW * 1.5, Math.abs(x2 - x1) - 16);
    const ls = wrap(m.label, 13.5, 600, span);
    const labelH = ls.length * 16.5;
    const arrowY = y + labelH + 8;
    const cls = `rd-msg tone-${m.tone ?? 'plain'}${m.dashed ? ' dashed' : ''}`;
    let mid = (x1 + x2) / 2;
    if (self) {
      rows.append(el('path', { d: `M${x1},${arrowY} h34 v20 h-32`, ...arrowAttrs(id, m.tone) }, cls));
      mid = x1 + 8;
      ls.forEach((l, j) => rows.append(svgText(mid, y + 12 + j * 16.5, l, 'rd-msg-label', {})));
    } else {
      rows.append(el('line', { x1: x1 + (x2 > x1 ? 1 : -1), y1: arrowY, x2: x2 + (x2 > x1 ? -2 : 2), y2: arrowY, ...arrowAttrs(id, m.tone) }, cls));
      // Keep the label inside the chart's actor columns.
      const half = widest(ls, 13.5, 600) / 2;
      mid = Math.min(Math.max(mid, left + half + 2), left + n * colW - half - 2);
      ls.forEach((l, j) => rows.append(svgText(mid, y + 12 + j * 16.5, l, 'rd-msg-label', { 'text-anchor': 'middle' })));
    }
    let rowH = labelH + 8 + (self ? 30 : 14);
    if (m.note) {
      const nl = wrap(m.note, 13, 400, noteW - 18);
      const nh = nl.length * 16 + 12;
      const nx = left + n * colW + 14;
      const ny = Math.max(y, arrowY - nh / 2);
      rows.append(el('line', { x1: left + n * colW - 4, y1: arrowY, x2: nx, y2: arrowY }, 'rd-note-leader'));
      rows.append(el('rect', { x: nx, y: ny, width: noteW, height: nh, rx: 6 }, `rd-seq-note tone-${m.tone ?? 'plain'}`));
      nl.forEach((l, j) => rows.append(svgText(nx + 9, ny + 6 + 12 + j * 16, l, 'rd-note-text')));
      rowH = Math.max(rowH, ny + nh - y + 8);
    }
    y += rowH;
  }
  const total = y + 10;
  const lifelines = el('g');
  for (const a of s.actors) lifelines.append(el('line', { x1: cx(a), y1: headH + 2, x2: cx(a), y2: total - 4 }, 'rd-lifeline'));
  svg.append(lifelines, heads, rows);
  svg.setAttribute('viewBox', `0 0 ${width} ${total}`);
  return figure(svg, width, caption, 0.75, 'rd-sequence');
}

// ---- design snapshots -------------------------------------------------------------

/** Points along an SVG path made of M, L, H, V, Q and C (absolute or relative) and Z: enough for the design pages' lines. */
function samplePath(d: string): { x: number; y: number }[] {
  const toks = d.match(/[MLHVQCZmlhvqcz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const pts: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = 'M';
  let i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        pts.push({ x, y });
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        pts.push({ x, y });
        break;
      case 'H':
        x = ox + num();
        pts.push({ x, y });
        break;
      case 'V':
        y = oy + num();
        pts.push({ x, y });
        break;
      case 'Q': {
        const [c1x, c1y, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
        for (let k = 1; k <= 16; k++) {
          const t = k / 16;
          const u = 1 - t;
          pts.push({ x: u * u * x + 2 * u * t * c1x + t * t * ex, y: u * u * y + 2 * u * t * c1y + t * t * ey });
        }
        x = ex;
        y = ey;
        break;
      }
      case 'C': {
        const [c1x, c1y, c2x, c2y, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        for (let k = 1; k <= 16; k++) {
          const t = k / 16;
          const u = 1 - t;
          pts.push({ x: u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex, y: u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey });
        }
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        x = sx;
        y = sy;
        pts.push({ x, y });
        break;
      default:
        i++;
    }
  }
  return pts;
}

/** Where a flow's chip sits: `chip` of the way along, or the point at height `chipY` nearest that. */
function chipPoint(fl: Flow): { x: number; y: number } {
  const pts = samplePath(fl.d);
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
  const seg: number[] = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = seg[seg.length - 1];
  const at = (f: number) => {
    const L = f * total;
    let i = 1;
    while (i < pts.length - 1 && seg[i] < L) i++;
    const t = seg[i] === seg[i - 1] ? 0 : (L - seg[i - 1]) / (seg[i] - seg[i - 1]);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, L };
  };
  const want = at(fl.chip ?? 0.5);
  if (fl.chipY === undefined) return want;
  let best: { x: number; y: number; d: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if ((a.y - fl.chipY) * (b.y - fl.chipY) > 0 || a.y === b.y) continue;
    const t = (fl.chipY - a.y) / (b.y - a.y);
    const L = seg[i - 1] + t * (seg[i] - seg[i - 1]);
    const p = { x: a.x + (b.x - a.x) * t, y: fl.chipY, d: Math.abs(L - want.L) };
    if (!best || p.d < best.d) best = p;
  }
  return best ?? want;
}

/**
 * A still of a design page's own diagram: the components and flows a step is about drawn lit (the
 * tour's blue), everything else in the quiet slate the tour uses, with solid colours and no opacity.
 * Drawn here from the design's data in the design page's visual language, so the design page's own
 * drawing code is not touched. The view is cropped to the lit parts and what sits near them.
 */
function drawDesign(d: Design, lit: string[], flows: string[], caption: string): HTMLElement {
  const id = `rd${++uid}`;
  const sizeOf = (c: Component) => ({ w: c.w ?? 156, h: c.h ?? 56 });
  const boxOf = (c: Component): Rect => {
    const s = sizeOf(c);
    return { x: c.x - s.w / 2, y: c.y - s.h / 2, w: s.w, h: s.h };
  };
  const litSet = new Set(lit);
  // A reply's id lights the line that carries it.
  const replyOf = new Map(d.flows.flatMap((f) => (f.reply ? [[f.reply.id, f.id] as const] : [])));
  const flowSet = new Set(flows.map((f) => replyOf.get(f) ?? f));
  const shown = d.flows.filter((f) => !f.cold || flowSet.has(f.id));

  // The crop: the lit boxes and lines with a margin, widened to take in whole any box it cuts, at least 640 by 360.
  const W = d.size.w;
  const H = d.size.h;
  let crop: Rect = { x: 0, y: 0, w: W, h: H };
  const litBoxes = [...d.components.filter((c) => litSet.has(c.id)).map(boxOf), ...d.flows.filter((f) => flowSet.has(f.id)).map((f) => {
    const p = samplePath(f.d);
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  })];
  if (litBoxes.length) {
    const M = 48;
    let x0 = Math.min(...litBoxes.map((b) => b.x)) - M;
    let y0 = Math.min(...litBoxes.map((b) => b.y)) - M;
    let x1 = Math.max(...litBoxes.map((b) => b.x + b.w)) + M;
    let y1 = Math.max(...litBoxes.map((b) => b.y + b.h)) + M;
    for (const c of d.components) {
      const b = boxOf(c);
      if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) {
        x0 = Math.min(x0, b.x - 16);
        y0 = Math.min(y0, b.y - 16);
        x1 = Math.max(x1, b.x + b.w + 16);
        y1 = Math.max(y1, b.y + b.h + 16);
      }
    }
    const grow = (a: number, b: number, least: number, max: number): [number, number] => {
      if (b - a < least) {
        const c = (a + b) / 2;
        a = c - least / 2;
        b = c + least / 2;
      }
      if (a < 0) [a, b] = [0, b - a];
      if (b > max) [a, b] = [Math.max(0, a - (b - max)), max];
      return [a, b];
    };
    [x0, x1] = grow(x0, x1, 640, W);
    [y0, y1] = grow(y0, y1, 360, H);
    crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const svg = el('svg', { viewBox: `${crop.x} ${crop.y} ${crop.w} ${crop.h}`, width: crop.w });
  const defs = el('defs');
  for (const t of ['plain', 'lit', 'quiet']) {
    const m = el('marker', { id: `${id}-tip-${t}`, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: t === 'lit' ? 5.2 : 7, markerHeight: t === 'lit' ? 5.2 : 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0,0 L10,5 L0,10 z' }, `rd-dtip ${t}`));
    defs.append(m);
  }
  svg.append(defs);
  const fr = d.frame;
  svg.append(el('rect', { x: fr.x, y: fr.y, width: fr.w, height: fr.h, rx: 14 }, 'rd-dframe'));
  // The frame's words, where the crop shows them whole.
  const inCrop = (x0: number, x1: number, y: number) => x0 >= crop.x && x1 <= crop.x + crop.w && y - 16 >= crop.y && y <= crop.y + crop.h;
  if (inCrop(fr.x + 14, fr.x + 14 + measure(fr.label, 16.5, 600), fr.y + 22)) svg.append(svgText(fr.x + 14, fr.y + 22, fr.label, 'rd-dframe-label'));
  if (fr.note && inCrop(fr.x + fr.w - 14 - measure(fr.note, 16.5, 400), fr.x + fr.w - 14, fr.y + 22)) svg.append(svgText(fr.x + fr.w - 14, fr.y + 22, fr.note, 'rd-dframe-label note', { 'text-anchor': 'end' }));

  const chips = el('g');
  for (const f of shown) {
    const on = flowSet.has(f.id);
    const tip = `url(#${id}-tip-${on ? 'lit' : 'quiet'})`;
    svg.append(el('path', { d: f.d, 'marker-end': tip, ...(f.reply ? { 'marker-start': tip } : {}) }, `rd-dflow mode-${f.mode}${on ? ' lit' : ''}`));
    if (on) {
      const p = chipPoint(f);
      const cw = measure(f.via, 16.5, 650) + 30;
      const g = el('g', { transform: `translate(${p.x},${p.y})` }, `rd-dchip mode-${f.mode}`);
      g.append(el('rect', { x: -cw / 2, y: -17, width: cw, height: 34, rx: 17 }), svgText(0, 5.5, f.via, '', { 'text-anchor': 'middle' }));
      chips.append(g);
    }
  }
  // A box the crop would cut is left out; its lines run off the edge, which reads as "continues elsewhere".
  const whole = (b: Rect) => b.x >= crop.x - 2 && b.y >= crop.y - 2 && b.x + b.w <= crop.x + crop.w + 2 && b.y + b.h <= crop.y + crop.h + 2;
  for (const c of d.components) {
    if (!litSet.has(c.id) && !whole(boxOf(c))) continue;
    const { w, h: hh } = sizeOf(c);
    const rx = c.kind === 'input' ? Math.min(20, hh / 2) : 10;
    const g = el('g', { transform: `translate(${c.x - w / 2},${c.y - hh / 2})` }, `rd-dnode kind-${c.kind}${litSet.has(c.id) ? ' lit' : ''}`);
    const CAP = 6;
    if (c.kind === 'store') {
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 1 ${w},${CAP} V${hh - CAP} A${w / 2},${CAP} 0 0 1 0,${hh - CAP} Z` }, 'rd-dbox'));
      g.append(el('path', { d: `M0,${CAP} A${w / 2},${CAP} 0 0 0 ${w},${CAP}` }, 'rd-dmark'));
    } else g.append(el('rect', { width: w, height: hh, rx }, 'rd-dbox'));
    if (c.kind === 'input' || c.kind === 'shared') {
      const clipId = `${id}-bar-${c.id}`;
      const clip = el('clipPath', { id: clipId });
      clip.append(el('rect', { x: 0.8, y: 0.8, width: w - 1.6, height: hh - 1.6, rx: Math.max(0, rx - 0.8) }));
      g.append(clip, el('rect', { x: 0.8, y: 0, width: 4, height: hh, 'clip-path': `url(#${clipId})` }, 'rd-dbar'));
    }
    if (c.kind === 'queue') g.append(el('path', { d: Array.from({ length: 9 }, (_, i) => `M${18 + i * ((w - 36) / 8)},${hh - 9} v5`).join(' ') }, 'rd-dmark'));
    const top = c.lines || c.kind === 'queue' ? 23.5 : c.kind === 'store' ? 2 * CAP + 23.5 : hh / 2 - 4.5;
    g.append(svgText(w / 2, top, c.short ?? c.name, 'rd-dname', { 'text-anchor': 'middle' }), svgText(w / 2, top + 19, c.tech, 'rd-dtech', { 'text-anchor': 'middle' }));
    (c.lines ?? []).forEach((line, i) => g.append(svgText(14, top + 41 + i * 18.5, line, 'rd-dtech')));
    svg.append(g);
  }
  svg.append(chips);
  const open = h('a.rd-figure-link', { href: `#/d/${d.id}` }, `Open the interactive ${d.name.replace(/ \(.*\)$/, '').toLowerCase()} design`);
  return figure(svg, Math.round(crop.w * 0.96), caption, 0.68, 'rd-design', h('span.rd-figure-more', null, ' ', open));
}

// ---- blocks -------------------------------------------------------------------------

const CALLOUT: Record<string, string> = { interview: 'Say it in the interview', pitfall: 'Pitfall', rule: 'Rule of thumb', example: 'Worked example' };
const CODE_LANG: Record<string, string> = { sql: 'SQL', json: 'JSON', text: 'Text', python: 'Python', java: 'Java', http: 'HTTP' };

function seeKind(href: string): string {
  if (href.startsWith('#/s/')) return 'Animated page';
  if (/^#\/d\/[^/]+\/read/.test(href)) return 'Walkthrough';
  if (href.startsWith('#/d/')) return 'Interactive design';
  if (href.startsWith('#/c/')) return 'Reading';
  return 'Page';
}

function block(b: Block, designs: Map<string, Design>): HTMLElement {
  if ('p' in b) return h('p', null, inline(b.p));
  if ('h' in b) return h('h3.rd-h', null, inline(b.h));
  if ('list' in b) return h(b.ordered ? 'ol.rd-list.ordered' : 'ul.rd-list', null, b.list.map((t) => h('li', null, inline(t))));
  if ('callout' in b) {
    return h(
      `aside.rd-callout.${b.kind}`, { 'aria-label': b.title ? `${CALLOUT[b.kind]}: ${plain(b.title)}` : CALLOUT[b.kind] },
      h('p.rd-callout-kind', null, CALLOUT[b.kind]),
      b.title ? h('p.rd-callout-title', null, inline(b.title)) : null,
      ...paras(b.callout),
    );
  }
  if ('table' in b) {
    // The caption sits outside the box that scrolls sideways, so a phone shows it whole; it still names the table.
    const capId = b.caption ? `rd-cap-${++uid}` : undefined;
    const t = h(
      'table.rd-table', { 'aria-labelledby': capId },
      h('thead', null, h('tr', null, b.table.head.map((c) => h('th', { scope: 'col' }, inline(c))))),
      h('tbody', null, b.table.rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, inline(c)) : h('td', null, inline(c))))))),
    );
    return h('div.rd-table-box', null, b.caption ? h('p.rd-table-cap', { id: capId }, inline(b.caption)) : null, scrollRegion(h('div.rd-table-wrap', null, t), b.caption ? plain(b.caption) : 'Table'));
  }
  if ('code' in b) {
    const pre = scrollRegion(h('pre.rd-pre', null, h('code', null, b.code.replace(/\n+$/, ''))), b.title ?? `${CODE_LANG[b.lang] ?? b.lang} listing`);
    return h('figure.rd-code', null, h('figcaption', null, h('span.rd-code-lang', null, CODE_LANG[b.lang] ?? b.lang), b.title ? h('span.rd-code-title', null, b.title) : null), pre);
  }
  if ('diagram' in b) return drawDiagram(b.diagram, b.caption);
  if ('sequence' in b) return drawSequence(b.sequence, b.caption);
  if ('design' in b) {
    const d = designs.get(b.design.id);
    if (!d) return h('p.rd-missing', null, `Design "${b.design.id}" is not on this site.`);
    return drawDesign(d, b.design.lit, b.design.flows ?? [], b.caption);
  }
  if ('see' in b) {
    return h(
      'ul.rd-see', { 'aria-label': 'See it animated' },
      b.see.map((s) => h('li', null, h('a.rd-see-card', { href: s.href }, h('span.rd-see-kind', null, seeKind(s.href)), h('span.rd-see-label', null, s.label), h('span.rd-see-why', null, inline(s.why))))),
    );
  }
  return h('p', null, '');
}

// ---- the page --------------------------------------------------------------------------

/** The page on screen, so a change of section in the address scrolls to it instead of drawing the page again. */
let current: { key: string; go: (section?: string) => void } | null = null;

/** Reading page key for an address, or null: `c:<id>` or `d:<design id>`. */
export function readingKey(path: string): { key: string; section?: string } | null {
  const c = /^\/c\/([a-z0-9-]+)(?:\/([^/]+))?$/.exec(path);
  if (c) return { key: `c:${c[1]}`, section: c[2] && decodeURIComponent(c[2]) };
  const d = /^\/d\/([a-z0-9-]+)\/read(?:\/([^/]+))?$/.exec(path);
  if (d) return { key: `d:${d[1]}`, section: d[2] && decodeURIComponent(d[2]) };
  return null;
}

/** Scroll the page on screen to a section, if the address names the page already shown. True when it did. */
export function goToSection(key: string, section?: string): boolean {
  if (!current || current.key !== key) return false;
  current.go(section);
  return true;
}

/** The title for the window, or undefined when there is no such page. */
export function readingTitle(key: string): string | undefined {
  const [kind, id] = key.split(':');
  return kind === 'c' ? concept(id)?.title : walkthrough(id) ? `Walkthrough: ${designEntry(id)?.name ?? id}` : undefined;
}

/** Fixture pages, for previewing the renderer in development. Never in a production build. */
async function devFixture(id: string): Promise<Reading | undefined> {
  if (!import.meta.env.DEV) return undefined;
  const files = import.meta.glob<{ default: Reading }>('../reading/__fixtures__/*.ts');
  for (const load of Object.values(files)) {
    const m = await load().catch(() => undefined);
    if (m?.default?.id === id) return m.default;
  }
  return undefined;
}

export async function mountReading(host: HTMLElement, key: string, section?: string): Promise<() => void> {
  const [kind, id] = key.split(':');
  const page: Reading | undefined = kind === 'c' ? (concept(id) ?? (await devFixture(id))) : walkthrough(id);
  if (!page) {
    const lost = h('h1', { tabIndex: -1 }, 'No page at this address');
    const article = h('article', null, lost, h('p', null, kind === 'd' && designEntry(id) ? ['This design has no walkthrough yet. ', h('a', { href: `#/d/${id}` }, 'Open the interactive design'), '.'] : ['Pick a page from the list, or ', h('a', { href: '#/' }, 'go to the start'), '.']));
    host.append(article);
    lost.focus();
    return () => article.remove();
  }

  // Load every design the page draws a snapshot of before drawing anything.
  const wanted = new Set<string>();
  for (const s of page.sections) for (const b of s.blocks) if ('design' in b) wanted.add(b.design.id);
  if (kind === 'd') wanted.add(id);
  const designs = new Map<string, Design>();
  await Promise.all([...wanted].map(async (d) => {
    const e = DESIGNS.find((x) => x.id === d);
    if (e) designs.set(d, await e.load());
  }));
  // Words in the drawings are measured to wrap, so the font must be in before they are.
  await Promise.race([Promise.all([document.fonts.load(`700 15px ${FONT}`), document.fonts.load(`400 13px ${FONT}`)]), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);

  const base = kind === 'c' ? `#/c/${id}` : `#/d/${id}/read`;
  const entryD = kind === 'd' ? designEntry(id) : undefined;
  const kicker = kind === 'c' ? h('p.rd-kicker', null, 'System design patterns · ', (page as Concept).group) : h('p.rd-kicker', null, 'Walkthrough · ', entryD?.name ?? id);
  const words = page.sections.length === 1 ? '1 section' : `${page.sections.length} sections`;
  const head = h(
    'header.page-head.rd-head', null,
    kicker,
    h('h1', { tabIndex: -1 }, page.title),
    h('p.lede', null, inline(page.summary)),
    h('p.rd-meta', null, `${page.minutes} min read · ${words}`),
    kind === 'd' ? h('p.rd-actions', null, h('a.rd-action', { href: `#/d/${id}` }, 'Open the interactive design'), entryD?.extras ? h('a.rd-action', { href: `#/d/${id}/rehearse` }, 'Rehearse it') : null) : null,
  );

  const tocLinks = new Map<string, HTMLAnchorElement>();
  const tocList = h('ol', null, page.sections.map((s) => {
    const a = h('a', { href: `${base}/${encodeURIComponent(s.id)}` }, inline(s.title));
    tocLinks.set(s.id, a);
    return h('li', null, a);
  }));
  const toc = h('details.rd-toc-box', null, h('summary', null, 'Contents', h('span.rd-toc-count', null, ` · ${words}`)), tocList);
  // A page with design snapshots needs a wider column for them, so its contents sit beside the text only on a big screen.
  const hasDesign = page.sections.some((s) => s.blocks.some((b) => 'design' in b));
  const wide = matchMedia(hasDesign ? '(min-width: 1700px)' : '(min-width: 1360px)');
  const syncToc = () => {
    toc.open = wide.matches;
  };
  syncToc();
  wide.addEventListener('change', syncToc);
  const aside = h('nav.rd-toc', { 'aria-label': 'Contents' }, toc);

  const sectionEls = new Map<string, HTMLElement>();
  const body = h('div.rd-body', null);
  for (const s of page.sections) {
    const heading = h('h2', { tabIndex: -1 }, inline(s.title));
    const sec = h('section.rd-section', { id: `rd-${s.id}`, 'aria-label': plain(s.title) }, heading, s.blocks.map((b) => block(b, designs)));
    sectionEls.set(s.id, sec);
    body.append(sec);
  }
  if (page.unverified?.length) {
    body.append(
      h(
        'section.rd-unverified', { 'aria-labelledby': 'rd-unverified-h' },
        h('h2', { id: 'rd-unverified-h' }, 'Not checked against a source'),
        h('p', null, 'The writer could not check these against a source. Treat them as likely, not certain.'),
        h('ul', null, page.unverified.map((u) => h('li', null, inline(u)))),
      ),
    );
  }
  if (kind === 'd') body.append(h('p.rd-foot', null, h('a.rd-action', { href: `#/d/${id}` }, `Back to the interactive ${entryD?.name ?? 'design'}`)));

  const article = h(hasDesign ? 'article.rd.wide-figs' : 'article.rd', null, head, h('div.rd-layout', null, aside, body));
  host.append(article);

  // The contents list marks the section being read.
  let mark = '';
  const setMark = (sid: string) => {
    if (sid === mark) return;
    mark = sid;
    for (const [k, a] of tocLinks) {
      if (k === sid) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    }
  };
  const onScroll = () => {
    let at = page.sections[0]?.id ?? '';
    for (const [sid, sec] of sectionEls) if (sec.getBoundingClientRect().top < 140) at = sid;
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
  onScroll();

  const go = (sid?: string) => {
    const sec = sid ? sectionEls.get(sid) : undefined;
    if (!wide.matches) toc.open = false;
    if (!sec) {
      window.scrollTo(0, 0);
      return;
    }
    sec.scrollIntoView({ block: 'start' });
    sec.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    setMark(sid!);
  };
  if (section) requestAnimationFrame(() => go(section));
  const key0 = key;
  current = { key: key0, go };

  return () => {
    removeEventListener('scroll', scrolled);
    wide.removeEventListener('change', syncToc);
    cancelAnimationFrame(raf);
    if (current?.key === key0) current = null;
    article.remove();
  };
}
