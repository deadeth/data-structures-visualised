import { beforeAll, describe, expect, it } from 'vitest';
import { CATALOG, isReady } from '../catalog';
import { regionNames, listing } from '../core/code';
import { DESIGNS } from '../designs';
import { LOCKED_IDS } from '../locked/manifest';
import { READING_FILES } from '../reading';
import { CLOCK_KEY, IDLE, clockText, elapsed, mmss, overBy, parseClock, spoken, start, stop } from './clock';
import { FIXTURE_ID, GUIDE, JAVA_FOLDERS, PRACTICES, loadPractice, type PracticeEntry, type PracticeSources } from './index';
import { BANNERS, isRegionMarker, proseCell, javaPath, javaSections, stageOf, stagesInTests, stripRegions, testsWithoutStage, withStage, type JavaSections } from './java';
import type { Practice } from './types';
import fixtureGuide from './__fixtures__/fixture-guide';

/**
 * Checks every pairing practice page (and the development fixture) for what `tsc` cannot see: stages and
 * files that do not line up, regions that do not match the Java, counts and lengths the contract sets, Java files that break the
 * code brief (docs/briefs/practice-code.md), dead links, and the reading brief's banned words and company
 * names. Each failure names the page and the field. A folder with Java and no `page.ts` yet is skipped, and so is
 * a page still in the old shape (see `oldShape`).
 * Compiling and running the Java is `node scripts/practice/check.mjs`, not part of this suite.
 */

// ---- words ---------------------------------------------------------------------------------

/** The banned list is read from the reading pages' test, as the course's test does, so the lists never drift apart. */
const sources = import.meta.glob<string>(['../reading/reading.test.ts', '../course/course.test.ts'], { query: '?raw', import: 'default', eager: true });
const raw = (name: string) => Object.entries(sources).find(([p]) => p.endsWith(name))?.[1] ?? '';

function bannedList(): string[] {
  const body = /const BANNED = \[([\s\S]*?)\];/.exec(raw('reading.test.ts'))?.[1];
  if (!body) throw new Error('could not find the BANNED list in src/reading/reading.test.ts');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The company names the course's test bans, read from it (it spells them in pieces so it does not name them itself). */
function companyNames(): string[] {
  const names = [...raw('course.test.ts').matchAll(/const NAME_[A-Z]+ = \[([^\]]*)\]\.join\(''\)/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join(''));
  if (!names.length) throw new Error('could not find the company names in src/course/course.test.ts');
  return names;
}

const bannedRe = bannedList().map((phrase) => {
  const words = phrase.split(' ');
  const first = words[0];
  const stem = first.endsWith('e') ? `${first.slice(0, -1)}(?:e|es|ed|ing|ely)` : `${first}(?:s|es|ed|ing|ly)?`;
  return { phrase, re: new RegExp(`(?<![\\p{L}\\p{N}-])${[stem, ...words.slice(1)].join('\\s+')}(?![\\p{L}\\p{N}-])`, 'iu') };
});
const PHRASES = [
  { phrase: "it's not just X, it's Y", re: /\bnot just\b[^.;:]{0,80}?,\s*(?:it'?s|it is|but)\b/i },
  { phrase: "in today's world", re: /\bin today'?s world\b/i },
  { phrase: 'not only X but Y', re: /\bnot only\b[^.;:]{0,80}?\bbut\b/i },
];
const COMPANIES = new RegExp(`\\b(?:${companyNames().join('|')})\\b`, 'i');

// ---- links ---------------------------------------------------------------------------------

interface Ctx {
  concepts: Map<string, Set<string>>;
  designs: Set<string>;
  /** Practice page ids, with their part ids. */
  practices: Map<string, Set<string>>;
}

function checkHref(href: string, ctx: Ctx): string | null {
  if (!href.startsWith('#/')) return 'only site links (#/...) are allowed';
  const path = href.slice(2);
  if (path === '' || path === 'compare' || path === 'p' || path === 'course' || path.startsWith('course/') || path.startsWith('search/')) return null;
  let m = /^s\/([^/]+)$/.exec(path);
  if (m) return CATALOG.some((c) => c.id === m![1]) && isReady(m[1]) ? null : `no structure page "${m[1]}"`;
  m = /^c\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (m) {
    const secs = ctx.concepts.get(m[1]);
    if (!secs) return `no concept page "${m[1]}"`;
    return m[2] && !secs.has(decodeURIComponent(m[2])) ? `concept page "${m[1]}" has no section "${m[2]}"` : null;
  }
  m = /^d\/([^/]+)(?:\/.*)?$/.exec(path);
  if (m) return ctx.designs.has(m[1]) || LOCKED_IDS.includes(m[1]) ? null : `no design "${m[1]}"`;
  m = /^p\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (m) {
    const parts = ctx.practices.get(m[1]);
    if (!parts) return `no practice page "${m[1]}"`;
    return m[2] && !parts.has(decodeURIComponent(m[2])) ? `practice page "${m[1]}" has no part "${m[2]}"` : null;
  }
  return `"${href}" is not an address on this site`;
}

// ---- one page ---------------------------------------------------------------------------------

/** Every string of a page with a name for where it is, and whether it is prose (links are read only in prose). */
function strings(p: Practice): { at: string; text: string; prose: boolean }[] {
  const out: { at: string; text: string; prose: boolean }[] = [];
  const add = (at: string, text: string | undefined, prose = true) => text !== undefined && out.push({ at, text, prose });
  add('title', p.title);
  add('summary', p.summary);
  add('testing intro', p.testing.intro);
  p.testing.points.forEach((t, i) => add(`testing point ${i + 1}`, t));
  add('use', p.use);
  p.brief.forEach((t, i) => add(`brief ${i + 1}`, t));
  p.given.forEach((t, i) => add(`given ${i + 1}`, t));
  p.ask.forEach((a, i) => {
    add(`ask ${i + 1} q`, a.q);
    add(`ask ${i + 1} why`, a.why);
    add(`ask ${i + 1} assume`, a.assume);
  });
  add('outline', p.outline, false);
  for (const pt of p.parts) {
    const w = `part "${pt.id}"`;
    add(`${w} title`, pt.title);
    add(`${w} ask`, pt.ask);
    pt.tests.forEach((t, i) => add(`${w} tests ${i + 1}`, t, false));
    add(`${w} pseudocode`, pt.pseudocode, false);
    add(`${w} choice`, pt.choice);
    add(`${w} say`, pt.say);
    if (pt.sketch) {
      add(`${w} sketch caption`, pt.sketch.caption);
      add(`${w} sketch text`, pt.sketch.text, false);
    }
    add(`${w} trace caption`, pt.trace.caption);
    pt.trace.head.forEach((t, i) => add(`${w} trace head ${i + 1}`, t));
    pt.trace.rows.forEach((r, i) => r.forEach((t, j) => add(`${w} trace row ${i + 1} cell ${j + 1}`, t)));
    add(`${w} trace note`, pt.trace.note);
    pt.pitfalls.forEach((t, i) => add(`${w} pitfalls ${i + 1}`, t));
    (pt.verbal ?? []).forEach((t, i) => add(`${w} verbal ${i + 1}`, t));
    add(`${w} caveat`, pt.caveat);
  }
  p.followUps.forEach((f, i) => {
    add(`followUps ${i + 1} q`, f.q);
    add(`followUps ${i + 1} a`, f.a);
  });
  p.see.forEach((s, i) => add(`see ${i + 1} label`, s.label));
  (p.unverified ?? []).forEach((t, i) => add(`unverified ${i + 1}`, t));
  return out;
}

function checkWords(text: string, at: string, out: string[]): void {
  // "harness" is banned as a verb ("harness the power of"); a test harness is the plain name of a thing these pages describe.
  const words = text.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(/\btest harness(?:es)?\b/gi, 'test rig');
  for (const { phrase, re } of [...bannedRe, ...PHRASES]) {
    const m = re.exec(words);
    if (m) out.push(`${at}: banned word or phrase "${phrase}" (found "${m[0]}")`);
  }
  const co = COMPANIES.exec(text);
  if (co) out.push(`${at}: names a company ("${co[0]}")`);
}

const JAVA_MAX = 80;
const PSEUDO_MAX = 64;
const CHOICE_MAX_WORDS = 110;
const ANSWER_MAX_WORDS = 75;
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * A page still in the shape the contract had before 20 November 2026 (parts with `explain`, no `testing`).
 * The real pages are being rewritten; until each is, it is skipped by name rather than failed.
 */
export function oldShape(p: Practice): boolean {
  const loose = p as unknown as { testing?: unknown; parts: Record<string, unknown>[]; followUps: { a: unknown }[] };
  return !loose.testing || loose.parts.some((pt) => 'explain' in pt || 'lines' in pt) || loose.followUps.some((f) => typeof f.a !== 'string') || 'mistakes' in loose;
}
const STARTER_MAX_BYTES = 50_000;

/** Every fault in one page, each naming the page and the field. */
function validate(e: PracticeEntry, src: PracticeSources, ctx: Ctx, folder = e.id): string[] {
  const out: string[] = [];
  const p = e.page;
  const name = `${e.dir} (${p.id})`;
  const at = (field: string) => `${name}, ${field}`;

  // Ids and stages.
  if (p.id !== folder) out.push(at(`id: "${p.id}" should match the folder name "${folder}"`));
  const ids = new Set<string>();
  for (const pt of p.parts) {
    if (ids.has(pt.id)) out.push(at(`parts: part id "${pt.id}" is used twice`));
    ids.add(pt.id);
    if (!/^[a-z0-9-]+$/.test(pt.id)) out.push(at(`part "${pt.id}": id should be lower case letters, digits and hyphens`));
  }
  const stages = p.parts.map((pt) => pt.stage).sort((a, b) => a - b);
  stages.forEach((s, i) => {
    if (s !== i + 1) out.push(at(`parts: stages should run 1 to ${stages.length} with one part each; found ${stages.join(', ')}`));
  });
  if (!p.parts.some((pt) => pt.stage === p.core)) out.push(at(`core: ${p.core} is not the stage of any part`));
  if (!(p.minutes > 0)) out.push(at(`minutes: ${p.minutes} should be more than 0`));
  if (!e.hasStarter) out.push(at('starter: starter/Solution.java is missing'));
  for (const s of stages) if (!src.stages.has(s)) out.push(at(`part at stage ${s}: solution/s${s}/Solution.java is missing`));
  for (const s of src.stages.keys()) if (!stages.includes(s)) out.push(at(`solution/s${s}/Solution.java: no part has stage ${s}`));

  // Words and links.
  for (const s of strings(p)) {
    checkWords(s.text, at(s.at), out);
    if (s.prose) for (const m of s.text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      const bad = checkHref(m[2], ctx);
      if (bad) out.push(at(`${s.at}: link [${m[1]}](${m[2]}): ${bad}`));
    }
  }
  p.see.forEach((s, i) => {
    const bad = checkHref(s.href, ctx);
    if (bad) out.push(at(`see ${i + 1}: ${s.href}: ${bad}`));
  });

  // Counts the page's shape asks for.
  const count = (field: string, n: number, lo: number, hi: number) => {
    if (n < lo || n > hi) out.push(at(`${field}: ${n} ${n === 1 ? 'item' : 'items'}; ${lo === hi ? `exactly ${lo}` : `${lo} to ${hi}`}`));
  };
  count('testing points', p.testing.points.length, 3, 3);
  count('given', p.given.length, 1, 5);
  count('ask', p.ask.length, 5, 6);
  count('followUps', p.followUps.length, 8, 12);
  p.followUps.forEach((f, i) => {
    const n = wordCount(f.a);
    if (n > ANSWER_MAX_WORDS) out.push(at(`followUps ${i + 1} a: ${n} words; at most ${ANSWER_MAX_WORDS}`));
  });

  // Core, stretch and variant stages.
  const variants = p.parts.filter((pt) => pt.variant);
  if (variants.length > 1) out.push(at(`parts: ${variants.length} parts are variants (${variants.map((v) => v.id).join(', ')}); at most one`));
  const top = Math.max(0, ...p.parts.map((pt) => pt.stage));
  for (const pt of p.parts) {
    const w = `part "${pt.id}"`;
    const n = wordCount(pt.choice);
    if (n > CHOICE_MAX_WORDS) out.push(at(`${w} choice: ${n} words; at most ${CHOICE_MAX_WORDS}`));
    count(`${w} pitfalls`, pt.pitfalls.length, 2, 4);
    const verbal = pt.verbal?.length ?? 0;
    if (pt.variant) {
      if (pt.stage !== top) out.push(at(`${w}: a variant must be the last stage (it is stage ${pt.stage} of ${top})`));
      if (pt.stage <= p.core) out.push(at(`${w}: a variant must come after core (stage ${p.core}); it is stage ${pt.stage}`));
      count(`${w} verbal`, verbal, 1, 2);
    } else if (pt.stage <= p.core) {
      if (verbal) out.push(at(`${w} verbal: a core stage has no verbal answer`));
    } else count(`${w} verbal (a stretch stage)`, verbal, 3, 3);
    if (pt.caveat?.includes('\n')) out.push(at(`${w} caveat: one line only`));
  }

  // Pseudocode and sketch width, and trace shape.
  const pseudo = (field: string, text: string) => text.split('\n').forEach((l, i) => {
    if (l.length > PSEUDO_MAX) out.push(at(`${field}: line ${i + 1} is ${l.length} characters; at most ${PSEUDO_MAX}`));
  });
  pseudo('outline', p.outline);
  for (const pt of p.parts) {
    pseudo(`part "${pt.id}" pseudocode`, pt.pseudocode);
    if (pt.sketch) pseudo(`part "${pt.id}" sketch text`, pt.sketch.text);
    pt.trace.rows.forEach((r, i) => {
      if (r.length !== pt.trace.head.length) out.push(at(`part "${pt.id}" trace row ${i + 1}: ${r.length} cells for ${pt.trace.head.length} columns`));
    });
  }

  // The Java files.
  const files: [string, string][] = [...(e.hasStarter ? [['starter/Solution.java', src.starter] as [string, string]] : []), ...[...src.stages].sort((a, b) => a[0] - b[0]).map(([s, t]): [string, string] => [`solution/s${s}/Solution.java`, t])];
  const split = new Map<string, JavaSections>();
  for (const [file, text] of files) {
    text.replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
      if (l.length > JAVA_MAX) out.push(at(`${file}: line ${i + 1} is ${l.length} characters; at most ${JAVA_MAX}`));
    });
    const sec = javaSections(text);
    if (typeof sec === 'string') out.push(at(`${file}: ${sec}`));
    else split.set(file, sec);
    const co = COMPANIES.exec(text);
    if (co) out.push(at(`${file}: names a company ("${co[0]}")`));
  }
  if (e.hasStarter) {
    if (new TextEncoder().encode(src.starter).length >= STARTER_MAX_BYTES) out.push(at(`starter/Solution.java: ${new TextEncoder().encode(src.starter).length} bytes; under ${STARTER_MAX_BYTES}`));
    if (stageOf(src.starter) !== 1) out.push(at(`starter/Solution.java: STAGE should be 1, found ${stageOf(src.starter) ?? 'no STAGE line'}`));
    const marker = src.starter.split('\n').findIndex(isRegionMarker);
    if (marker >= 0) out.push(at(`starter/Solution.java: line ${marker + 1} is a region marker; the starter has none`));
  }
  for (const [s, text] of src.stages) {
    if (stageOf(text) !== s) out.push(at(`solution/s${s}/Solution.java: STAGE should be ${s}, found ${stageOf(text) ?? 'no STAGE line'}`));
  }
  const starterSec = split.get('starter/Solution.java');
  if (starterSec) {
    for (const [file, sec] of split) {
      if (file === 'starter/Solution.java') continue;
      if (sec.supplied !== starterSec.supplied) out.push(at(`${file}: the "Supplied code" section differs from the starter's`));
      if (testsWithoutStage(sec.tests) !== testsWithoutStage(starterSec.tests)) out.push(at(`${file}: the "Tests" section differs from the starter's (other than the STAGE line)`));
    }
  }

  // Each part against its stage file.
  for (const pt of p.parts) {
    const w = `part "${pt.id}"`;
    for (const t of pt.tests) if (e.hasStarter && !src.starter.includes(t)) out.push(at(`${w} tests: "${t}" does not appear in the starter`));
    const file = src.stages.get(pt.stage);
    if (!file) continue;
    const have = regionNames(file, 'java');
    const missing = pt.regions.filter((r) => !have.includes(r));
    for (const r of missing) out.push(at(`${w} regions: "${r}" is not a region of solution/s${pt.stage}/Solution.java (it has ${have.join(', ') || 'none'})`));
    if (missing.length) continue;
    if (!listing(file, 'java', pt.regions).lines.length) out.push(at(`${w} regions: ${pt.regions.join(', ')} hold no lines`));
  }
  return out;
}

// ---- the run -----------------------------------------------------------------------------------

const ctx: Ctx = { concepts: new Map(), designs: new Set(DESIGNS.map((d) => d.id)), practices: new Map() };
let fixture: PracticeEntry | undefined;

beforeAll(async () => {
  for (const f of READING_FILES) if (f.kind === 'concept') ctx.concepts.set(f.page.id, new Set(f.page.sections.map((s) => s.id)));
  fixture = await loadPractice(FIXTURE_ID);
  for (const e of [...PRACTICES, ...(fixture ? [fixture] : [])]) ctx.practices.set(e.id, new Set(e.page.parts.map((pt) => pt.id)));
});

describe('practice pages', () => {
  it('have unique ids, and the fixture is not listed', () => {
    const ids = PRACTICES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(FIXTURE_ID);
  });

  for (const e of PRACTICES) {
    if (oldShape(e.page)) {
      it.skip(`${e.dir}: still in the old page shape (has Part.explain or lacks testing); skipped until rewritten`, () => undefined);
      continue;
    }
    it(`${e.dir} passes validation`, async () => {
      const problems = validate(e, await e.sources(), ctx);
      expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
    });
  }

  for (const folder of JAVA_FOLDERS.filter((f) => !PRACTICES.some((e) => e.id === f))) {
    it.skip(`src/practice/${folder}: has Java but no page.ts yet`, () => undefined);
  }

  for (const [file, guide] of [['src/practice/guide.ts', GUIDE], ['src/practice/__fixtures__/fixture-guide.ts', fixtureGuide]] as const) it(`${file}, when written, names only pages that exist, has unique section ids and clean words`, () => {
    if (!guide) return;
    const GUIDE = guide;
    const problems: string[] = [];
    for (const id of GUIDE.order) if (!PRACTICES.some((e) => e.id === id) && !JAVA_FOLDERS.includes(id) && id !== FIXTURE_ID) problems.push(`${file}, order: no page "${id}"`);
    const seen = new Set<string>();
    for (const s of GUIDE.sections) {
      if (seen.has(s.id)) problems.push(`${file}: section id "${s.id}" is used twice`);
      seen.add(s.id);
      const texts: [string, string][] = [['title', s.title]];
      s.blocks.forEach((b, i) => {
        if ('p' in b) texts.push([`block ${i + 1}`, b.p]);
        if ('list' in b) b.list.forEach((t, j) => texts.push([`block ${i + 1} item ${j + 1}`, t]));
        if ('callout' in b) texts.push([`block ${i + 1} callout`, `${b.title ?? ''} ${b.callout}`]);
        if ('table' in b) [...b.table.head, ...b.table.rows.flat(), b.caption ?? ''].forEach((t) => texts.push([`block ${i + 1} table`, t]));
      });
      for (const [w, t] of [['title', GUIDE.title], ['summary', GUIDE.summary], ...texts.map(([a, b]): [string, string] => [`section "${s.id}" ${a}`, b])]) {
        checkWords(t, `${file}, ${w}`, problems);
        for (const m of t.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
          const bad = checkHref(m[2], ctx);
          if (bad) problems.push(`${file}, ${w}: link ${m[2]}: ${bad}`);
        }
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('the fixture loads in development, is in the current shape, and passes', async () => {
    expect(fixture, 'the fixture should load where import.meta.env.DEV is true').toBeDefined();
    expect(oldShape(fixture!.page)).toBe(false);
    const kinds = fixture!.page.parts.map((pt) => (pt.variant ? 'variant' : pt.stage > fixture!.page.core ? 'stretch' : 'core'));
    expect(kinds, 'the fixture should exercise core, stretch and variant stages').toEqual(expect.arrayContaining(['core', 'stretch', 'variant']));
    expect(fixture!.page.parts.some((pt) => pt.sketch) && fixture!.page.parts.some((pt) => pt.caveat)).toBe(true);
    const problems = validate(fixture!, await fixture!.sources(), ctx);
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('a broken copy of the fixture fails on every fault it holds', async () => {
    const good = await fixture!.sources();
    const page: Practice = structuredClone(fixture!.page);
    page.parts[0].regions = ['state', 'nope'];
    page.parts[1].tests = [...page.parts[1].tests, 'a test nobody wrote'];
    page.parts[1].pseudocode += `\n${'x'.repeat(65)}`;
    page.parts[1].sketch!.text += `\n${'s'.repeat(66)}`;
    page.parts[1].trace.rows[0] = ['one'];
    page.parts[1].verbal = ['A core stage with a spoken answer.'];
    page.parts[1].choice = 'word '.repeat(111);
    page.parts[1].pitfalls = ['Only one.'];
    page.parts[2].verbal = ['One.', 'Two.'];
    page.parts[3].verbal = [];
    page.parts.push({ ...structuredClone(page.parts[3]), id: 'extra', stage: 6 });
    page.testing.points = page.testing.points.slice(0, 2);
    page.given = ['1', '2', '3', '4', '5', '6'];
    page.ask = page.ask.slice(0, 4);
    page.followUps = page.followUps.slice(0, 7);
    page.followUps[0].a = 'word '.repeat(76);
    page.see = [...page.see, { href: '#/s/nowhere', label: 'Nowhere' }];
    page.summary = 'A robust page with a [dead link](#/s/no-such-structure) and a [missing part](#/p/fixture-practice/nope).';
    page.use = `Paste it into ${companyNames()[0]}'s editor.`;
    const stages = new Map(good.stages);
    stages.set(2, withStage(good.stages.get(2)!.replace('// ===== Your code =====', '// ===== Your code ====='), 5).replace('lines.add(who', 'lines.add( who'));
    const starter = good.starter.replace('    static final int STAGE = 1;', `    static final int STAGE = 1;\n    // region oops\n    // endregion\n    static final String LONG = "${'y'.repeat(70)}";`);
    const broken = { ...fixture!, page, sources: async () => ({ starter, stages }) } as PracticeEntry;
    const p = validate(broken, await broken.sources(), ctx).join('\n');
    for (const want of [
      'part "count" regions: "nope" is not a region',
      'part "limit" tests: "a test nobody wrote" does not appear in the starter',
      'part "limit" pseudocode: line 7 is 65 characters',
      'part "limit" sketch text: line 6 is 66 characters',
      'part "limit" trace row 1: 1 cells for 4 columns',
      'part "limit" verbal: a core stage has no verbal answer',
      'part "limit" choice: 111 words; at most 110',
      'part "limit" pitfalls: 1 item; 2 to 4',
      'part "reset" verbal (a stretch stage): 2 items; exactly 3',
      'part "remaining": a variant must be the last stage',
      'part "remaining" verbal: 0 items; 1 to 2',
      'parts: 2 parts are variants',
      'testing points: 2 items; exactly 3',
      'given: 6 items; 1 to 5',
      'ask: 4 items; 5 to 6',
      'followUps: 7 items; 8 to 12',
      'followUps 1 a: 76 words; at most 75',
      'see 4: #/s/nowhere: no structure page "nowhere"',
      'stages should run 1 to 5',
      'part at stage 6: solution/s6/Solution.java is missing',
      'banned word or phrase "robust"',
      'no structure page "no-such-structure"',
      'practice page "fixture-practice" has no part "nope"',
      'use: names a company',
      'solution/s2/Solution.java: STAGE should be 2, found 5',
      'solution/s2/Solution.java: the "Supplied code" section differs',
      'starter/Solution.java: line',
      'is a region marker',
      'characters; at most 80',
      'the "Tests" section differs from the starter\'s',
    ]) expect(p).toContain(want);
    const offCore = { ...fixture!, page: { ...structuredClone(fixture!.page), core: 7 } } as PracticeEntry;
    expect(validate(offCore, good, ctx).join('\n')).toContain('core: 7 is not the stage of any part');
  });
});

// ---- helpers ------------------------------------------------------------------------------------

describe('practice Java helpers', () => {
  const file = [
    'import java.util.List;',
    'public class Solution {',
    `    ${BANNERS[0]}`,
    '    interface A {}',
    `    ${BANNERS[1]}`,
    '    // region one',
    '    int x;',
    '    // endregion',
    '    //region two-b',
    '    int y;',
    '    //   endregion  ',
    `    ${BANNERS[2]}`,
    '    static final int STAGE = 3;',
    '    public static void main(String[] a) {',
    '        if (STAGE >= 1) s1();',
    '        if (STAGE >= 4) s4();',
    '    }',
    '}',
  ].join('\n');

  it('splits a file at its three banners', () => {
    const s = javaSections(file) as JavaSections;
    expect(s.head).toBe('import java.util.List;\npublic class Solution {');
    expect(s.supplied.split('\n')).toEqual([`    ${BANNERS[0]}`, '    interface A {}']);
    expect(s.yours.startsWith(`    ${BANNERS[1]}`)).toBe(true);
    expect(s.tests.split('\n')[0]).toBe(`    ${BANNERS[2]}`);
    expect(javaSections(file.replace(BANNERS[1], 'x'))).toContain('is missing');
    expect(javaSections(`${file}\n${BANNERS[2]}`)).toContain('appears twice');
    const swapped = file.replace(BANNERS[0], '@@').replace(BANNERS[1], BANNERS[0]).replace('@@', BANNERS[1]);
    expect(javaSections(swapped)).toContain('not in the order');
    expect(typeof javaSections(file.replace(/\n/g, '\r\n'))).toBe('object');
  });

  it('strips region markers and nothing else', () => {
    const out = stripRegions(file).split('\n');
    expect(out).toContain('    int x;');
    expect(out).toContain('    int y;');
    expect(out.some(isRegionMarker)).toBe(false);
    expect(out.length).toBe(file.split('\n').length - 4);
    expect(isRegionMarker('    // regional office')).toBe(false);
    expect(isRegionMarker('x = 1; // endregion')).toBe(false);
  });

  it('reads and sets STAGE, and counts the stages main can run', () => {
    expect(stageOf(file)).toBe(3);
    expect(stageOf(withStage(file, 4))).toBe(4);
    expect(withStage(file, 4).replace('STAGE = 4', 'STAGE = 3')).toBe(file);
    expect(stageOf('class A {}')).toBeUndefined();
    expect(testsWithoutStage('    static final int STAGE = 2;\nx')).toBe(testsWithoutStage('    static final int STAGE = 9;\nx'));
    expect(stagesInTests(file)).toBe(4);
  });

  it('tells words in a trace cell from a short value', () => {
    expect(proseCell('threw IllegalStateException: square taken')).toBe(true);
    expect(proseCell('[cat@2, ann@2]')).toBe(false);
    expect(proseCell('`OPEN`')).toBe(false);
    expect(proseCell('java.lang.IllegalStateException')).toBe(false);
  });

  it('reads a page and stage from a file path', () => {
    expect(javaPath('./rate-limiter/starter/Solution.java')).toEqual({ id: 'rate-limiter', stage: 'starter' });
    expect(javaPath('./__fixtures__/fixture-practice/solution/s12/Solution.java')).toEqual({ id: 'fixture-practice', stage: 12 });
    expect(javaPath('./rate-limiter/solution/Solution.java')).toBeUndefined();
  });
});

describe('practice clock', () => {
  it('formats minutes and seconds', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(999)).toBe('0:00');
    expect(mmss(760_000)).toBe('12:40');
    expect(mmss(72 * 60_000 + 5_000)).toBe('72:05');
    expect(mmss(-5)).toBe('0:00');
    expect(clockText(760_000, 40)).toBe('12:40 of 40:00');
  });

  it('is over time only past the target', () => {
    expect(overBy(40 * 60_000, 40)).toBeNull();
    expect(overBy(40 * 60_000 + 999, 40)).toBeNull();
    expect(overBy(42 * 60_000 + 10_000, 40)).toBe('2:10');
  });

  it('counts while running and keeps its time when stopped', () => {
    let s = start(IDLE, 1_000);
    expect(elapsed(s, 61_000)).toBe(60_000);
    expect(start(s, 5_000)).toBe(s);
    s = stop(s, 61_000);
    expect(s).toEqual({ since: null, before: 60_000 });
    expect(elapsed(s, 999_999)).toBe(60_000);
    s = start(s, 100_000);
    expect(elapsed(s, 110_000)).toBe(70_000);
    // A clock changed backwards never shows less than nothing run since the start.
    expect(elapsed(s, 50_000)).toBe(60_000);
  });

  it('reads its saved state, and anything malformed as idle', () => {
    expect(parseClock(JSON.stringify({ since: 5, before: 10 }))).toEqual({ since: 5, before: 10 });
    expect(parseClock(null)).toEqual(IDLE);
    expect(parseClock('{')).toEqual(IDLE);
    expect(parseClock(JSON.stringify({ since: 'x', before: -4 }))).toEqual(IDLE);
    expect(CLOCK_KEY('rate-limiter')).toBe('dsv.practice.clock.rate-limiter');
  });

  it('says the time in words', () => {
    expect(spoken(760_000)).toBe('12 minutes 40 seconds');
    expect(spoken(60_000)).toBe('1 minute');
    expect(spoken(1_000)).toBe('1 second');
    expect(spoken(0)).toBe('0 seconds');
  });
});
