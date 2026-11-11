import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './styles.css';
import './ui/search.css';
import { CATALOG, GROUPS, entry, isReady } from './catalog';
import { DESIGNS, design as designEntry } from './designs';
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
nav.append(navGroup('System designs', DESIGNS.map((d) => h('li', null, link(`/d/${d.id}`, d.name, `${d.hint}: an interactive design with a guided tour`)))));

const menu = h('details.menu', null, h('summary', null, 'All structures'), nav);

/**
 * Single-key shortcuts ("/" for search here; the structure pages' speed keys
 * and the design tour's keys read the same setting) can be switched off.
 * Stored as dsv.shortcuts = "on" | "off"; on unless switched off.
 */
const SHORTCUTS = 'dsv.shortcuts';
const shortcutsOn = () => {
  try {
    return localStorage.getItem(SHORTCUTS) !== 'off';
  } catch {
    return true;
  }
};

// One search box for the whole site. Typing shows results in the main column; "/" jumps to it.
const searchInput = h('input.search-input', { type: 'search', id: 'site-search', placeholder: 'SimHash, lease, Kafka…', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
let searchTimer = 0;
function showResults(): void {
  searchTimer = 0;
  const q = searchInput.value.trim();
  const to = q ? `#/search/${encodeURIComponent(q)}` : '#/search/';
  // The first keystroke from another page adds one history entry, so Back returns to that page.
  // After that each keystroke replaces it, so typing a word does not leave a trail.
  if (/^#\/search\//.test(location.hash)) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  void route(true);
}
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(showResults, 140);
});
/** Set by Enter or Down in the search box: once the results are on the page, focus goes to the first one. */
let toResults = false;
let routing = false;
function focusResults(): boolean {
  const first = main.querySelector<HTMLElement>('.search-results h3 a') ?? main.querySelector<HTMLElement>('.search-summary');
  if (!first) return false;
  toResults = false;
  first.focus();
  return true;
}
searchInput.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey || !searchInput.value.trim()) return;
  e.preventDefault();
  toResults = true;
  // Results still to come (typing has just paused, or they are loading): focus moves when they arrive.
  if (searchTimer) {
    clearTimeout(searchTimer);
    showResults();
  } else if (!routing && /^#\/search\//.test(location.hash)) focusResults();
});
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.key === '/' && shortcutsOn() && !e.ctrlKey && !e.metaKey && !e.altKey && !t.closest('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    // Mid-page the box may already be on screen (the sidebar sticks): then the page stays where it is.
    const r = searchInput.getBoundingClientRect();
    searchInput.focus({ preventScroll: r.top >= 0 && r.bottom <= innerHeight });
    searchInput.select();
  }
});
const keysBox = h('input', { type: 'checkbox', id: 'site-keys', checked: shortcutsOn() }) as HTMLInputElement;
const syncKeys = () => {
  if (keysBox.checked) searchInput.setAttribute('aria-keyshortcuts', '/');
  else searchInput.removeAttribute('aria-keyshortcuts');
};
keysBox.addEventListener('change', () => {
  try {
    localStorage.setItem(SHORTCUTS, keysBox.checked ? 'on' : 'off');
  } catch {
    // Storage can be blocked; the switch still works for this visit.
  }
  syncKeys();
});
syncKeys();
const search = h(
  'form.search', { role: 'search', onsubmit: (e: Event) => e.preventDefault() },
  h('label', { for: 'site-search' }, 'Search'),
  searchInput,
  h('p.search-keys', null, keysBox, h('label', { for: 'site-keys' }, 'Keyboard shortcuts'), h('span.search-keys-hint', { 'aria-hidden': 'true' }, h('kbd', null, '/'), ' to search')),
);
const wide = matchMedia('(min-width: 900px)');
// The design page needs the width for its diagram: below 1300px the sidebar folds into the top bar there, as on a phone.
const roomy = matchMedia('(min-width: 1300px)');
let folds = false;
const syncMenu = () => {
  document.documentElement.classList.toggle('fold-side', folds && !roomy.matches);
  menu.open = wide.matches && !(folds && !roomy.matches);
};
wide.addEventListener('change', syncMenu);
roomy.addEventListener('change', syncMenu);
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
/** Where each search results page was scrolled to, so Back returns to the same place in the list. */
const searchScroll = new Map<string, number>();
let shown = '';

async function route(typing = false): Promise<void> {
  const token = ++navToken;
  routing = true;
  if (/^#\/search\//.test(shown) && !typing) searchScroll.set(shown, window.scrollY);
  shown = location.hash;
  const path = location.hash.replace(/^#/, '') || '/';
  const found = /^\/search\/(.*)$/.exec(path);
  const design0 = /^\/d\//.test(path);
  if (design0 !== folds) {
    folds = design0;
    syncMenu();
  }
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
  const dm = /^\/d\/([a-z0-9-]+)(?:\/([cfgt])\/([a-z0-9-]+))?$/.exec(path);
  const chosen = dm ? designEntry(dm[1]) : undefined;
  if (path === '/') {
    document.title = 'Data structures, visualised';
    mount = mountHome(main);
  } else if (path === '/compare') {
    document.title = 'Head to head | Data structures, visualised';
    mount = mountCompare(main);
  } else if (found) {
    document.title = 'Search | Data structures, visualised';
    const q = decodeURIComponent(found[1]);
    // Coming back to a results page (not typing into the box), focus returns to the result that was followed.
    mount = import('./ui/search').then((s) => s.mountSearch(main, q, !typing));
  } else if (dm && chosen) {
    document.title = `${chosen.name} | Data structures, visualised`;
    const open = dm[2] ? { kind: dm[2], id: dm[3] } : undefined;
    mount = Promise.all([import('./ui/design-page'), chosen.load()]).then(([page, d]) => page.mountDesign(main, d, open));
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
    if (token === navToken) {
      teardown = off;
      routing = false;
      const back = found && !typing ? searchScroll.get(location.hash) : undefined;
      if (back) window.scrollTo(0, back);
      if (found && toResults) focusResults();
    } else off();
  } catch (err) {
    routing = false;
    console.error(err);
    if (token === navToken) main.replaceChildren(h('article', null, h('h1', null, 'This page failed to load'), h('p', null, 'Reload the page to try again.')));
  }
}

window.addEventListener('hashchange', () => void route());
void route();
