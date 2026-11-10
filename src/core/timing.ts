/**
 * Playback timing. Kept pure so the rules can be unit tested.
 *
 * At 1x a step lasts 1150ms and the movement inside it 520ms. Slower speeds
 * stretch the movement too, but by the square root of the slow-down so a
 * quarter-speed step still feels like motion rather than drift; faster speeds
 * keep the movement inside the shorter step.
 */
export const BASE_STEP_MS = 1150;
export const BASE_TWEEN_MS = 520;
/** Movement when stepping by hand at 1x. */
export const BASE_MANUAL_MS = 240;
export const MAX_MANUAL_MS = 480;
/** Replay from the end eases back to the first frame instead of snapping. */
export const REWIND_MS = 300;

export function stepMs(speed: number): number {
  return BASE_STEP_MS / speed;
}

/** Movement between frames while playing. */
export function playTweenMs(speed: number): number {
  return Math.round(Math.min(stepMs(speed) * 0.6, BASE_TWEEN_MS * Math.sqrt(1 / speed)));
}

/** Movement for a single manual step (arrow keys, step buttons). */
export function manualTweenMs(speed: number): number {
  return Math.round(Math.min(BASE_MANUAL_MS / Math.sqrt(speed), MAX_MANUAL_MS));
}

/**
 * Time left in a step when the speed changes part-way through it. The reader
 * keeps the fraction of the dwell already spent, so a speed change never
 * restarts the step: `remaining = (1 - elapsed / oldStepMs) * newStepMs`.
 */
export function remainingAfterSpeedChange(elapsedMs: number, oldStepMs: number, newStepMs: number): number {
  const done = oldStepMs > 0 ? Math.min(1, Math.max(0, elapsedMs / oldStepMs)) : 1;
  return Math.max(0, Math.round((1 - done) * newStepMs));
}

/** The easing every movement on the stage uses: the canvas, the chip, the pan and the code listing's scroll. */
export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Below this, a code listing jumps to the live lines instead of gliding there. */
export const MIN_GLIDE_MS = 300;
