import { h } from '../core/dom';
import { registerDesign, design as designEntry } from '../designs';
import type { Extras } from '../designs/extras/types';
import type { Design } from '../designs/types';
import { registerWalkthrough } from '../reading';
import type { Reading } from '../reading/types';
import { open, type Sealed } from './crypto';
import { LOCKED, blobUrl, type LockedEntry } from './manifest';

/** What a locked file holds once opened. */
export interface LockedPayload {
  designs: Design[];
  extras: Record<string, Extras>;
  walkthroughs: Record<string, Reading>;
  /** Sidebar name, hint and interview question for each design; the design's own name stands in when missing. */
  entries?: { id: string; name: string; hint: string; question: string }[];
}

/** The password, kept for this tab only, so a reload or a new page stays open until the tab is closed. */
const KEY = 'dsv.unlock';

const opened = new Set<LockedEntry>();
const listeners: (() => void)[] = [];

/** Called after any locked page opens, to redraw what lists pages (the sidebar). */
export function onUnlock(fn: () => void): void {
  listeners.push(fn);
}

export const isOpen = (e: LockedEntry): boolean => opened.has(e) || e.ids.every((id) => !!designEntry(id));

/** Put an opened file's pages into the site's registries, as if they had been there from the start. */
export function registerPayload(p: LockedPayload): void {
  for (const [id, page] of Object.entries(p.walkthroughs ?? {})) registerWalkthrough(id, page);
  for (const d of p.designs) {
    const meta = p.entries?.find((e) => e.id === d.id);
    const ex = p.extras?.[d.id];
    registerDesign({
      id: d.id,
      name: meta?.name ?? d.name,
      hint: meta?.hint ?? d.blurb,
      question: meta?.question ?? d.name,
      load: () => Promise.resolve(d),
      extras: ex ? () => Promise.resolve(ex) : undefined,
    });
  }
}

const files = new Map<LockedEntry, Promise<Sealed>>();
function fetchSealed(e: LockedEntry): Promise<Sealed> {
  let f = files.get(e);
  if (!f) {
    f = fetch(blobUrl(e)).then((r) => {
      if (!r.ok) throw new Error(`Locked file: HTTP ${r.status}`);
      return r.json() as Promise<Sealed>;
    });
    // A failed fetch is not kept, so the next try fetches again.
    f.catch(() => files.delete(e));
    files.set(e, f);
  }
  return f;
}

export type UnlockResult = 'ok' | 'wrong' | 'unavailable';

/** Try a password on one locked file. Never throws. */
export async function unlock(e: LockedEntry, password: string): Promise<UnlockResult> {
  if (isOpen(e)) return 'ok';
  let sealed: Sealed;
  try {
    sealed = await fetchSealed(e);
  } catch (err) {
    console.warn(err);
    return 'unavailable';
  }
  let payload: LockedPayload;
  try {
    payload = JSON.parse(await open(sealed, password)) as LockedPayload;
  } catch {
    return 'wrong';
  }
  try {
    registerPayload(payload);
  } catch (err) {
    console.warn(err);
    return 'unavailable';
  }
  opened.add(e);
  try {
    sessionStorage.setItem(KEY, password);
  } catch {
    // Storage can be blocked; the page stays open until it is reloaded.
  }
  for (const fn of listeners) fn();
  return 'ok';
}

/** Open every locked file the password kept for this tab opens. Quiet: nothing is shown either way. */
export async function unlockSaved(): Promise<void> {
  let password: string | null = null;
  try {
    password = sessionStorage.getItem(KEY);
  } catch {
    return;
  }
  if (!password) return;
  await Promise.all(LOCKED.map((e) => unlock(e, password)));
}

/** The form that stands in for a locked page. `done` is called once the page has opened. */
export function mountLock(host: HTMLElement, e: LockedEntry, done: () => void): () => void {
  const title = h('h1', { tabIndex: -1 }, e.label);
  const input = h('input.lock-input', { type: 'password', id: 'lock-password', name: 'password', autocomplete: 'current-password', required: true, 'aria-describedby': 'lock-error' }) as HTMLInputElement;
  const button = h('button.btn.primary', { type: 'submit' }, 'Unlock') as HTMLButtonElement;
  const error = h('p.form-error.lock-error', { id: 'lock-error', role: 'status' });
  let alive = true;
  const form = h(
    'form.lock-form', {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        if (!input.value || button.disabled) return;
        button.disabled = true;
        button.textContent = 'Unlocking…';
        error.textContent = '';
        const r = await unlock(e, input.value);
        if (!alive) return;
        if (r === 'ok') {
          done();
          return;
        }
        button.disabled = false;
        button.textContent = 'Unlock';
        error.textContent = r === 'wrong' ? 'That password did not unlock this page.' : 'The page could not be loaded. Check the connection and try again.';
        input.select();
        input.focus();
      },
    },
    h('label', { for: 'lock-password' }, 'Password'),
    h('div.lock-row', null, input, button),
    error,
  );
  const article = h('article.lock-page', null, h('header.page-head', null, title, h('p.lede', null, 'This page is locked.')), form);
  host.append(article);
  input.focus();
  return () => {
    alive = false;
    article.remove();
  };
}
