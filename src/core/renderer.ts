import { PROBE_H, fitScene, neededHeight, sceneBounds, type Fit } from './fit';
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

/** Below this width the canvas takes the height of its content instead of a fixed height. */
const FOLLOW_QUERY = '(max-width: 899px)';
const MIN_FOLLOW_H = 220;

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  private fit: Fit = { s: 1, tx: 0, ty: 0, w: 0, h: 0 };
  private fitFrom: Fit = { s: 1, tx: 0, ty: 0, w: 0, h: 0 };
  private fitTo: Fit = { s: 1, tx: 0, ty: 0, w: 0, h: 0 };
  private hasFit = false;
  private decorSig = '';
  private raf = 0;
  private t0 = 0;
  private dur = 0;
  private w = 800;
  private h = 420;
  private last: Frame | null = null;
  private ro: ResizeObserver | null = null;
  /** The frames of the current operation, used to size the canvas once for all of them. */
  private planned: Frame[] = [];
  private overflowing = false;
  private roRaf = 0;

  constructor(private readonly host: HTMLElement, label = 'Animated diagram of the data structure') {
    this.svg = el('svg', { role: 'img', 'aria-label': label }, 'scene');
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
      // Deferred a frame: resizing can change the canvas height, which must not happen inside the observer.
      this.ro = new ResizeObserver(() => {
        cancelAnimationFrame(this.roRaf);
        this.roRaf = requestAnimationFrame(() => this.resize());
      });
      this.ro.observe(host);
    }
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.roRaf);
    this.ro?.disconnect();
    this.svg.remove();
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w < 10 || h < 10) return;
    const widthChanged = Math.abs(w - this.w) > 0.5;
    this.w = w;
    this.h = h;
    // The height an operation needs depends on the width, so re-plan when the width changes.
    if (widthChanged && this.planned.length && this.sizeCanvas()) return;
    if (this.last) {
      this.fitTo = this.computeFit(this.last);
      this.sizeSvg(this.fitTo);
      if (!this.raf) {
        this.fit = { ...this.fitTo };
        this.applyFit();
      }
    } else {
      this.sizeSvg({ s: 1, tx: 0, ty: 0, w, h });
    }
  }

  /**
   * Tell the renderer which frames are coming, so the canvas height can be
   * settled once for the whole operation rather than jumping between steps.
   * Also hides the probe chip, so it drops in fresh instead of flying over from
   * where the last operation left it.
   */
  plan(frames: Frame[]): void {
    this.planned = frames;
    this.resetProbe();
    this.sizeCanvas();
    // Read the settled size now, so the first frame is fitted to it rather than to the old one.
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w >= 10 && h >= 10) {
      this.w = w;
      this.h = h;
    }
  }

  /** Set the canvas height for the planned frames. Returns true if it changed (a resize will follow). */
  private sizeCanvas(): boolean {
    const follow = typeof matchMedia !== 'undefined' && matchMedia(FOLLOW_QUERY).matches;
    const style = this.host.style;
    const before = `${style.height}|${style.minHeight}`;
    const w = this.host.clientWidth || this.w;
    const scenes = this.planned.map((f) => f.scene);
    if (follow) {
      const maxH = Math.max(MIN_FOLLOW_H, Math.round(window.innerHeight * 0.7));
      style.minHeight = '';
      style.height = `${neededHeight(scenes, w, true, MIN_FOLLOW_H, maxH)}px`;
    } else {
      // Keep the canvas's own height, but never let it squeeze the scene below the minimum scale.
      style.height = '';
      const need = neededHeight(scenes, w, false, 0, Infinity);
      style.minHeight = need > 0 ? `${need}px` : '';
    }
    return before !== `${style.height}|${style.minHeight}`;
  }

  private resetProbe(): void {
    const p = this.probe;
    p.shown = false;
    p.o = p.fo = p.to = 0;
    this.probeG.style.opacity = '0';
  }

  /** Give the SVG its drawn size, and make the canvas a named, focusable scroll region when it overflows. */
  private sizeSvg(f: Fit): void {
    // Within a pixel of the canvas counts as fitting: no scrollbar for a rounding error.
    const w = f.w > this.w + 1 ? f.w : this.w;
    const h = this.h;
    this.svg.style.width = `${w}px`;
    this.svg.style.height = `${h}px`;
    this.svg.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
    const over = w > this.w + 1;
    if (over !== this.overflowing) {
      this.overflowing = over;
      if (over) {
        this.host.setAttribute('tabindex', '0');
        this.host.setAttribute('role', 'region');
        this.host.setAttribute('aria-label', 'Diagram, wider than the screen. Scroll sideways to see all of it.');
      } else {
        this.host.removeAttribute('tabindex');
        this.host.removeAttribute('role');
        this.host.removeAttribute('aria-label');
      }
      this.host.classList.toggle('overflowing', over);
    }
  }

  /**
   * When the scene is wider than the canvas, scroll so that the probe (or,
   * without one, whatever is highlighted) sits comfortably in view.
   */
  private follow(frame: Frame): void {
    if (!this.overflowing) return;
    const f = this.fitTo;
    let focusX: number | null = null;
    const probe = frame.probe ? frame.scene.nodes.find((n) => n.id === frame.probe!.at) : undefined;
    if (probe) {
      focusX = probe.cells.length > 1 && frame.probe!.cell != null && probe.shape !== 'circle'
        ? probe.x - nodeSize(probe).w / 2 + cellCentre(probe.cells, frame.probe!.cell)
        : probe.x;
    } else {
      const hot = new Set(['compare', 'key', 'ok', 'bad']);
      let lo = Infinity, hi = -Infinity;
      for (const n of frame.scene.nodes) {
        if (!(hot.has(n.tone ?? '') || n.cells.some((c) => hot.has(c.tone ?? '')))) continue;
        const w = nodeSize(n).w;
        lo = Math.min(lo, n.x - w / 2);
        hi = Math.max(hi, n.x + w / 2);
      }
      if (isFinite(lo)) focusX = (lo + hi) / 2;
    }
    if (focusX == null) return;
    const x = f.tx + focusX * f.s;
    const view = this.host.clientWidth;
    const left = this.host.scrollLeft;
    const margin = Math.min(120, view * 0.22);
    if (x >= left + margin && x <= left + view - margin) return;
    const target = Math.max(0, Math.min(f.w - view, x - view / 2));
    this.host.scrollTo({ left: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
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
    this.sizeSvg(this.fitTo);
    this.follow(frame);

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
      w: this.fitTo.w,
      h: this.fitTo.h,
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
        const s = el('text', { 'text-anchor': 'middle', y: r + 16 }, `cell-sub${c.subValue ? ' value' : ''}`);
        s.textContent = c.sub;
        g.append(s);
        below = r + 20;
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
          const s = el('text', { x: x + cw / 2, y: h / 2 + 16, 'text-anchor': 'middle' }, `cell-sub${c.subValue ? ' value' : ''}`);
          s.textContent = c.sub;
          g.append(s);
        }
        x += cw + CELL_GAP;
      }
      if (anySub) below = h / 2 + 20;
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
      y = def.y + target.h / 2 + PROBE_H / 2 + 9 + (hasSub ? 20 : 0) + (def.caption ? 16 : 0);
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
    return fitScene(sceneBounds(frame.scene), this.w, this.h);
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
