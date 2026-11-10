import { describe, expect, it } from 'vitest';
import { FIT_PAD, MIN_SCALE, fitScene, neededHeight, sceneBounds } from './fit';
import type { Scene } from './types';

/** A row of single-cell nodes `n` wide. */
const row = (n: number): Scene => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, x: i * 60, y: 0, cells: [{ text: String(i) }] })),
  edges: [],
});

describe('fitting a scene into the canvas', () => {
  it('never scales a wide scene below the minimum; the scene scrolls instead', () => {
    const b = sceneBounds(row(30))!;
    const f = fitScene(b, 390, 400);
    expect(f.s).toBe(MIN_SCALE);
    expect(f.w).toBeGreaterThan(390);
    expect(f.w).toBe(Math.ceil(b.bw * MIN_SCALE + FIT_PAD * 2));
    // The scene starts at the left padding.
    expect(Math.abs(f.tx + b.minX * f.s - FIT_PAD)).toBeLessThanOrEqual(0.5);
  });

  it('fits a scene that is small enough without scrolling', () => {
    const f = fitScene(sceneBounds(row(5)), 1000, 400);
    expect(f.w).toBe(1000);
    expect(f.s).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('on a narrow screen sizes the canvas to the content at the scale it will be drawn', () => {
    const scenes = [row(30), row(3)];
    const h = neededHeight(scenes, 390, true, 0, 2000);
    const f = fitScene(sceneBounds(row(30)), 390, h);
    expect(f.s).toBe(MIN_SCALE);
  });

  it('keeps the canvas height within its limits', () => {
    expect(neededHeight([row(3)], 390, true, 220, 500)).toBe(220);
    // Taller than the cap at the width's scale, but it fits the cap at the minimum scale: capped.
    const tall: Scene = { nodes: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, x: 0, y: i * 80, cells: [{ text: 'x' }] })), edges: [] };
    expect(neededHeight([tall], 390, true, 220, 500)).toBe(500);
    expect(fitScene(sceneBounds(tall), 390, 500).s).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('never lets the height take the scale below the minimum (a phone held sideways)', () => {
    const tall: Scene = { nodes: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, x: 0, y: i * 80, cells: [{ text: 'x' }] })), edges: [] };
    const b = sceneBounds(tall)!;
    // The cap would squeeze it, so the canvas is as tall as the scene needs at the minimum scale.
    const h = neededHeight([tall], 844, true, 220, 273);
    expect(h).toBe(Math.ceil(b.bh * MIN_SCALE + FIT_PAD * 2));
    expect(fitScene(b, 844, h).s).toBe(MIN_SCALE);
    // Even a canvas that is too short is never drawn below the minimum: the drawing is taller instead.
    const f = fitScene(b, 844, 273);
    expect(f.s).toBe(MIN_SCALE);
    expect(f.h).toBeGreaterThan(273);
  });
});
