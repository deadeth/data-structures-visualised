import { h } from '../core/dom';
import { loadCourse } from '../course';
import { courseTally, nextItem, sharedStore } from '../course/progress';
import { inline } from './inline';

/** "45 min", "1 h", "2 h 10 min". */
export const duration = (min: number): string => {
  const hrs = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return !hrs ? `${m} min` : m ? `${hrs} h ${m} min` : `${hrs} h`;
};

/** The home page's course card: what the course is, the reader's progress and where to carry on. Kept small: the course page loads only when opened. */
export function courseCard(): { el: HTMLElement; off: () => void } {
  const el = h('section.home-course', { 'aria-labelledby': 'home-course-h' }, h('h2', { id: 'home-course-h' }, 'Course'), h('p', null, 'A study plan for system design interviews, built from the pages on this site.'));
  let off = () => {};
  let alive = true;
  void loadCourse().then((course) => {
    if (!alive) return;
    if (!course) {
      el.append(h('p.cs-continue', null, h('a.btn.cs-continue-btn', { href: '#/course' }, 'See what is planned'), h('span.cs-continue-what', null, 'The course is being written.')));
      return;
    }
    const store = sharedStore();
    const figs = h('p.cs-figs');
    const fill = h('span.cs-bar-fill');
    const bar = h('div.cs-bar', { role: 'progressbar', 'aria-label': 'Course progress', 'aria-valuemin': '0' }, fill);
    const cont = h('p.cs-continue');
    el.querySelector('h2')!.replaceChildren(...inline(course.title));
    // The summary's first sentence: the card stays short; the course page has the rest.
    el.querySelector('p')!.replaceChildren(...inline(course.summary.split(/(?<=[.!?])\s+/)[0]));
    el.append(figs, bar, cont);
    const update = () => {
      const t = courseTally(course, store);
      figs.replaceChildren(
        h('span', null, h('strong', null, `${t.itemsDone} of ${t.items}`), ' items done'),
        h('span', null, h('strong', null, duration(t.minutesDone)), ` of ${duration(t.minutes)}`),
        h('span', null, `${course.modules.length} modules`),
      );
      bar.setAttribute('aria-valuemax', String(t.items));
      bar.setAttribute('aria-valuenow', String(t.itemsDone));
      bar.setAttribute('aria-valuetext', `${t.itemsDone} of ${t.items} items done`);
      bar.classList.toggle('full', t.items > 0 && t.itemsDone === t.items);
      fill.style.width = `${t.items ? Math.round((t.itemsDone / t.items) * 100) : 0}%`;
      const next = nextItem(course, store);
      cont.replaceChildren(
        h('a.btn.primary.cs-continue-btn', { href: next ? `#/course/${next.module.id}/${next.module.items[next.index].id}` : '#/course' }, !t.itemsDone ? 'Start the course' : next ? 'Continue' : 'Open the course'),
        h('a', { href: '#/course' }, 'See every module'),
      );
    };
    update();
    off = store.onChange(update);
  });
  return {
    el,
    off: () => {
      alive = false;
      off();
    },
  };
}
