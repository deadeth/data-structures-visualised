import { LABEL_LINE, LABEL_MAX, PROBE_FONT, PROBE_H, SUB_ROOM, TITLE_ROOM, fitScene, labelLines, neededHeight, nodeSpan, overflowsWidth, probeWidth, sceneBounds, type Fit } from './fit';
import { CELL_GAP, CELL_H, TRAY_PAD, cellCentre, cellWidth, circleRadius, nodeSize, slotX } from './geometry';
import { ease } from './timing';
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

export interface RendererOptions {
  /** Accessible name for the diagram. */
  label?: string;
  /**
   * Height of everything that must share the screen with the canvas on a
   * phone (readout, transport, margins), so the canvas is never planned
   * taller than the room left for it.
   */
  reserve?: () => number;
  /** Called when the canvas stops being a scroll region while it has focus. */
  onRegionLost?: () => void;
}

/** How long the scene takes to settle into a canvas that changed width because the layout changed. */
const RESIZE_MS = 240;

const REGION_LABEL = 'Diagram, wider than the view. Left and right arrows scroll it; Space still plays.';

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
  private span0: { x1: number; x2: number } | null = null;
  /** False while the planned frames have no probe at all (a resting picture): no room is kept above the nodes for one. */
  private probeRoom = true;
  private overflowing = false;
  private roRaf = 0;
  /** Sideways scroll tween, driven by the same clock and easing as the nodes and the chip. */
  private scrollFrom = 0;
  private scrollTo: number | null = null;
  private scrollSet = -1;
  /** True for the first frame shown after plan(): with nothing to follow, it is framed on the scene's centre. */
  private fresh = true;
  private onScroll = () => this.syncFades();
  /** Until this time, a change of canvas size glides the scene to its new fit instead of jumping (see easeNextResize). */
  private easeUntil = 0;

  constructor(private readonly host: HTMLElement, private readonly opts: RendererOptions = {}) {
    const label = opts.label ?? 'Animated diagram of the data structure';
    this.svg = el('svg', { role: 'img', 'aria-label': label }, 'scene');
    this.world = el('g');
    this.decorLayer = el('g', {}, 'decor');
    this.edgeLayer = el('g', {}, 'edges');
    this.nodeLayer = el('g', {}, 'nodes');
    this.probeG = el('g', {}, 'probe');
    this.probeRect = el('rect', { height: PROBE_H, rx: PROBE_H / 2, y: -PROBE_H / 2 });
    this.probeTip = el('path');
    this.probeText = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': PROBE_FONT });
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
    host.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize();
  }

  /**
   * The canvas is about to change size because the reader changed the layout
   * (Steps or Code beside it): glide the scene to its new fit over a short
   * tween rather than jumping. Instant under reduced motion.
   */
  easeNextResize(): void {
    this.easeUntil = performance.now() + 600;
  }

  /**
   * Where the chip is heading, in viewport px (top and bottom, tip included),
   * or null when no chip shows. Read after show(): it is the end of the tween.
   */
  probeTarget(): { top: number; bottom: number } | null {
    const p = this.probe;
    if (p.to <= 0) return this.markedTarget();
    const f = this.fitTo;
    const top0 = this.host.getBoundingClientRect().top + f.ty;
    const y = top0 + p.ty * f.s;
    const half = (PROBE_H / 2 + 7) * f.s;
    let top = y - half;
    let bottom = y + half;
    // The node the chip points at belongs with it: keep both in view.
    const at = this.last?.probe ? this.last.scene.nodes.find((n) => n.id === this.last!.probe!.at) : undefined;
    if (at) {
      const { h } = nodeSize(at);
      top = Math.min(top, top0 + (at.y - h / 2) * f.s);
      bottom = Math.max(bottom, top0 + (at.y + h / 2) * f.s);
    }
    return { top, bottom };
  }

  /**
   * With no chip showing, the nodes the frame marks (the key, the comparison,
   * the result), in viewport px, so a short screen can still keep them in view.
   */
  private markedTarget(): { top: number; bottom: number } | null {
    const frame = this.last;
    if (!frame) return null;
    const marked = (t: string | undefined) => t === 'key' || t === 'compare' || t === 'ok' || t === 'bad';
    let lo = Infinity, hi = -Infinity;
    for (const n of frame.scene.nodes) {
      if (!(marked(n.tone) || n.cells.some((c) => marked(c.tone)))) continue;
      const { h } = nodeSize(n);
      lo = Math.min(lo, n.y - h / 2);
      hi = Math.max(hi, n.y + h / 2);
    }
    if (!isFinite(lo)) return null;
    const f = this.fitTo;
    const top = this.host.getBoundingClientRect().top + f.ty;
    return { top: top + lo * f.s, bottom: top + hi * f.s };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.roRaf);
    this.ro?.disconnect();
    this.host.removeEventListener('scroll', this.onScroll);
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
    if (widthChanged && this.planned.length) {
      const resized = this.sizeCanvas();
      this.setRegion(this.planOverflows());
      if (resized) return;
    }
    if (this.last) {
      const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (performance.now() < this.easeUntil && !this.raf && this.hasFit && !calm) {
        this.easeUntil = 0;
        this.show(this.last, RESIZE_MS);
        return;
      }
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
    this.probeRoom = frames.some((f) => f.probe);
    // Centred on the nodes of the whole operation, so the view holds still between its steps.
    this.span0 = nodeSpan(frames.map((f) => f.scene));
    this.fresh = true;
    this.resetProbe();
    this.sizeCanvas();
    // Read the settled size now, so the first frame is fitted to it rather than to the old one.
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w >= 10 && h >= 10) {
      this.w = w;
      this.h = h;
    }
    this.setRegion(this.planOverflows());
  }

  /** Whether any frame of the operation is wider than the canvas. Decided once, so the canvas does not flip between steps. */
  private planOverflows(): boolean {
    // Measured without the scrollbar's height, which only exists once it overflows.
    const h = this.host.clientHeight + (this.overflowing ? this.host.offsetHeight - this.host.clientHeight : 0);
    return this.planned.some((f) => overflowsWidth(sceneBounds(f.scene, false, this.probeRoom), this.w, h));
  }

  /**
   * Make the canvas a named, focusable scroll region for the whole operation
   * when any of its frames overflows, and an ordinary box when none does.
   */
  private setRegion(over: boolean): void {
    if (over === this.overflowing) return;
    this.overflowing = over;
    const hadFocus = typeof document !== 'undefined' && document.activeElement === this.host;
    if (over) {
      this.host.setAttribute('tabindex', '0');
      this.host.setAttribute('role', 'region');
      this.host.setAttribute('aria-label', REGION_LABEL);
    } else {
      this.host.removeAttribute('tabindex');
      this.host.removeAttribute('role');
      this.host.removeAttribute('aria-label');
    }
    this.host.classList.toggle('overflowing', over);
    if (!over && hadFocus) this.opts.onRegionLost?.();
  }

  /** Set the canvas height for the planned frames. Returns true if it changed (a resize will follow). */
  private sizeCanvas(): boolean {
    const follow = typeof matchMedia !== 'undefined' && matchMedia(FOLLOW_QUERY).matches;
    const style = this.host.style;
    const before = `${style.height}|${style.minHeight}`;
    const w = this.host.clientWidth || this.w;
    const scenes = this.planned.map((f) => f.scene);
    if (follow) {
      // As tall as the content, but leave room on screen for the readout and the transport.
      const room = window.innerHeight - (this.opts.reserve?.() ?? 0);
      const maxH = Math.max(MIN_FOLLOW_H, Math.round(Math.min(window.innerHeight * 0.7, room)));
      style.minHeight = '';
      style.height = `${neededHeight(scenes, w, true, MIN_FOLLOW_H, maxH, this.probeRoom)}px`;
    } else {
      // Keep the canvas's own height, but never let it squeeze the scene below the minimum scale.
      style.height = '';
      const need = neededHeight(scenes, w, false, 0, Infinity, this.probeRoom);
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

  /** Give the SVG its drawn size. Wider than the canvas means it scrolls sideways. */
  private sizeSvg(f: Fit): void {
    // Within a pixel of the canvas counts as fitting: no scrollbar for a rounding error.
    const w = f.w > this.w + 1 ? f.w : this.w;
    const h = f.h > this.h + 1 ? f.h : this.h;
    this.svg.style.width = `${w}px`;
    this.svg.style.height = `${h}px`;
    this.svg.setAttribute('viewBox', `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  /** Fade whichever edge has more of the scene beyond it, so a scrolling canvas says so. */
  private syncFades(): void {
    const host = this.host;
    const left = host.scrollLeft;
    const more = host.scrollWidth - host.clientWidth;
    host.classList.toggle('more-left', more > 1 && left > 1);
    host.classList.toggle('more-right', more > 1 && left < more - 1);
  }

  /** Left and right edges, in canvas px of the drawn scene, of the nodes (or cells) whose tone passes the test. */
  private span(frame: Frame, test: (tone: string | undefined) => boolean, f: Fit): { lo: number; hi: number } | null {
    let lo = Infinity, hi = -Infinity;
    for (const n of frame.scene.nodes) {
      if (!(test(n.tone) || n.cells.some((c) => test(c.tone)))) continue;
      const w = nodeSize(n).w;
      lo = Math.min(lo, n.x - w / 2);
      hi = Math.max(hi, n.x + w / 2);
    }
    return isFinite(lo) ? { lo: f.tx + lo * f.s, hi: f.tx + hi * f.s } : null;
  }

  /**
   * Where the canvas should be scrolled to for this frame, or null to leave
   * it. The probe stays comfortably in view; when it hops to somewhere that
   * is out of view, and both ends of the hop fit in the view, the view centres
   * on the hop so it is seen whole. The last frame of an operation shows the
   * result (the nodes marked found or written). With nothing to follow, the
   * first frame of an operation is framed on the scene's centre.
   */
  private scrollTarget(frame: Frame, oldX: number | null, newX: number | null): number | null {
    const f = this.fitTo;
    const view = this.host.clientWidth;
    const maxLeft = Math.max(0, f.w - view);
    if (maxLeft <= 0) return 0;
    const left = this.host.scrollLeft;
    const margin = Math.min(120, view * 0.22);
    const clamp = (x: number) => Math.round(Math.max(0, Math.min(maxLeft, x)));
    const inView = (lo: number, hi: number, m: number) => lo >= left + m && hi <= left + view - m;

    const isLast = this.planned.length > 1 && frame === this.planned[this.planned.length - 1];
    if (isLast) {
      const ok = this.span(frame, (t) => t === 'ok', f);
      if (ok) {
        // The result and the chip together.
        let { lo, hi } = ok;
        if (newX != null) {
          lo = Math.min(lo, newX - 40);
          hi = Math.max(hi, newX + 40);
        }
        if (inView(lo, hi, 12)) return null;
        if (hi - lo <= view - 48) return clamp((lo + hi) / 2 - view / 2);
        // Too wide to see whole: from its start, as far as the chip allows (the chip never leaves the view).
        return clamp(newX == null ? lo - 24 : Math.max(lo - 24, newX + margin - view));
      }
    }
    if (newX != null) {
      // The node being compared comes into view with the chip when both fit.
      const cmp = this.span(frame, (t) => t === 'compare', f);
      if (cmp && !inView(cmp.lo, cmp.hi, 12)) {
        const lo = Math.min(cmp.lo, newX - 40);
        const hi = Math.max(cmp.hi, newX + 40);
        if (hi - lo <= view - 24) return clamp((lo + hi) / 2 - view / 2);
      }
      if (inView(newX, newX, margin)) return null;
      if (oldX != null && Math.abs(newX - oldX) <= view - margin * 2) return clamp((oldX + newX) / 2 - view / 2);
      return clamp(newX - view / 2);
    }
    const hot = this.span(frame, (t) => t === 'compare' || t === 'key' || t === 'ok' || t === 'bad', f);
    if (hot) {
      if (inView(hot.lo, hot.hi, Math.min(margin, 24))) return null;
      return clamp((hot.lo + hot.hi) / 2 - view / 2);
    }
    // Nothing to follow: frame the middle of the scene (the root, for a tree), but never so far
    // right that a note reading from the left starts out of view.
    if (!this.fresh) return null;
    let start = Infinity;
    for (const d of frame.scene.decor ?? []) if (d.type === 'label' && d.text && (d.anchor ?? 'start') === 'start') start = Math.min(start, f.tx + d.x * f.s);
    return clamp(Math.min((f.w - view) / 2, start - 16));
  }

  /**
   * Nudge a sideways scroll so no label (a caption, title, note or edge
   * label) is cut in half by the edge of the view, as long as the chip and
   * the nodes being compared stay in view. A label is either shown whole or
   * left wholly beyond the faded edge. Returns null when the view can stay.
   */
  private clearLabels(frame: Frame, target: number | null, newX: number | null): number | null {
    const f = this.fitTo;
    const view = this.host.clientWidth;
    const maxLeft = Math.max(0, f.w - view);
    const base = target ?? this.host.scrollLeft;
    if (maxLeft <= 0) return target;
    // Label size in CSS px: 14 scene units, never under 12 px (see the label styles).
    const charW = Math.max(12, 14 * f.s) * 0.56;
    const spans: [number, number][] = [];
    const add = (cx: number, text: string | undefined, anchor: 'start' | 'middle' | 'end' = 'middle') => {
      if (!text) return;
      const w = Math.max(...labelLines(text).map((l) => l.length)) * charW;
      const x = f.tx + cx * f.s;
      const a = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      spans.push([a, a + w]);
    };
    const at = new Map(frame.scene.nodes.map((n) => [n.id, n]));
    for (const n of frame.scene.nodes) {
      add(n.x, n.caption);
      add(n.x, n.title);
      // Each cell (and the index or value under it) counts too, so the edge falls between cells, not across one.
      const { w } = nodeSize(n);
      if (n.shape === 'circle' || n.cells.length <= 1) {
        const x = f.tx + (n.x - w / 2) * f.s;
        spans.push([x, x + w * f.s]);
      } else {
        n.cells.forEach((c, i) => {
          const cx = f.tx + (n.x - w / 2 + cellCentre(n.cells, i)) * f.s;
          const half = (cellWidth(c) / 2) * f.s;
          spans.push([cx - half, cx + half]);
        });
      }
    }
    for (const e of frame.scene.edges) {
      const a = at.get(e.from);
      const b = at.get(e.to);
      if (e.label && a && b) add((a.x + b.x) / 2, e.label);
    }
    for (const d of frame.scene.decor ?? []) if (d.type === 'label') add(d.x, d.text, d.anchor ?? 'start');
    if (!spans.length) return target;
    // What must stay in view: the chip, and the nodes being compared.
    const keep: [number, number][] = [];
    if (newX != null) keep.push([newX - 24, newX + 24]);
    const hot = this.span(frame, (t) => t === 'compare', f);
    if (hot) keep.push([hot.lo, hot.hi]);
    const cuts = (x: number) => spans.filter(([a, b]) => (a < x - 1 && b > x + 1) || (a < x + view - 1 && b > x + view + 1)).length;
    const keeps = (x: number) => keep.every(([a, b]) => a >= x + 4 && b <= x + view - 4);
    const clamp = (x: number) => Math.round(Math.max(0, Math.min(maxLeft, x)));
    let best = clamp(base);
    let bestCuts = cuts(best);
    if (bestCuts === 0) return target;
    const candidates = new Set<number>();
    for (const [a, b] of spans) {
      for (const x of [a - 10, b + 2, b + 10 - view, a - 2 - view]) candidates.add(clamp(x));
    }
    for (const x of candidates) {
      if (Math.abs(x - base) > view * 0.5 || !keeps(x)) continue;
      const c = cuts(x);
      if (c < bestCuts || (c === bestCuts && Math.abs(x - base) < Math.abs(best - base))) {
        best = x;
        bestCuts = c;
      }
    }
    return Math.abs(best - this.host.scrollLeft) < 1 && target == null ? null : best;
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
      // Ruled-out nodes are quiet through their own colours, not through opacity on top of them.
      live.tx = def.x; live.ty = def.y; live.to = 1;
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
      // Like nodes, a ruled-out edge is quiet through its colour (see .edge.tone-dim), so its label stays readable.
      live.to = 1;
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
    // Where the chip is now, in canvas px, before it is aimed at its new place.
    const p = this.probe;
    const oldX = p.shown && p.o > 0.5 ? this.fit.tx + p.x * this.fit.s : null;
    this.aimProbe(frame.probe);

    this.fitFrom = { ...this.fit };
    this.fitTo = this.computeFit(frame);
    if (!this.hasFit) {
      this.fitFrom = { ...this.fitTo };
      this.hasFit = true;
    }
    this.sizeSvg(this.fitTo);
    const newX = p.to > 0 ? this.fitTo.tx + p.tx * this.fitTo.s : null;
    const target = this.overflowing ? this.clearLabels(frame, this.scrollTarget(frame, oldX, newX), newX) : null;
    this.fresh = false;
    this.scrollFrom = this.host.scrollLeft;
    this.scrollTo = target != null && Math.abs(target - this.scrollFrom) >= 1 ? target : null;
    this.scrollSet = this.scrollFrom;

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
    this.scrollTo = null;
    this.syncFades();
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
    if (this.scrollTo != null) {
      // The reader took over (a swipe or the arrow keys): stop steering.
      if (Math.abs(this.host.scrollLeft - this.scrollSet) > 2) this.scrollTo = null;
      else {
        this.host.scrollLeft = lerp(this.scrollFrom, this.scrollTo, k);
        this.scrollSet = this.host.scrollLeft;
      }
    }
  }

  private applyFit(): void {
    const f = this.fit;
    this.world.setAttribute('transform', `translate(${f.tx.toFixed(2)},${f.ty.toFixed(2)}) scale(${f.s.toFixed(4)})`);
    // Labels grow as the scale falls so they never render under 12 CSS px (see .scene label styles).
    const s = Math.min(1, Math.max(0.5, f.s)).toFixed(3);
    if (this.svg.style.getPropertyValue('--s') !== s) this.svg.style.setProperty('--s', s);
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

    if (def.shape === 'tag') {
      // A named pointer: one style on every page, never a state colour or a hue.
      g.setAttribute('class', 'node pointer');
      g.append(el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 6 }, 'tag'));
      const t = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, 'tag-text');
      t.textContent = def.cells[0]?.text ?? '';
      g.append(t);
    } else if (def.shape === 'circle') {
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
        // An empty slot gets a light dashed outline (see .cell.empty).
        g.append(el('rect', { x, y: -CELL_H / 2, width: cw, height: CELL_H, rx: 6 }, `cell tone-${tone}${c.text === '' ? ' empty' : ''}`));
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
      const t = el('text', { y: -h / 2 - 7, 'text-anchor': 'middle' }, 'node-title');
      t.textContent = def.title;
      g.append(t);
    }
    if (def.caption) {
      // Hangs from just under the node or its subs, so a larger label grows downwards, away from them.
      const t = el('text', { y: below + 4, 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, 'node-caption');
      setLines(t, def.caption, 0);
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
    const w = probeWidth(probe.text);
    const place = probe.place ?? 'above';
    let x = def.x;
    let y = def.y;
    const cellX = probe.cell != null && def.shape !== 'circle' ? def.x - target.w / 2 + cellCentre(def.cells, probe.cell) : def.x;
    if (place === 'above') {
      x = cellX;
      y = def.y - target.h / 2 - PROBE_H / 2 - 9 - (def.title ? TITLE_ROOM : 0);
    } else if (place === 'below') {
      x = cellX;
      const hasSub = def.cells.some((c) => c.sub);
      const captionLines = labelLines(def.caption).length;
      y = def.y + target.h / 2 + PROBE_H / 2 + 9 + (hasSub ? SUB_ROOM : 0) + (captionLines ? LABEL_MAX + 4 + (captionLines - 1) * LABEL_LINE : 0);
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
        setLines(t, d.text, d.x);
        this.decorLayer.append(t);
      }
    }
  }

  // ---- fit ----------------------------------------------------------------

  private computeFit(frame: Frame): Fit {
    return fitScene(sceneBounds(frame.scene, false, this.probeRoom), this.w, this.h, this.span0, sceneBounds(frame.scene, true, this.probeRoom));
  }
}

/** Fill a text element with a label, one tspan per line where a newline breaks it. */
function setLines(t: SVGTextElement, text: string, x: number): void {
  const lines = labelLines(text);
  if (lines.length <= 1) {
    t.textContent = text;
    return;
  }
  lines.forEach((line, i) => {
    const span = el('tspan', { x, dy: i === 0 ? 0 : '1.25em' });
    span.textContent = line;
    t.append(span);
  });
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
