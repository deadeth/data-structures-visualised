import { beforeAll, describe, expect, it } from 'vitest';
import { CATALOG, isReady } from '../catalog';
import { DESIGNS } from '../designs';
import type { Design } from '../designs/types';
import { LOCKED_IDS } from '../locked/manifest';
import { READING_FILES } from '../reading';
import fixture from './__fixtures__/fixture-course';
import { ProgressStore, STORAGE_KEY, courseTally, moduleTally, nextItem, parse, type StorageLike } from './progress';
import type { Course } from './types';

/**
 * Checks the course (and its fixture) for what `tsc` cannot see: duplicate ids, links to pages that do
 * not exist, practise items without `covers`, the reading brief's banned words, and company names.
 * Also tests the progress store against a storage that works, holds rubbish, or throws.
 */

const real = import.meta.glob<{ default?: Course; course?: Course }>('./course.ts', { eager: true });
const realCourse = Object.values(real).map((m) => m.default ?? m.course)[0];

// ---- words ---------------------------------------------------------------------------------

/** The banned list is read from the reading pages' test, so the two never drift apart. */
function bannedList(): string[] {
  const files = import.meta.glob<string>('../reading/reading.test.ts', { query: '?raw', import: 'default', eager: true });
  const src = Object.values(files)[0] ?? '';
  const body = /const BANNED = \[([\s\S]*?)\];/.exec(src)?.[1];
  if (!body) throw new Error('could not find the BANNED list in src/reading/reading.test.ts');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const BANNED = bannedList();
const bannedRe = BANNED.map((phrase) => {
  const words = phrase.split(' ');
  const first = words[0];
  const stem = first.endsWith('e') ? `${first.slice(0, -1)}(?:e|es|ed|ing|ely)` : `${first}(?:s|es|ed|ing|ly)?`;
  return { phrase, re: new RegExp(`(?<![\\p{L}\\p{N}-])${[stem, ...words.slice(1)].join('\\s+')}(?![\\p{L}\\p{N}-])`, 'iu') };
});
const PHRASES = [
  { phrase: "it's not just X, it's Y", re: /\bnot just\b[^.;:]{0,80}?,\s*(?:it'?s|it is|but)\b/i },
  { phrase: "in today's world", re: /\bin today'?s world\b/i },
];
/** Companies the course must not name. Whole words, any case. */
/** Spelled in pieces so this file does not itself name them. */
const NAME_A = ['W', 'ise'].join('');
const NAME_B = ['BE', 'AM'].join('');
const COMPANIES = new RegExp(`\\b(?:${NAME_A}|${NAME_B})\\b`, 'i');

// ---- links ---------------------------------------------------------------------------------

interface Ctx {
  designs: Map<string, Design>;
  /** Reading pages by address base (`c/<id>` or `d/<id>/read`), with their section ids. */
  pages: Map<string, Set<string>>;
  /** Module ids and their item ids, for links inside the course. */
  modules: Map<string, Set<string>>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function checkHref(href: string, ctx: Ctx): string | null {
  if (!href.startsWith('#/')) return 'only site links (#/...) are allowed';
  const path = href.slice(2);
  if (path === '' || path === 'compare' || path.startsWith('search/')) return null;
  let m = /^course(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path);
  if (m) {
    if (!m[1]) return null;
    const items = ctx.modules.get(m[1]);
    if (!items) return `no course module "${m[1]}"`;
    return m[2] && !items.has(m[2]) ? `module "${m[1]}" has no item "${m[2]}"` : null;
  }
  m = /^s\/([^/]+)$/.exec(path);
  if (m) return CATALOG.some((c) => c.id === m![1]) && isReady(m[1]) ? null : `no structure page "${m[1]}"`;
  m = /^c\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (m) {
    const secs = ctx.pages.get(`c/${m[1]}`);
    if (!secs) return `no concept page "${m[1]}"`;
    return m[2] && !secs.has(decodeURIComponent(m[2])) ? `concept page "${m[1]}" has no section "${m[2]}"` : null;
  }
  m = /^d\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (m) {
    const d = ctx.designs.get(m[1]);
    // A locked design's content is not in the repo: any address under it leads to the password form.
    if (!d) return LOCKED_IDS.includes(m[1]) ? null : `no design "${m[1]}"`;
    const rest = m[2];
    if (!rest) return null;
    const entry = DESIGNS.find((x) => x.id === m![1])!;
    let r = /^read(?:\/([^/]+))?$/.exec(rest);
    if (r) {
      const secs = ctx.pages.get(`d/${m[1]}/read`);
      if (!secs) return `design "${m[1]}" has no walkthrough`;
      return r[1] && !secs.has(decodeURIComponent(r[1])) ? `the ${m[1]} walkthrough has no section "${r[1]}"` : null;
    }
    if (rest === 'rehearse' || rest === 'crib') return entry.extras ? null : `design "${m[1]}" has no interview extras, so no ${rest}`;
    r = /^([cfgtqxs])\/([^/]+)$/.exec(rest);
    if (!r) return `"${rest}" is not a part of a design page`;
    const [, k, id] = r;
    if (k === 'c') return d.components.some((c) => c.id === id) ? null : `design "${d.id}" has no component "${id}"`;
    if (k === 'f') return d.flows.some((f) => f.id === id || f.reply?.id === id) ? null : `design "${d.id}" has no flow "${id}"`;
    if (k === 't') return Number(id) >= 1 && Number(id) <= d.tour.length ? null : `design "${d.id}" has no tour step ${id}`;
    if (k === 's') {
      const [sid, step] = id.split('.');
      const st = (d.stories ?? []).find((x) => x.id === sid);
      if (!st) return `design "${d.id}" has no story "${sid}"`;
      return step === undefined || (Number(step) >= 1 && Number(step) <= st.tour.length) ? null : `story "${sid}" has no step ${step}`;
    }
    if (k === 'g') return d.glossary.some((g) => slug(g.term) === id) ? null : `design "${d.id}" has no glossary term "${id}"`;
    return entry.extras ? null : `design "${d.id}" has no interview extras for "${k}/${id}"`;
  }
  return `"${href}" is not an address on this site`;
}

function checkText(text: string, at: string, ctx: Ctx, out: string[]): void {
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const bad = checkHref(m[2], ctx);
    if (bad) out.push(`${at}: link [${m[1]}](${m[2]}): ${bad}`);
  }
  const words = text.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']');
  for (const { phrase, re } of [...bannedRe, ...PHRASES]) {
    const m = re.exec(words);
    if (m) out.push(`${at}: banned word or phrase "${phrase}" (found "${m[0]}")`);
  }
  const co = COMPANIES.exec(text);
  if (co) out.push(`${at}: names a company ("${co[0]}"); the course must not`);
}

// ---- the course ------------------------------------------------------------------------------

const ID = /^[a-z0-9-]+$/;

function validate(c: Course, ctx: Ctx): string[] {
  const out: string[] = [];
  ctx.modules = new Map(c.modules.map((m) => [m.id, new Set(m.items.map((i) => i.id))]));
  checkText(c.title, 'title', ctx, out);
  checkText(c.summary, 'summary', ctx, out);
  c.howTo.forEach((p, i) => checkText(p, `howTo ${i + 1}`, ctx, out));
  if (!c.modules.length) out.push('the course has no modules');
  const mods = new Set<string>();
  for (const m of c.modules) {
    const at = `module "${m.id}"`;
    if (mods.has(m.id)) out.push(`${at}: id is used twice`);
    mods.add(m.id);
    if (!ID.test(m.id)) out.push(`${at}: id should be lower case letters, digits and hyphens (it is part of an address)`);
    if (COMPANIES.test(m.id)) out.push(`${at}: id names a company`);
    checkText(m.title, `${at}, title`, ctx, out);
    checkText(m.why, `${at}, why`, ctx, out);
    if (!(m.minutes > 0)) out.push(`${at}: minutes should be a positive number`);
    if (!m.items.length) out.push(`${at}: has no items`);
    if (!m.checkpoint.length) out.push(`${at}: has no checkpoint questions`);
    const items = new Set<string>();
    for (const it of m.items) {
      const iat = `${at}, item "${it.id}"`;
      if (items.has(it.id)) out.push(`${iat}: id is used twice in the module`);
      items.add(it.id);
      if (!ID.test(it.id)) out.push(`${iat}: id should be lower case letters, digits and hyphens (it is part of an address)`);
      if (COMPANIES.test(it.id)) out.push(`${iat}: id names a company`);
      if (!['read', 'watch', 'practise', 'drill'].includes(it.kind)) out.push(`${iat}: unknown kind "${it.kind}"`);
      if (!(it.minutes > 0)) out.push(`${iat}: minutes should be a positive number`);
      checkText(it.title, `${iat}, title`, ctx, out);
      checkText(it.note, `${iat}, note`, ctx, out);
      if (it.href !== undefined) {
        const bad = checkHref(it.href, ctx);
        if (bad) out.push(`${iat}: href ${it.href}: ${bad}`);
        if (COMPANIES.test(it.href)) out.push(`${iat}: href names a company`);
      }
      if (it.kind === 'practise' && !it.covers?.length) out.push(`${iat}: a practise item needs "covers"`);
      (it.covers ?? []).forEach((cv, i) => checkText(cv, `${iat}, covers ${i + 1}`, ctx, out));
    }
    const qs = new Set<string>();
    m.checkpoint.forEach((q, i) => {
      if (qs.has(q.trim())) out.push(`${at}, checkpoint ${i + 1}: the same question is asked twice`);
      qs.add(q.trim());
      checkText(q, `${at}, checkpoint ${i + 1}`, ctx, out);
    });
  }
  return out;
}

const ctx: Ctx = { designs: new Map(), pages: new Map(), modules: new Map() };

beforeAll(async () => {
  for (const d of DESIGNS) ctx.designs.set(d.id, await d.load());
  for (const f of READING_FILES) {
    const key = f.kind === 'concept' ? `c/${f.page.id}` : `d/${f.file.replace(/^.*\//, '').replace(/\.ts$/, '')}/read`;
    ctx.pages.set(key, new Set(f.page.sections.map((s) => s.id)));
  }
});

describe('course', () => {
  it('the fixture passes validation', () => {
    const problems = validate(fixture, ctx);
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it.skipIf(!realCourse)('src/course/course.ts passes validation', () => {
    const problems = validate(realCourse!, ctx);
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('the validator catches each fault', () => {
    const bad: Course = {
      title: `A course from ${NAME_A}`,
      summary: 'We leverage things. See [x](#/s/no-such-structure).',
      howTo: [`Study at ${NAME_B}.`],
      modules: [
        {
          id: 'one', title: 'One', why: 'Why.', minutes: 10,
          items: [
            { id: 'a', kind: 'read', title: 'A', href: '#/d/no-such-design', minutes: 5, note: 'n' },
            { id: 'a', kind: 'practise', title: 'B', href: '#/d/ledger/t/999', minutes: 5, note: 'n' },
            { id: 'c', kind: 'read', title: 'C', href: '#/c/caching/no-such-section', minutes: 5, note: 'n' },
            { id: 'd', kind: 'read', title: 'D', href: '#/d/web-crawler/read', minutes: 5, note: 'n' },
            { id: 'e', kind: 'read', title: 'E', href: '#/d/money-moved-dashboard/crib', minutes: 5, note: 'n' },
          ],
          checkpoint: ['Q?', 'Q?'],
        },
        { id: 'one', title: 'Again', why: 'w', minutes: 1, items: [{ id: 'x', kind: 'drill', title: 'X', minutes: 1, note: 'otherwise fine' }], checkpoint: ['Z?'] },
      ],
    };
    const p = validate(bad, ctx).join('\n');
    for (const want of [
      `title: names a company ("${NAME_A}")`,
      `howTo 1: names a company ("${NAME_B}")`,
      'banned word or phrase "leverage"',
      'no structure page "no-such-structure"',
      'no design "no-such-design"',
      'item "a": id is used twice in the module',
      'a practise item needs "covers"',
      'has no tour step 999',
      'concept page "caching" has no section "no-such-section"',
      'checkpoint 2: the same question is asked twice',
      'module "one": id is used twice',
    ]) expect(p).toContain(want);
    // The walkthrough and the locked design's crib are real addresses; "otherwise" is not a company.
    expect(p).not.toContain('item "d"');
    expect(p).not.toContain('item "e"');
    expect(p).not.toContain('otherwise');
  });
});

// ---- the progress store ---------------------------------------------------------------------

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  failGet = false;
  failSet = false;
  getItem(k: string) {
    if (this.failGet) throw new Error('blocked');
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failSet) throw new Error('quota');
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.failSet) throw new Error('blocked');
    this.map.delete(k);
  }
}

const at = () => new Date('2026-11-16T10:00:00.000Z');

describe('progress store', () => {
  it('saves and loads again', () => {
    const mem = new MemStorage();
    const a = new ProgressStore(mem, at);
    a.setItem('foundations', 'b-plus-tree', true);
    a.setCheckpoint('foundations', 1, true);
    a.setLevel('foundations', 'shaky');
    const stored = JSON.parse(mem.map.get(STORAGE_KEY)!);
    expect(stored).toEqual({
      items: { 'foundations/b-plus-tree': { done: true, at: '2026-11-16T10:00:00.000Z' } },
      checkpoints: { 'foundations/1': { done: true, at: '2026-11-16T10:00:00.000Z' } },
      confidence: { foundations: { level: 'shaky', at: '2026-11-16T10:00:00.000Z' } },
    });
    const b = new ProgressStore(mem, at);
    expect(b.itemDone('foundations', 'b-plus-tree')).toBe(true);
    expect(b.checkpointDone('foundations', 1)).toBe(true);
    expect(b.level('foundations')).toBe('shaky');
    expect(b.saving).toBe(true);
  });

  it('ignores corrupted JSON and bad entries', () => {
    const mem = new MemStorage();
    mem.map.set(STORAGE_KEY, '{not json');
    expect(new ProgressStore(mem).data).toEqual({ items: {}, checkpoints: {}, confidence: {} });
    mem.map.set(STORAGE_KEY, '[1,2]');
    expect(new ProgressStore(mem).data.items).toEqual({});
    mem.map.set(STORAGE_KEY, JSON.stringify({ items: { 'm/a': { done: true, at: 'yesterday-ish' }, 'm/b': { done: 'yes' }, 'm/c': 7 }, checkpoints: null, confidence: { m: { level: 'great' }, n: { level: 'solid', at: '2026-01-02T00:00:00Z' } } }));
    const s = new ProgressStore(mem);
    expect(s.data.items).toEqual({ 'm/a': { done: true, at: '' } });
    expect(s.data.checkpoints).toEqual({});
    expect(s.data.confidence).toEqual({ n: { level: 'solid', at: '2026-01-02T00:00:00Z' } });
    expect(parse(null)).toBeNull();
  });

  it('keeps going in memory when storage throws', () => {
    const mem = new MemStorage();
    mem.failGet = true;
    const s = new ProgressStore(mem);
    expect(s.saving).toBe(false);
    s.setItem('m', 'a', true);
    expect(s.itemDone('m', 'a')).toBe(true);

    const mem2 = new MemStorage();
    const s2 = new ProgressStore(mem2);
    mem2.failSet = true;
    let told = 0;
    s2.onChange(() => told++);
    s2.setItem('m', 'a', true);
    expect(s2.saving).toBe(false);
    expect(s2.itemDone('m', 'a')).toBe(true);
    expect(told).toBe(1);
    s2.reset();
    expect(s2.itemDone('m', 'a')).toBe(false);

    const none = new ProgressStore(null);
    expect(none.saving).toBe(false);
    none.setLevel('m', 'solid');
    expect(none.level('m')).toBe('solid');
  });

  it('counts only ids the course has, and finds the next item', () => {
    const mem = new MemStorage();
    mem.map.set(STORAGE_KEY, JSON.stringify({ items: { 'foundations/b-plus-tree': { done: true, at: '2026-11-10T09:00:00Z' }, 'foundations/renamed-away': { done: true, at: '2026-11-12T09:00:00Z' }, 'gone-module/x': { done: true, at: '2026-11-13T09:00:00Z' } }, checkpoints: { 'foundations/99': { done: true, at: '2026-11-14T09:00:00Z' } } }));
    const s = new ProgressStore(mem);
    const t = courseTally(fixture, s);
    expect(t.itemsDone).toBe(1);
    expect(t.items).toBe(fixture.modules.reduce((n, m) => n + m.items.length, 0));
    expect(t.minutesDone).toBe(15);
    expect(t.checkpointsDone).toBe(0);
    expect(t.last).toBe('2026-11-10T09:00:00Z');
    expect(moduleTally(fixture.modules[1], s).itemsDone).toBe(0);
    const next = nextItem(fixture, s)!;
    expect(next.module.id).toBe('foundations');
    expect(next.module.items[next.index].id).toBe('lsm');
    // The unknown entries stay stored, untouched, in case the id comes back.
    s.setItem('foundations', 'lsm', true);
    expect(JSON.parse(mem.map.get(STORAGE_KEY)!).items['gone-module/x'].done).toBe(true);
  });

  it('imports an export, and refuses anything else', () => {
    const a = new ProgressStore(new MemStorage(), at);
    a.setItem('foundations', 'lsm', true);
    const text = a.exportText();
    const b = new ProgressStore(new MemStorage());
    expect(b.importText('hello')).toBe(false);
    expect(b.importText('null')).toBe(false);
    expect(b.importText(`  ${text}\n`)).toBe(true);
    expect(b.itemDone('foundations', 'lsm')).toBe(true);
  });
});
