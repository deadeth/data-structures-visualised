import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
import './ui/search.css';
import { CATALOG, GROUPS, entry, isReady } from './catalog';
import { h } from './core/dom';
import { mountCompare } from './ui/compare';
import { mountHome } from './ui/home';
import { mountStructure } from './ui/structure-page';

const REPO = 'https://github.com/deadeth/data-structures-visualised';

const app = document.getElementById('app')!;
const main = h('main', { id: 'main', tabIndex: -1 });
const navLinks = new Map<string, HTMLAnchorElement>();

function link(path: string, label: string, title?: string): HTMLAnchorElement {
  const a = h('a', { href: `#${path}`, title }, label);
  navLinks.set(path, a);
  return a;
}

// Group labels are not headings: they would come before each page's h1. Each list is named by its label instead.
const nav = h('nav.site-nav', { 'aria-label': 'Data structures' });
const navGroup = (label: string, items: HTMLElement[]) => {
  const id = `nav-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return h('div.nav-group', null, h('p.nav-label', { id }, label), h('ul', { 'aria-labelledby': id }, items));
};
for (const group of GROUPS) {
  const items = CATALOG.filter((c) => c.group === group).map((c) =>
    h('li', null, isReady(c.id) ? link(`/s/${c.id}`, c.name, c.blurb) : h('span.soon', { title: 'Not built yet' }, c.name)),
  );
  nav.append(navGroup(group, items));
}
nav.append(navGroup('Compare', [h('li', null, link('/compare', 'Head to head', 'Run one workload through every structure'))]));
nav.append(navGroup('System designs', [h('li', null, link('/d/web-crawler', 'Distributed web crawler', 'An interactive high-level design with a guided tour'))]));

const menu = h('details.menu', null, h('summary', null, 'All structures'), nav);

// One search box for the whole site. Typing shows results in the main column; "/" jumps to it.
const searchInput = h('input.search-input', { type: 'search', id: 'site-search', placeholder: 'SimHash, lease, Kafka…', autocomplete: 'off', spellcheck: false, 'aria-keyshortcuts': '/' }) as HTMLInputElement;
let searchTimer = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = searchInput.value.trim();
    // Replace, so that typing a word does not leave a trail of history entries.
    history.replaceState(null, '', q ? `#/search/${encodeURIComponent(q)}` : '#/search/');
    void route(true);
  }, 140);
});
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !t.closest('input, textarea, select')) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
const search = h('form.search', { role: 'search', onsubmit: (e: Event) => e.preventDefault() }, h('label', { for: 'site-search' }, 'Search'), searchInput);
const wide = matchMedia('(min-width: 900px)');
const syncMenu = () => (menu.open = wide.matches);
wide.addEventListener('change', syncMenu);
syncMenu();

app.append(
  h('a.skip', { href: '#main' }, 'Skip to content'),
  h(
    'div.shell', null,
    h(
      'aside.sidebar', null,
      h('a.brand', { href: '#/' }, h('span.brand-mark', { 'aria-hidden': 'true' }), h('span', null, 'Data structures, visualised')),
      search,
      menu,
      h('p.side-foot', null, h('a', { href: REPO }, 'Source on GitHub')),
    ),
    main,
  ),
);

let teardown: (() => void) | null = null;
let navToken = 0;

async function route(typing = false): Promise<void> {
  const token = ++navToken;
  const path = location.hash.replace(/^#/, '') || '/';
  const found = /^\/search\/(.*)$/.exec(path);
  if (!found) searchInput.value = '';
  else if (!typing) searchInput.value = decodeURIComponent(found[1]);
  teardown?.();
  teardown = null;
  main.replaceChildren();
  for (const [p, a] of navLinks) {
    if (p === path || path.startsWith(`${p}/`)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!wide.matches) menu.open = false;
  if (!typing) window.scrollTo(0, 0);

  let mount: Promise<() => void>;
  const m = /^\/s\/([a-z0-9-]+)$/.exec(path);
  const design = /^\/d\/web-crawler(?:\/([cfg])\/([a-z0-9-]+))?$/.exec(path);
  if (path === '/') {
    document.title = 'Data structures, visualised';
    mount = mountHome(main);
  } else if (path === '/compare') {
    document.title = 'Head to head | Data structures, visualised';
    mount = mountCompare(main);
  } else if (found) {
    document.title = 'Search | Data structures, visualised';
    const q = decodeURIComponent(found[1]);
    mount = import('./ui/search').then((s) => s.mountSearch(main, q));
  } else if (design) {
    document.title = 'Distributed web crawler | Data structures, visualised';
    const open = design[1] ? { kind: design[1], id: design[2] } : undefined;
    mount = Promise.all([import('./ui/design-page'), import('./designs/web-crawler')]).then(([page, d]) => page.mountDesign(main, d.webCrawler, open));
  } else if (m && entry(m[1]) && isReady(m[1])) {
    document.title = `${entry(m[1])!.name} | Data structures, visualised`;
    mount = mountStructure(main, m[1]);
  } else {
    document.title = 'Page not found | Data structures, visualised';
    main.append(h('article', null, h('h1', null, 'No page at this address'), h('p', null, 'Pick a structure from the list, or ', h('a', { href: '#/' }, 'go to the start'), '.')));
    return;
  }
  try {
    const off = await mount;
    if (token === navToken) teardown = off;
    else off();
  } catch (err) {
    console.error(err);
    if (token === navToken) main.replaceChildren(h('article', null, h('h1', null, 'This page failed to load'), h('p', null, 'Reload the page to try again.')));
  }
}

window.addEventListener('hashchange', () => void route());
void route();
