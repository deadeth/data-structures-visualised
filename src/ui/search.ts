import { DESIGNS } from '../designs';
import { CATALOG, isReady, loadStructure } from '../catalog';
import { h } from '../core/dom';
import { MODES } from '../designs/types';
import { slug } from './design-page';

interface Doc {
  kind: 'Term' | 'Component' | 'Connection' | 'Tour step' | 'Decision' | 'Interview question' | 'Structure';
  title: string;
  /** Other names that should find this entry. */
  also: string[];
  text: string;
  href: string;
  /** Shown under the title: where the entry lives. */
  where: string;
  /** The design it belongs to, named in the link so two results with one title can be told apart. */
  from?: string;
}

let index: Promise<Doc[]> | null = null;

/** Everything on the site that can be looked up, built the first time someone searches. */
function build(): Promise<Doc[]> {
  index ??= (async () => {
    const docs: Doc[] = [];
    for (const entry of DESIGNS) {
    const d = await entry.load();
    const base = `#/d/${d.id}`;
    const name = (id: string) => d.components.find((c) => c.id === id)!.name;
    for (const g of d.glossary) {
      docs.push({ kind: 'Term', title: g.term, also: g.also ?? [], text: g.text, href: `${base}/g/${slug(g.term)}`, where: g.where ? `Glossary. Used in ${name(g.where)}.` : 'Glossary', from: d.name });
    }
    for (const c of d.components) {
      docs.push({
        kind: 'Component',
        title: c.name,
        also: [c.tech, ...c.alternatives.map((a) => a.name)],
        text: [c.what, c.why, c.fails, ...(c.numbers ?? []), ...c.alternatives.map((a) => `${a.name}. ${a.good} ${a.cost}`), c.say].join(' '),
        href: `${base}/c/${c.id}`,
        where: `${d.name}: component`,
        from: d.name,
      });
    }
    for (const f of d.flows) {
      const mode = MODES.find((m) => m.id === f.mode)!.label;
      docs.push({
        kind: 'Connection',
        title: `${name(f.from)} to ${name(f.to)}`,
        also: [f.via, mode, ...(f.label ? [f.label] : []), ...(f.travels ? [f.travels] : [])],
        text: [f.how, f.delivery, ...f.alts].join(' '),
        href: `${base}/f/${f.id}`,
        where: `${d.name}: connection by ${f.via}`,
        from: d.name,
      });
      // The reply on a two-way line is found on its own, and opens the same line.
      if (f.reply) {
        docs.push({
          kind: 'Connection',
          title: `${name(f.to)} to ${name(f.from)}`,
          also: [f.via, mode, f.reply.label],
          text: [f.reply.how, f.reply.delivery].join(' '),
          href: `${base}/f/${f.reply.id}`,
          where: `${d.name}: the reply on the ${f.via} line`,
          from: d.name,
        });
      }
    }
    d.tour.forEach((t, i) => docs.push({ kind: 'Tour step', title: t.title, also: [], text: t.text, href: `${base}/t/${i + 1}`, where: `${d.name}: tour step ${i + 1}`, from: d.name }));
    for (const dec of d.decisions) docs.push({ kind: 'Decision', title: dec.choice, also: [], text: `${dec.a} ${dec.b} ${dec.call}`, href: base, where: `${d.name}: decisions worth defending`, from: d.name });
    // Likely pushes from the design's interview extras, when written: each opens its question in the "Likely pushes" section.
    const ex = await entry.extras?.().catch(() => undefined);
    ex?.pushes.forEach((p, i) => docs.push({ kind: 'Interview question', title: p.q, also: [], text: p.a.join(' '), href: `${base}/q/${i + 1}`, where: `${d.name}: likely pushes`, from: d.name }));
    }

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

/** Where a word is found in a text: at the start of one of its words (a whole word, or one being typed), only inside one, or not at all. */
function found(hay: string, w: string): 'word' | 'inside' | null {
  let i = hay.indexOf(w);
  if (i < 0) return null;
  for (; i >= 0; i = hay.indexOf(w, i + 1)) if (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1])) return 'word';
  return 'inside';
}

function score(doc: Doc, words: string[]): number {
  const title = fold(doc.title);
  const also = fold(doc.also.join(' | '));
  const first = fold(doc.also[0] ?? '');
  const text = fold(doc.text);
  let total = 0;
  for (const w of words) {
    let s = 0;
    // A word found at the start of a word counts for far more than the same letters inside another ("lease" in "release").
    const t = found(title, w);
    const f = found(first, w);
    const a = found(also, w);
    const x = found(text, w);
    if (title === w) s = 120;
    else if (title.startsWith(w)) s = 90;
    else if (t === 'word') s = 70;
    else if (f === 'word') s = 60;
    else if (a === 'word') s = 45;
    else if (x === 'word') s = 15;
    else if (t) s = 12;
    else if (f || a) s = 8;
    else if (x) s = 4;
    // A text that keeps coming back to the word is more about it than one that mentions it once.
    if (s) s += Math.min(5, text.split(w).length - 1);
    // Every word must be found somewhere, or the entry is not a match.
    if (!s) return 0;
    total += s;
  }
  if (doc.kind === 'Term') total += 8;
  return total;
}

/** The four-word runs in a stretch of text, folded, for spotting a phrase said twice. */
const grams = (t: string) => {
  const w = fold(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(' '));
  return out;
};

/**
 * A stretch of the text with every match marked. It starts at the sentence
 * that holds the first match and runs on a sentence at a time to about 260
 * characters, leaving out any sentence that repeats a phrase already shown.
 */
function excerpt(text: string, words: string[], whole: boolean): (string | HTMLElement)[] {
  let piece = text;
  let before = false;
  let after = false;
  if (!whole) {
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [text];
    let first = sentences.findIndex((x) => words.some((w) => fold(x).includes(w)));
    if (first < 0) first = 0;
    const kept: string[] = [];
    const seen = new Set<string>();
    let length = 0;
    for (let i = first; i < sentences.length && length < 260; i++) {
      const g = grams(sentences[i]);
      if ([...g].some((x) => seen.has(x))) continue;
      g.forEach((x) => seen.add(x));
      kept.push(sentences[i]);
      length += sentences[i].length;
    }
    piece = kept.join('').trim();
    // One long sentence is cut at a word near 300 characters.
    if (piece.length > 300) {
      let to = 280;
      while (to < piece.length && piece[to] !== ' ') to++;
      piece = piece.slice(0, to);
      after = true;
    } else after = kept.length > 0 && text.trim().endsWith(kept[kept.length - 1].trim()) === false;
    before = first > 0;
  }
  const low = fold(piece);
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) marks.push([i, i + w.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: (string | HTMLElement)[] = [before ? '… ' : ''];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out.push(piece.slice(pos, a), h('mark', null, piece.slice(a, b)));
    pos = b;
  }
  out.push(piece.slice(pos), after ? ' …' : '');
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

/** The query as the site itself writes it: the first entry title, other name or text that has it, in that order. */
function casing(q: string, docs: Doc[]): string {
  const want = fold(q);
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc})(?![\\p{L}\\p{N}])`, 'iu');
  for (const pick of [(d: Doc) => [d.title], (d: Doc) => d.also, (d: Doc) => [d.text]]) {
    for (const d of docs) {
      for (const t of pick(d)) {
        const m = re.exec(t);
        if (m && fold(m[2]) === want) return m[2];
      }
    }
  }
  return q;
}

const has = (s: string, words: string[]) => {
  const f = fold(s);
  return words.some((w) => f.includes(w));
};

const SUGGEST = ['SimHash', 'Bloom filter', 'lease', 'Kafka', 'robots.txt', 'SSRF', 'WARC', 'idempotent', 'B+ tree', 'eviction'];

/** The results page. The search box itself lives in the sidebar and drives this through the address. */
/** The result last followed from each results page, so Back can put focus on it again. */
const followed = new Map<string, string>();

export async function mountSearch(host: HTMLElement, query: string, returning = false): Promise<() => void> {
  const q = query.trim();
  const words = fold(q).split(/\s+/).filter(Boolean);
  const list = h('div.search-groups', null);
  // Focus lands here when nothing matches and the reader pressed Enter in the box.
  const summary = h('p.search-summary', { tabIndex: -1 }, q ? 'Searching…' : 'Type in the search box to look something up.');
  const heading = h('h1', null, q ? `Search: ${q}` : 'Search');
  const tries = h(
    'p.search-tries', null, 'Try: ',
    SUGGEST.flatMap((s, i) => [i ? ', ' : '', h('a', { href: `#/search/${encodeURIComponent(s)}` }, s)]),
  );
  const page = h('article.search-page', null, h('header.page-head', null, heading), summary, list, tries);
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
    // The heading and the window's title show the term as the site writes it ("SimHash", not "simhash").
    const shown = casing(q, hits.map((x) => x.d));
    heading.textContent = `Search: ${shown}`;
    document.title = `Search: ${shown} | Data structures, visualised`;
    // Results are grouped by where they live, best match first within each group, and the groups in the order of their best match.
    // An entry whose title is exactly the search comes first, whatever kind it is: the SimHash page above MinHash and near-duplicates.
    const exact = (d: Doc) => fold(d.title) === words.join(' ');
    const groupOf = (d: Doc) => (exact(d) ? 'Exact matches' : d.kind === 'Term' ? 'Glossary' : d.kind === 'Structure' ? 'Data structures' : 'System design');
    const groups = new Map<string, Doc[]>();
    if (hits.some((x) => exact(x.d))) groups.set('Exact matches', []);
    for (const { d } of hits) {
      const g = groupOf(d);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(d);
    }
    for (const [g, docs] of groups) {
      const ol = h('ol.search-results', null);
      for (const d of docs) {
        // When the match is in another name for the entry (a technology, an alternative) and not its text, show that name, marked.
        const inText = has(d.text, words);
        const other = !inText && !has(d.title, words) ? d.also.find((a) => has(a, words)) : undefined;
        ol.append(
          h(
            'li', null,
            h('p.search-kind', null, h('span.search-pill', { class: `kind-${slug(d.kind)}` }, d.kind)),
            // The kind is read out with the title, so two results with one name (a term and a structure) can be told apart.
            // Named in one string, so no stray space creeps in before the comma: its title, its kind and the design it is in.
            h('h3', null, h('a', { href: d.href, 'aria-label': [d.title, d.kind.toLowerCase(), d.from].filter(Boolean).join(', '), onclick: () => followed.set(q, d.href) }, excerpt(d.title, words, true))),
            other ? h('p.search-also', null, 'Also: ', excerpt(other, words, true)) : null,
            h('p.search-text', null, excerpt(d.text, words, d.kind === 'Term')),
            h('p.search-where', null, d.where),
          ),
        );
      }
      list.append(h('section.search-group', { 'aria-label': `${g}, ${docs.length} ${docs.length === 1 ? 'match' : 'matches'}` }, h('h2.search-group-head', null, g, h('span.search-group-count', null, ` ${docs.length}`)), ol));
    }
    const back = returning ? followed.get(q) : undefined;
    if (back) {
      const a = [...list.querySelectorAll('h3 a')].find((x) => x.getAttribute('href') === back) as HTMLElement | undefined;
      a?.focus({ preventScroll: true });
    }
  } else announce(summary.textContent ?? '');
  return () => page.remove();
}
