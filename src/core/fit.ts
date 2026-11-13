import { nodeSize } from './geometry';
import type { Scene } from './types';

/**
 * How a scene is scaled into the canvas. Pure functions, so the rules can be
 * tested without a browser.
 *
 * Cell text is 16px in scene units. Below MIN_SCALE it would render under
 * 12 CSS px, which is too small to read, so the scale never goes lower than
 * that across the width: a scene that is still too wide makes the canvas
 * scroll sideways instead.
 */
export const MIN_SCALE = 0.75;
export const MAX_SCALE = 1.25;
/** On a canvas at least this wide (a large monitor), a scene may grow further. */
export const WIDE_CANVAS = 1000;
export const MAX_SCALE_WIDE = 1.7;
/** Clear space around the scene inside the canvas, in CSS px. */
export const FIT_PAD = 26;
/** Room for a horizontal scrollbar when the scene overflows. */
export const SCROLLBAR_ALLOWANCE = 16;
/** Chip height, and the room always kept above a node for it. */
export const PROBE_H = 28;
/** Probe chip text, in scene units: never smaller than cell text (16). */
export const PROBE_FONT = 17;
/** Advance of one character of the chip's mono face at PROBE_FONT. */
export const PROBE_CHAR_W = 10.6;
/** Drawn width of the probe chip for this text. */
export function probeWidth(text: string): number {
  return Math.max(36, text.length * PROBE_CHAR_W + 20);
}
/**
 * Labels (titles, captions, subs, decor and edge labels) are 14px in scene
 * units, but grow as the scale falls so they never render under 12 CSS px:
 * at MIN_SCALE they are 16. Room around nodes is kept for that largest size.
 */
export const LABEL_MAX = 12 / MIN_SCALE;
/** Room a title takes above its node, and a sub label or caption below it. */
export const TITLE_ROOM = LABEL_MAX + 4;
export const SUB_ROOM = LABEL_MAX + 6;
export const CAPTION_ROOM = LABEL_MAX + 4;
/** Distance between the lines of a label broken with a newline (1.25em at the largest label size). */
export const LABEL_LINE = LABEL_MAX * 1.25;
/** Rough advance of one character of the label face at its largest size, for keeping labels inside the view. */
export const LABEL_CHAR_W = LABEL_MAX * 0.55;

/** Lines in a label: a newline breaks it. */
export const labelLines = (text: string | undefined): string[] => (text ? text.split('\n') : []);
/** Rough drawn width of a label's longest line at the largest label size. */
export const labelWidth = (text: string | undefined): number => Math.max(0, ...labelLines(text).map((l) => l.length * LABEL_CHAR_W));

export interface Bounds { minX: number; minY: number; bw: number; bh: number }

export interface Fit {
  s: number;
  tx: number;
  ty: number;
  /** Drawn size of the scene's box in CSS px: at least the canvas, wider when the scene has to scroll. */
  w: number;
  h: number;
}

/**
 * The box a scene occupies, including room for the probe chip, titles, subs
 * and captions. Pass `probeRoom` false for a picture no chip will visit (the
 * resting picture between operations), so it is not kept room it never uses.
 */
export function sceneBounds(scene: Scene, drawnOnly = false, probeRoom = true): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  };
  const at = new Map<string, { x: number; y: number }>();
  for (const n of scene.nodes) {
    const { w, h } = nodeSize(n);
    at.set(n.id, n);
    const captionLines = labelLines(n.caption).length;
    const extraBelow = (n.cells.some((c) => c.sub) ? SUB_ROOM : 0) + (captionLines ? CAPTION_ROOM + (captionLines - 1) * LABEL_LINE : 0);
    // Titles and captions can be wider than their node: keep them inside the view too.
    const half = Math.max(w, labelWidth(n.title), labelWidth(n.caption)) / 2;
    // Always leave room above for the probe chip so the view does not jump when it arrives.
    grow(n.x - half, n.y - h / 2 - (probeRoom ? PROBE_H + 16 : 0) - (n.title ? TITLE_ROOM : 0), n.x + half, n.y + h / 2 + extraBelow);
  }
  for (const e of scene.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!e.label || !a || !b) continue;
    const half = labelWidth(e.label) / 2 + 12;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    grow(mx - half, my - LABEL_MAX - 12, mx + half, my + LABEL_MAX + 12);
  }
  for (const d of scene.decor ?? []) {
    // Empty labels only pin the scene's size; with drawnOnly they are left out.
    if (drawnOnly && d.type === 'label' && !d.text) continue;
    if (d.type === 'ring') grow(d.cx - d.r, d.cy - d.r, d.cx + d.r, d.cy + d.r);
    else if (d.type === 'band') grow(d.x, d.y, d.x + d.w, d.y + d.h);
    else {
      // Roughly the advance of the label face at its largest size.
      const tw = labelWidth(d.text);
      const x1 = d.anchor === 'end' ? d.x - tw : d.anchor === 'middle' ? d.x - tw / 2 : d.x;
      const lines = Math.max(1, labelLines(d.text).length);
      grow(x1, d.y - LABEL_MAX * 0.65, x1 + tw, d.y + (lines - 1) * LABEL_LINE + LABEL_MAX * 0.65);
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, bw: Math.max(1, maxX - minX), bh: Math.max(1, maxY - minY) };
}

/** Scale to use across the width alone: as large as fits, but never below MIN_SCALE. */
export function widthScale(b: Bounds, canvasW: number): number {
  // A canvas on a large monitor has room to draw the scene bigger than on a laptop.
  const cap = canvasW >= WIDE_CANVAS ? MAX_SCALE_WIDE : MAX_SCALE;
  return Math.min(cap, Math.max(MIN_SCALE, (canvasW - FIT_PAD * 2) / b.bw));
}

/**
 * Fit a scene into a canvas. Neither the width nor the height may take the
 * scale below MIN_SCALE: a scene too wide at that scale makes `w` grow past
 * the canvas width (the canvas scrolls sideways), and one too tall makes `h`
 * grow past the canvas height (the caller should make the canvas that tall;
 * see neededHeight).
 */
export function fitScene(b: Bounds | null, canvasW: number, canvasH: number, focus?: { x1: number; x2: number } | null, drawn?: Bounds | null): Fit {
  if (!b) return { s: 1, tx: canvasW / 2, ty: canvasH / 2, w: canvasW, h: canvasH };
  const s = Math.max(MIN_SCALE, Math.min(widthScale(b, canvasW), (canvasH - FIT_PAD * 2) / b.bh));
  const w = Math.max(canvasW, Math.ceil(b.bw * s + FIT_PAD * 2));
  const h = Math.max(canvasH, Math.ceil(b.bh * s + FIT_PAD * 2));
  let tx = (w - b.bw * s) / 2 - b.minX * s;
  // When the scene fits, centre what is drawn (the nodes) rather than the room kept around them,
  // as far as the whole scene still fits inside the padding.
  if (focus && w <= canvasW + 1) {
    const want = canvasW / 2 - ((focus.x1 + focus.x2) / 2) * s;
    const c = drawn ?? b;
    tx = Math.max(FIT_PAD - c.minX * s, Math.min(canvasW - FIT_PAD - (c.minX + c.bw) * s, want));
  }
  return { s, tx, ty: (h - b.bh * s) / 2 - b.minY * s, w, h };
}

/** Left and right edges of the nodes across a set of scenes: what the view centres on when a scene fits. */
export function nodeSpan(scenes: Scene[]): { x1: number; x2: number } | null {
  let x1 = Infinity, x2 = -Infinity;
  for (const sc of scenes) for (const n of sc.nodes) {
    const { w } = nodeSize(n);
    x1 = Math.min(x1, n.x - w / 2);
    x2 = Math.max(x2, n.x + w / 2);
  }
  return isFinite(x1) ? { x1, x2 } : null;
}

/** True when a scene, fitted to this canvas, is wider than it (the canvas scrolls sideways). */
export function overflowsWidth(b: Bounds | null, canvasW: number, canvasH: number): boolean {
  return fitScene(b, canvasW, canvasH).w > canvasW + 1;
}

/**
 * Canvas height an operation needs so that none of its frames is squeezed below
 * MIN_SCALE by the height. With `follow` set (narrow screens) the canvas takes
 * the height of its content at the scale the width allows, within
 * [minH, maxH]; otherwise the result is only a floor under the canvas's own
 * CSS height. Either way the result is never less than the height the
 * tallest frame needs at MIN_SCALE: when that is more than `maxH` (a phone
 * held sideways) the canvas is that tall anyway and the page scrolls.
 */
export function neededHeight(scenes: Scene[], canvasW: number, follow: boolean, minH: number, maxH: number, probeRoom = true): number {
  let need = 0;
  let floor = 0;
  for (const scene of scenes) {
    const b = sceneBounds(scene, false, probeRoom);
    if (!b) continue;
    const s = follow ? widthScale(b, canvasW) : MIN_SCALE;
    const overflow = b.bw * s + FIT_PAD * 2 > canvasW ? SCROLLBAR_ALLOWANCE : 0;
    need = Math.max(need, Math.ceil(b.bh * s + FIT_PAD * 2 + overflow));
    const overflowAtMin = b.bw * MIN_SCALE + FIT_PAD * 2 > canvasW ? SCROLLBAR_ALLOWANCE : 0;
    floor = Math.max(floor, Math.ceil(b.bh * MIN_SCALE + FIT_PAD * 2 + overflowAtMin));
  }
  return Math.max(minH, floor, Math.min(maxH, need));
}

/** Narrowest canvas that shows every one of these scenes without scrolling sideways (at MIN_SCALE). */
export function minCanvasWidth(scenes: Scene[]): number {
  let need = 0;
  for (const sc of scenes) {
    const b = sceneBounds(sc);
    if (b) need = Math.max(need, Math.ceil(b.bw * MIN_SCALE + FIT_PAD * 2));
  }
  return need;
}
