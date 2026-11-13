import type { Source } from '../core/code';
import { CodePanel, codeRowPx } from './code-panel';
import { h } from '../core/dom';
import { Player, SPEEDS } from '../core/player';
import { ease } from '../core/timing';
import { Renderer } from '../core/renderer';
import { minCanvasWidth } from '../core/fit';
import type { Frame, Scene } from '../core/types';

const ICONS = {
  restart: 'M6 5v14M19 5l-9 7 9 7V5z',
  back: 'M15 5l-8 7 8 7V5z',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  next: 'M9 5l8 7-8 7V5z',
  end: 'M18 5v14M5 5l9 7-9 7V5z',
};

/** At this width and above the step log sits beside the canvas; below it, under the counters. */
const LOG_BESIDE = '(min-width: 1200px)';
/**
 * Code needs a wider column than the step log, so it sits beside the canvas
 * (under the step log) only from here up. Below it, with the code on, a
 * window of the listing sits under the canvas; it scrolls to the rest.
 */
const CODE_BESIDE = '(min-width: 1360px)';
/** Below this width the layout is a phone's. */
const NARROW = '(max-width: 899px)';
/** A short screen, such as a phone held sideways. */
const SHORT = '(max-height: 500px)';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem('dsv.speed'));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function saveSpeed(v: number): void {
  try {
    localStorage.setItem('dsv.speed', String(v));
  } catch {
    /* private mode: speed just won't be remembered */
  }
}

/** The key followed in each frame: the probe of the latest frame that had one, else the first one to come. */
export function followedKeys(frames: Frame[]): (string | null)[] {
  const out: (string | null)[] = [];
  let held: string | null = null;
  for (const f of frames) {
    if (f.probe) held = f.probe.text;
    out.push(held);
  }
  const first = frames.find((f) => f.probe)?.probe?.text ?? null;
  return out.map((k) => k ?? first);
}

export interface StageOptions {
  /** Smaller canvas and no step log. Used for the demo on the home page. */
  compact?: boolean;
  counters: { key: string; label: string }[];
  /** Name of the structure, for the diagram's accessible name. */
  name?: string;
  /** Announce steps to screen readers when the reader moves through them. Off for the home demo. */
  live?: boolean;
  /** Offer the example code as an alternative to the step log. */
  code?: boolean;
}

/** The reader's switch for single-character shortcuts. A missing value means on. */
const SHORTCUTS_STORE = 'dsv.shortcuts';

function shortcutsOn(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_STORE) !== 'off';
  } catch {
    return true;
  }
}

const CODE_STORE = 'dsv.code';
/** The store used while the side panel was a Steps or Code switch. Read once, then replaced by CODE_STORE. */
const OLD_STORE = 'dsv.side';

/** Whether the reader wants the code shown. A value in the old store wins and is migrated, so "Code" stays on. */
function savedCodeOn(): boolean {
  try {
    const old = localStorage.getItem(OLD_STORE);
    if (old != null) {
      localStorage.removeItem(OLD_STORE);
      localStorage.setItem(CODE_STORE, old === 'code' ? 'on' : 'off');
    }
    return localStorage.getItem(CODE_STORE) === 'on';
  } catch {
    return false;
  }
}

/**
 * The instrument: comparison readout, canvas, transport, counters and step log.
 * Give it frames and it plays them. It owns no data structure logic.
 */
export class Stage {
  readonly root: HTMLElement;
  private renderer: Renderer;
  private player: Player;
  private counters: { key: string; label: string }[];
  private readout: HTMLElement;
  private canvasWrap: HTMLElement;
  private transport: HTMLElement;
  private cmp: HTMLElement;
  private measure: HTMLElement;
  private msg: HTMLElement;
  private status: HTMLElement | null = null;
  private logWrap: HTMLDetailsElement | null = null;
  private code: CodePanel | null = null;
  private codeOn = false;
  /**
   * Set once a scene on this page proved too wide to sit beside the code
   * column without scrolling sideways (a wide skip list at 1440px). The code
   * then takes the window under the canvas instead, as between 1200 and
   * 1359px, so turning the code on never makes the diagram scroll.
   */
  private wideScene = false;
  private wideAt = 0;
  /** The Code on/off toggle, for the page to place with its other tools. Null when there is no code. */
  readonly codeToggle: HTMLButtonElement | null = null;
  /**
   * Said beside the toggle when the code is on but hidden: on a short screen
   * (a phone held sideways) there is no room for the listing between the
   * canvas and the transport, so it is not drawn at all.
   */
  readonly codeNote: HTMLElement | null = null;
  private logSummary: HTMLElement | null = null;
  private log: HTMLOListElement | null = null;
  private logItems: HTMLLIElement[] = [];
  /** Highest frame reached in this operation. Later steps stay hidden in the log until reached. */
  private revealed = -1;
  private keys: (string | null)[] = [];
  private scrub: HTMLInputElement;
  private stepLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private playText: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private counterEls = new Map<string, HTMLElement>();
  private countersHost: HTMLElement;
  private navBtns: Record<'restart' | 'back' | 'next' | 'end', HTMLButtonElement>;
  private doneResolvers: (() => void)[] = [];
  private onKey: (e: KeyboardEvent) => void;
  private beside = matchMedia(LOG_BESIDE);
  private codeBeside = matchMedia(CODE_BESIDE);
  private short = matchMedia(SHORT);
  private onBeside = () => this.syncLogPlacement(true);
  /** Movement time of the frame being shown, so the code listing glides on the same clock as the canvas. */
  private frameMs = 0;
  private loads = 0;
  private lastIndex = -1;
  private lastPlaying = false;
  private announceTimer = 0;
  private resizeRaf = 0;
  private lastWidth = 0;
  /** Set while an operation is being loaded, so focus is moved only once the transport is up to date. */
  private loading = false;
  private lostFocus = false;
  private stickRaf = 0;
  private pageRaf = 0;
  /**
   * The transport sticks to the bottom of the screen while the readout is
   * clear of it, so it never sits over the readout or over a canvas that has
   * not scrolled into view yet.
   */
  private onScroll = () => {
    cancelAnimationFrame(this.stickRaf);
    this.stickRaf = requestAnimationFrame(() => this.syncStick());
  };
  private onResize = () => {
    cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = requestAnimationFrame(() => {
      const w = this.root.clientWidth;
      if (w !== this.lastWidth) {
        this.lastWidth = w;
        this.fitChips(this.player.frames);
        this.sizeMessage();
        this.sizeRest(this.player.frames);
        this.sizeWindow();
        this.sizeLogSplit(this.player.frames);
      }
    });
  };

  constructor(host: HTMLElement, opts: StageOptions) {
    this.counters = opts.counters;

    // Row one: the chips (the key, then the comparison). Row two: the sentence. Both start at the same left edge.
    this.cmp = h('div.readout-cmp', { 'aria-hidden': 'true' });
    this.measure = h('div.readout-cmp.measure', { 'aria-hidden': 'true' });
    // Not a live region: it changes on every frame while playing. Announcements go through `status`.
    this.msg = h('p.readout-msg');
    this.readout = h('div.readout.at-rest', null, this.cmp, this.msg, this.measure);

    const canvas = h('div.canvas');
    // Shown at the top of the transport only while the canvas has keyboard focus and scrolls: there the arrows pan instead of stepping.
    const panHint = h('p.pan-hint', { 'aria-hidden': 'true' }, h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' scroll the diagram here. ', h('kbd', null, 'Space'), ' still plays.');
    this.canvasWrap = h('div.canvas-wrap', null, canvas);

    const nav = (name: 'restart' | 'back' | 'next' | 'end', label: string, fn: () => void, keys?: string) =>
      h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, 'aria-keyshortcuts': keys, onclick: fn }, icon(name));
    this.navBtns = {
      restart: nav('restart', 'Back to the first step', () => this.player.seek(0)),
      back: nav('back', 'Step back (left arrow)', () => this.player.step(-1), 'ArrowLeft'),
      next: nav('next', 'Step forward (right arrow)', () => this.player.step(1), 'ArrowRight'),
      end: nav('end', 'Skip to the last step', () => this.player.finish()),
    };
    this.playText = h('span', null, 'Play');
    this.playBtn = h('button.play-btn', { type: 'button', title: 'Play or pause (space)', 'aria-keyshortcuts': 'Space', onclick: () => this.player.toggle() }, icon('play'), this.playText);
    this.scrub = h('input.scrub', {
      type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': 'Step',
      oninput: () => this.player.seek(Number(this.scrub.value)),
    });
    this.stepLabel = h('span.step-label', { 'aria-hidden': 'true' });
    const speed = h('div.speed', { role: 'group', 'aria-label': 'Playback speed' }, h('span.speed-label', null, 'Speed'));
    for (const s of SPEEDS) {
      const b = h('button.speed-btn', { type: 'button', 'aria-pressed': 'false', 'aria-keyshortcuts': '[ ]', onclick: () => this.setSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
      speed.append(b);
    }
    const transport = (this.transport = h(
      'div.transport', null,
      panHint,
      h('div.transport-nav', null, this.navBtns.restart, this.navBtns.back, this.playBtn, this.navBtns.next, this.navBtns.end),
      h('div.transport-scrub', null, this.scrub, this.stepLabel),
      speed,
    ));
    const hint = h(
      'p.shortcuts', null,
      h('span', { 'aria-hidden': 'true' },
        h('kbd', null, 'Space'), ' play or pause, ', h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' step, ',
        h('kbd', null, '['), ' ', h('kbd', null, ']'), ' speed'),
      h('span.visually-hidden', null, 'Keyboard: Space plays or pauses, the left and right arrows step, and with focus in the animation the square brackets change speed.'),
    );

    this.countersHost = h('dl.counters');
    this.buildCounters();

    // DOM order is the reading and tab order on every width: readout, canvas, transport, counters, then the log.
    this.root = h('section.stage', { class: opts.compact ? 'compact' : '', 'aria-label': 'Animation' }, this.readout, this.canvasWrap, transport, hint, this.countersHost);
    if (!opts.compact && opts.code) this.code = new CodePanel();
    if (!opts.compact) {
      this.log = h('ol.log', { 'aria-label': 'Steps in this operation', onkeydown: (e: KeyboardEvent) => this.logKey(e) });
      this.logSummary = h('summary.log-title', null, 'Steps');
      this.logWrap = h('details.log-wrap', null, this.logSummary, this.log);
      if (opts.code) {
        // The steps are always shown; the code is shown as well when the reader turns it on.
        (this as { codeToggle: HTMLButtonElement | null }).codeToggle = h('button.code-toggle', {
          type: 'button',
          'aria-pressed': 'false',
          onclick: () => this.setCodeOn(!this.codeOn),
        }, 'Code') as HTMLButtonElement;
        (this as { codeNote: HTMLElement | null }).codeNote = h('span.code-short-note', { hidden: true }, 'Code is hidden on a screen this short. Turn the phone upright to read it.');
        this.codeOn = savedCodeOn();
      }
      this.logSummary.addEventListener('click', (e) => {
        // Beside the canvas the log is a fixed panel, not a disclosure.
        if (this.beside.matches) e.preventDefault();
      });
      this.logWrap.addEventListener('toggle', () => this.scrollLog());
      this.root.append(this.logWrap);
      this.beside.addEventListener('change', this.onBeside);
      this.codeBeside.addEventListener('change', this.onBeside);
      this.short.addEventListener('change', this.onBeside);
      this.syncLogPlacement(false);
      if (this.code) this.setCodeOn(this.codeOn, false);
    }
    if (opts.live !== false) {
      this.status = h('div.visually-hidden', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      this.root.append(this.status);
    }
    host.append(this.root);

    this.renderer = new Renderer(canvas, {
      label: opts.name ? `Diagram of the ${opts.name}. The readout above it describes each step in words.` : undefined,
      // On a phone the canvas shares the screen with the readout and the transport.
      reserve: () => this.readout.offsetHeight + this.transport.offsetHeight + (this.code?.windowRoot.offsetHeight ?? 0) + 24,
      onRegionLost: () => {
        if (this.loading) this.lostFocus = true;
        else this.focusPlay();
      },
    });
    this.player = new Player(
      (frame, ms) => {
        this.frameMs = ms;
        this.renderer.show(frame, ms);
        this.followProbe(ms);
      },
      () => this.sync(),
      () => {
        const r = this.doneResolvers;
        this.doneResolvers = [];
        for (const fn of r) fn();
      },
    );
    this.setSpeed(loadSpeed(), false);

    this.onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.root.isConnected) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isRange = tag === 'INPUT' && (t as HTMLInputElement).type === 'range';
      if ((tag === 'INPUT' && !isRange) || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (e.key === ' ') {
        // The "All steps" disclosure keeps its own Space.
        if (tag === 'SUMMARY') return;
        const activatable = tag === 'BUTTON' || tag === 'A';
        // With nothing to play, let Space do its usual job on a button.
        if (activatable && this.player.frames.length <= 1) return;
        e.preventDefault();
        if (!e.repeat && this.player.frames.length > 1) this.player.toggle();
        return;
      }
      if (e.key === ']' || e.key === '[') {
        // Single-character keys act only inside the animation, and not at all when the reader turned shortcuts off.
        if (!t || !this.root.contains(t) || !shortcutsOn()) return;
        const i = (SPEEDS as readonly number[]).indexOf(this.player.speed) + (e.key === ']' ? 1 : -1);
        if (i >= 0 && i < SPEEDS.length) this.setSpeed(SPEEDS[i]);
        return;
      }
      // Arrows keep their own meaning on the scrubber (move it) and on a scrolling canvas (pan it).
      if (isRange || t?.classList.contains('canvas')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.player.step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.player.step(-1);
      }
    };
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('resize', this.onScroll);
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  private syncStick(): void {
    if (!this.root.isConnected) return;
    const room = window.innerHeight - this.transport.offsetHeight;
    // It sticks at rest too: the stage is sized to fit at rest (sizeRest), and where a tall picture still
    // pushes the controls below the fold they are kept on screen, as they are while an operation plays.
    const stick = this.readout.getBoundingClientRect().bottom < room - 48;
    this.root.classList.toggle('stick', stick);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('resize', this.onScroll);
    window.removeEventListener('scroll', this.onScroll);
    cancelAnimationFrame(this.resizeRaf);
    cancelAnimationFrame(this.stickRaf);
    this.beside.removeEventListener('change', this.onBeside);
    this.codeBeside.removeEventListener('change', this.onBeside);
    this.short.removeEventListener('change', this.onBeside);
    clearTimeout(this.announceTimer);
    this.player.pause();
    this.renderer.destroy();
    this.root.remove();
  }

  setCounters(counters: { key: string; label: string }[]): void {
    this.counters = counters;
    this.buildCounters();
  }

  private buildCounters(): void {
    this.countersHost.replaceChildren();
    this.counterEls.clear();
    for (const c of this.counters) {
      const dd = h('dd', null, '0');
      this.counterEls.set(c.key, dd);
      this.countersHost.append(h('div.counter', null, dd, h('dt', null, c.label)));
    }
  }

  get speed(): number {
    return this.player.speed;
  }

  setSpeed(s: number, persist = true): void {
    this.player.setSpeed(s);
    if (persist) saveSpeed(s);
    this.speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === s)));
  }

  /** Show or hide the example code. The step log is shown either way. */
  setCodeOn(on: boolean, persist = true): void {
    if (!this.code || !this.logWrap) return;
    const was = this.codeOn;
    this.codeOn = on;
    // The canvas may change width: let the scene glide to its new fit rather than jump.
    if (was !== on && (this.renderer as Renderer | undefined)) this.renderer.easeNextResize();
    this.root.classList.toggle('with-code', on);
    this.codeToggle?.setAttribute('aria-pressed', String(on));
    if (persist) {
      try {
        localStorage.setItem(CODE_STORE, on ? 'on' : 'off');
      } catch {
        // Not being able to remember the choice is harmless.
      }
    }
    this.syncLogPlacement(true);
    if (this.player as Player | undefined) {
      this.sizeWindow();
      this.scrollLog();
      this.code.show(this.player.frames[this.player.index]?.lines);
      this.code.showVars(this.player.frames[this.player.index]?.vars);
    }
  }

  /**
   * The example code for the operation about to play. Pass no regions when it
   * has none. With `rest` set nothing is playing: the listing shows unlit.
   */
  setCode(source: Source | undefined, regions: string[] | undefined, opts: { empty?: string; rest?: boolean } = {}): void {
    this.code?.load(source, regions, opts);
  }

  /** Show a resting picture with a line of narration. */
  still(scene: Scene, message: string): void {
    this.load([{ scene, message, counters: {} }], false);
  }

  /** Play an operation's frames. Resolves when playback reaches the end or is replaced. */
  play(frames: Frame[]): Promise<void> {
    this.flushDone();
    return new Promise((resolve) => {
      this.doneResolvers.push(resolve);
      this.load(frames, true);
    });
  }

  /** Load an operation's frames, paused on the first one. */
  cue(frames: Frame[]): void {
    this.flushDone();
    this.load(frames, false);
  }

  /** Jump the current operation to its last frame. */
  finish(): void {
    this.player.finish();
    this.flushDone();
  }

  get busy(): boolean {
    return this.player.playing;
  }

  /** Number of frames in the current operation. */
  get length(): number {
    return this.player.frames.length;
  }

  pause(): void {
    this.player.pause();
  }

  /** Jump to a frame without animating. */
  seek(index: number): void {
    this.player.seek(index);
  }

  /**
   * Bring the readout, the canvas and the transport into view so the reader
   * sees the operation they just started. Runs a frame after the operation is
   * loaded, once the canvas has its height. Scrolls the least that works: just
   * enough to lift the transport clear of the bottom of the screen, but never
   * so far that the readout goes off the top. Resolves when the scroll is done.
   */
  reveal(): Promise<void> {
    return new Promise((done) => {
      // On a short screen, once the stage is in view, make sure the chip is clear of the transport too.
      const resolve = () => {
        this.followProbe(0);
        done();
      };
      requestAnimationFrame(() => {
        if (!this.root.isConnected) return resolve();
        const vh = window.innerHeight;
        const top = this.readout.getBoundingClientRect().top;
        let delta = 0;
        if (this.short.matches) {
          // A short screen: the readout sticks to the top and the transport to the bottom, so it is enough
          // that the stage fills the screen. followProbe() then keeps the chip between them.
          const st = this.root.getBoundingClientRect();
          if (st.top > 0 || st.bottom < vh) delta = st.bottom - st.top >= vh ? st.top : st.bottom - vh;
          if (st.top > 0 && delta > st.top) delta = st.top;
          return this.scrollPage(delta, resolve);
        }
        // Where the transport sits in the flow (it may be stuck to the bottom of the screen right now), under the code window if one shows.
        const win = this.code?.windowRoot;
        const above = win && win.offsetHeight > 0 ? win : this.canvasWrap;
        const bottom = above.getBoundingClientRect().bottom + this.transport.offsetHeight;
        if (top < 0) delta = top - 8;
        else if (bottom > vh) delta = Math.min(bottom - (vh - 12), top - 8);
        this.scrollPage(delta, resolve);
      });
    });
  }

  /** Scroll the page by `delta`, smoothly unless motion is reduced, then call `done`. */
  private scrollPage(delta: number, done: () => void): void {
    if (Math.abs(delta) < 1) return done();
    const smooth = !reducedMotion();
    window.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) return done();
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      window.removeEventListener('scrollend', finish);
      done();
    };
    window.addEventListener('scrollend', finish);
    window.setTimeout(finish, 900);
  }

  /**
   * On a short screen (a phone held sideways) the canvas is taller than the
   * room between the top of the screen and the stuck transport, so scroll the
   * page with the chip: on the same clock and easing as the canvas, just
   * enough to keep it clear of the transport and the top edge.
   */
  private followProbe(ms: number): void {
    cancelAnimationFrame(this.pageRaf);
    if (!matchMedia(SHORT).matches || !this.onScreen || this.loading) return;
    const p = this.renderer.probeTarget();
    if (!p) return;
    // The transport sticks to the bottom while playing; where it would sit is the screen's bottom less its height.
    const tr = this.transport.getBoundingClientRect();
    const floor = Math.min(tr.top, window.innerHeight - this.transport.offsetHeight) - 8;
    const ceil = Math.max(4, this.readout.getBoundingClientRect().bottom + 4);
    let delta = 0;
    if (p.bottom > floor) delta = p.bottom - floor;
    else if (p.top < ceil) delta = p.top - ceil;
    if (Math.abs(delta) < 1) return;
    const from = window.scrollY;
    if (ms <= 0 || reducedMotion()) {
      window.scrollTo(0, from + delta);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      window.scrollTo(0, from + delta * ease(t));
      if (t < 1) this.pageRaf = requestAnimationFrame(tick);
    };
    this.pageRaf = requestAnimationFrame(tick);
  }

  /** True when any of the stage is on screen. */
  get onScreen(): boolean {
    const r = this.root.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  /** Put keyboard focus on the play button without scrolling, or on the stage if there is nothing to play. */
  focusPlay(): void {
    if (!this.playBtn.disabled) this.playBtn.focus({ preventScroll: true });
    else {
      this.root.tabIndex = -1;
      this.root.focus({ preventScroll: true });
    }
  }

  private flushDone(): void {
    const r = this.doneResolvers;
    this.doneResolvers = [];
    for (const fn of r) fn();
  }

  // ---- readout --------------------------------------------------------------

  /**
   * The chips for one frame. Magenta only ever carries the followed key. When
   * the comparison is about something else (a derived value such as a hash or
   * a distance), the key stays on the left and the comparison follows with a
   * neutral pill for its left side.
   */
  private chips(frame: Frame, key: string | null): HTMLElement[] {
    const keyPill = (dim: boolean) => h(`span.cmp-key${dim ? '.dim' : ''}`, { title: 'The key being followed' }, key);
    const c = frame.compare;
    if (!c) return key != null ? [keyPill(true)] : [];
    const tail = [h('span.cmp-op', null, c.op), h('span.cmp-other', null, String(c.right))];
    if (key != null && String(c.left) === key) return [keyPill(false), ...tail];
    // A left side that names its subject ("70: balance +2", "h(63) = 232°") is a description, not the key:
    // set it in the text face and smaller, so the followed key keeps the weight.
    const subject = !/^-?[\d.]+$/.test(String(c.left));
    const left = h(`span.cmp-left${subject ? '.subject' : ''}`, null, String(c.left));
    return key != null ? [keyPill(false), h('span.cmp-gap'), left, ...tail] : [left, ...tail];
  }

  /**
   * Set up the readout for an operation. With no chips in any frame (a resting
   * picture) the chip row is not there at all; otherwise it is there for the
   * whole operation, so nothing below it moves between steps.
   */
  private sizeReadout(frames: Frame[]): void {
    const any = frames.some((f, i) => this.chips(f, this.keys[i]).length > 0);
    this.readout.classList.toggle('at-rest', !any);
    this.fitChips(frames);
    this.sizeMessage(frames);
  }

  /** Shrink the chips for this operation if its widest comparison would not fit across the readout. */
  private fitChips(frames: Frame[]): void {
    const room = this.readout.clientWidth - 40;
    let widest = 0;
    frames.forEach((f, i) => {
      this.measure.replaceChildren(...this.chips(f, this.keys[i]));
      widest = Math.max(widest, this.measure.scrollWidth);
    });
    this.measure.replaceChildren();
    const fit = widest > room && room > 0 ? Math.max(0.62, room / widest) : 1;
    this.readout.style.setProperty('--cmp-fit', fit.toFixed(3));
  }

  /**
   * Hold the sentence's height through an operation at its longest message,
   * but never more than the clamp allows (three lines, four on a phone; the
   * rest is in the step log and is read out in full). An operation whose
   * sentences all fit on one line keeps one line.
   */
  private sizeMessage(frames: Frame[] = this.player.frames): void {
    const msg = this.msg;
    const keep = { text: msg.textContent, verdict: msg.classList.contains('verdict') };
    msg.style.minHeight = '';
    let tallest = 0;
    for (const f of frames) {
      msg.classList.toggle('verdict', !!f.compare);
      msg.textContent = f.message;
      tallest = Math.max(tallest, msg.offsetHeight);
    }
    msg.textContent = keep.text;
    msg.classList.toggle('verdict', keep.verdict);
    if (tallest) msg.style.minHeight = `${tallest}px`;
  }

  /**
   * On a laptop the code window under the canvas takes up to eight rows, but
   * never so many that the readout, the canvas, the window and the transport
   * stop fitting on the screen together (a tall tree needs its canvas). Set
   * once per operation, so it does not change size between steps. On a phone
   * it is a fixed strip of three rows and the canvas makes room for it instead.
   */
  private sizeWindow(frames: Frame[] = this.player.frames): void {
    const win = this.code?.windowRoot;
    if (!win || win.offsetHeight === 0 || matchMedia(NARROW).matches) {
      this.root.style.removeProperty('--code-rows');
      return;
    }
    const rowH = codeRowPx();
    const used = this.readout.offsetHeight + this.canvasWrap.offsetHeight + this.transport.offsetHeight + 1;
    const head = win.querySelector<HTMLElement>('.code-head')?.offsetHeight ?? 0;
    // 8px kept above the readout and 12px under the transport, as reveal() does. At rest three rows will do.
    const rows = frames.length <= 1 ? 3 : Math.max(3, Math.min(8, Math.floor((window.innerHeight - used - head - 8 - 12) / rowH)));
    this.root.style.setProperty('--code-rows', String(rows));
  }

  /**
   * At rest (a single picture, nothing to play) the canvas takes no more
   * height than leaves the transport on screen with the page at the top, as
   * an operation's own budget does once it is scrolled into view. The
   * renderer still never lets it squeeze the picture below its minimum scale.
   * During an operation the canvas keeps its usual height.
   */
  private sizeRest(frames: Frame[]): void {
    const style = this.root.style;
    style.removeProperty('--canvas-h');
    if (frames.length > 1 || this.root.classList.contains('compact') || matchMedia(NARROW).matches || this.short.matches) return;
    const canvas = this.canvasWrap.firstElementChild as HTMLElement;
    const floor = canvas.style.minHeight;
    canvas.style.minHeight = '';
    const natural = canvas.offsetHeight;
    canvas.style.minHeight = floor;
    const win = this.code?.windowRoot;
    const rowH = codeRowPx();
    const winH = win?.isConnected ? (win.querySelector<HTMLElement>('.code-head')?.offsetHeight ?? 0) + 3 * rowH + 1 : 0;
    const top = this.root.getBoundingClientRect().top + window.scrollY;
    const budget = Math.floor(window.innerHeight - top - this.readout.offsetHeight - winH - this.transport.offsetHeight - 12);
    if (budget < natural) style.setProperty('--canvas-h', `${Math.max(160, budget)}px`);
  }

  /** Latch `wideScene` if these frames need more width than the canvas has beside the code column. */
  private checkWide(frames: Frame[]): void {
    if (!this.code || !this.logWrap) return;
    const w = this.root.clientWidth;
    if (w !== this.wideAt) {
      // A different width: judge afresh.
      this.wideAt = w;
      this.wideScene = false;
    }
    const column = Math.min(480, Math.max(380, w * 0.38));
    const room = w - column - 1;
    const need = minCanvasWidth(frames.map((f) => f.scene));
    if (!this.wideScene && need > room && need <= w - 301) {
      this.wideScene = true;
      this.syncLogPlacement(true);
    }
  }

  // ---- step log -------------------------------------------------------------

  /**
   * Where things go. From 1200px the step log is beside the canvas; with the
   * code on, from 1360px the side column widens and holds the code under the
   * log, and below that the code is a window under the canvas. Below 1200px
   * the log is the "All steps" disclosure under the counters.
   */
  private syncLogPlacement(changed: boolean): void {
    if (!this.logWrap || !this.logSummary || !this.log) return;
    const beside = this.beside.matches;
    const codeBeside = !!this.code && this.codeOn && beside && this.codeBeside.matches && !this.wideScene;
    const was = this.root.classList.contains('beside');
    this.root.classList.toggle('beside', beside);
    this.root.classList.toggle('code-beside', codeBeside);
    if (this.code) {
      // Each surface is in the page only while it shows, so the listing is never there twice for a screen reader.
      const side = this.code.root;
      if (codeBeside && !side.isConnected) this.logWrap.append(side);
      else if (!codeBeside && side.isConnected) side.remove();
      // The window sits under the canvas, above the transport, so the live line is read with the picture.
      const win = this.code.windowRoot;
      // On a short screen the window would push the transport off the screen or sit over it: leave it out and say so.
      const hidden = this.codeOn && !codeBeside && this.short.matches;
      const showWin = this.codeOn && !codeBeside && !hidden;
      if (showWin && !win.isConnected) this.canvasWrap.after(win);
      else if (!showWin && win.isConnected) win.remove();
      if (this.codeNote) this.codeNote.hidden = !hidden;
    }
    this.logSummary.textContent = beside ? 'Steps' : 'All steps';
    this.logSummary.tabIndex = beside ? -1 : 0;
    // Open beside the canvas; under it, open on a laptop and folded away on a phone.
    if (beside || !changed || was !== beside) this.logWrap.open = beside || !matchMedia(NARROW).matches;
  }

  private fillLogItem(i: number): void {
    const li = this.logItems[i];
    const f = this.player.frames[i];
    const text = f.compare
      ? [h('code', null, `${f.compare.left} ${f.compare.op} ${f.compare.right}`), ` ${f.compare.verdict}`]
      : [f.message];
    const btn = h('button', { type: 'button', tabIndex: -1, onclick: () => this.player.seek(i) }, h('span', null, ...text));
    li.className = '';
    li.replaceChildren(btn);
  }

  private logKey(e: KeyboardEvent): void {
    const btns = this.logItems.map((li) => li.querySelector('button')).filter((b): b is HTMLButtonElement => !!b);
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let next = at;
    if (e.key === 'ArrowDown') next = Math.min(btns.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    else return;
    e.preventDefault();
    btns[at].tabIndex = -1;
    btns[next].tabIndex = 0;
    btns[next].focus();
  }

  /**
   * Keep the current step in view with the one before it whole above it. The
   * list scrolls to an item's edge and its height stops at an item's edge, so
   * no step is ever shown cut in half at either end.
   */
  private scrollLog(): void {
    const log = this.log;
    if (!log || !this.logWrap?.open) return;
    const items = this.logItems;
    const index = this.player.index;
    const cur = items[index];
    if (!cur) return;
    log.style.height = '';
    const room = log.clientHeight;
    if (room === 0) return;
    const topOf = (i: number) => (i <= 0 ? 0 : items[i].offsetTop);
    const bottomOf = (i: number) => items[i].offsetTop + items[i].offsetHeight;
    const prevI = Math.max(0, index - 1);
    const st = log.scrollTop;
    let top: number;
    if (bottomOf(index) - topOf(prevI) > room) top = topOf(index);
    else if (topOf(prevI) < st) top = topOf(prevI);
    else if (bottomOf(index) > st + room) {
      // Down by whole items, as little as shows the current step.
      let i = 0;
      while (i < prevI && bottomOf(index) - topOf(i) > room) i++;
      top = topOf(i);
    } else {
      // Where the reader left it, moved on to the edge of the first item that shows whole.
      let i = 0;
      while (i < items.length - 1 && topOf(i) < st - 1) i++;
      top = topOf(i);
    }
    // Stop the view at the last item that fits whole, unless the rest of the list fits.
    let height = room;
    const rest = log.scrollHeight - top;
    if (rest > room + 1) {
      let last = -1;
      for (let i = 0; i < items.length && bottomOf(i) <= top + room; i++) last = i;
      if (last >= 0) height = bottomOf(last) - top;
    } else if (top > 0) {
      // The rest of the list fits: end the view with it, so the list can scroll as far as `top`.
      height = rest;
    }
    if (height < room) log.style.height = `${height}px`;
    if (Math.abs(top - log.scrollTop) > 1) log.scrollTo({ top, behavior: 'auto' });
    log.classList.toggle('more-up', top > 1);
    log.classList.toggle('more-down', log.scrollHeight - top - log.clientHeight > 1);
  }

  /**
   * With the code in the side column, the step log on top takes the room this
   * operation's steps need (all of them, written out), never more than about
   * 38% of the column; the code below gets the rest.
   */
  private sizeLogSplit(frames: Frame[]): void {
    const log = this.log;
    if (!log || !this.root.classList.contains('code-beside') || !this.logWrap) {
      this.root.style.removeProperty('--log-h');
      return;
    }
    const probe = h('ol.log', { 'aria-hidden': 'true', style: `position:absolute;visibility:hidden;left:0;top:0;bottom:auto;width:${log.clientWidth}px;height:auto;max-height:none` });
    for (const f of frames) {
      const text = f.compare ? [h('code', null, `${f.compare.left} ${f.compare.op} ${f.compare.right}`), ` ${f.compare.verdict}`] : [f.message];
      probe.append(h('li', null, h('button', { type: 'button', tabIndex: -1 }, h('span', null, ...text))));
    }
    this.logWrap.append(probe);
    const natural = probe.scrollHeight;
    probe.remove();
    const cap = Math.max(176, this.logWrap.clientHeight * 0.38 - 34);
    this.root.style.setProperty('--log-h', `${Math.ceil(Math.min(cap, natural))}px`);
  }

  // ---- loading and syncing --------------------------------------------------

  private load(frames: Frame[], autoplay: boolean): void {
    this.loads++;
    this.keys = followedKeys(frames);
    this.revealed = -1;
    if (this.log) {
      this.log.replaceChildren();
      this.logItems = frames.map(() => {
        const li = h('li.ahead', null, h('span.placeholder', { 'aria-hidden': 'true' }), h('span.visually-hidden', null, 'Not reached yet'));
        this.log!.append(li);
        return li;
      });
    }
    this.scrub.max = String(Math.max(0, frames.length - 1));
    this.sizeReadout(frames);
    this.checkWide(frames);
    this.sizeRest(frames);
    this.loading = true;
    this.lostFocus = false;
    this.renderer.plan(frames);
    this.sizeWindow(frames);
    this.sizeLogSplit(frames);
    this.lastIndex = -1;
    this.player.load(frames, autoplay);
    this.loading = false;
    // The canvas stopped being a scroll region while it had focus: hand focus to the transport.
    if (this.lostFocus) this.focusPlay();
    this.syncStick();
  }

  private announce(text: string): void {
    if (!this.status) return;
    const status = this.status;
    clearTimeout(this.announceTimer);
    status.textContent = '';
    this.announceTimer = window.setTimeout(() => (status.textContent = text), 60);
  }

  private sync(): void {
    const p = this.player;
    const frame = p.frames[p.index];
    if (!frame) return;
    const many = p.frames.length > 1;

    this.cmp.replaceChildren(...this.chips(frame, this.keys[p.index] ?? null));
    this.msg.classList.toggle('verdict', !!frame.compare);
    this.msg.textContent = frame.message;

    this.scrub.value = String(p.index);
    this.scrub.disabled = !many;
    this.scrub.setAttribute('aria-valuetext', many ? `Step ${p.index + 1} of ${p.frames.length}` : 'No steps yet');
    this.stepLabel.textContent = many ? `Step ${p.index + 1} of ${p.frames.length}` : 'No steps yet';
    this.playBtn.replaceChildren(icon(p.playing ? 'pause' : 'play'), this.playText);
    this.playText.textContent = p.playing ? 'Pause' : p.atEnd && many ? 'Replay' : 'Play';
    this.playBtn.disabled = !many;
    this.navBtns.restart.disabled = this.navBtns.back.disabled = !many || p.index === 0;
    this.navBtns.next.disabled = this.navBtns.end.disabled = !many || p.atEnd;

    for (const c of this.counters) {
      const elx = this.counterEls.get(c.key);
      if (elx) elx.textContent = String(frame.counters[c.key] ?? 0);
    }

    if (this.log) {
      if (p.index > this.revealed) {
        for (let i = this.revealed + 1; i <= p.index; i++) this.fillLogItem(i);
        this.revealed = p.index;
      }
      const focusInLog = this.log.contains(document.activeElement);
      this.logItems.forEach((li, i) => {
        if (i > this.revealed) return;
        const btn = li.querySelector('button')!;
        const current = i === p.index;
        li.classList.toggle('current', current);
        li.classList.toggle('past', i < p.index);
        if (current) btn.setAttribute('aria-current', 'step');
        else btn.removeAttribute('aria-current');
        // One tab stop for the whole log: the current step. Arrow keys move within it.
        if (!focusInLog) btn.tabIndex = current ? 0 : -1;
      });
      this.scrollLog();
    }
    this.code?.show(frame.lines, this.frameMs);
    this.code?.showVars(frame.vars);
    this.frameMs = 0;

    // Speak only when the reader is moving through the steps, not on every frame of playback.
    const moved = p.index !== this.lastIndex;
    const stopped = this.lastPlaying && !p.playing;
    if (!p.playing && (moved || stopped) && this.loads > 1) {
      const c = frame.compare;
      const lead = many ? `Step ${p.index + 1} of ${p.frames.length}. ` : '';
      // With the code on, say which lines are running too (the highlight itself is not announced).
      const lines = this.codeOn ? this.code?.liveText() : '';
      this.announce(lead + (c ? `${c.left} ${c.op} ${c.right}. ` : '') + frame.message + (lines ? ` Code ${lines}.` : ''));
    }
    this.lastIndex = p.index;
    this.lastPlaying = p.playing;
  }
}
