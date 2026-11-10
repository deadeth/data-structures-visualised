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
/** Clear space around the scene inside the canvas, in CSS px. */
export const FIT_PAD = 26;
/** Room for a horizontal scrollbar when the scene overflows. */
export const SCROLLBAR_ALLOWANCE = 16;
/** Chip height, and the room always kept above a node for it. */
export const PROBE_H = 26;

export interface Bounds { minX: number; minY: number; bw: number; bh: number }

export interface Fit {
  s: number;
  tx: number;
  ty: number;
  /** Drawn size of the scene's box in CSS px: at least the canvas, wider when the scene has to scroll. */
  w: number;
  h: number;
}

/** The box a scene occupies, including room for the probe chip, titles, subs and captions. */
export function sceneBounds(scene: Scene): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x1: number, y1: number, x2: number, y2: number) => {
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  };
  for (const n of scene.nodes) {
    const { w, h } = nodeSize(n);
    const extraBelow = (n.cells.some((c) => c.sub) ? 20 : 0) + (n.caption ? 18 : 0);
    // Always leave room above for the probe chip so the view does not jump when it arrives.
    grow(n.x - w / 2, n.y - h / 2 - PROBE_H - 16 - (n.title ? 16 : 0), n.x + w / 2, n.y + h / 2 + extraBelow);
  }
  for (const d of scene.decor ?? []) {
    if (d.type === 'ring') grow(d.cx - d.r, d.cy - d.r, d.cx + d.r, d.cy + d.r);
    else if (d.type === 'band') grow(d.x, d.y, d.x + d.w, d.y + d.h);
    else {
      const tw = d.text.length * 8;
      const x1 = d.anchor === 'end' ? d.x - tw : d.anchor === 'middle' ? d.x - tw / 2 : d.x;
      grow(x1, d.y - 10, x1 + tw, d.y + 10);
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, bw: Math.max(1, maxX - minX), bh: Math.max(1, maxY - minY) };
}

/** Scale to use across the width alone: as large as fits, but never below MIN_SCALE. */
export function widthScale(b: Bounds, canvasW: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, (canvasW - FIT_PAD * 2) / b.bw));
}

/**
 * Fit a scene into a canvas. The height always fits; the width fits unless
 * that would take the scale below MIN_SCALE, in which case `w` grows past the
 * canvas width and the canvas scrolls.
 */
export function fitScene(b: Bounds | null, canvasW: number, canvasH: number): Fit {
  if (!b) return { s: 1, tx: canvasW / 2, ty: canvasH / 2, w: canvasW, h: canvasH };
  const s = Math.min(widthScale(b, canvasW), (canvasH - FIT_PAD * 2) / b.bh);
  const w = Math.max(canvasW, Math.ceil(b.bw * s + FIT_PAD * 2));
  return {
    s,
    tx: (w - b.bw * s) / 2 - b.minX * s,
    ty: (canvasH - b.bh * s) / 2 - b.minY * s,
    w,
    h: canvasH,
  };
}

/**
 * Canvas height an operation needs so that none of its frames is squeezed below
 * MIN_SCALE by the height. With `follow` set (narrow screens) the canvas takes
 * exactly the height of its content, within [minH, maxH]; otherwise the
 * result is only a floor under the canvas's own CSS height.
 */
export function neededHeight(scenes: Scene[], canvasW: number, follow: boolean, minH: number, maxH: number): number {
  let need = 0;
  for (const scene of scenes) {
    const b = sceneBounds(scene);
    if (!b) continue;
    const s = follow ? widthScale(b, canvasW) : MIN_SCALE;
    const overflow = b.bw * s + FIT_PAD * 2 > canvasW ? SCROLLBAR_ALLOWANCE : 0;
    need = Math.max(need, Math.ceil(b.bh * s + FIT_PAD * 2 + overflow));
  }
  return Math.max(minH, Math.min(maxH, need));
}
