import { CATALOG, isReady, loadStructure } from '../catalog';
import { h } from '../core/dom';
import { MODES } from '../designs/types';
import { slug } from './design-page';

interface Doc {
  kind: 'Term' | 'Component' | 'Connection' | 'Tour step' | 'Structure';
  title: string;
  /** Other names that should find this entry. */
  also: string[];
  text: string;
  href: string;
  /** Shown under the title: where the entry lives. */
  where: string;
}

let index: Promise<Doc[]> | null = null;

/** Everything on the site that can be looked up, built the first time someone searches. */
function build(): Promise<Doc[]> {
  index ??= (async () => {
    const docs: Doc[] = [];
    const { webCrawler: d } = await import('../designs/web-crawler');
    const base = '#/d/web-crawler';
    const name = (id: string) => d.components.find((c) => c.id === id)!.name;
    for (const g of d.glossary) {
      docs.push({ kind: 'Term', title: g.term, also: g.also ?? [], text: g.text, href: `${base}/g/${slug(g.term)}`, where: g.where ? `Glossary. Used in ${name(g.where)}.` : 'Glossary' });
    }
    for (const c of d.components) {
      docs.push({
        kind: 'Component',
        title: c.name,
        also: [c.tech, ...c.alternatives.map((a) => a.name)],
        text: [c.what, c.why, c.fails, ...(c.numbers ?? []), ...c.alternatives.map((a) => `${a.name}. ${a.good} ${a.cost}`), c.say].join(' '),
        href: `${base}/c/${c.id}`,
        where: `${d.name}: component`,
      });
    }
    for (const f of d.flows) {
      docs.push({
        kind: 'Connection',
        title: `${name(f.from)} to ${name(f.to)}`,
        also: [f.via, MODES.find((m) => m.id === f.mode)!.label],
        text: [f.how, f.delivery, ...f.alts].join(' '),
        href: `${base}/f/${f.id}`,
        where: `${d.name}: connection by ${f.via}`,
      });
    }
    d.tour.forEach((t, i) => docs.push({ kind: 'Tour step', title: t.title, also: [], text: t.text, href: base, where: `${d.name}: tour step ${i + 1}` }));
    for (const dec of d.decisions) docs.push({ kind: 'Term', title: dec.choice, also: [], text: `${dec.a} ${dec.b} ${dec.call}`, href: base, where: `${d.name}: decisions worth defending` });

    await Promise.all(
      CATALOG.filter((c) => isReady(c.id)).map(async (c) => {
        const def = await loadStructure(c.id);
        const i = def.info;
        docs.push({
          kind: 'Structure',
          title: c.name,
          also: [c.group, ...i.usedIn.map((u) => u.name)],
          text: [c.blurb, i.summary, ...i.watch, ...i.usedIn.map((u) => `${u.name}: ${u.how}`), ...i.reachFor, ...i.costs, ...i.interview, i.space].join(' '),
          href: `#/s/${c.id}`,
          where: `Data structure: ${c.group.toLowerCase()}`,
        });
      }),
    );
    return docs;
  })();
  return index;
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function score(doc: Doc, words: string[]): number {
  const title = fold(doc.title);
  const also = fold(doc.also.join(' | '));
  const text = fold(doc.text);
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (title === w) s = 120;
    else if (title.startsWith(w)) s = 90;
    else if (title.includes(w)) s = 70;
    else if (fold(doc.also[0] ?? '').includes(w)) s = 60;
    else if (also.includes(w)) s = 45;
    else if (text.includes(w)) s = 15;
    // A text that keeps coming back to the word is more about it than one that mentions it once.
    if (s) s += Math.min(5, text.split(w).length - 1);
    // Every word must be found somewhere, or the entry is not a match.
    if (!s) return 0;
    total += s;
  }
  if (doc.kind === 'Term') total += 8;
  return total;
}

/** A stretch of the text around the first match, with every match marked. */
function excerpt(text: string, words: string[], whole: boolean): (string | HTMLElement)[] {
  const lower = fold(text);
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let from = 0;
  let to = text.length;
  if (!whole) {
    from = Math.max(0, (at < 0 ? 0 : at) - 90);
    to = Math.min(text.length, from + 260);
    while (from > 0 && text[from - 1] !== ' ') from--;
    while (to < text.length && text[to] !== ' ') to++;
  }
  const piece = text.slice(from, to);
  const low = fold(piece);
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) marks.push([i, i + w.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: (string | HTMLElement)[] = [from > 0 ? '… ' : ''];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out.push(piece.slice(pos, a), h('mark', null, piece.slice(a, b)));
    pos = b;
  }
  out.push(piece.slice(pos), to < text.length ? ' …' : '');
  return out;
}

/**
 * One live region for the whole site, outside the page that search rebuilds,
 * so a screen reader hears the result count once the typing pauses rather than
 * a fresh region on every keystroke.
 */
let live: HTMLElement | null = null;
let liveTimer = 0;
function announce(text: string): void {
  if (!live || !live.isConnected) {
    live = h('p.visually-hidden', { id: 'search-status', role: 'status', 'aria-live': 'polite' });
    document.body.append(live);
  }
  clearTimeout(liveTimer);
  liveTimer = window.setTimeout(() => {
    live!.textContent = text;
  }, 700);
}

const has = (s: string, words: string[]) => {
  const f = fold(s);
  return words.some((w) => f.includes(w));
};

const SUGGEST = ['SimHash', 'Bloom filter', 'lease', 'Kafka', 'robots.txt', 'SSRF', 'WARC', 'idempotent', 'B+ tree', 'eviction'];

/** The results page. The search box itself lives in the sidebar and drives this through the address. */
export async function mountSearch(host: HTMLElement, query: string): Promise<() => void> {
  const q = query.trim();
  const words = fold(q).split(/\s+/).filter(Boolean);
  const list = h('ol.search-results', null);
  const summary = h('p.search-summary', null, q ? 'Searching…' : 'Type in the search box to look something up.');
  const tries = h(
    'p.search-tries', null, 'Try: ',
    SUGGEST.flatMap((s, i) => [i ? ', ' : '', h('a', { href: `#/search/${encodeURIComponent(s)}` }, s)]),
  );
  const page = h('article.search-page', null, h('header.page-head', null, h('h1', null, q ? `Search: ${q}` : 'Search')), summary, list, tries);
  host.append(page);

  if (words.length) {
    const docs = await build();
    const hits = docs
      .map((d) => ({ d, s: score(d, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.d.title.localeCompare(b.d.title))
      .slice(0, 40);
    summary.textContent = hits.length ? `${hits.length === 40 ? 'The best 40 matches' : hits.length === 1 ? '1 match' : `${hits.length} matches`} across the glossary, the system design and the data structures.` : `Nothing matches "${q}". Check the spelling, or try a shorter word.`;
    announce(summary.textContent);
    for (const { d } of hits) {
      // When the match is in another name for the entry (a technology, an alternative) and not its text, show that name, marked.
      const inText = has(d.text, words);
      const other = !inText && !has(d.title, words) ? d.also.find((a) => has(a, words)) : undefined;
      list.append(
        h(
          'li', null,
          h('p.search-kind', null, d.kind),
          h('h2', null, h('a', { href: d.href }, excerpt(d.title, words, true))),
          other ? h('p.search-also', null, 'Also: ', excerpt(other, words, true)) : null,
          h('p.search-text', null, excerpt(d.text, words, d.kind === 'Term')),
          h('p.search-where', null, d.where),
        ),
      );
    }
  } else announce(summary.textContent ?? '');
  return () => page.remove();
}
