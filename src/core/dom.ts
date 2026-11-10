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
