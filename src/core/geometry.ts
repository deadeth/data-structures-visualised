import type { Cell, SceneNode } from './types';

/** Node metrics. Layout code should use these so nodes never overlap. */
export const CELL_H = 36;
export const CELL_MIN_W = 40;
export const CELL_PAD = 11;
/** Advance width of one character of the canvas font at its drawn size. */
export const CHAR_W = 9.9;
export const CIRCLE_MIN_R = 20;

export function cellWidth(c: Cell): number {
  return c.w ?? Math.max(CELL_MIN_W, Math.ceil(c.text.length * CHAR_W) + CELL_PAD * 2);
}

/** A node with several cells is drawn as a tray holding the cells. */
export const TRAY_PAD = 4;
export const CELL_GAP = 3;

/** Outer width of a box node with these cells. */
export function cellsWidth(cells: Cell[]): number {
  if (cells.length <= 1) return cells.length ? cellWidth(cells[0]) : CELL_MIN_W;
  let w = TRAY_PAD * 2 + CELL_GAP * (cells.length - 1);
  for (const c of cells) w += cellWidth(c);
  return w;
}

/** Outer height of a box node with this many cells. */
export function cellsHeight(count: number): number {
  return count > 1 ? CELL_H + TRAY_PAD * 2 : CELL_H;
}

/** X offset from the node's left edge to the centre of cell i. */
export function cellCentre(cells: Cell[], i: number): number {
  if (cells.length <= 1) return cellsWidth(cells) / 2;
  let x = TRAY_PAD;
  for (let j = 0; j < i; j++) x += cellWidth(cells[j]) + CELL_GAP;
  return x + cellWidth(cells[i]) / 2;
}

/** X offset from the node's left edge to the boundary before cell i (0..cells.length). */
export function slotX(cells: Cell[], i: number): number {
  if (cells.length <= 1) return i <= 0 ? 4 : cellsWidth(cells) - 4;
  let x = TRAY_PAD - CELL_GAP / 2;
  for (let j = 0; j < i && j < cells.length; j++) x += cellWidth(cells[j]) + CELL_GAP;
  return x;
}

export function circleRadius(n: SceneNode): number {
  return n.r ?? Math.max(CIRCLE_MIN_R, Math.ceil((n.cells[0]?.text.length ?? 1) * CHAR_W) / 2 + 9);
}

/** Height of a pointer tag (top, head, lo). */
export const TAG_H = 26;
/** Advance of one character of a tag's text (the text face at 600, at the largest label size). */
export const TAG_CHAR_W = 9;

export function tagWidth(text: string): number {
  return Math.max(40, Math.ceil(text.length * TAG_CHAR_W) + 18);
}

export function nodeSize(n: SceneNode): { w: number; h: number } {
  if (n.shape === 'tag') return { w: n.cells[0]?.w ?? tagWidth(n.cells[0]?.text ?? ''), h: TAG_H };
  if (n.shape === 'circle') {
    const r = circleRadius(n);
    return { w: r * 2, h: r * 2 };
  }
  return { w: cellsWidth(n.cells), h: cellsHeight(n.cells.length) };
}

/** Width of a box node holding these labels. Handy before the SceneNode exists. */
export function boxWidth(texts: (string | number)[]): number {
  return cellsWidth(texts.length ? texts.map((t) => ({ text: String(t) })) : [{ text: '' }]);
}

export interface TidyOptions<T> {
  root: T;
  /** Children in order. Use null for a missing child that should still hold its side (binary trees). */
  children(node: T): (T | null)[];
  /** Drawn width of the node. */
  width(node: T): number;
  gapX?: number;
  gapY?: number;
  /** Width reserved for a null child. */
  nullWidth?: number;
}

/**
 * Tidy tree layout: leaves are placed left to right, each parent is centred
 * over its children. Returns the centre of every node; the root's top row is y = 0.
 */
export function tidyTree<T>(opts: TidyOptions<T>): Map<T, { x: number; y: number; depth: number }> {
  const gapX = opts.gapX ?? 18;
  const gapY = opts.gapY ?? 84;
  const nullW = opts.nullWidth ?? 18;
  const out = new Map<T, { x: number; y: number; depth: number }>();
  let cursor = 0;

  // Iterative post-order so very deep trees cannot overflow the stack.
  type Item = { node: T; depth: number; kids: (T | null)[]; i: number; xs: number[]; start: number };
  const stack: Item[] = [{ node: opts.root, depth: 0, kids: opts.children(opts.root), i: 0, xs: [], start: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i < top.kids.length) {
      const kid = top.kids[top.i++];
      if (kid === null) {
        top.xs.push(cursor + nullW / 2);
        cursor += nullW + gapX;
      } else {
        stack.push({ node: kid, depth: top.depth + 1, kids: opts.children(kid), i: 0, xs: [], start: cursor });
      }
      continue;
    }
    stack.pop();
    const w = opts.width(top.node);
    let x: number;
    if (top.xs.length === 0) {
      x = cursor + w / 2;
      cursor += w + gapX;
    } else {
      x = (top.xs[0] + top.xs[top.xs.length - 1]) / 2;
      // A parent wider than its subtree must not overlap whatever was placed before it.
      const left = x - w / 2;
      if (left < top.start) x += top.start - left;
      cursor = Math.max(cursor, x + w / 2 + gapX);
    }
    out.set(top.node, { x, y: top.depth * gapY, depth: top.depth });
    const parent = stack[stack.length - 1];
    if (parent) parent.xs.push(x);
  }
  return out;
}
