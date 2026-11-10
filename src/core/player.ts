import { REWIND_MS, manualTweenMs, playTweenMs, remainingAfterSpeedChange, stepMs } from './timing';
import type { Frame } from './types';

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Moves through a list of frames. Knows nothing about drawing: it calls
 * `render(frame, ms)` and `changed()` and leaves the rest to the stage.
 */
export class Player {
  frames: Frame[] = [];
  index = 0;
  playing = false;
  speed = 1;
  private timer = 0;
  /** What the pending timer will do, when it was armed and the full step length it was armed for. */
  private pending: (() => void) | null = null;
  private armedAt = 0;
  private armedFor = 0;

  constructor(
    private readonly render: (frame: Frame, ms: number) => void,
    private readonly changed: () => void,
    private readonly ended: () => void,
  ) {}

  get stepMs(): number {
    return stepMs(this.speed);
  }

  private get tweenMs(): number {
    return reducedMotion() ? 0 : playTweenMs(this.speed);
  }

  get atEnd(): boolean {
    return this.index >= this.frames.length - 1;
  }

  load(frames: Frame[], autoplay: boolean): void {
    this.disarm();
    this.frames = frames;
    this.index = 0;
    this.playing = false;
    if (!frames.length) return;
    this.render(frames[0], autoplay ? this.tweenMs : 0);
    if (autoplay && frames.length > 1) {
      this.playing = true;
      this.schedule();
    }
    this.changed();
    if (frames.length <= 1) this.ended();
  }

  /** Run `fn` after `delay` ms, remembering enough to stretch or shrink the wait if the speed changes. */
  private arm(fn: () => void, delay = this.stepMs): void {
    clearTimeout(this.timer);
    this.pending = fn;
    this.armedAt = performance.now();
    this.armedFor = delay;
    this.timer = window.setTimeout(() => {
      this.pending = null;
      fn();
    }, delay);
  }

  private disarm(): void {
    clearTimeout(this.timer);
    this.pending = null;
  }

  private schedule(delay?: number): void {
    this.arm(() => {
      if (!this.playing) return;
      if (this.atEnd) {
        this.playing = false;
        this.changed();
        this.ended();
        return;
      }
      this.index++;
      this.render(this.frames[this.index], this.tweenMs);
      this.changed();
      if (this.atEnd) {
        // Let the last frame land before reporting the end.
        this.arm(() => {
          this.playing = false;
          this.changed();
          this.ended();
        });
      } else {
        this.schedule();
      }
    }, delay);
  }

  play(): void {
    if (!this.frames.length) return;
    if (this.atEnd) {
      // Replay: ease back to the start rather than snapping.
      this.index = 0;
      this.render(this.frames[0], reducedMotion() ? 0 : REWIND_MS);
    }
    this.playing = true;
    this.changed();
    this.schedule();
  }

  pause(): void {
    this.disarm();
    this.playing = false;
    this.changed();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** Move by one frame and stop playing. */
  step(delta: 1 | -1): void {
    this.seek(this.index + delta, true);
  }

  seek(index: number, smooth = false): void {
    if (!this.frames.length) return;
    this.disarm();
    this.playing = false;
    const next = Math.max(0, Math.min(this.frames.length - 1, index));
    const ms = smooth && Math.abs(next - this.index) === 1 && !reducedMotion() ? manualTweenMs(this.speed) : 0;
    this.index = next;
    this.render(this.frames[next], ms);
    this.changed();
  }

  /** Jump to the last frame without animating. */
  finish(): void {
    if (!this.frames.length) return;
    const wasPlaying = this.playing;
    this.seek(this.frames.length - 1);
    if (wasPlaying) this.ended();
  }

  /** Change speed. Mid-step, the part of the step already spent is kept rather than starting the wait again. */
  setSpeed(speed: number): void {
    const before = this.armedFor;
    const fn = this.pending;
    this.speed = speed;
    if (this.playing && fn) {
      const elapsed = performance.now() - this.armedAt;
      // armedFor is the whole step at the old speed only when the wait began at a step boundary.
      const oldStep = Math.max(before, elapsed);
      const left = remainingAfterSpeedChange(elapsed, oldStep, this.stepMs);
      clearTimeout(this.timer);
      this.pending = fn;
      this.armedFor = this.stepMs;
      this.armedAt = performance.now() - (this.stepMs - left);
      this.timer = window.setTimeout(() => {
        this.pending = null;
        fn();
      }, left);
    }
    this.changed();
  }
}
