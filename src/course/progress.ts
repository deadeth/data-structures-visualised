import type { Course, Module } from './types';

/**
 * The reader's progress through the course, kept in their browser under `dsv.course`:
 *
 *   { items:       { '<module>/<item>': { done, at } },
 *     checkpoints: { '<module>/<index>': { done, at } },      index counts from 0
 *     confidence:  { '<module>': { level, at } },            level: 'not-yet' | 'shaky' | 'solid'
 *     pages:       { '<address>': { done, at } } }           pages ticked in a design's study guide that the course does not list
 *
 * `at` is an ISO date-time. Every read and write is wrapped: when storage is blocked or full, progress
 * lives in memory for the visit and `saving` is false. Entries for ids the course no longer has (a
 * renamed item) are kept as they are and left out of every count.
 */

export const STORAGE_KEY = 'dsv.course';

export type Level = 'not-yet' | 'shaky' | 'solid';
export const LEVELS: { id: Level; label: string }[] = [
  { id: 'not-yet', label: 'Not yet' },
  { id: 'shaky', label: 'Shaky' },
  { id: 'solid', label: 'Solid' },
];

export interface Mark {
  done: boolean;
  at: string;
}
export interface Rating {
  level: Level;
  at: string;
}
export interface Progress {
  items: Record<string, Mark>;
  checkpoints: Record<string, Mark>;
  confidence: Record<string, Rating>;
  /** Pages ticked as studied outside the course (a design's study guide), by site address such as `#/s/heap`. */
  pages: Record<string, Mark>;
}

/** The part of the Storage interface used here, so a test can hand in its own. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const empty = (): Progress => ({ items: {}, checkpoints: {}, confidence: {}, pages: {} });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/**
 * Whatever was stored, reduced to entries of the right shape. Anything else is dropped one entry at a
 * time, so one bad entry does not cost the rest. Returns null when the text is not a progress object at all.
 */
export function parse(text: string | null): Progress | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const out = empty();
  const marks = (src: unknown, dst: Record<string, Mark>) => {
    if (!isObj(src)) return;
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && typeof v.done === 'boolean') dst[k] = { done: v.done, at: isDate(v.at) ? v.at : '' };
    }
  };
  marks(raw.items, out.items);
  marks(raw.checkpoints, out.checkpoints);
  marks(raw.pages, out.pages);
  if (isObj(raw.confidence)) {
    for (const [k, v] of Object.entries(raw.confidence)) {
      if (isObj(v) && LEVELS.some((l) => l.id === v.level)) out.confidence[k] = { level: v.level as Level, at: isDate(v.at) ? v.at : '' };
    }
  }
  return out;
}

export const itemKey = (moduleId: string, itemId: string) => `${moduleId}/${itemId}`;
export const checkpointKey = (moduleId: string, index: number) => `${moduleId}/${index}`;

/** The browser's localStorage, or null when even asking for it throws (some privacy settings do). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class ProgressStore {
  data: Progress = empty();
  /** False once a read or write has failed: progress then lasts only for this visit. */
  saving = true;
  private listeners = new Set<() => void>();

  constructor(
    private storage: StorageLike | null,
    private now: () => Date = () => new Date(),
  ) {
    if (!storage) this.saving = false;
    this.load();
  }

  load(): void {
    if (!this.storage) return;
    try {
      this.data = parse(this.storage.getItem(STORAGE_KEY)) ?? empty();
    } catch {
      this.saving = false;
    }
  }

  private save(): void {
    if (this.storage && this.saving) {
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      } catch {
        this.saving = false;
      }
    }
    for (const f of this.listeners) f();
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private stamp = () => this.now().toISOString();

  itemDone = (m: string, i: string) => this.data.items[itemKey(m, i)]?.done === true;
  checkpointDone = (m: string, i: number) => this.data.checkpoints[checkpointKey(m, i)]?.done === true;
  pageDone = (href: string) => this.data.pages[href]?.done === true;
  level = (m: string): Level | undefined => this.data.confidence[m]?.level;

  setItem(m: string, i: string, done: boolean): void {
    this.data.items[itemKey(m, i)] = { done, at: this.stamp() };
    this.save();
  }

  /** Ticks or unticks several course items at once, with one save. */
  setItems(keys: { module: string; item: string }[], done: boolean): void {
    const at = this.stamp();
    for (const k of keys) this.data.items[itemKey(k.module, k.item)] = { done, at };
    this.save();
  }

  setPage(href: string, done: boolean): void {
    this.data.pages[href] = { done, at: this.stamp() };
    this.save();
  }

  setCheckpoint(m: string, i: number, done: boolean): void {
    this.data.checkpoints[checkpointKey(m, i)] = { done, at: this.stamp() };
    this.save();
  }

  setLevel(m: string, level: Level | null): void {
    if (level) this.data.confidence[m] = { level, at: this.stamp() };
    else delete this.data.confidence[m];
    this.save();
  }

  reset(): void {
    this.data = empty();
    if (this.storage && this.saving) {
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch {
        this.saving = false;
      }
    }
    for (const f of this.listeners) f();
  }

  /** Read storage again (another tab changed it) and tell the listeners. */
  reload(): void {
    this.load();
    for (const f of this.listeners) f();
  }

  exportText(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /** Replaces progress with an exported file's. Returns false, changing nothing, when the text is not one. */
  importText(text: string): boolean {
    const p = parse(text.trim());
    if (!p) return false;
    this.data = p;
    this.save();
    return true;
  }
}

let shared: ProgressStore | null = null;
/** The one store the site's pages share. It follows changes made in other tabs. */
export function sharedStore(): ProgressStore {
  if (!shared) {
    const s = new ProgressStore(browserStorage());
    shared = s;
    if (typeof addEventListener === 'function') addEventListener('storage', (e) => e.key === STORAGE_KEY && s.saving && s.reload());
  }
  return shared;
}

// ---- counting against the course -----------------------------------------------------

export interface Tally {
  items: number;
  itemsDone: number;
  minutes: number;
  minutesDone: number;
  checkpoints: number;
  checkpointsDone: number;
  /** The latest date anything in it was ticked or rated, if ever. */
  last?: string;
}

export function moduleTally(m: Module, s: ProgressStore): Tally {
  const t: Tally = { items: m.items.length, itemsDone: 0, minutes: 0, minutesDone: 0, checkpoints: m.checkpoint.length, checkpointsDone: 0 };
  const seen = (at: string | undefined) => {
    if (at && (!t.last || at > t.last)) t.last = at;
  };
  for (const it of m.items) {
    t.minutes += it.minutes;
    const mark = s.data.items[itemKey(m.id, it.id)];
    if (mark?.done) {
      t.itemsDone++;
      t.minutesDone += it.minutes;
      seen(mark.at);
    }
  }
  m.checkpoint.forEach((_, i) => {
    const mark = s.data.checkpoints[checkpointKey(m.id, i)];
    if (mark?.done) {
      t.checkpointsDone++;
      seen(mark.at);
    }
  });
  seen(s.data.confidence[m.id]?.at);
  return t;
}

export function courseTally(c: Course, s: ProgressStore): Tally {
  const t: Tally = { items: 0, itemsDone: 0, minutes: 0, minutesDone: 0, checkpoints: 0, checkpointsDone: 0 };
  for (const m of c.modules) {
    const x = moduleTally(m, s);
    t.items += x.items;
    t.itemsDone += x.itemsDone;
    t.minutes += x.minutes;
    t.minutesDone += x.minutesDone;
    t.checkpoints += x.checkpoints;
    t.checkpointsDone += x.checkpointsDone;
    if (x.last && (!t.last || x.last > t.last)) t.last = x.last;
  }
  return t;
}

/** The first item not yet done, in course order. */
export function nextItem(c: Course, s: ProgressStore): { module: Module; index: number } | null {
  for (const m of c.modules) {
    const index = m.items.findIndex((it) => !s.itemDone(m.id, it.id));
    if (index >= 0) return { module: m, index };
  }
  return null;
}

// ---- pages shared with a design's study guide ---------------------------------------------

/**
 * The course items a study guide's page stands for, so a tick in either place is one tick.
 * An address of a course item (`#/course/<module>/<item>`) is that item. Any other address is
 * every reading or watching item the course links to the same page; a practice prompt or a drill
 * that happens to link there is a different piece of work and is left alone.
 */
export function linkedItems(c: Course | null, href: string): { module: string; item: string }[] {
  if (!c) return [];
  const own = /^#\/course\/([^/]+)\/([^/]+)$/.exec(href);
  if (own) return c.modules.some((m) => m.id === own[1] && m.items.some((i) => i.id === own[2])) ? [{ module: own[1], item: own[2] }] : [];
  return c.modules.flatMap((m) => m.items.filter((i) => i.href === href && (i.kind === 'read' || i.kind === 'watch')).map((i) => ({ module: m.id, item: i.id })));
}
