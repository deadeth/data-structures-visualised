import { h } from '../core/dom';
import { Player, SPEEDS } from '../core/player';
import { Renderer } from '../core/renderer';
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
/** Below this width the layout is a phone's. */
const NARROW = '(max-width: 899px)';

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
  private onBeside = () => this.syncLogPlacement(true);
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
  /**
   * The transport sticks to the bottom of the screen only while there is
   * something to play and the readout is clear of it, so it never sits over
   * the readout or over a canvas that has not scrolled into view yet.
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
      h('span.visually-hidden', null, 'Keyboard: Space plays or pauses, the left and right arrows step, the square brackets change speed.'),
    );

    this.countersHost = h('dl.counters');
    this.buildCounters();

    // DOM order is the reading and tab order on every width: readout, canvas, transport, counters, then the log.
    this.root = h('section.stage', { class: opts.compact ? 'compact' : '', 'aria-label': 'Animation' }, this.readout, this.canvasWrap, transport, hint, this.countersHost);
    if (!opts.compact) {
      this.log = h('ol.log', { 'aria-label': 'Steps in this operation', onkeydown: (e: KeyboardEvent) => this.logKey(e) });
      this.logSummary = h('summary.log-title', null, 'Steps');
      this.logWrap = h('details.log-wrap', null, this.logSummary, this.log);
      this.logSummary.addEventListener('click', (e) => {
        // Beside the canvas the log is a fixed panel, not a disclosure.
        if (this.beside.matches) e.preventDefault();
      });
      this.logWrap.addEventListener('toggle', () => this.scrollLog());
      this.root.append(this.logWrap);
      this.beside.addEventListener('change', this.onBeside);
      this.syncLogPlacement(false);
    }
    if (opts.live !== false) {
      this.status = h('div.visually-hidden', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      this.root.append(this.status);
    }
    host.append(this.root);

    this.renderer = new Renderer(canvas, {
      label: opts.name ? `Diagram of the ${opts.name}. The readout above it describes each step in words.` : undefined,
      // On a phone the canvas shares the screen with the readout and the transport.
      reserve: () => this.readout.offsetHeight + this.transport.offsetHeight + 24,
      onRegionLost: () => {
        if (this.loading) this.lostFocus = true;
        else this.focusPlay();
      },
    });
    this.player = new Player(
      (frame, ms) => this.renderer.show(frame, ms),
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
    const stick = this.player.frames.length > 1 && this.readout.getBoundingClientRect().bottom < room - 48;
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
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        if (!this.root.isConnected) return resolve();
        const vh = window.innerHeight;
        const top = this.readout.getBoundingClientRect().top;
        // Where the transport sits in the flow (it may be stuck to the bottom of the screen right now).
        const bottom = this.canvasWrap.getBoundingClientRect().bottom + this.transport.offsetHeight;
        let delta = 0;
        if (top < 0) delta = top - 8;
        else if (bottom > vh) delta = Math.min(bottom - (vh - 12), top - 8);
        if (Math.abs(delta) < 1) return resolve();
        const smooth = !reducedMotion();
        window.scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'auto' });
        if (!smooth) return resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          window.removeEventListener('scrollend', finish);
          resolve();
        };
        window.addEventListener('scrollend', finish);
        window.setTimeout(finish, 900);
      });
    });
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
    const left = h('span.cmp-left', null, String(c.left));
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
   * but never more than three lines (the rest is in the step log and is read
   * out in full), and at least two lines on a wide screen.
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
    if (!matchMedia(NARROW).matches) {
      msg.classList.add('verdict');
      tallest = Math.max(tallest, Math.ceil(2 * parseFloat(getComputedStyle(msg).lineHeight)));
    }
    msg.textContent = keep.text;
    msg.classList.toggle('verdict', keep.verdict);
    if (tallest) msg.style.minHeight = `${tallest}px`;
  }

  // ---- step log -------------------------------------------------------------

  private syncLogPlacement(changed: boolean): void {
    if (!this.logWrap || !this.logSummary) return;
    const beside = this.beside.matches;
    this.logSummary.textContent = beside ? 'Steps' : 'All steps';
    this.logSummary.tabIndex = beside ? -1 : 0;
    // Open beside the canvas; under it, open on a laptop and folded away on a phone.
    if (beside || !changed) this.logWrap.open = beside || !matchMedia(NARROW).matches;
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

  /** Keep the current step in view with the one before it whole above it, never cutting an item mid-line. */
  private scrollLog(): void {
    const log = this.log;
    if (!log || !this.logWrap?.open) return;
    const index = this.player.index;
    const cur = this.logItems[index];
    if (!cur || log.clientHeight === 0) return;
    const prev = this.logItems[index - 1] ?? cur;
    const edge = 16;
    const view = log.clientHeight;
    let top = log.scrollTop;
    const curBottom = cur.offsetTop + cur.offsetHeight;
    if (prev.offsetTop - edge < top) top = prev.offsetTop - edge;
    else if (curBottom + edge > top + view) {
      top = curBottom + edge - view;
      // Snap forward to an item boundary so the top item is whole, as long as the previous step stays visible.
      const first = this.logItems.find((li) => li.offsetTop + li.offsetHeight > top);
      if (first && first.offsetTop < top) top = Math.min(first.offsetTop + first.offsetHeight, prev.offsetTop - edge);
    }
    top = Math.max(0, top);
    if (Math.abs(top - log.scrollTop) > 1) log.scrollTo({ top, behavior: 'auto' });
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
    this.loading = true;
    this.lostFocus = false;
    this.renderer.plan(frames);
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

    // Speak only when the reader is moving through the steps, not on every frame of playback.
    const moved = p.index !== this.lastIndex;
    const stopped = this.lastPlaying && !p.playing;
    if (!p.playing && (moved || stopped) && this.loads > 1) {
      const c = frame.compare;
      const lead = many ? `Step ${p.index + 1} of ${p.frames.length}. ` : '';
      this.announce(lead + (c ? `${c.left} ${c.op} ${c.right}. ` : '') + frame.message);
    }
    this.lastIndex = p.index;
    this.lastPlaying = p.playing;
  }
}
