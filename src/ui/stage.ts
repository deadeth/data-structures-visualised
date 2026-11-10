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

export interface StageOptions {
  /** Smaller canvas and no step log. Used for the demo on the home page. */
  compact?: boolean;
  counters: { key: string; label: string }[];
}

/**
 * The instrument: comparison readout, canvas, step log, transport and counters.
 * Give it frames and it plays them. It owns no data structure logic.
 */
export class Stage {
  readonly root: HTMLElement;
  private renderer: Renderer;
  private player: Player;
  private counters: { key: string; label: string }[];
  private cmp: HTMLElement;
  private msg: HTMLElement;
  private log: HTMLOListElement | null = null;
  private logItems: HTMLElement[] = [];
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

  constructor(host: HTMLElement, opts: StageOptions) {
    this.counters = opts.counters;

    this.cmp = h('div.readout-cmp', { 'aria-live': 'off' });
    this.msg = h('p.readout-msg', { 'aria-live': 'polite' });
    const readout = h('div.readout', null, this.cmp, this.msg);

    const canvas = h('div.canvas');
    const body = h('div.stage-body', null, canvas);
    if (!opts.compact) {
      this.log = h('ol.log', { 'aria-label': 'Steps in this operation' });
      body.append(h('div.log-wrap', null, h('h3.log-title', null, 'Steps'), this.log));
    }

    const nav = (name: 'restart' | 'back' | 'next' | 'end', label: string, fn: () => void) =>
      h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: fn }, icon(name));
    this.navBtns = {
      restart: nav('restart', 'Back to the first step', () => this.player.seek(0)),
      back: nav('back', 'Step back (left arrow)', () => this.player.step(-1)),
      next: nav('next', 'Step forward (right arrow)', () => this.player.step(1)),
      end: nav('end', 'Skip to the last step', () => this.player.finish()),
    };
    this.playText = h('span', null, 'Play');
    this.playBtn = h('button.play-btn', { type: 'button', title: 'Play or pause (space)', onclick: () => this.player.toggle() }, icon('play'), this.playText);
    this.scrub = h('input.scrub', {
      type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': 'Step',
      oninput: () => this.player.seek(Number(this.scrub.value)),
    });
    this.stepLabel = h('span.step-label');
    const speed = h('div.speed', { role: 'group', 'aria-label': 'Playback speed' }, h('span.speed-label', null, 'Speed'));
    for (const s of SPEEDS) {
      const b = h('button.speed-btn', { type: 'button', 'aria-pressed': 'false', onclick: () => this.setSpeed(s) }, `${s}×`);
      this.speedBtns.push(b);
      speed.append(b);
    }
    const transport = h(
      'div.transport', null,
      h('div.transport-nav', null, this.navBtns.restart, this.navBtns.back, this.playBtn, this.navBtns.next, this.navBtns.end),
      h('div.transport-scrub', null, this.scrub, this.stepLabel),
      speed,
    );

    this.countersHost = h('dl.counters');
    this.buildCounters();

    this.root = h('section.stage', { class: opts.compact ? 'compact' : '', 'aria-label': 'Animation' }, readout, body, transport, this.countersHost);
    host.append(this.root);

    this.renderer = new Renderer(canvas);
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
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.root.isConnected) return;
      if (e.key === ' ') {
        e.preventDefault();
        this.player.toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.player.step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.player.step(-1);
      } else if (e.key === ']' || e.key === '[') {
        const i = (SPEEDS as readonly number[]).indexOf(this.player.speed) + (e.key === ']' ? 1 : -1);
        if (i >= 0 && i < SPEEDS.length) this.setSpeed(SPEEDS[i]);
      }
    };
    document.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey);
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

  private flushDone(): void {
    const r = this.doneResolvers;
    this.doneResolvers = [];
    for (const fn of r) fn();
  }

  private load(frames: Frame[], autoplay: boolean): void {
    if (this.log) {
      this.log.replaceChildren();
      this.logItems = frames.map((f, i) => {
        const text = f.compare
          ? [h('code', null, `${f.compare.left} ${f.compare.op} ${f.compare.right}`), ` ${f.compare.verdict}`]
          : [f.message];
        const btn = h('button', { type: 'button', onclick: () => this.player.seek(i) }, h('span', null, ...text));
        const li = h('li', null, btn);
        this.log!.append(li);
        return li;
      });
    }
    this.scrub.max = String(Math.max(0, frames.length - 1));
    this.player.load(frames, autoplay);
  }

  private sync(): void {
    const p = this.player;
    const frame = p.frames[p.index];
    if (!frame) return;
    const many = p.frames.length > 1;

    // Left of the readout: the key being followed, and what it is being compared with right now.
    this.cmp.replaceChildren();
    if (frame.compare) {
      const c = frame.compare;
      this.cmp.append(
        h('span.cmp-key', { title: 'The key being followed' }, String(c.left)),
        h('span.cmp-op', null, c.op),
        h('span.cmp-other', null, String(c.right)),
      );
    } else if (frame.probe) {
      this.cmp.append(h('span.cmp-key', { title: 'The key being followed' }, frame.probe.text));
    }
    this.msg.classList.toggle('verdict', !!frame.compare);
    this.msg.textContent = frame.message;

    this.scrub.value = String(p.index);
    this.scrub.disabled = !many;
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
      this.logItems.forEach((li, i) => {
        li.classList.toggle('current', i === p.index);
        li.classList.toggle('past', i < p.index);
      });
      const cur = this.logItems[p.index];
      if (cur) {
        const top = cur.offsetTop;
        const wantTop = top - this.log.clientHeight / 2 + cur.offsetHeight / 2;
        this.log.scrollTo({ top: Math.max(0, wantTop), behavior: 'auto' });
      }
    }
  }
}
