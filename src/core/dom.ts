type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript helper: h('button.primary', { type: 'button', onclick }, 'Insert'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  props: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = (spec as string).split('.');
  const e = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) e.className = classes.join(' ');
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') e.className += (e.className ? ' ' : '') + String(v);
      else if (k === 'text') e.textContent = String(v);
      else if (k === 'html') e.innerHTML = String(v);
      else if (k in e && k !== 'list' && k !== 'form') (e as unknown as Record<string, unknown>)[k] = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

export function clear(e: Element): void {
  e.replaceChildren();
}

/**
 * Set a value so that only the figures are in the mono face: "7 of 15" keeps
 * "of" in the text face, and a value that is all words ("none yet") has no
 * mono at all.
 */
export function figures(value: string): DocumentFragment {
  const out = document.createDocumentFragment();
  // A number on its own ("7", "1.83", "1,000", "50%"), not digits inside a name such as "L0".
  for (const part of value.split(/((?<![A-Za-z\d])\d+(?:[.,]\d+)*%?)/)) {
    if (!part) continue;
    out.append(/^\d/.test(part) ? h('span.fig', null, part) : h('span.word', null, part));
  }
  return out;
}

/**
 * A box that may scroll sideways. While it does, it is a named region with a
 * tab stop so it can be scrolled from the keyboard; when it fits, it is neither.
 */
export function scrollRegion<T extends HTMLElement>(box: T, label: string): T {
  const sync = () => {
    const scrolls = box.scrollWidth > box.clientWidth + 1;
    if (scrolls) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `${label}, scrolls sideways`);
    } else {
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
    }
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(box);
  return box;
}

const BIG_O = /O\((?:[^()]|\([^()]*\))*\)/g;

/** Escape our own content for innerHTML and turn "log_B n" into "log<sub>B</sub> n". */
function subs(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/_(\w)/g, '<sub>$1</sub>');
}

/**
 * Prose that mentions a cost: each big-O is kept on one line, the rest flows.
 * Input is our own content, never user text.
 */
export function maths(text: string): string {
  return subs(text).replace(BIG_O, '<span class="big-o">$&</span>');
}

/**
 * A cost in a table cell. Each big-O is set in mono and never breaks; every
 * word around it ("page reads", "worst", "amortised") is a qualifier in the
 * text face and may wrap. A cost with no big-O at all ("Not supported") is
 * words. Input is our own content, never user text.
 */
export function costHtml(text: string): string {
  const parts: string[] = [];
  let at = 0;
  let any = false;
  const words = (t: string) => {
    if (!t) return;
    // Bare punctuation and spaces between two big-Os stay as they are; words become a qualifier.
    parts.push(/[A-Za-z0-9]/.test(t) ? t.replace(/^(\s*)(.*?)(\s*)$/s, (_m, a, b, c) => `${a}<span class="qualifier">${subs(b)}</span>${c}`) : subs(t));
  };
  for (const m of text.matchAll(BIG_O)) {
    any = true;
    words(text.slice(at, m.index));
    parts.push(`<span class="big-o">${subs(m[0])}</span>`);
    at = m.index! + m[0].length;
  }
  if (!any) return `<span class="words">${subs(text)}</span>`;
  words(text.slice(at));
  return parts.join('');
}

/**
 * Give a table explicit ARIA table roles. Tables that restack on a phone use
 * display: block, and some browsers (Safari with VoiceOver) then drop the
 * table semantics unless the roles are spelled out.
 */
export function tableRoles<T extends HTMLTableElement>(table: T): T {
  table.setAttribute('role', 'table');
  for (const g of table.querySelectorAll(':scope > thead, :scope > tbody, :scope > tfoot')) g.setAttribute('role', 'rowgroup');
  for (const tr of table.querySelectorAll('tr')) tr.setAttribute('role', 'row');
  for (const th of table.querySelectorAll('th')) th.setAttribute('role', th.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader');
  for (const td of table.querySelectorAll('td')) td.setAttribute('role', 'cell');
  return table;
}
