/**
 * Recorded narration on a design tour: the Audio button, and one audio element that plays each step's clip.
 * The tour player (design-page.ts) tells it when a step is entered, paused or resumed, and asks it before moving on:
 * while the tour plays, a step waits for its clip to end, then 400 ms, as well as for its usual dwell.
 * A clip plays only while the hash it was recorded from (narration-manifest.ts) matches the page's own words.
 */
import { h } from '../core/dom';
import { hashOf, narrationOf } from '../designs/narration';
import { NARRATION } from '../designs/narration-manifest';
import type { TourStep } from '../designs/types';

const KEY = 'dsv.audio';
/** The gap after a clip ends before the tour moves on. */
const GAP = 400;
const NS = 'http://www.w3.org/2000/svg';

export interface TourAudio {
  /** The Audio button for the tour controls; null when this design and tour have no clips. */
  button: HTMLButtonElement | null;
  /** The one audio element (no controls, so it draws nothing), to put in the page so it can be found and inspected. */
  element: HTMLAudioElement | null;
  /** A step was entered: any clip stops. With `sound` (a user's own action, or the tour playing) its clip starts. */
  enter(i: number, sound: boolean): void;
  /** Run `next` when step i's clip has ended (and the gap after it), or at once when there is no clip to wait for. */
  after(i: number, next: () => void): void;
  /** The tour paused: the clip pauses, and nothing waits on it. */
  pause(): void;
  /** The tour plays again at step i: its clip resumes, or starts if it never did. A finished clip is not played again. */
  resume(i: number): void;
  /** Left the tour: the clip stops. */
  stop(): void;
  destroy(): void;
}

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
};
const store = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Storage can be blocked; the setting still holds for this visit.
  }
};

function speaker(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  const body = document.createElementNS(NS, 'path');
  body.setAttribute('d', 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z');
  body.setAttribute('fill', 'currentColor');
  const waves = document.createElementNS(NS, 'path');
  waves.setAttribute('class', 'hld-audio-waves');
  waves.setAttribute('d', 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11');
  svg.append(body, waves);
  return svg;
}

/**
 * @param designId the design's id
 * @param tourKey "main", or the story's id
 * @param tour the steps the page shows, whose words the clips must match
 * @param step the step on show, -1 off the tour
 */
export function tourAudio(designId: string, tourKey: string, tour: TourStep[], step: () => number): TourAudio {
  const hashes = NARRATION[designId]?.[tourKey];
  /** Each step's clip address, or null where there is none or it was made from other words. */
  const urls = tour.map((s, i) => (hashes?.[i] && hashes[i] === hashOf(narrationOf(s, i + 1)) ? `${import.meta.env.BASE_URL}audio/${designId}/${tourKey}/${i + 1}.mp3` : null));
  if (!urls.some(Boolean)) {
    const noop = () => {};
    return { button: null, element: null, enter: noop, after: (_i, next) => next(), pause: noop, resume: noop, stop: noop, destroy: noop };
  }

  let on = stored();
  const audio = new Audio();
  audio.preload = 'auto';
  audio.className = 'hld-audio-el';
  /** The step whose clip is loaded, -1 for none. */
  let cur = -1;
  /** Whether that clip has been asked to play, and whether it has finished (or failed). */
  let started = false;
  let ended = false;
  let waiting: (() => void) | null = null;
  let gap = 0;
  const prefetched = new Set<string>();

  const button = h(
    'button.hld-audio', { type: 'button', 'aria-pressed': String(on), title: 'Reads each step aloud', onclick: () => setOn(!on) },
    speaker(), h('span.hld-audio-text', null, 'Audio'),
  ) as HTMLButtonElement;
  // The description, for a screen reader, as the tooltip gives it to a pointer.
  button.setAttribute('aria-description', 'Reads each step aloud');

  /** Whatever waited on the clip goes ahead now. */
  function release(): void {
    clearTimeout(gap);
    gap = 0;
    const fn = waiting;
    waiting = null;
    fn?.();
  }
  function finish(): void {
    ended = true;
    if (!waiting) return;
    clearTimeout(gap);
    gap = window.setTimeout(release, GAP);
  }
  audio.addEventListener('ended', finish);
  audio.addEventListener('error', () => {
    if (!started) return;
    // A clip that cannot load or decode: the step runs on its usual dwell.
    ended = true;
    release();
  });

  function prefetch(i: number): void {
    const u = urls[i];
    if (!u || prefetched.has(u)) return;
    prefetched.add(u);
    // Warms the browser's cache, so the next step's clip starts at once. One audio element plays; this only fetches.
    fetch(u, { priority: 'low' } as RequestInit).catch(() => prefetched.delete(u));
  }

  function silence(): void {
    clearTimeout(gap);
    gap = 0;
    audio.pause();
    started = false;
    ended = false;
  }

  function start(i: number): void {
    const u = urls[i];
    cur = i;
    started = false;
    ended = false;
    if (!on || !u) return;
    audio.src = u;
    started = true;
    // A browser may refuse sound without a gesture: then the step simply runs without it.
    audio.play().catch(() => {
      if (cur !== i) return;
      started = false;
      release();
    });
    prefetch(i + 1);
  }

  function setOn(v: boolean): void {
    on = v;
    store(v);
    button.setAttribute('aria-pressed', String(v));
    if (!v) {
      // Off mid-clip: it stops, and a step that waited only on it moves on by its usual dwell.
      silence();
      release();
      return;
    }
    // On during the tour (a click, so sound is allowed): the step on show is read from its start.
    const i = step();
    if (i >= 0) start(i);
  }

  return {
    button,
    element: audio,
    enter(i, sound) {
      silence();
      waiting = null;
      cur = i;
      if (sound) start(i);
      else if (on) prefetch(i);
    },
    after(i, next) {
      if (!on || cur !== i || !started || ended || !urls[i]) {
        next();
        return;
      }
      waiting = next;
    },
    pause() {
      clearTimeout(gap);
      gap = 0;
      waiting = null;
      if (started && !ended) audio.pause();
    },
    resume(i) {
      if (!on || !urls[i]) return;
      if (cur === i && started) {
        if (!ended && audio.paused) audio.play().catch(() => {
          started = false;
          release();
        });
        return;
      }
      start(i);
    },
    stop() {
      silence();
      waiting = null;
      cur = -1;
    },
    destroy() {
      silence();
      waiting = null;
      cur = -1;
      audio.removeAttribute('src');
      audio.load();
    },
  };
}
