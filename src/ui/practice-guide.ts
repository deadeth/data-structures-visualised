import './practice.css';
import { h } from '../core/dom';
import { loadPractice, type PracticeEntry } from '../practice';
import { parseArticle, plainOf, sectionsOf, type Article, type ArticleBlock, type Inline } from '../practice/article';
import { codeFrame } from './practice-page';

/**
 * A practice page's tutorial: `#/p/<id>/guide`, and `#/p/<id>/guide/<n>` for the same article at section n
 * (or sub-section n.k). Moving between sections of the article on screen scrolls; it never draws it again.
 */

/** Inline markup as DOM. Links go out of the site, so they open where they are, as any link would. */
function inlineNodes(nodes: Inline[]): (Node | string)[] {
  return nodes.map((n) => {
    if (n.t === 'text') return n.text;
    if (n.t === 'code') return h('code', null, n.text);
    if (n.t === 'bold') return h('strong', null, inlineNodes(n.children));
    return h('a', { href: n.href, rel: 'noopener' }, inlineNodes(n.children));
  });
}

const anchor = (id: string, number: string) => `#/p/${id}/guide/${number}`;

function block(b: ArticleBlock, section: string): HTMLElement {
  if (b.kind === 'heading') {
    const label = [`${b.number}. `, ...inlineNodes(b.text)];
    return b.level === 2
      ? h('h2', { id: `pp-g-h-${b.number}`, tabIndex: -1 }, ...label)
      : h('h3.pp-g-h3', { id: `pp-g-h-${b.number}`, tabIndex: -1, 'data-number': b.number }, ...label);
  }
  if (b.kind === 'paragraph') return h('p', null, inlineNodes(b.text));
  if (b.kind === 'list') {
    return b.ordered
      ? h('ol.pp-list.ordered', { start: b.start === 1 ? null : b.start }, b.items.map((it) => h('li', null, inlineNodes(it))))
      : h('ul.pp-list', null, b.items.map((it) => h('li', null, inlineNodes(it))));
  }
  const lines = [...b.lines];
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return codeFrame(lines, { lang: b.lang === 'java' ? 'java' : 'pseudo', label: `${b.lang === 'java' ? 'Java' : 'Code'} in section ${section}` });
}

let current: { id: string; go: (n?: string) => void } | null = null;

/** Scroll the tutorial on screen to a section, if it is this page's. True when it did. */
export function goToSection(id: string, n?: string): boolean {
  if (!current || current.id !== id) return false;
  current.go(n);
  return true;
}

/** The title for the window, or undefined when the page or its tutorial does not exist. */
export async function tutorialTitle(id: string): Promise<string | undefined> {
  const entry = await loadPractice(id);
  if (!entry?.hasTutorial) return undefined;
  const a = parseArticle(await entry.tutorial()).article;
  return a ? `${plainOf(a.title)} (tutorial)` : `${entry.page.title}: tutorial`;
}

function notFound(host: HTMLElement): () => void {
  const lost = h('h1', { tabIndex: -1 }, 'No page at this address');
  const article = h('article', null, lost, h('p', null, 'Pick a task from ', h('a', { href: '#/p' }, 'the pairing practice list'), ', or ', h('a', { href: '#/' }, 'go to the start'), '.'));
  host.append(article);
  lost.focus();
  return () => article.remove();
}

export async function mountTutorial(host: HTMLElement, id: string, n?: string): Promise<() => void> {
  const entry = await loadPractice(id);
  if (!entry?.hasTutorial) return notFound(host);
  const { article, errors } = parseArticle(await entry.tutorial());
  if (!article) {
    // The tests stop this reaching the site; in development, say what is wrong.
    const el = h('article.pp', null, h('h1', { tabIndex: -1 }, 'This tutorial does not parse'), h('ul.pp-list', null, errors.map((e) => h('li', null, `Line ${e.line}: ${e.message}`))));
    host.append(el);
    return () => el.remove();
  }
  return draw(host, entry, article, n);
}

function draw(host: HTMLElement, entry: PracticeEntry, a: Article, n?: string): () => void {
  const id = entry.id;
  const sections = sectionsOf(a);
  const offs: (() => void)[] = [];

  const head = h(
    'header.page-head.pp-head', null,
    h('p.pp-kicker', null, h('a', { href: '#/p' }, 'Pairing practice'), ' · Tutorial'),
    h('h1', { tabIndex: -1 }, inlineNodes(a.title)),
    h('p.lede.pp-g-lede', null, 'An article that builds the whole solution step by step, so it shows the full solution. Back to the practice page: ', h('a', { href: `#/p/${id}` }, entry.page.title), '.'),
  );

  // Each ## section in its own <section>, so the contents list and the address can name it.
  const targets = new Map<string, HTMLElement>();
  const sectionEls = sections.map((s) => {
    const el = h('section.pp-section.pp-g-section', { id: `pp-g-${s.number}`, 'aria-labelledby': `pp-g-h-${s.number}` }, s.blocks.map((b) => block(b, s.number)));
    targets.set(s.number, el);
    for (const h3 of el.querySelectorAll<HTMLElement>('h3[data-number]')) targets.set(h3.dataset.number!, h3);
    return el;
  });

  const tocLinks = new Map<string, HTMLAnchorElement>();
  const toc = h(
    'nav.pp-toc.pp-g-toc', { 'aria-labelledby': 'pp-g-toc-h' },
    h('p.pp-toc-h', { id: 'pp-g-toc-h' }, 'Contents'),
    h(
      'ol.pp-toc-list', null,
      sections.map((s) => {
        const link = h('a', { href: anchor(id, s.number) }, h('span.pp-toc-n', null, `${s.number}.`), h('span.pp-toc-title', null, s.title));
        tocLinks.set(s.number, link);
        return h('li', null, link);
      }),
    ),
  );

  const body = h('div.pp-body.pp-g-body', null, sectionEls, h('p.pp-g-back', null, h('a', { href: `#/p/${id}` }, `Back to the practice page: ${entry.page.title}`)));
  const el = h('article.pp.pp-g', null, head, h('div.pp-layout', null, toc, body));
  host.append(el);

  // The contents list marks the section being read.
  let mark = '';
  const setMark = (k: string) => {
    if (k === mark) return;
    mark = k;
    for (const [num, link] of tocLinks) {
      if (num === k) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  const onScroll = () => {
    let at = '';
    const atFoot = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    for (const s of sections) if (targets.get(s.number)!.getBoundingClientRect().top < (atFoot ? innerHeight * 0.6 : 100)) at = s.number;
    setMark(at);
  };
  let raf = 0;
  const scrolled = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      onScroll();
    });
  };
  addEventListener('scroll', scrolled, { passive: true });
  offs.push(() => {
    removeEventListener('scroll', scrolled);
    cancelAnimationFrame(raf);
  });
  onScroll();

  const go = (num?: string) => {
    const target = num ? targets.get(num) : undefined;
    if (!target) {
      window.scrollTo(0, 0);
      return;
    }
    target.scrollIntoView({ block: 'start' });
    const heading = target.matches('h3') ? target : target.querySelector<HTMLElement>('h2');
    heading?.focus({ preventScroll: true });
    setMark(num!.split('.')[0]);
  };
  if (n) requestAnimationFrame(() => go(n));
  current = { id, go };

  return () => {
    for (const off of offs) off();
    if (current?.id === id) current = null;
    el.remove();
  };
}
