import { CELL_GAP, CELL_H, TRAY_PAD, cellCentre, cellWidth, circleRadius, nodeSize, slotX, CHAR_W } from './geometry';
import type { Decor, Frame, Probe, SceneEdge, SceneNode } from './types';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (cls) e.setAttribute('class', cls);
  return e;
}

interface Tween {
  x: number; y: number; o: number;
  fx: number; fy: number; fo: number;
  tx: number; ty: number; to: number;
}

interface LiveNode extends Tween {
  def: SceneNode;
  g: SVGGElement;
  sig: string;
  w: number;
  h: number;
  leaving: boolean;
}

interface LiveEdge {
  def: SceneEdge;
  g: SVGGElement;
  line: SVGPathElement;
  head: SVGPathElement;
  label: SVGTextElement | null;
  o: number; fo: number; to: number;
  leaving: boolean;
}

interface Fit { s: number; tx: number; ty: number }

const PROBE_H = 26;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Draws frames into an SVG and tweens between them.
 *
 * Nodes are matched by id from one frame to the next, so a node that changes
 * position slides there, a new node grows out of its `from` node, and a
 * removed node fades. Edges are recomputed from the live node positions on
 * every tick, so they stay attached while things move.
 */
export class Renderer {
  readonly svg: SVGSVGElement;
  private world: SVGGElement;
  private decorLayer: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private probeG: SVGGElement;
  private probeRect: SVGRectElement;
  private probeText: SVGTextElement;
  private probeTip: SVGPathElement;

  private nodes = new Map<string, LiveNode>();
  private edges = new Map<string, LiveEdge>();
  private probe: Tween & { text: string; place: NonNullable<Probe['place']>; shown: boolean } = {
    x: 0, y: 0, o: 0, fx: 0, fy: 0, fo: 0, tx: 0, ty: 0, to: 0, text: '', place: 'above', shown: false,
  };
  private fit: Fit = { s: 1, tx: 0, ty: 0 };
  private fitFrom: Fit = { s: 1, tx: 0, ty: 0 };
  private fitTo: Fit = { s: 1, tx: 0, ty: 0 };
  private hasFit = false;
  private decorSig = '';
  private raf = 0;
  private t0 = 0;
  private dur = 0;
  private w = 800;
  private h = 420;
  private last: Frame | null = null;
  private ro: ResizeObserver | null = null;

  constructor(host: HTMLElement) {
    this.svg = el('svg', { role: 'img', 'aria-label': 'Animated diagram of the data structure' }, 'scene');
    this.world = el('g');
    this.decorLayer = el('g', {}, 'decor');
    this.edgeLayer = el('g', {}, 'edges');
    this.nodeLayer = el('g', {}, 'nodes');
    this.probeG = el('g', {}, 'probe');
    this.probeRect = el('rect', { height: PROBE_H, rx: PROBE_H / 2, y: -PROBE_H / 2 });
    this.probeTip = el('path');
    this.probeText = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    this.probeG.append(this.probeTip, this.probeRect, this.probeText);
    this.probeG.style.opacity = '0';
    this.world.append(this.decorLayer, this.edgeLayer, this.nodeLayer, this.probeG);
    this.svg.append(this.world);
    host.append(this.svg);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.svg.remove();
  }

  private resize(): void {
    const r = this.svg.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    this.w = r.width;
    this.h = r.height;
    this.svg.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    if (this.last) {
      this.fitTo = this.computeFit(this.last);
      if (!this.raf) {
        this.fit = { ...this.fitTo };
        this.applyFit();
      }
    }
  }

  /** Show a frame, taking `ms` to get there. Zero jumps straight to it. */
  show(frame: Frame, ms: number): void {
    this.last = frame;
    const scene = frame.scene;
    const seen = new Set<string>();

    for (const def of scene.nodes) {
      seen.add(def.id);
      let live = this.nodes.get(def.id);
      if (!live) {
        const origin = def.from ? this.nodes.get(def.from) : undefined;
        const g = el('g', {}, 'node');
        this.nodeLayer.append(g);
        const x = origin ? origin.x : def.x;
        const y = origin ? origin.y : def.y;
        live = { def, g, sig: '', w: 0, h: 0, leaving: false, x, y, o: 0, fx: x, fy: y, fo: 0, tx: def.x, ty: def.y, to: 1 };
        this.nodes.set(def.id, live);
      }
      live.def = def;
      live.leaving = false;
      live.fx = live.x; live.fy = live.y; live.fo = live.o;
      live.tx = def.x; live.ty = def.y; live.to = def.tone === 'dim' ? 0.45 : 1;
      this.paintNode(live);
    }
    for (const [id, live] of this.nodes) {
      if (seen.has(id)) continue;
      live.leaving = true;
      live.fx = live.x; live.fy = live.y; live.fo = live.o;
      live.tx = live.x; live.ty = live.y; live.to = 0;
    }

    const seenEdges = new Set<string>();
    for (const def of scene.edges) {
      seenEdges.add(def.id);
      let live = this.edges.get(def.id);
      if (!live) {
        const g = el('g', {}, 'edge');
        const line = el('path', { fill: 'none' }, 'edge-line');
        const head = el('path', {}, 'edge-head');
        g.append(line, head);
        this.edgeLayer.append(g);
        live = { def, g, line, head, label: null, o: 0, fo: 0, to: 1, leaving: false };
        this.edges.set(def.id, live);
      }
      live.def = def;
      live.leaving = false;
      live.fo = live.o;
      live.to = def.tone === 'dim' ? 0.3 : 1;
      live.g.setAttribute('class', `edge tone-${def.tone ?? 'idle'}${def.dashed ? ' dashed' : ''}`);
      if (def.label != null) {
        if (!live.label) {
          live.label = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, 'edge-label');
          live.g.append(live.label);
        }
        live.label.textContent = def.label;
      } else if (live.label) {
        live.label.remove();
        live.label = null;
      }
    }
    for (const [id, live] of this.edges) {
      if (seenEdges.has(id)) continue;
      live.leaving = true;
      live.fo = live.o;
      live.to = 0;
    }

    this.paintDecor(scene.decor ?? []);
    this.aimProbe(frame.probe);

    this.fitFrom = { ...this.fit };
    this.fitTo = this.computeFit(frame);
    if (!this.hasFit) {
      this.fitFrom = { ...this.fitTo };
      this.hasFit = true;
    }

    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dur = ms;
    if (ms <= 0) {
      this.apply(1);
      this.settle();
      return;
    }
    this.t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - this.t0) / this.dur);
      this.apply(ease(t));
      if (t < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.raf = 0;
        this.settle();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private settle(): void {
    for (const [id, live] of this.nodes) {
      if (live.leaving) {
        live.g.remove();
        this.nodes.delete(id);
      }
    }
    for (const [id, live] of this.edges) {
      if (live.leaving) {
        live.g.remove();
        this.edges.delete(id);
      }
    }
  }

  private apply(k: number): void {
    for (const n of this.nodes.values()) {
      n.x = lerp(n.fx, n.tx, k);
      n.y = lerp(n.fy, n.ty, k);
      n.o = lerp(n.fo, n.to, k);
      n.g.setAttribute('transform', `translate(${n.x.toFixed(2)},${n.y.toFixed(2)})`);
      n.g.style.opacity = n.o.toFixed(3);
    }
    for (const e of this.edges.values()) {
      e.o = lerp(e.fo, e.to, k);
      this.paintEdge(e);
    }
    const p = this.probe;
    p.x = lerp(p.fx, p.tx, k);
    p.y = lerp(p.fy, p.ty, k);
    p.o = lerp(p.fo, p.to, k);
    this.probeG.setAttribute('transform', `translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`);
    this.probeG.style.opacity = p.o.toFixed(3);
    this.fit = {
      s: lerp(this.fitFrom.s, this.fitTo.s, k),
      tx: lerp(this.fitFrom.tx, this.fitTo.tx, k),
      ty: lerp(this.fitFrom.ty, this.fitTo.ty, k),
    };
    this.applyFit();
  }

  private applyFit(): void {
    const f = this.fit;
    this.world.setAttribute('transform', `translate(${f.tx.toFixed(2)},${f.ty.toFixed(2)}) scale(${f.s.toFixed(4)})`);
  }

  // ---- nodes --------------------------------------------------------------

  private paintNode(live: LiveNode): void {
    const def = live.def;
    const size = nodeSize(def);
    live.w = size.w;
    live.h = size.h;
    const sig = JSON.stringify([def.cells, def.shape, def.tone, def.hue, def.title, def.caption, def.r]);
    if (sig === live.sig) return;
    live.sig = sig;
    const g = live.g;
    g.replaceChildren();
    const hue = def.hue != null ? ` hue-${def.hue % 6}` : '';
    g.setAttribute('class', `node${hue}`);
    const { w, h } = size;
    let below = h / 2;

    if (def.shape === 'circle') {
      const r = circleRadius(def);
      const c = def.cells[0] ?? { text: '' };
      const tone = c.tone ?? def.tone ?? 'idle';
      g.append(el('circle', { r }, `cell tone-${tone}`));
      const t = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, `cell-text tone-${tone}`);
      t.textContent = c.text;
      g.append(t);
      if (c.sub) {
        const s = el('text', { 'text-anchor': 'middle', y: r + 13 }, 'cell-sub');
        s.textContent = c.sub;
        g.append(s);
        below = r + 18;
      }
    } else {
      const multi = def.cells.length > 1;
      if (multi) g.append(el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 9 }, `tray tone-${def.tone ?? 'idle'}`));
      let x = -w / 2 + (multi ? TRAY_PAD : 0);
      let anySub = false;
      const cells = def.cells.length ? def.cells : [{ text: '' }];
      for (const c of cells) {
        const cw = cellWidth(c);
        const tone = c.tone ?? (multi ? 'idle' : def.tone ?? 'idle');
        g.append(el('rect', { x, y: -CELL_H / 2, width: cw, height: CELL_H, rx: 6 }, `cell tone-${tone}`));
        const t = el('text', { x: x + cw / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, `cell-text tone-${tone}`);
        t.textContent = c.text;
        g.append(t);
        if (c.sub) {
          anySub = true;
          const s = el('text', { x: x + cw / 2, y: h / 2 + 13, 'text-anchor': 'middle' }, 'cell-sub');
          s.textContent = c.sub;
          g.append(s);
        }
        x += cw + CELL_GAP;
      }
      if (anySub) below = h / 2 + 18;
    }
    if (def.title) {
      const t = el('text', { y: -h / 2 - 8, 'text-anchor': 'middle' }, 'node-title');
      t.textContent = def.title;
      g.append(t);
    }
    if (def.caption) {
      const t = el('text', { y: below + 14, 'text-anchor': 'middle' }, 'node-caption');
      t.textContent = def.caption;
      g.append(t);
    }
  }

  // ---- edges --------------------------------------------------------------

  private paintEdge(e: LiveEdge): void {
    const a = this.nodes.get(e.def.from);
    const b = this.nodes.get(e.def.to);
    if (!a || !b) {
      e.g.style.opacity = '0';
      return;
    }
    e.g.style.opacity = Math.min(e.o, a.o, b.o).toFixed(3);
    const d = e.def;
    let x1: number, y1: number, x2: number, y2: number;
    const kind = d.kind ?? 'tree';
    if (kind === 'tree') {
      const down = b.y >= a.y;
      x1 = a.x;
      if (d.fromSlot != null) x1 = a.x - a.w / 2 + slotX(a.def.cells, d.fromSlot);
      else if (d.fromCell != null) x1 = a.x - a.w / 2 + cellCentre(a.def.cells, d.fromCell);
      y1 = a.y + (down ? a.h / 2 : -a.h / 2);
      x2 = d.toCell != null ? b.x - b.w / 2 + cellCentre(b.def.cells, d.toCell) : b.x;
      y2 = b.y + (down ? -b.h / 2 - 2 : b.h / 2 + 2);
    } else if (kind === 'side') {
      const right = b.x >= a.x;
      const off = d.offset ?? 0;
      x1 = a.x + (right ? a.w / 2 : -a.w / 2);
      y1 = a.y + off;
      x2 = b.x + (right ? -b.w / 2 - 2 : b.w / 2 + 2);
      y2 = b.y + off;
    } else {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const off = d.offset ?? 0;
      const ox = -uy * off;
      const oy = ux * off;
      const ca = clip(a, ux, uy);
      const cb = clip(b, -ux, -uy);
      x1 = a.x + ux * ca + ox;
      y1 = a.y + uy * ca + oy;
      x2 = b.x - ux * (cb + 2) + ox;
      y2 = b.y - uy * (cb + 2) + oy;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    if (d.arrow) {
      const s = 7;
      const bx = x2 - ux * s;
      const by = y2 - uy * s;
      e.head.setAttribute('d', `M${x2.toFixed(1)},${y2.toFixed(1)} L${(bx - uy * s * 0.5).toFixed(1)},${(by + ux * s * 0.5).toFixed(1)} L${(bx + uy * s * 0.5).toFixed(1)},${(by - ux * s * 0.5).toFixed(1)} Z`);
      e.line.setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)} L${(x2 - ux * s * 0.8).toFixed(1)},${(y2 - uy * s * 0.8).toFixed(1)}`);
    } else {
      e.head.setAttribute('d', '');
      e.line.setAttribute('d', `M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`);
    }
    if (e.label) {
      e.label.setAttribute('x', ((x1 + x2) / 2 - uy * 11).toFixed(1));
      e.label.setAttribute('y', ((y1 + y2) / 2 + ux * 11).toFixed(1));
    }
  }

  // ---- probe --------------------------------------------------------------

  private aimProbe(probe: Probe | undefined): void {
    const p = this.probe;
    p.fx = p.x; p.fy = p.y; p.fo = p.o;
    const target = probe ? this.nodes.get(probe.at) : undefined;
    if (!probe || !target) {
      p.to = 0;
      p.tx = p.x; p.ty = p.y;
      p.shown = false;
      return;
    }
    const def = target.def;
    const w = Math.max(34, probe.text.length * CHAR_W + 20);
    const place = probe.place ?? 'above';
    let x = def.x;
    let y = def.y;
    const cellX = probe.cell != null && def.shape !== 'circle' ? def.x - target.w / 2 + cellCentre(def.cells, probe.cell) : def.x;
    if (place === 'above') {
      x = cellX;
      y = def.y - target.h / 2 - PROBE_H / 2 - 9 - (def.title ? 16 : 0);
    } else if (place === 'below') {
      x = cellX;
      const hasSub = def.cells.some((c) => c.sub);
      y = def.y + target.h / 2 + PROBE_H / 2 + 9 + (hasSub ? 18 : 0) + (def.caption ? 16 : 0);
    } else if (place === 'left') {
      x = def.x - target.w / 2 - w / 2 - 10;
    } else {
      x = def.x + target.w / 2 + w / 2 + 10;
    }
    p.tx = x; p.ty = y; p.to = 1;
    if (!p.shown) {
      // First appearance: drop in from just outside its resting place rather than flying across the canvas.
      p.fx = x; p.fy = y - (place === 'below' ? -14 : 14);
      p.x = p.fx; p.y = p.fy;
    }
    p.shown = true;
    p.text = probe.text;
    p.place = place;
    this.probeRect.setAttribute('x', String(-w / 2));
    this.probeRect.setAttribute('width', String(w));
    this.probeText.textContent = probe.text;
    const tip =
      place === 'above' ? `M-5,${PROBE_H / 2 - 1} L5,${PROBE_H / 2 - 1} L0,${PROBE_H / 2 + 6} Z`
      : place === 'below' ? `M-5,${-PROBE_H / 2 + 1} L5,${-PROBE_H / 2 + 1} L0,${-PROBE_H / 2 - 6} Z`
      : place === 'left' ? `M${w / 2 - 1},-5 L${w / 2 - 1},5 L${w / 2 + 6},0 Z`
      : `M${-w / 2 + 1},-5 L${-w / 2 + 1},5 L${-w / 2 - 6},0 Z`;
    this.probeTip.setAttribute('d', tip);
  }

  // ---- decor --------------------------------------------------------------

  private paintDecor(decor: Decor[]): void {
    const sig = JSON.stringify(decor);
    if (sig === this.decorSig) return;
    this.decorSig = sig;
    this.decorLayer.replaceChildren();
    for (const d of decor) {
      if (d.type === 'ring') {
        this.decorLayer.append(el('circle', { cx: d.cx, cy: d.cy, r: d.r, fill: 'none' }, 'decor-ring'));
      } else if (d.type === 'band') {
        this.decorLayer.append(el('rect', { x: d.x, y: d.y, width: d.w, height: d.h, rx: 10 }, 'decor-band'));
        if (d.label) {
          const t = el('text', { x: d.x + 12, y: d.y + 18 }, 'decor-label');
          t.textContent = d.label;
          this.decorLayer.append(t);
        }
      } else {
        const t = el('text', { x: d.x, y: d.y, 'text-anchor': d.anchor ?? 'start', 'dominant-baseline': 'central' }, `decor-label${d.strong ? ' strong' : ''}`);
        t.textContent = d.text;
        this.decorLayer.append(t);
      }
    }
  }

  // ---- fit ----------------------------------------------------------------

  private computeFit(frame: Frame): Fit {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x1: number, y1: number, x2: number, y2: number) => {
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    };
    for (const n of frame.scene.nodes) {
      const { w, h } = nodeSize(n);
      const extraBelow = (n.cells.some((c) => c.sub) ? 18 : 0) + (n.caption ? 18 : 0);
      // Always leave room above for the probe chip so the view does not jump when it arrives.
      grow(n.x - w / 2, n.y - h / 2 - PROBE_H - 16 - (n.title ? 16 : 0), n.x + w / 2, n.y + h / 2 + extraBelow);
    }
    for (const d of frame.scene.decor ?? []) {
      if (d.type === 'ring') grow(d.cx - d.r, d.cy - d.r, d.cx + d.r, d.cy + d.r);
      else if (d.type === 'band') grow(d.x, d.y, d.x + d.w, d.y + d.h);
      else {
        const tw = d.text.length * 7.5;
        const x1 = d.anchor === 'end' ? d.x - tw : d.anchor === 'middle' ? d.x - tw / 2 : d.x;
        grow(x1, d.y - 9, x1 + tw, d.y + 9);
      }
    }
    if (!isFinite(minX)) return { s: 1, tx: this.w / 2, ty: this.h / 2 };
    const pad = 26;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const s = Math.min(1.25, (this.w - pad * 2) / bw, (this.h - pad * 2) / bh);
    return {
      s,
      tx: (this.w - bw * s) / 2 - minX * s,
      ty: (this.h - bh * s) / 2 - minY * s,
    };
  }
}

/** Distance from a node's centre to its outline along a unit direction. */
function clip(n: LiveNode, ux: number, uy: number): number {
  if (n.def.shape === 'circle') return circleRadius(n.def);
  const hx = n.w / 2;
  const hy = n.h / 2;
  const tx = Math.abs(ux) < 1e-6 ? Infinity : hx / Math.abs(ux);
  const ty = Math.abs(uy) < 1e-6 ? Infinity : hy / Math.abs(uy);
  return Math.min(tx, ty);
}
