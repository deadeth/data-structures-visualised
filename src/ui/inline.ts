import { h } from '../core/dom';

/**
 * Inline markup shared by the reading pages and the course: **bold**, `code` and [label](#/...) links.
 * Nothing else is parsed; a link that is not a site address stays as text.
 */
export function inline(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h('strong', null, inline(m[1])));
    else if (m[2] !== undefined) out.push(h('code', null, m[2]));
    else if (m[4].startsWith('#/')) out.push(h('a', { href: m[4] }, inline(m[3])));
    else out.push(...inline(m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
