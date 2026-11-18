import './design-study.css';
import { h } from '../core/dom';
import { loadCourse } from '../course';
import { linkedItems, sharedStore } from '../course/progress';
import type { Course } from '../course/types';
import type { Design } from '../designs/types';

/**
 * The study guide on a design page: the site's pages to study for the design, grouped and in
 * order, each with a tick box. Ticks live in the course's progress store (`dsv.course`), so they
 * are exported, imported and reset with it. A page the course also lists as reading or watching
 * shares its tick with those course items: tick either and both show it. Any other page is kept
 * by its address under `pages`.
 */
const span = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`);

/** What kind of page an address leads to, as the small label beside it. */
function kindOf(href: string): string {
  if (href.startsWith('#/s/')) return 'Animated';
  if (href.startsWith('#/c/') || /^#\/d\/[^/]+\/read/.test(href)) return 'Reading';
  if (/^#\/d\/[^/]+\/(rehearse|crib)/.test(href)) return 'Practice';
  if (href.startsWith('#/course')) return 'Course';
  return 'Design';
}

/** The study guide card for a design, or null when the design has none. */
export function studyCard(design: Design): HTMLElement | null {
  const guide = design.study;
  if (!guide) return null;
  const store = sharedStore();
  let course: Course | null = null;
  const id = `${design.id}-study`;
  const all = guide.groups.flatMap((g) => g.items);
  const total = all.reduce((n, i) => n + i.minutes, 0);
  /** Studied: any course item this page stands for is ticked, or, for a page the course does not list, its own tick. */
  const isDone = (href: string) => {
    const links = linkedItems(course, href);
    return links.length ? links.some((l) => store.itemDone(l.module, l.item)) : store.pageDone(href);
  };

  const count = h('p.study-count', { 'aria-live': 'polite' });
  const bar = h('div.study-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length), 'aria-label': 'Pages studied' }, h('span'));
  const unsaved = h('p.study-unsaved', { hidden: true }, 'Your ticks could not be saved in this browser, so they will last for this visit only.');
  const rows: { href: string; box: HTMLInputElement; row: HTMLElement; shared: HTMLElement }[] = [];
  /** Bring every box, the count and the bar into line with the store. */
  const refresh = () => {
    for (const r of rows) {
      r.box.checked = isDone(r.href);
      r.row.classList.toggle('done', r.box.checked);
      r.shared.hidden = !linkedItems(course, r.href).length;
    }
    const n = rows.filter((r) => r.box.checked).length;
    const left = all.filter((i) => !isDone(i.href)).reduce((m, i) => m + i.minutes, 0);
    count.textContent = `${n} of ${all.length} pages studied · ${left ? `${span(left)} left of ${span(total)}` : `all ${span(total)} done`}`;
    bar.setAttribute('aria-valuenow', String(n));
    (bar.firstElementChild as HTMLElement).style.width = `${all.length ? (100 * n) / all.length : 0}%`;
    unsaved.hidden = store.saving;
  };

  let serial = 0;
  const groups = guide.groups.map((g, gi) =>
    h(
      'section.study-group', null,
      h('h3', null, `${gi + 1}. ${g.title}`),
      h('p.study-why', null, g.why),
      h(
        'ul.study-items', null,
        g.items.map((item) => {
          const box = h('input', { type: 'checkbox', id: `${id}-${serial++}`, 'aria-label': `Studied: ${item.label}` }) as HTMLInputElement;
          const shared = h('span.study-shared', { hidden: true }, 'Shares its tick with the course');
          const row = h(
            'li.study-item', null,
            box,
            h(
              'div', null,
              h('p.study-title', null, h('label.study-kind', { for: box.id }, kindOf(item.href)), ' ', h('a', { href: item.href }, item.label), h('span.study-min', null, ` ${span(item.minutes)}`)),
              h('p.study-take', null, item.take),
              shared,
            ),
          );
          rows.push({ href: item.href, box, row, shared });
          box.addEventListener('change', () => {
            const links = linkedItems(course, item.href);
            if (links.length) store.setItems(links, box.checked);
            else store.setPage(item.href, box.checked);
          });
          return row;
        }),
      ),
    ),
  );
  const card = h(
    'section.note.wide.hld-card.study', { id, 'aria-labelledby': `${id}-h` },
    h('h2', { id: `${id}-h`, tabIndex: -1 }, 'Study guide'),
    h('p.hld-lead', null, guide.intro),
    count,
    bar,
    unsaved,
    ...groups,
  );
  refresh();
  // The store tells us of every change, here or in another tab; stop listening once the page has gone.
  const stop = store.onChange(() => (card.isConnected ? refresh() : stop()));
  // The course arrives a moment later: until then every tick reads as the page's own.
  void loadCourse().then((c) => {
    course = c;
    refresh();
  });
  return card;
}
