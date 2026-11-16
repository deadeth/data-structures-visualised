import './course.css';
import { h } from '../core/dom';
import { loadCourse } from '../course';
import { LEVELS, checkpointKey, courseTally, itemKey, moduleTally, nextItem, sharedStore, type Level, type ProgressStore, type Tally } from '../course/progress';
import type { Course, Item, Module } from '../course/types';
import { duration } from './course-card';
import { inline } from './inline';

/**
 * The course: `#/course` is the overview, `#/course/<module>` one module, and `#/course/<module>/<item>`
 * the same module scrolled to one item (where "Continue" goes). Progress is kept by `src/course/progress.ts`.
 */

const KIND: Record<Item['kind'], string> = { read: 'Read', watch: 'Watch', practise: 'Practise', drill: 'Drill' };

/** "14 Nov", with the year when it is not this year. */
function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

/** A progress bar: a real progressbar for assistive technology, with the count as its text. */
export function bar(done: number, total: number, label: string, text: string): HTMLElement {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const fill = h('span.cs-bar-fill');
  fill.style.width = `${pct}%`;
  return h(
    'div.cs-bar',
    { role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-valuetext': text, class: done && done === total ? 'full' : null },
    fill,
  );
}

function setBar(el: HTMLElement, done: number, total: number, text: string): void {
  el.setAttribute('aria-valuenow', String(done));
  el.setAttribute('aria-valuemax', String(total));
  el.setAttribute('aria-valuetext', text);
  el.classList.toggle('full', total > 0 && done === total);
  (el.firstElementChild as HTMLElement).style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

type State = 'new' | 'started' | 'checkpoint' | 'done';
function moduleState(t: Tally): State {
  if (t.itemsDone === t.items && t.checkpointsDone === t.checkpoints) return 'done';
  if (t.itemsDone === t.items) return 'checkpoint';
  return t.itemsDone || t.checkpointsDone ? 'started' : 'new';
}
const STATE_LABEL: Record<State, string> = { new: 'Not started', started: 'In progress', checkpoint: 'Checkpoint to go', done: 'Done' };

const itemsText = (t: Tally) => `${t.itemsDone} of ${t.items} items done`;

/** The quiet line shown when the browser will not keep progress. */
const unsavedLine = (s: ProgressStore) => (s.saving ? null : h('p.cs-unsaved', null, 'This browser is not letting the site save, so your ticks last only until you close the tab.'));

/** Where the reader was when they followed an item's link, so coming back puts them there again. */
let returnTo: { hash: string; y: number; href: string } | null = null;
const remember = (e: Event) => {
  const a = (e.target as HTMLElement).closest('a');
  if (a && /^#\/(?!course)/.test(a.getAttribute('href') ?? '')) returnTo = { hash: location.hash, y: window.scrollY, href: a.getAttribute('href')! };
};

/** The window's title for the course or one of its modules. */
export async function courseTitle(moduleId?: string): Promise<string> {
  const course = await loadCourse();
  if (!course) return 'Course';
  const m = moduleId ? course.modules.find((x) => x.id === moduleId) : undefined;
  return m ? `${m.title}: ${course.title}` : course.title;
}

export async function mountCourse(host: HTMLElement, moduleId?: string, itemId?: string): Promise<() => void> {
  const course = await loadCourse();
  const store = sharedStore();
  const page = h('article.course');
  host.append(page);
  let off: () => void = () => {};

  const draw = () => {
    off();
    page.replaceChildren();
    if (!course) {
      page.append(h('header.page-head', null, h('h1', null, 'Course')), h('p.lede', null, 'The course is being written. It will be a study plan for system design interviews, built from the pages on this site, with your progress kept in this browser.'));
      off = () => {};
      return;
    }
    const m = moduleId ? course.modules.find((x) => x.id === moduleId) : undefined;
    if (moduleId && !m) {
      const lost = h('h1', { tabIndex: -1 }, 'No module at this address');
      page.append(h('header.page-head', null, lost), h('p', null, 'It may have been renamed. ', h('a', { href: '#/course' }, 'See every module'), '.'));
      off = () => {};
      return;
    }
    off = m ? drawModule(page, course, m, store) : drawOverview(page, course, store, redraw);
  };
  /** After an import or a reset: draw again and put focus on the line that says what happened. */
  const redraw = (message: string) => {
    draw();
    const status = page.querySelector<HTMLElement>('.cs-tools-status');
    if (status) {
      status.textContent = message;
      status.focus();
    }
  };
  draw();
  page.addEventListener('click', remember);

  // Back from a page the course linked to: the same place, and focus on the link that was followed.
  if (returnTo && returnTo.hash === location.hash) {
    const back = returnTo;
    returnTo = null;
    window.scrollTo(0, back.y);
    page.querySelector<HTMLElement>(`a[href="${CSS.escape(back.href)}"]`)?.focus({ preventScroll: true });
  } else if (course && moduleId && itemId) {
    const li = page.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
    if (li) {
      li.scrollIntoView({ block: 'center' });
      li.classList.add('cs-target');
      li.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    }
  }

  return () => {
    off();
    page.remove();
  };
}

// ---- overview ----------------------------------------------------------------------------

function drawOverview(page: HTMLElement, course: Course, store: ProgressStore, redraw: (msg: string) => void): () => void {
  const t0 = courseTally(course, store);
  const figs = h('p.cs-figs');
  const overall = bar(0, 0, 'Course progress', '');
  const last = h('p.cs-last');
  const cont = h('p.cs-continue');
  const progress = h(
    'section.cs-progress', { 'aria-labelledby': 'cs-progress-h' },
    h('h2.cs-progress-h', { id: 'cs-progress-h' }, 'Your progress'),
    figs, overall, last, cont, unsavedLine(store),
  );

  const howTo = h(
    'details.cs-howto', { open: t0.itemsDone === 0 },
    h('summary', null, 'How to study with this course'),
    h('div.cs-howto-body', null, course.howTo.map((p) => h('p', null, inline(p)))),
  );

  const rows = course.modules.map((m, i) => {
    const meta = h('p.cs-mod-meta');
    const state = h('span.cs-state');
    const b = bar(0, 0, `${m.title}: progress`, '');
    const li = h(
      'li.cs-mod', null,
      // Titles that carry their own number ("3. Storage") need no label above them.
      /^\d+[.:]\s/.test(m.title) ? null : h('p.cs-mod-num', null, `Module ${i + 1}`),
      h('h3', null, h('a', { href: `#/course/${m.id}` }, inline(m.title))),
      h('p.cs-mod-why', null, inline(m.why)),
      h('div.cs-mod-foot', null, b, h('p.cs-mod-status', null, state, meta)),
    );
    return { m, li, meta, state, bar: b };
  });

  const update = () => {
    const t = courseTally(course, store);
    figs.replaceChildren(
      h('span', null, h('strong', null, `${t.itemsDone} of ${t.items}`), ' items done'),
      h('span', null, h('strong', null, duration(t.minutesDone)), ` of ${duration(t.minutes)} studied`),
      h('span', null, h('strong', null, `${t.checkpointsDone} of ${t.checkpoints}`), ' checkpoint questions'),
    );
    setBar(overall, t.itemsDone, t.items, itemsText(t));
    last.textContent = t.last ? `Last studied ${day(t.last)}.` : 'Nothing ticked yet.';
    const next = nextItem(course, store);
    if (next) {
      const it = next.module.items[next.index];
      const mi = course.modules.indexOf(next.module) + 1;
      cont.replaceChildren(
        h('a.btn.primary.cs-continue-btn', { href: `#/course/${next.module.id}/${it.id}` }, t.itemsDone ? 'Continue' : 'Start the course'),
        h('span.cs-continue-what', null, `Next: ${it.title}`, h('span.cs-continue-where', null, ` (module ${mi})`)),
      );
    } else cont.replaceChildren(h('span.cs-continue-what', null, 'Every item is done. Keep answering the checkpoint questions out loud until each is solid.'));
    for (const r of rows) {
      const t2 = moduleTally(r.m, store);
      const st = moduleState(t2);
      r.li.dataset.state = st;
      r.state.textContent = STATE_LABEL[st];
      r.state.className = `cs-state cs-state-${st}`;
      setBar(r.bar, t2.itemsDone, t2.items, itemsText(t2));
      r.meta.textContent = [`${t2.itemsDone} of ${t2.items} items`, duration(t2.minutes), ...(t2.last ? [`last studied ${day(t2.last)}`] : [])].join(' · ');
    }
  };
  update();

  page.append(
    h('header.page-head', null, h('h1', null, inline(course.title)), h('p.lede', null, inline(course.summary))),
    progress,
    howTo,
    h('section.cs-modules', { 'aria-labelledby': 'cs-modules-h' }, h('h2', { id: 'cs-modules-h' }, 'Modules'), h('ol.cs-mod-list', null, rows.map((r) => r.li))),
    tools(store, course, redraw),
  );
  return store.onChange(update);
}

// ---- export, import, reset ------------------------------------------------------------------

function tools(store: ProgressStore, course: Course, redraw: (msg: string) => void): HTMLElement {
  const status = h('p.cs-tools-status', { role: 'status', tabIndex: -1 });
  const say = (text: string) => {
    status.textContent = text;
  };

  const download = h('button.btn', { type: 'button' }, 'Download progress');
  download.addEventListener('click', () => {
    try {
      const blob = new Blob([store.exportText()], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `course-progress-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say('Downloaded. Keep the file to import your progress in another browser.');
    } catch {
      say('The download did not start. Use "Copy progress" instead.');
    }
  });

  const shown = h('textarea.cs-textarea', { readOnly: true, rows: 6, 'aria-label': 'Your progress as text' }) as HTMLTextAreaElement;
  const shownBox = h('div.cs-shown', { hidden: true }, h('p', null, 'Copy this text and keep it somewhere safe:'), shown);
  const copy = h('button.btn', { type: 'button' }, 'Copy progress');
  copy.addEventListener('click', async () => {
    const text = store.exportText();
    try {
      await navigator.clipboard.writeText(text);
      say('Copied. Paste it into "Import progress" in another browser.');
    } catch {
      // No clipboard (an older browser, or permission refused): show the text to copy by hand.
      shown.value = text;
      shownBox.hidden = false;
      shown.focus();
      shown.select();
      say('The browser would not copy it. The text is selected below: copy it by hand.');
    }
  });

  // Import: paste the text or choose a file. Either replaces what this browser holds.
  const paste = h('textarea.cs-textarea', { id: 'cs-import-text', rows: 5, spellcheck: false }) as HTMLTextAreaElement;
  const file = h('input', { type: 'file', id: 'cs-import-file', accept: '.json,application/json,text/plain' }) as HTMLInputElement;
  const importErr = h('p.form-error', { id: 'cs-import-error', 'aria-live': 'polite' });
  const doImport = (text: string) => {
    if (!store.importText(text)) {
      importErr.textContent = 'That is not an exported progress file. Nothing has changed.';
      paste.setAttribute('aria-invalid', 'true');
      return;
    }
    const t = courseTally(course, store);
    redraw(`Imported: ${t.itemsDone} of ${t.items} items done.`);
  };
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      doImport(await f.text());
    } catch {
      importErr.textContent = 'That file could not be read. Nothing has changed.';
    }
  });
  const importBtn = h('button.btn', { type: 'button' }, 'Import');
  importBtn.addEventListener('click', () => doImport(paste.value));
  paste.addEventListener('input', () => {
    importErr.textContent = '';
    paste.removeAttribute('aria-invalid');
  });
  const importBox = h(
    'details.cs-import', null,
    h('summary', null, 'Import progress'),
    h(
      'div.cs-import-body', null,
      h('p', null, 'Importing replaces the progress held in this browser.'),
      h('label', { for: 'cs-import-text' }, 'Paste exported progress'),
      paste,
      importErr,
      h('p.cs-import-row', null, importBtn),
      h('p.cs-import-file', null, h('label', { for: 'cs-import-file' }, 'Or choose an exported file '), file),
    ),
  );
  paste.setAttribute('aria-describedby', 'cs-import-error');

  // Reset asks again on the page, not in a browser dialog.
  const reset = h('button.btn.danger', { type: 'button' }, 'Reset progress');
  const yes = h('button.btn.danger', { type: 'button' }, 'Yes, clear it');
  const no = h('button.btn', { type: 'button' }, 'Keep it');
  const ask = h('div.cs-confirm', { hidden: true, role: 'group', 'aria-labelledby': 'cs-confirm-q' }, h('p', { id: 'cs-confirm-q' }, 'Clear every tick and rating in this browser? This cannot be undone. Download your progress first to keep a copy.'), h('p.cs-confirm-row', null, yes, no));
  reset.addEventListener('click', () => {
    ask.hidden = false;
    reset.hidden = true;
    no.focus();
  });
  no.addEventListener('click', () => {
    ask.hidden = true;
    reset.hidden = false;
    reset.focus();
  });
  yes.addEventListener('click', () => {
    store.reset();
    redraw('Progress cleared.');
  });

  return h(
    'section.cs-tools', { 'aria-labelledby': 'cs-tools-h' },
    h('h2', { id: 'cs-tools-h' }, 'Keep your progress'),
    h('p', null, 'Progress is kept in this browser only, with nothing sent anywhere. To move it to another browser or device, copy or download it here and import it there.'),
    h('p.cs-tools-row', null, copy, download, reset),
    shownBox,
    ask,
    importBox,
    status,
  );
}

// ---- one module ----------------------------------------------------------------------------

function drawModule(page: HTMLElement, course: Course, m: Module, store: ProgressStore): () => void {
  const index = course.modules.indexOf(m);
  const figs = h('p.cs-figs');
  const modBar = bar(0, 0, 'Module progress', '');
  const state = h('span.cs-state');
  const itemDone = new Map<string, HTMLElement>();
  const cpDone: HTMLInputElement[] = [];

  const items = m.items.map((it) => {
    const id = `cs-i-${m.id}-${it.id}`;
    const box = h('input', { type: 'checkbox', id, checked: store.itemDone(m.id, it.id) }) as HTMLInputElement;
    box.addEventListener('change', () => store.setItem(m.id, it.id, box.checked));
    const when = h('span.cs-when');
    itemDone.set(it.id, when);
    const title = it.href ? h('a.cs-item-title', { href: it.href }, inline(it.title)) : h('span.cs-item-title', null, inline(it.title));
    return h(
      'li.cs-item', { 'data-item': it.id },
      h('label.cs-check', { for: id }, box, h('span.visually-hidden', null, `Done: ${it.title}`)),
      h(
        'div.cs-item-body', null,
        h('p.cs-item-head', { id: `${id}-t` }, h('span.cs-kind', { class: `cs-kind-${it.kind}` }, KIND[it.kind]), ' ', title),
        h('p.cs-item-meta', null, h('span', null, duration(it.minutes)), it.href ? null : h('span.cs-nopage', null, 'No page on the site yet'), when),
        h('p.cs-note', null, inline(it.note)),
        it.covers?.length
          ? h('details.cs-covers', null, h('summary', null, `What a strong answer covers (${it.covers.length})`), h('ul', null, it.covers.map((c) => h('li', null, inline(c)))))
          : null,
      ),
    );
  });

  const checks = m.checkpoint.map((q, i) => {
    const id = `cs-c-${m.id}-${i}`;
    const box = h('input', { type: 'checkbox', id, checked: store.checkpointDone(m.id, i), 'aria-describedby': `${id}-q` }) as HTMLInputElement;
    box.addEventListener('change', () => store.setCheckpoint(m.id, i, box.checked));
    cpDone.push(box);
    return h(
      'li.cs-cp', { 'data-key': checkpointKey(m.id, i) },
      h('p.cs-cp-q', { id: `${id}-q` }, inline(q)),
      h('label.cs-cp-check', { for: id }, box, h('span', null, 'I can answer this out loud'), h('span.visually-hidden', null, `: question ${i + 1}`)),
    );
  });

  // Confidence: three radios, and a button to take the rating back.
  const name = `cs-conf-${m.id}`;
  const radios = LEVELS.map((l) => {
    const r = h('input', { type: 'radio', name, id: `${name}-${l.id}`, value: l.id, checked: store.level(m.id) === l.id }) as HTMLInputElement;
    r.addEventListener('change', () => r.checked && store.setLevel(m.id, l.id as Level));
    return h('label.cs-level', { for: r.id }, r, h('span', null, l.label));
  });
  const clear = h('button.btn.quiet.cs-clear', { type: 'button' }, 'Clear rating');
  clear.addEventListener('click', () => {
    store.setLevel(m.id, null);
    for (const l of radios) (l.querySelector('input') as HTMLInputElement).checked = false;
    (radios[0].querySelector('input') as HTMLInputElement).focus();
  });
  const confidence = h(
    'fieldset.cs-confidence', null,
    h('legend', null, 'How sure are you of this module?'),
    h('div.cs-levels', null, radios),
    clear,
  );

  const prev = course.modules[index - 1];
  const next = course.modules[index + 1];

  const update = () => {
    const t = moduleTally(m, store);
    figs.replaceChildren(
      h('span', null, h('strong', null, `${t.itemsDone} of ${t.items}`), ' items done'),
      h('span', null, h('strong', null, duration(t.minutesDone)), ` of ${duration(t.minutes)}`),
      h('span', null, h('strong', null, `${t.checkpointsDone} of ${t.checkpoints}`), ' checkpoint questions'),
    );
    setBar(modBar, t.itemsDone, t.items, itemsText(t));
    const st = moduleState(t);
    state.textContent = STATE_LABEL[st];
    state.className = `cs-state cs-state-${st}`;
    for (const it of m.items) {
      const mark = store.data.items[itemKey(m.id, it.id)];
      const el = itemDone.get(it.id)!;
      el.textContent = mark?.done ? `Done${mark.at ? ` ${day(mark.at)}` : ''}` : '';
      el.closest('.cs-item')!.classList.toggle('done', !!mark?.done);
      const box = el.closest('.cs-item')!.querySelector('input') as HTMLInputElement;
      box.checked = !!mark?.done;
    }
    m.checkpoint.forEach((_, i) => (cpDone[i].checked = store.checkpointDone(m.id, i)));
    const lvl = store.level(m.id);
    for (const l of radios) {
      const r = l.querySelector('input') as HTMLInputElement;
      r.checked = r.value === lvl;
    }
    clear.hidden = !lvl;
  };

  page.append(
    h('nav.cs-crumb', { 'aria-label': 'Course' }, h('a', { href: '#/course' }, inline(course.title)), h('span', null, ` · Module ${index + 1} of ${course.modules.length}`)),
    h('header.page-head', null, h('h1', null, inline(m.title)), h('p.lede', null, inline(m.why))),
    h('section.cs-progress', { 'aria-label': 'Module progress' }, figs, modBar, h('p.cs-mod-status', null, state), unsavedLine(store)),
    h('section.cs-items', { 'aria-labelledby': 'cs-items-h' }, h('h2', { id: 'cs-items-h' }, 'Study'), h('p.cs-hint', null, 'Tick each item when you have done it. Links open the page on this site; Back brings you here.'), h('ol.cs-item-list', null, items)),
    h(
      'section.cs-checkpoint', { 'aria-labelledby': 'cs-cp-h' },
      h('h2', { id: 'cs-cp-h' }, 'Checkpoint'),
      h('p.cs-hint', null, 'Answer each question out loud, without notes, before you tick it.'),
      h('ol.cs-cp-list', null, checks),
      confidence,
    ),
    h(
      'nav.cs-pager', { 'aria-label': 'Modules' },
      prev ? h('a.cs-prev', { href: `#/course/${prev.id}` }, h('span.cs-pager-dir', null, 'Previous module'), h('span', null, inline(prev.title))) : h('span'),
      next ? h('a.cs-next', { href: `#/course/${next.id}` }, h('span.cs-pager-dir', null, 'Next module'), h('span', null, inline(next.title))) : h('a.cs-next', { href: '#/course' }, h('span.cs-pager-dir', null, 'Last module'), h('span', null, 'Back to the course')),
    ),
  );
  update();
  return store.onChange(update);
}
