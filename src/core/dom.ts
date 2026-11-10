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
