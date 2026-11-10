import { describe, expect, it } from 'vitest';
import { manualTweenMs, playTweenMs, remainingAfterSpeedChange, stepMs } from './timing';

describe('playback timing', () => {
  it('keeps 1x as it was', () => {
    expect(stepMs(1)).toBe(1150);
    expect(playTweenMs(1)).toBe(520);
    expect(manualTweenMs(1)).toBe(240);
  });

  it('slows the movement as well as the step at slow speeds', () => {
    expect(playTweenMs(0.5)).toBe(735);
    expect(playTweenMs(0.25)).toBe(1040);
    expect(manualTweenMs(0.5)).toBe(339);
    expect(manualTweenMs(0.25)).toBe(480);
  });

  it('keeps the movement inside the step at fast speeds', () => {
    for (const s of [2, 4, 8]) expect(playTweenMs(s)).toBeLessThan(stepMs(s));
    expect(playTweenMs(8)).toBe(86);
  });

  it('never makes slower speeds move faster', () => {
    const speeds = [0.25, 0.5, 1, 2, 4, 8];
    for (let i = 1; i < speeds.length; i++) {
      expect(playTweenMs(speeds[i])).toBeLessThanOrEqual(playTweenMs(speeds[i - 1]));
      expect(manualTweenMs(speeds[i])).toBeLessThanOrEqual(manualTweenMs(speeds[i - 1]));
    }
  });
});

describe('changing speed mid-step', () => {
  it('keeps the fraction of the step already spent', () => {
    // Half of a 1x step gone, then 2x: half of the 2x step is left.
    expect(remainingAfterSpeedChange(575, stepMs(1), stepMs(2))).toBe(Math.round(stepMs(2) / 2));
    // A quarter gone at 1x, then 0.25x: three quarters of the long step are left.
    expect(remainingAfterSpeedChange(stepMs(1) / 4, stepMs(1), stepMs(0.25))).toBe(Math.round(stepMs(0.25) * 0.75));
  });

  it('never goes negative or past a whole step', () => {
    expect(remainingAfterSpeedChange(5000, stepMs(1), stepMs(4))).toBe(0);
    expect(remainingAfterSpeedChange(-10, stepMs(1), stepMs(4))).toBe(Math.round(stepMs(4)));
  });
});
