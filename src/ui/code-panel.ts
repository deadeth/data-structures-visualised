import { LANGS, listing, tokenise, type Lang, type Listing, type Source } from '../core/code';
import { h } from '../core/dom';

const STORE = 'dsv.code.lang';

function savedLang(): Lang {
  try {
    const v = localStorage.getItem(STORE);
    if (v === 'python' || v === 'java') return v;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return 'python';
}

/**
 * The example code for the running operation, in Python or Java, with the
 * lines for the current step highlighted. It only shows what it is given: the
 * stage tells it which regions to list and which anchors are live.
 */
export class CodePanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Map<Lang, HTMLButtonElement>();
  private lang: Lang = savedLang();
  private source: Source | undefined;
  private regions: string[] | undefined;
  private current: Listing | null = null;
  private rows: HTMLElement[] = [];
  private live: string[] = [];
  private note = 'Run an operation to see the code for it here.';

  constructor() {
    const switcher = h('div.code-langs', { role: 'group', 'aria-label': 'Language' });
    for (const { id, label } of LANGS) {
      const b = h('button.code-lang', { type: 'button', 'aria-pressed': String(id === this.lang), onclick: () => this.setLang(id) }, label) as HTMLButtonElement;
      this.tabs.set(id, b);
      switcher.append(b);
    }
    this.body = h('div.code-body', { tabIndex: 0, role: 'region', 'aria-label': 'Example code for this operation' });
    this.root = h('div.code-panel', null, switcher, this.body);
    this.render();
  }

  /** Show the listing for an operation. Pass nothing when the operation has no code. */
  load(source: Source | undefined, regions: string[] | undefined, emptyNote?: string): void {
    this.source = source;
    this.regions = regions;
    this.live = [];
    if (emptyNote) this.note = emptyNote;
    this.render();
  }

  /** Highlight the lines that carry any of these anchors. */
  show(anchors: string[] | undefined): void {
    this.live = anchors ?? [];
    this.paint(true);
  }

  setLang(lang: Lang): void {
    if (lang === this.lang) return;
    this.lang = lang;
    try {
      localStorage.setItem(STORE, lang);
    } catch {
      // Not being able to remember the choice is harmless.
    }
    for (const [id, b] of this.tabs) b.setAttribute('aria-pressed', String(id === lang));
    this.render();
  }

  private render(): void {
    this.rows = [];
    this.current = null;
    if (!this.source || !this.regions?.length) {
      this.body.replaceChildren(h('p.code-empty', null, this.note));
      return;
    }
    this.current = listing(this.source[this.lang], this.lang, this.regions);
    const pre = h('pre.code', null);
    this.current.lines.forEach((text, i) => {
      const code = h('code', null);
      for (const t of tokenise(text, this.lang)) code.append(t.kind === 'plain' ? document.createTextNode(t.text) : h(`span.tok-${t.kind}`, null, t.text));
      const row = h('span.code-line', null, h('span.code-no', { 'aria-hidden': 'true' }, String(i + 1)), code);
      this.rows.push(row);
      pre.append(row);
    });
    this.body.replaceChildren(pre);
    this.paint(false);
  }

  private paint(follow: boolean): void {
    if (!this.current) return;
    const on = new Set<number>();
    for (const a of this.live) for (const i of this.current.anchors.get(a) ?? []) on.add(i);
    let first: HTMLElement | null = null;
    let last: HTMLElement | null = null;
    this.rows.forEach((row, i) => {
      const active = on.has(i);
      row.classList.toggle('on', active);
      if (active) {
        row.setAttribute('aria-current', 'true');
        first ??= row;
        last = row;
      } else {
        row.removeAttribute('aria-current');
      }
    });
    if (!first || !last) return;
    // Keep the live lines in view by scrolling the panel only, never the page.
    const box = this.body;
    const top = (first as HTMLElement).offsetTop;
    const bottom = (last as HTMLElement).offsetTop + (last as HTMLElement).offsetHeight;
    const pad = 28;
    let target = box.scrollTop;
    if (top - pad < box.scrollTop) target = Math.max(0, top - pad);
    else if (bottom + pad > box.scrollTop + box.clientHeight) target = Math.min(top - pad, bottom + pad - box.clientHeight);
    if (target !== box.scrollTop) {
      const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      box.scrollTo({ top: target, behavior: follow && !calm ? 'smooth' : 'auto' });
    }
  }
}
