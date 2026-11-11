import { LANGS, listing, tokenise, type Lang, type Listing, type Source } from '../core/code';
import { h } from '../core/dom';
import { MIN_GLIDE_MS, ease } from '../core/timing';

const STORE = 'dsv.code.lang';

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function savedLang(): Lang {
  try {
    const v = localStorage.getItem(STORE);
    if (v === 'python' || v === 'java') return v;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return 'python';
}

/** Height of one row of code in CSS px: 0.75rem at 1.65, rounded to whole pixels as --code-row is in the CSS. */
export function codeRowPx(): number {
  const rem = typeof document === 'undefined' ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.round(0.75 * 1.65 * rem);
}

/** Sorted line indexes grouped into runs of consecutive lines. */
export function runsOf(lines: number[]): number[][] {
  const out: number[][] = [];
  for (const i of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else out.push([i]);
  }
  return out;
}

/** Line numbers as a reader would say them: "line 16", "lines 16 to 20", "lines 34 to 35 and 61 to 62". Numbers are 1-based. */
export function describeLines(numbers: number[]): string {
  const runs = runsOf(numbers);
  if (!runs.length) return '';
  const parts = runs.map((r) => (r.length === 1 ? String(r[0]) : `${r[0]} to ${r[r.length - 1]}`));
  const single = runs.length === 1 && runs[0].length === 1;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${single ? 'line' : 'lines'} ${list}`;
}

/** A line that only comments or documents, so not the signature of the function it opens. */
const isNote = (text: string) => /^\s*(#|\/\/|\/\*|\*|"""|@)/.test(text);

/**
 * One surface showing a listing: the full listing beside or under the stage,
 * or the short window under the canvas that follows the live lines. Both
 * follow the live lines with the canvas's own clock and easing, never move
 * the page, and say when highlighted lines are out of view.
 */
export class CodeView {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  private rows: HTMLElement[] = [];
  private lines: string[] = [];
  private starts: number[] = [];
  private on: number[] = [];
  /** A line of the last anchor the frame named: the lines that change the picture. */
  private focus = -1;
  private readonly up: HTMLButtonElement;
  private readonly down: HTMLButtonElement;
  private raf = 0;
  private moreRaf = 0;
  private lastSet = -1;
  private scrolls = false;

  constructor(private readonly kind: 'full' | 'window') {
    this.body = h(kind === 'full' ? 'div.code-body' : 'div.code-window-body', null);
    this.up = h('button.code-more.up', { type: 'button', hidden: true, onclick: () => this.reveal(-1) });
    this.down = h('button.code-more.down', { type: 'button', hidden: true, onclick: () => this.reveal(1) });
    this.root = h(kind === 'full' ? 'div.code-view' : 'div.code-window-view', null, this.body, h('div.code-mores', null, this.up, this.down));
    this.body.addEventListener('scroll', () => this.queueMore(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      let last = 0;
      new ResizeObserver(() => {
        const size = this.body.clientHeight * 10000 + this.body.clientWidth;
        if (size === last) return;
        last = size;
        // Shown again, or resized: settle on the live lines at once.
        this.syncScrollable();
        this.follow(0);
      }).observe(this.body);
      if (kind === 'full') {
        // The side column's listing is as tall as the column allows, in whole rows, so its bottom never cuts a row.
        new ResizeObserver(() => {
          const room = this.root.clientHeight;
          // One more pixel for the rule along its top.
          if (room > 0) this.body.style.height = `${Math.floor((room - 1) / codeRowPx()) * codeRowPx() + 1}px`;
        }).observe(this.root);
      }
    }
  }

  /** True while the surface is laid out (the window is hidden on wide screens and in Steps view). */
  get visible(): boolean {
    return this.body.clientHeight > 0;
  }

  render(current: Listing | null, lang: Lang, empty: string, note: string | null): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.rows = [];
    this.on = [];
    this.lines = current?.lines ?? [];
    this.starts = current?.starts ?? [];
    if (!current) {
      this.body.replaceChildren(h('p.code-empty', null, empty));
    } else {
      const pre = h('pre.code', null);
      current.lines.forEach((text, i) => {
        // A hanging indent: the line starts at its own indent and anything that wraps hangs 2ch deeper,
        // so block structure survives a narrow column. The spaces stay in the text (at no width) so a copy keeps them.
        const n = text.length - text.trimStart().length;
        const code = h('code', null);
        // The indent's width is set in CSS from --ind (in characters), so a phone can halve it.
        code.style.setProperty('--ind', String(n));
        if (n) code.append(h('span.code-indent', null, text.slice(0, n)));
        for (const t of tokenise(text.slice(n), lang)) code.append(t.kind === 'plain' ? document.createTextNode(t.text) : h(`span.tok-${t.kind}`, null, t.text));
        // A blank line holds a newline-free space so a copied listing keeps the blank line between functions.
        if (!text) code.append(h('span.code-indent', null, ' '));
        const row = h('span.code-line', null, h('span.code-no', { 'aria-hidden': 'true' }, String(i + 1)), code);
        this.rows.push(row);
        pre.append(row);
      });
      this.body.replaceChildren(...(note && this.kind === 'full' ? [h('p.code-note', null, note)] : []), pre);
    }
    this.body.scrollTop = 0;
    this.syncScrollable();
    this.syncMore();
  }

  /** Light these lines. `focus` is a line of the last-named anchor. Follows them over `ms`. */
  paint(on: number[], focus: number, ms: number): void {
    const now = new Set(on);
    this.rows.forEach((row, i) => {
      const active = now.has(i);
      if (active === row.classList.contains('on')) return;
      row.classList.toggle('on', active);
      // aria-current is pruned from the accessibility tree on a plain span, so say it in words.
      if (active) row.prepend(h('span.code-running.visually-hidden', null, 'Running: '));
      else row.querySelector('.code-running')?.remove();
    });
    this.on = [...now].sort((a, b) => a - b);
    this.focus = focus;
    this.follow(ms);
  }

  private top(i: number): number {
    return this.rows[i].offsetTop;
  }

  private bottom(i: number): number {
    return this.rows[i].offsetTop + this.rows[i].offsetHeight;
  }

  private get pad(): number {
    return this.kind === 'window' ? 0 : Math.min(24, this.body.clientHeight * 0.08);
  }

  /** Bring the live lines into view if they are not, over `ms`. */
  follow(ms: number): void {
    const view = this.body.clientHeight;
    if (!this.rows.length || !this.on.length || view < 4) {
      this.syncMore();
      return;
    }
    const runs = runsOf(this.on);
    const pad = this.pad;
    const first = runs[0][0];
    const last = runs[runs.length - 1][runs[runs.length - 1].length - 1];
    // Every run together if they fit; otherwise the run with the lines that change the picture.
    let run = [first, last];
    if (this.bottom(last) - this.top(first) > view - pad * 2) {
      const r = runs.find((x) => x.includes(this.focus)) ?? runs[runs.length - 1];
      run = [r[0], r[r.length - 1]];
    }
    const st = this.body.scrollTop;
    if (this.top(run[0]) >= st + pad - 1 && this.bottom(run[1]) <= st + view - pad + 1) {
      this.syncMore();
      return;
    }
    // Lines wholly out of view: ease out, so they arrive at once and slow into place, rather than starting slowly off screen.
    const outside = this.bottom(run[1]) <= st || this.top(run[0]) >= st + view;
    this.glide(this.place(run[0], run[1]), ms, outside);
  }

  /**
   * Where to scroll so lines a to b show: the first about 30% down, the
   * enclosing function's signature kept in view when it fits, and no row cut
   * in half at the top.
   */
  private place(a: number, b: number): number {
    const view = this.body.clientHeight;
    const pad = this.pad;
    const bt = this.top(a);
    const bb = this.bottom(b);
    const lead = Math.max(0, Math.min(view * 0.3, view - (bb - bt) - pad));
    let target = bt - lead;
    let sig = -1;
    for (const s of this.starts) if (s <= a) sig = s;
    if (sig >= 0) {
      while (sig < a && isNote(this.lines[sig])) sig++;
      if (bb - this.top(sig) + pad * 2 <= view) target = Math.min(target, this.top(sig) - pad);
    }
    const max = Math.max(0, this.body.scrollHeight - view);
    target = Math.max(0, Math.min(max, target));
    // Rows are a fraction of a pixel tall, so neighbours can overlap by less than a pixel: allow for it.
    const cut = this.rows.find((r) => r.offsetTop < target - 1 && r.offsetTop + r.offsetHeight > target + 1);
    if (cut) {
      const upTo = cut.offsetTop;
      const downTo = cut.offsetTop + cut.offsetHeight;
      target = bb <= upTo + view + 1 || downTo > bt + 1 ? upTo : downTo;
    }
    return Math.round(Math.max(0, Math.min(max, target)));
  }

  /** Scroll the surface (never the page) to `target`, on the canvas's clock when there is time to see it. */
  private glide(target: number, ms: number, out = false): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const body = this.body;
    const from = body.scrollTop;
    const d = target - from;
    if (Math.abs(d) < 1) return this.syncMore();
    if (ms < MIN_GLIDE_MS || Math.abs(d) > body.clientHeight || reducedMotion()) {
      body.scrollTop = target;
      return this.syncMore();
    }
    const t0 = performance.now();
    this.lastSet = from;
    const tick = (now: number) => {
      // The reader took over: stop steering.
      if (Math.abs(body.scrollTop - this.lastSet) > 2) {
        this.raf = 0;
        return this.syncMore();
      }
      const t = Math.min(1, (now - t0) / ms);
      body.scrollTop = from + d * (out ? 1 - (1 - t) ** 3 : ease(t));
      this.lastSet = body.scrollTop;
      if (t < 1) this.raf = requestAnimationFrame(tick);
      else {
        this.raf = 0;
        this.syncMore();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Scroll to the nearest highlighted run out of view above (-1) or below (1). */
  private reveal(dir: -1 | 1): void {
    const st = this.body.scrollTop;
    const view = this.body.clientHeight;
    const runs = runsOf(this.on);
    const out = dir < 0 ? runs.filter((r) => this.top(r[0]) < st - 2).pop() : runs.find((r) => this.bottom(r[r.length - 1]) > st + view + 2);
    if (!out) return;
    const btn = dir < 0 ? this.up : this.down;
    this.glide(this.place(out[0], out[out.length - 1]), reducedMotion() ? 0 : 320);
    // If the pressed control goes away, keep focus on its twin rather than losing it.
    const keep = () => {
      if (document.activeElement === document.body || btn.hidden) {
        const other = dir < 0 ? this.down : this.up;
        if (btn.hidden && !other.hidden) other.focus({ preventScroll: true });
      }
    };
    window.setTimeout(keep, reducedMotion() ? 0 : 360);
  }

  private queueMore(): void {
    cancelAnimationFrame(this.moreRaf);
    this.moreRaf = requestAnimationFrame(() => this.syncMore());
  }

  /** Say how many highlighted lines are out of view, on the edge where they are. */
  private syncMore(): void {
    let above = 0;
    let below = 0;
    const view = this.body.clientHeight;
    if (view > 4 && this.rows.length) {
      const st = this.body.scrollTop;
      for (const i of this.on) {
        if (this.top(i) < st - 2) above++;
        else if (this.bottom(i) > st + view + 2) below++;
      }
    }
    const set = (b: HTMLButtonElement, n: number, where: string, arrow: string) => {
      b.hidden = n === 0;
      if (!n) return;
      // The name starts with the visible words, so speech input can use them.
      const label = `${n} more ${where}: highlighted line${n === 1 ? '' : 's'} out of view`;
      if (b.getAttribute('aria-label') === label) return;
      b.setAttribute('aria-label', label);
      b.replaceChildren(h('span', { 'aria-hidden': 'true' }, arrow), ` ${n} more ${where}`);
    };
    set(this.up, above, 'above', '↑');
    set(this.down, below, 'below', '↓');
  }

  /** A tab stop and a region only while the listing actually scrolls, so it can be read from the keyboard. */
  private syncScrollable(): void {
    const scrolls = this.body.scrollHeight > this.body.clientHeight + 1 && this.body.clientHeight > 0;
    if (scrolls === this.scrolls) return;
    this.scrolls = scrolls;
    if (scrolls) {
      this.body.setAttribute('tabindex', '0');
      this.body.setAttribute('role', 'region');
      this.body.setAttribute('aria-label', this.kind === 'full' ? 'Example code for this operation' : 'Example code for this operation. It follows the running line; scroll to read the rest.');
    } else {
      this.body.removeAttribute('tabindex');
      this.body.removeAttribute('role');
      this.body.removeAttribute('aria-label');
    }
  }
}

/**
 * The example code for the running operation, in Python or Java, with the
 * lines for the current step highlighted. It only shows what it is given: the
 * stage tells it which regions to list and which anchors are live. It drives
 * two surfaces, each with a small header holding the language switch: the
 * listing in the side column on wide screens (`root`), and the window under
 * the canvas below that (`windowRoot`). The stage puts one of them in the page.
 */
export class CodePanel {
  readonly root: HTMLElement;
  readonly windowRoot: HTMLElement;
  readonly full = new CodeView('full');
  readonly window = new CodeView('window');
  private readonly tabs: { id: Lang; b: HTMLButtonElement }[] = [];
  private lang: Lang = savedLang();
  private source: Source | undefined;
  private regions: string[] | undefined;
  private current: Listing | null = null;
  private live: string[] = [];
  private empty = 'Run an operation to see the code for it here.';
  private note: string | null = null;

  constructor() {
    const header = () => {
      const switcher = h('div.code-langs', { role: 'group', 'aria-label': 'Code language' });
      for (const { id, label } of LANGS) {
        const b = h('button.code-lang', { type: 'button', 'aria-pressed': String(id === this.lang), onclick: () => this.setLang(id) }, label) as HTMLButtonElement;
        this.tabs.push({ id, b });
        switcher.append(b);
      }
      return h('div.code-head', null, h('span.code-title', null, 'Code'), switcher);
    };
    this.root = h('div.code-panel', null, header(), this.full.root);
    this.windowRoot = h('div.code-window', null, header(), this.window.root);
    this.render();
  }

  /**
   * Show the listing for an operation. Pass no regions when it has none.
   * With `rest` set nothing is running yet: the listing shows unlit, under a note.
   */
  load(source: Source | undefined, regions: string[] | undefined, opts: { empty?: string; rest?: boolean } = {}): void {
    this.source = source;
    this.regions = regions;
    this.live = [];
    if (opts.empty) this.empty = opts.empty;
    this.note = opts.rest ? 'The lines for each step light up as it plays.' : null;
    this.render();
  }

  /** Highlight the lines that carry any of these anchors, following them over `ms`. */
  show(anchors: string[] | undefined, ms = 0): void {
    this.live = anchors ?? [];
    this.paint(ms);
  }

  /** The live lines as a reader would say them, or '' when none are lit. */
  liveText(): string {
    const on = this.lit();
    return on.length ? describeLines(on.map((i) => i + 1)) : '';
  }

  setLang(lang: Lang): void {
    if (lang === this.lang) return;
    this.lang = lang;
    try {
      localStorage.setItem(STORE, lang);
    } catch {
      // Not being able to remember the choice is harmless.
    }
    for (const { id, b } of this.tabs) b.setAttribute('aria-pressed', String(id === lang));
    this.render();
  }

  private lit(): number[] {
    if (!this.current) return [];
    const on = new Set<number>();
    for (const a of this.live) for (const i of this.current.anchors.get(a) ?? []) on.add(i);
    return [...on];
  }

  private render(): void {
    this.current = this.source && this.regions?.length ? listing(this.source[this.lang], this.lang, this.regions) : null;
    for (const v of [this.full, this.window]) v.render(this.current, this.lang, this.empty, this.note);
    this.paint(0);
  }

  private paint(ms: number): void {
    if (!this.current) return;
    let focus = -1;
    for (let k = this.live.length - 1; k >= 0 && focus < 0; k--) focus = this.current.anchors.get(this.live[k])?.[0] ?? -1;
    const on = this.lit();
    for (const v of [this.full, this.window]) v.paint(on, focus, ms);
  }
}
