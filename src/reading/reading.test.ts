import { beforeAll, describe, expect, it } from 'vitest';
import { CATALOG, isReady } from '../catalog';
import { DESIGNS } from '../designs';
import { LOCKED_IDS } from '../locked/manifest';
import type { Design } from '../designs/types';
import { READING_FILES, type ReadingFile } from './index';
import type { Block, Diagram, DiagramNode, Reading } from './types';
import fixture from './__fixtures__/fixture-reading';
import broken from './__fixtures__/fixture-broken';

/**
 * Checks every registered reading page (and two fixtures) for the faults a writer cannot see in
 * `tsc`: broken ids and links, diagrams whose boxes overlap or whose lines run through boxes, and the
 * banned words of docs/briefs/reading-page.md. Each failure names the file, section and block.
 */

/**
 * Words and phrases the brief bans, matched case-insensitively as whole words with their common endings.
 * "navigate" and "landscape" are banned in their figurative sense; the test cannot tell, so it flags every use.
 */
const BANNED = [
  'delve', 'dive into', 'navigate', 'underscore', 'bolster', 'foster', 'harness', 'leverage', 'unpack', 'shed light on',
  'pave the way', 'pivotal', 'groundbreaking', 'cutting-edge', 'transformative', 'game-changing', 'innovative', 'robust',
  'comprehensive', 'seamless', 'intricate', 'nuanced', 'vibrant', 'multifaceted', 'holistic', 'testament', 'landscape', 'realm',
];
const bannedRe = BANNED.map((phrase) => {
  const words = phrase.split(' ');
  const first = words[0];
  // The first word may be inflected: delves, delved, delving, leveraged, unpacks, robustly.
  const stem = first.endsWith('e') ? `${first.slice(0, -1)}(?:e|es|ed|ing|ely)` : `${first}(?:s|es|ed|ing|ly)?`;
  return { phrase, re: new RegExp(`(?<![\\p{L}\\p{N}-])${[stem, ...words.slice(1)].join('\\s+')}(?![\\p{L}\\p{N}-])`, 'iu') };
});
const PHRASES = [
  { phrase: "it's not just X, it's Y", re: /\bnot just\b[^.;:]{0,80}?,\s*(?:it'?s|it is|but)\b/i },
  { phrase: "in today's world", re: /\bin today'?s world\b/i },
];

interface Ctx {
  designs: Map<string, Design>;
  /** Pages that can be linked to, by address base (`c/<id>` or `d/<id>/read`), with their section ids. */
  pages: Map<string, Set<string>>;
}

type Where = string;

// ---- geometry ---------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const rectOf = (n: DiagramNode): Rect => ({ x: n.x, y: n.y, w: n.w ?? 140, h: n.h ?? 56 });
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** Where the line from a box's centre towards a point leaves the box (as the renderer draws it). */
function exit(r: Rect, tx: number, ty: number) {
  const c = centre(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}
/** Length of the part of segment p-q inside a rectangle (Liang-Barsky clipping). */
function insideLength(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): number {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [[-dx, p.x - r.x], [dx, r.x + r.w - p.x], [-dy, p.y - r.y], [dy, r.y + r.h - p.y]];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq < 0) return 0;
    } else {
      const t = qq / pp;
      if (pp < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

/**
 * A rough fit of a node's words, with average character widths for the site's font (bold about 0.56 of
 * the size, regular about 0.48): the renderer shrinks words to label 12 and subtitle 11.5, then cuts
 * with an ellipsis. This flags only what would be cut even at those sizes.
 */
function wordsFit(n: DiagramNode): string | null {
  const r = rectOf(n);
  const kind = n.kind ?? 'box';
  const room = r.w - (kind === 'client' ? 20 : kind === 'note' ? 4 : 14);
  const top = kind === 'store' ? 14 : 0;
  const bottom = kind === 'store' ? r.h - 3.5 : kind === 'queue' ? r.h - 10 : r.h;
  const avail = bottom - top - 2;
  const lines = (text: string, cw: number) => {
    let count = 0;
    let line = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const w = word.length * cw;
      if (w > room) return { count: count + 1, tooLong: word };
      if (line && line + cw + w > room) {
        count++;
        line = w;
      } else line = line ? line + cw + w : w;
    }
    return { count: count + (line ? 1 : 0), tooLong: null as string | null };
  };
  const label = lines(n.label, 12 * 0.56);
  const sub = n.sub ? lines(n.sub, 11.5 * 0.48) : { count: 0, tooLong: null };
  if (label.tooLong) return `the word "${label.tooLong}" in its label is wider than the ${kind} (${r.w} wide)`;
  if (sub.tooLong) return `the word "${sub.tooLong}" in its sub is wider than the ${kind} (${r.w} wide)`;
  const need = label.count * 15 + sub.count * 14.5 - 3;
  if (need > avail) return `its label and sub need about ${Math.round(need)} units of height and the ${kind} has ${Math.round(avail)}: shorten the ${n.sub ? 'sub' : 'label'} or make the node taller`;
  return null;
}

function checkDiagram(d: Diagram, at: Where, out: string[]): void {
  if (d.w > 640 || d.h > 420) out.push(`${at}: diagram is ${d.w} by ${d.h}; the brief allows at most 640 by 420`);
  const ids = new Map<string, DiagramNode>();
  for (const n of d.nodes) {
    if (ids.has(n.id)) out.push(`${at}: node id "${n.id}" is used twice`);
    ids.set(n.id, n);
    const r = rectOf(n);
    if (r.x < 0 || r.y < 0 || r.x + r.w > d.w || r.y + r.h > d.h) out.push(`${at}: node "${n.id}" (${r.x},${r.y} ${r.w}x${r.h}) lies outside the diagram's ${d.w} by ${d.h}`);
    const fit = wordsFit(n);
    if (fit) out.push(`${at}: node "${n.id}": ${fit}`);
  }
  for (let i = 0; i < d.nodes.length; i++) for (let j = i + 1; j < d.nodes.length; j++) {
    const a = rectOf(d.nodes[i]);
    const b = rectOf(d.nodes[j]);
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ox > 0 && oy > 0) out.push(`${at}: nodes "${d.nodes[i].id}" and "${d.nodes[j].id}" overlap`);
  }
  for (const g of d.groups ?? []) {
    if (g.x < 0 || g.y < 0 || g.x + g.w > d.w || g.y + g.h > d.h) out.push(`${at}: group "${g.label}" lies outside the diagram's ${d.w} by ${d.h}`);
  }
  for (const e of d.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a) out.push(`${at}: edge ${e.from} -> ${e.to} names a missing node "${e.from}"`);
    if (!b) out.push(`${at}: edge ${e.from} -> ${e.to} names a missing node "${e.to}"`);
    if (!a || !b) continue;
    const ra = rectOf(a);
    const rb = rectOf(b);
    const p = exit(ra, centre(rb).x, centre(rb).y);
    const q = exit(rb, centre(ra).x, centre(ra).y);
    // The label's chip must leave some line showing on each side, or it hides the arrowhead.
    if (e.label) {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const lines = Math.max(1, Math.ceil((e.label.length * 12.5 * 0.5) / 150));
      const cw = Math.min(150, e.label.length * 12.5 * 0.5) + 14;
      const ch = lines * 15 + 8;
      // The chip's extent along the line's direction, and room for the arrowhead (10 units). The renderer slides the
      // chip toward the line's start when it must, so this fails only when there is no room for both.
      const along = len ? (cw * Math.abs(q.x - p.x) + ch * Math.abs(q.y - p.y)) / len : cw;
      if (along + 10 > len) out.push(`${at}: edge ${e.from} -> ${e.to}: its label "${e.label}" (about ${Math.round(along)} units along the line) is longer than the line (${Math.round(len)} units) and hides the arrowhead; widen the gap or shorten the label`);
    }
    for (const n of d.nodes) {
      if (n.id === e.from || n.id === e.to) continue;
      const r = rectOf(n);
      // A line that grazes a corner is let off: it must run more than 2 units inside the box.
      if (insideLength(p, q, { x: r.x + 0.5, y: r.y + 0.5, w: r.w - 1, h: r.h - 1 }) > 2) out.push(`${at}: edge ${e.from} -> ${e.to} runs through node "${n.id}"`);
    }
  }
}

// ---- links ---------------------------------------------------------------------------

function checkHref(href: string, ctx: Ctx): string | null {
  if (!href.startsWith('#/')) return 'only site links (#/...) are allowed';
  const path = href.slice(2);
  if (path === '' || path === 'compare' || path.startsWith('search/')) return null;
  let m = /^s\/([^/]+)$/.exec(path);
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
    // A locked design's content is not in the repo, so a link to it (or any part of it) cannot be checked: it leads to the password form.
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
    if (k === 'g') {
      const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return d.glossary.some((g) => slug(g.term) === id) ? null : `design "${d.id}" has no glossary term "${id}"`;
    }
    return entry.extras ? null : `design "${d.id}" has no interview extras for "${k}/${id}"`;
  }
  return `"${href}" is not an address on this site`;
}

// ---- text -----------------------------------------------------------------------------

/** Every string in a block that is shown as text (not code), with a name for where it is. */
function texts(b: Block): [string, string][] {
  if ('p' in b) return [['paragraph', b.p]];
  if ('h' in b) return [['subheading', b.h]];
  if ('list' in b) return b.list.map((t, i) => [`list item ${i + 1}`, t]);
  if ('callout' in b) return [['callout', b.callout], ...(b.title ? [['callout title', b.title] as [string, string]] : [])];
  if ('table' in b) return [...(b.caption ? [['table caption', b.caption] as [string, string]] : []), ...b.table.head.map((t): [string, string] => ['table head', t]), ...b.table.rows.flatMap((r, i) => r.map((t): [string, string] => [`table row ${i + 1}`, t]))];
  if ('code' in b) return b.title ? [['code title', b.title]] : [];
  if ('diagram' in b) return [['caption', b.caption], ...b.diagram.nodes.flatMap((n): [string, string][] => [[`node "${n.id}"`, n.label], [`node "${n.id}" sub`, n.sub ?? '']]), ...b.diagram.edges.map((e): [string, string] => [`edge ${e.from} -> ${e.to}`, e.label ?? '']), ...(b.diagram.groups ?? []).map((g): [string, string] => ['group', g.label])];
  if ('sequence' in b) return [['caption', b.caption], ...b.sequence.actors.map((a): [string, string] => ['actor', a]), ...b.sequence.messages.flatMap((m, i): [string, string][] => [[`message ${i + 1}`, m.label], [`message ${i + 1} note`, m.note ?? '']])];
  if ('design' in b) return [['caption', b.caption]];
  if ('see' in b) return b.see.flatMap((s): [string, string][] => [['see label', s.label], ['see why', s.why]]);
  return [];
}

function checkText(text: string, at: Where, ctx: Ctx, out: string[]): void {
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const bad = checkHref(m[2], ctx);
    if (bad) out.push(`${at}: link [${m[1]}](${m[2]}): ${bad}`);
  }
  const words = text.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']');
  for (const { phrase, re } of [...bannedRe, ...PHRASES]) {
    const m = re.exec(words);
    if (m) out.push(`${at}: banned word or phrase "${phrase}" (found "${m[0]}")`);
  }
}

// ---- a page ------------------------------------------------------------------------------

function validate(f: ReadingFile, ctx: Ctx): string[] {
  const out: string[] = [];
  const p = f.page;
  const name = f.file;
  const base = f.file.replace(/^.*\//, '').replace(/\.ts$/, '');
  if (f.kind === 'concept' && base !== p.id) out.push(`${name}: the page id "${p.id}" should match the file name "${base}"`);
  if (f.kind === 'walkthrough' && !ctx.designs.has(base)) out.push(`${name}: a walkthrough's file name must be a design id; there is no design "${base}"`);
  if (f.kind === 'concept' && !['Data', 'Messaging', 'Reliability', 'Interview craft'].includes((p as Reading & { group?: string }).group ?? '')) out.push(`${name}: unknown group`);
  checkText(p.title, `${name}, title`, ctx, out);
  checkText(p.summary, `${name}, summary`, ctx, out);
  (p.unverified ?? []).forEach((u, i) => checkText(u, `${name}, unverified ${i + 1}`, ctx, out));
  const seen = new Set<string>();
  for (const s of p.sections) {
    if (seen.has(s.id)) out.push(`${name}: section id "${s.id}" is used twice`);
    seen.add(s.id);
    if (!/^[a-z0-9-]+$/.test(s.id)) out.push(`${name}: section id "${s.id}" should be lower case letters, digits and hyphens`);
    checkText(s.title, `${name}, section "${s.id}", title`, ctx, out);
    s.blocks.forEach((b, i) => {
      const kind = Object.keys(b)[0];
      const at = `${name}, section "${s.id}", block ${i + 1} (${kind})`;
      for (const [part, t] of texts(b)) if (t) checkText(t, `${at}, ${part}`, ctx, out);
      if ('list' in b && b.list.length > 1 && b.list.every((t) => /^\*\*[^*]+?:?\*\*:?\s/.test(t) && /^\*\*[^*]+(?::\*\*|\*\*:)/.test(t))) out.push(`${at}: every item is "**Term:** explanation"; the brief asks for a table or plain sentences`);
      if ('diagram' in b) checkDiagram(b.diagram, at, out);
      if ('sequence' in b) {
        const actors = new Set(b.sequence.actors);
        if (b.sequence.actors.length > 5) out.push(`${at}: ${b.sequence.actors.length} actors; at most 5`);
        if (actors.size !== b.sequence.actors.length) out.push(`${at}: an actor is listed twice`);
        b.sequence.messages.forEach((m, j) => {
          for (const a of [m.from, m.to]) if (!actors.has(a)) out.push(`${at}, message ${j + 1}: actor "${a}" is not in the actors list`);
        });
      }
      if ('design' in b) {
        const d = ctx.designs.get(b.design.id);
        if (!d) out.push(`${at}: no design "${b.design.id}"`);
        else {
          for (const c of b.design.lit) if (!d.components.some((x) => x.id === c)) out.push(`${at}: design "${d.id}" has no component "${c}"`);
          for (const fl of b.design.flows ?? []) if (!d.flows.some((x) => x.id === fl || x.reply?.id === fl)) out.push(`${at}: design "${d.id}" has no flow "${fl}"`);
        }
      }
      if ('see' in b) {
        for (const s2 of b.see) {
          const bad = checkHref(s2.href, ctx);
          if (bad) out.push(`${at}: see link ${s2.href}: ${bad}`);
        }
      }
    });
  }
  return out;
}

const ctx: Ctx = { designs: new Map(), pages: new Map() };
const fixtures: ReadingFile[] = [
  { file: 'src/reading/__fixtures__/fixture-reading.ts', kind: 'concept', page: fixture },
  { file: 'src/reading/__fixtures__/fixture-broken.ts', kind: 'concept', page: broken },
];

beforeAll(async () => {
  for (const d of DESIGNS) ctx.designs.set(d.id, await d.load());
  for (const f of [...READING_FILES, fixtures[0]]) {
    const key = f.kind === 'concept' ? `c/${f.page.id}` : `d/${f.file.replace(/^.*\//, '').replace(/\.ts$/, '')}/read`;
    ctx.pages.set(key, new Set(f.page.sections.map((s) => s.id)));
  }
});

describe('reading pages', () => {
  it('have unique ids', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const f of READING_FILES) {
      const key = `${f.kind}:${f.page.id}`;
      if (seen.has(key)) dup.push(`${f.file}: id "${f.page.id}" is also used by ${seen.get(key)}`);
      seen.set(key, f.file);
    }
    expect(dup).toEqual([]);
  });

  for (const f of READING_FILES) {
    it(`${f.file} passes validation`, () => {
      const t = performance.now();
      const problems = validate(f, ctx);
      expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
      expect(performance.now() - t).toBeLessThan(1000);
    });
  }

  it('the fixture page passes', () => {
    expect(validate(fixtures[0], ctx)).toEqual([]);
  });

  it('the broken fixture fails on every fault it holds', () => {
    const p = validate(fixtures[1], ctx).join('\n');
    for (const want of [
      'banned word or phrase "leverage"',
      'banned word or phrase "robust"',
      'no structure page "no-such-structure"',
      'no design "no-such-design"',
      'nodes "a" and "b" overlap',
      'node "c" (300,160 140x56) lies outside',
      'names a missing node "ghost"',
      'edge a -> c runs through node "mid"',
      'node "s": ',
      'actor "C" is not in the actors list',
      'design "ledger" has no component "nope"',
      'design "ledger" has no flow "nope-flow"',
      'no concept page "no-such-concept"',
      'section id "one" is used twice',
    ]) expect(p).toContain(want);
  });
});
