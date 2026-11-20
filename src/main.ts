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
import './ui/reading.css';
import './ui/course.css';
import { CONCEPTS, CONCEPT_GROUPS, plain } from './reading';
import { PRACTICES } from './practice';
import { LOCKED, lockedEntry } from './locked/manifest';
import { isOpen, mountLock, onUnlock, unlockSaved } from './locked/unlock';

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
/**
 * Each group folds: its label is a button that shows or hides the list under it.
 * The groups folded shut are kept in localStorage as dsv.nav.closed, a JSON list of group ids.
 * A folded group that holds the page on screen stays shut, and its label says so.
 */
const NAV_CLOSED = 'dsv.nav.closed';
const closedGroups = (): Set<string> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NAV_CLOSED) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};
const navFolds: { group: HTMLElement; list: HTMLElement; here: HTMLElement }[] = [];
/** Marks each group that holds the current page, so a folded one still shows where the reader is. */
function markGroups(): void {
  for (const f of navFolds) {
    const holds = !!f.list.querySelector('[aria-current="page"]');
    f.group.classList.toggle('has-current', holds);
    f.here.textContent = holds ? ', holds this page' : '';
  }
}
const navGroup = (label: string, items: HTMLElement[]) => {
  const id = `nav-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const list = h('ul', { id: `${id}-list`, 'aria-labelledby': id }, items);
  const here = h('span.visually-hidden');
  const fold = h('button.nav-fold', { type: 'button', 'aria-expanded': 'true', 'aria-controls': `${id}-list` }, h('span.nav-label', { id }, label), here, h('span.nav-chevron', { 'aria-hidden': 'true' }));
  const show = (open: boolean) => {
    fold.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  };
  fold.addEventListener('click', () => {
    const open = list.hidden !== false;
    show(open);
    const closed = closedGroups();
    if (open) closed.delete(id);
    else closed.add(id);
    try {
      localStorage.setItem(NAV_CLOSED, JSON.stringify([...closed]));
    } catch {
      // Storage can be blocked; the group still folds for this visit.
    }
  });
  if (closedGroups().has(id)) show(false);
  const group = h('div.nav-group', null, fold, list);
  navFolds.push({ group, list, here });
  return group;
};
// The course has its own link above the menu; where the sidebar folds into a bar (design pages) it moves into the menu instead (course.css).
const courseLink = h('a.side-course', { href: '#/course' }, h('span.side-course-name', null, 'Course'), h('span.side-course-sub', null, 'A study plan, with your progress'));
const navCourse = navGroup('Course', [h('li', null, h('a', { href: '#/course' }, 'Study plan and progress'))]);
navCourse.classList.add('nav-course');
nav.append(navCourse);
for (const group of GROUPS) {
  const items = CATALOG.filter((c) => c.group === group).map((c) =>
    h('li', null, isReady(c.id) ? link(`/s/${c.id}`, c.name, c.blurb) : h('span.soon', { title: 'Not built yet' }, c.name)),
  );
  nav.append(navGroup(group, items));
}
nav.append(navGroup('Compare', [h('li', null, link('/compare', 'Head to head', 'Run one workload through every structure'))]));
// Designs, then any locked design not yet opened, under a neutral name. Drawn again when a locked page opens.
const designItems = () => [
  ...DESIGNS.map((d) => h('li', null, link(`/d/${d.id}`, d.name, `${d.hint}: an interactive design with a guided tour`))),
  ...LOCKED.flatMap((e) => e.ids.filter((id) => !designEntry(id)).map((id) => h('li', null, link(`/d/${id}`, e.label)))),
];
const designNav = navGroup('System designs', designItems());
nav.append(designNav);
// Pairing practice: the guide, then each page by title (in the guide's order once it names one).
nav.append(navGroup('Pairing practice', [h('li', null, link('/p', 'How to use these', 'Pairing practice: how to use these pages')), ...PRACTICES.map((p) => h('li', null, link(`/p/${p.id}`, p.page.title, plain(p.page.summary))))]));
// Concept pages, to read rather than watch: one list, with each group named inside it.
if (CONCEPTS.length) {
  const groups = CONCEPT_GROUPS.filter((g) => CONCEPTS.some((c) => c.group === g));
  const items = groups.flatMap((g) => {
    const subId = `nav-concepts-${g.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    return [
      h('li', null, h('p.nav-sub', { id: subId }, g), h('ul', { 'aria-labelledby': subId }, CONCEPTS.filter((c) => c.group === g).map((c) => h('li', null, link(`/c/${c.id}`, c.title, c.summary))))),
    ];
  });
  nav.append(navGroup('System design patterns', items));
}

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

// The skip link must not change the hash: the router would read "#main" as a route and replace the page.
const skip = h('a.skip', { href: '#main' }, 'Skip to content');
skip.addEventListener('click', (e) => {
  e.preventDefault();
  const target = document.getElementById('main');
  target?.focus();
  target?.scrollIntoView();
});

app.append(
  skip,
  h(
    'div.shell', null,
    h(
      'aside.sidebar', null,
      h('a.brand', { href: '#/' }, h('span.brand-mark', { 'aria-hidden': 'true' }), h('span', null, 'Data structures, visualised')),
      search,
      courseLink,
      menu,
      h('p.side-foot', null, h('a', { href: REPO }, 'Source on GitHub')),
    ),
    main,
  ),
);

// A locked page opened: name it in the sidebar, keeping the current page marked.
onUnlock(() => {
  const list = designNav.querySelector('ul')!;
  list.replaceChildren(...designItems());
  const path = location.hash.replace(/^#/, '') || '/';
  for (const [p, a] of navLinks) if (list.contains(a) && (p === path || path.startsWith(`${p}/`))) a.setAttribute('aria-current', 'page');
  markGroups();
});
/** Opens, without asking, any locked page whose password this tab has already given. */
const saved = unlockSaved();

let teardown: (() => void) | null = null;
let navToken = 0;
/** Where each search results page was scrolled to, so Back returns to the same place in the list. */
const searchScroll = new Map<string, number>();
let shown = '';
/** The reading page module once loaded, and the page it shows, so a change of section scrolls instead of drawing the page again. */
let readingMod: typeof import('./ui/reading-page') | null = null;
/** The practice page module once loaded, so a change of part on the page shown scrolls instead of drawing it again. */
let practiceMod: typeof import('./ui/practice-page') | null = null;

async function route(typing = false): Promise<void> {
  // A locked design's address: wait for the quiet unlock first, so an open tab never flashes the form.
  const lockedId = /^#\/d\/([a-z0-9-]+)/.exec(location.hash)?.[1];
  const lock = lockedId ? lockedEntry(lockedId) : undefined;
  if (lock && !isOpen(lock)) await saved;
  const token = ++navToken;
  routing = true;
  if (/^#\/search\//.test(shown) && !typing) searchScroll.set(shown, window.scrollY);
  shown = location.hash;
  const path = location.hash.replace(/^#/, '') || '/';
  const found = /^\/search\/(.*)$/.exec(path);
  // A reading page (`/c/<id>`, `/d/<design>/read`), opened at a section or not.
  const rc = /^\/c\/([a-z0-9-]+)(?:\/([^/]+))?$/.exec(path);
  const rd = /^\/d\/([a-z0-9-]+)\/read(?:\/([^/]+))?$/.exec(path);
  const readKey = rc ? `c:${rc[1]}` : rd ? `d:${rd[1]}` : null;
  const readSection = (rc?.[2] ?? rd?.[2]) ? decodeURIComponent((rc?.[2] ?? rd?.[2])!) : undefined;
  // Another section of the page already on screen: scroll to it, and draw nothing again.
  if (readKey && readingMod && !typing && teardown && readingMod.goToSection(readKey, readSection)) {
    routing = false;
    return;
  }
  // A pairing practice address: the guide (`/p`), a page (`/p/<id>`), or a page at one part (`/p/<id>/<part>`).
  const pm = /^\/p(?:\/([a-z0-9-]+)(?:\/([^/]+))?)?$/.exec(path);
  const pmPart = pm?.[2] ? decodeURIComponent(pm[2]) : undefined;
  if (pm?.[1] && practiceMod && !typing && teardown && practiceMod.goToPart(pm[1], pmPart)) {
    routing = false;
    return;
  }
  const design0 = /^\/d\//.test(path) && !rd;
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
    // The practice guide (`/p`) is marked only on its own address, not under every practice page.
    if (p === path || (p !== '/p' && path.startsWith(`${p}/`))) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  markGroups();
  const onCourse = path === '/course' || path.startsWith('/course/');
  for (const a of [courseLink, navCourse.querySelector('a')!]) {
    if (onCourse) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!wide.matches) menu.open = false;
  if (!typing) window.scrollTo(0, 0);

  let mount: Promise<() => void>;
  const m = /^\/s\/([a-z0-9-]+)$/.exec(path);
  // A design page, opened at a box (c), connection (f), glossary term (g), tour step (t), story (s, as `id` or `id.step`), likely push (q) or section (x);
  // or its rehearsal mode, crib or test.
  // The part id is matched loosely and lower-cased, so a mistyped or capitalised deep link reaches the design page's own "no such part" note.
  const dm = /^\/d\/([a-z0-9-]+)(?:\/([cfgtqxs])\/([^/]+)|\/(rehearse|crib|test))?$/.exec(path);
  const chosen = dm ? designEntry(dm[1]) : undefined;
  // The course (`/course`), one module (`/course/<module>`), or a module at one item (`/course/<module>/<item>`).
  const cm = /^\/course(?:\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?)?$/.exec(path);
  if (path === '/') {
    document.title = 'Data structures, visualised';
    mount = mountHome(main);
  } else if (path === '/compare') {
    document.title = 'Head to head | Data structures, visualised';
    mount = mountCompare(main);
  } else if (cm) {
    document.title = 'Course | Data structures, visualised';
    mount = import('./ui/course-page').then(async (cp) => {
      document.title = `${await cp.courseTitle(cm[1])} | Data structures, visualised`;
      return cp.mountCourse(main, cm[1], cm[2]);
    });
  } else if (found) {
    document.title = 'Search | Data structures, visualised';
    const q = decodeURIComponent(found[1]);
    // Coming back to a results page (not typing into the box), focus returns to the result that was followed.
    mount = import('./ui/search').then((s) => s.mountSearch(main, q, !typing));
  } else if (lock && !isOpen(lock)) {
    // Any address under a locked design (its page, a step, its walkthrough, rehearsal or crib) asks for the password, then shows that address.
    document.title = `${lock.label} | Data structures, visualised`;
    mount = Promise.resolve(mountLock(main, lock, () => void route()));
  } else if (readKey) {
    document.title = 'Reading | Data structures, visualised';
    mount = import('./ui/reading-page').then((r) => {
      readingMod = r;
      document.title = `${r.readingTitle(readKey) ?? 'Page not found'} | Data structures, visualised`;
      return r.mountReading(main, readKey, readSection);
    });
  } else if (pm) {
    document.title = 'Pairing practice | Data structures, visualised';
    mount = import('./ui/practice-page').then(async (pp) => {
      practiceMod = pp;
      document.title = `${(await pp.practiceTitle(pm[1])) ?? 'Page not found'} | Data structures, visualised`;
      return pp.mountPractice(main, pm[1], pmPart);
    });
  } else if (dm && chosen) {
    // Extras that fail to load leave the design page as it was, without them.
    const extras = chosen.extras
      ? chosen.extras().catch((err) => {
          console.error(err);
          return undefined;
        })
      : Promise.resolve(undefined);
    const mode = dm[4];
    if (mode === 'test') {
      document.title = `Test: ${chosen.name} | Data structures, visualised`;
      mount = import('./ui/design-quiz').then((q) => q.mountQuiz(main, chosen));
    } else if (mode) {
      document.title = `${mode === 'crib' ? 'Crib' : 'Rehearse'}: ${chosen.name} | Data structures, visualised`;
      mount = Promise.all([import('./ui/design-extras'), chosen.load(), extras]).then(([x, d, e]) => (mode === 'crib' ? x.mountCrib(main, chosen, d, e) : x.mountRehearse(main, chosen, d, e)));
    } else {
      document.title = `${chosen.name} | Data structures, visualised`;
      const open = dm[2] ? { kind: dm[2], id: decodeURIComponent(dm[3]).toLowerCase() } : undefined;
      mount = Promise.all([import('./ui/design-page'), chosen.load(), extras]).then(([page, d, e]) => page.mountDesign(main, d, open, e));
    }
  } else if (m && entry(m[1]) && isReady(m[1])) {
    document.title = `${entry(m[1])!.name} | Data structures, visualised`;
    mount = mountStructure(main, m[1]);
  } else {
    document.title = 'Page not found | Data structures, visualised';
    const lost = h('h1', { tabIndex: -1 }, 'No page at this address');
    main.append(h('article', null, lost, h('p', null, 'Pick a structure from the list, or ', h('a', { href: '#/' }, 'go to the start'), '.')));
    // Focus the heading so a screen reader announces the miss.
    lost.focus();
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
