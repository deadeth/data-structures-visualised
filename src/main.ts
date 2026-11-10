import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
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
      menu,
      h('p.side-foot', null, h('a', { href: REPO }, 'Source on GitHub')),
    ),
    main,
  ),
);

let teardown: (() => void) | null = null;
let navToken = 0;

async function route(): Promise<void> {
  const token = ++navToken;
  const path = location.hash.replace(/^#/, '') || '/';
  teardown?.();
  teardown = null;
  main.replaceChildren();
  for (const [p, a] of navLinks) {
    if (p === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!wide.matches) menu.open = false;
  window.scrollTo(0, 0);

  let mount: Promise<() => void>;
  const m = /^\/s\/([a-z0-9-]+)$/.exec(path);
  if (path === '/') {
    document.title = 'Data structures, visualised';
    mount = mountHome(main);
  } else if (path === '/compare') {
    document.title = 'Head to head | Data structures, visualised';
    mount = mountCompare(main);
  } else if (path === '/d/web-crawler') {
    document.title = 'Distributed web crawler | Data structures, visualised';
    mount = Promise.all([import('./ui/design-page'), import('./designs/web-crawler')]).then(([page, d]) => page.mountDesign(main, d.webCrawler));
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
