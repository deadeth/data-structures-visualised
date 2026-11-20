/**
 * Small, pure helpers over a practice page's Java files: their three banner sections, region markers and
 * the `STAGE` line. Used by the page, the shape tests and (as a copy in plain JS) scripts/practice/check.mjs.
 */

/** The banner comments that open the three sections of every file, in order. */
export const BANNERS = [
  '// ===== Supplied code: do not change =====',
  '// ===== Your code =====',
  '// ===== Tests: set STAGE to run more =====',
] as const;

export interface JavaSections {
  /** Everything before the first banner: imports, the header comment, the class line. */
  head: string;
  /** From the "Supplied code" banner up to the "Your code" banner. */
  supplied: string;
  /** From the "Your code" banner up to the "Tests" banner. */
  yours: string;
  /** From the "Tests" banner to the end of the file. */
  tests: string;
}

const lf = (src: string) => src.replace(/\r\n/g, '\n');

/** Where each banner sits, by line: -1 for a missing one. Banners are matched on the trimmed line. */
function bannerLines(lines: string[]): number[] {
  return BANNERS.map((b) => lines.findIndex((l) => l.trim() === b));
}

/** The file's three sections, or a sentence saying why it cannot be split: a banner missing, twice, or out of order. */
export function javaSections(src: string): JavaSections | string {
  const lines = lf(src).split('\n');
  const at = bannerLines(lines);
  for (let i = 0; i < BANNERS.length; i++) {
    if (at[i] < 0) return `the banner "${BANNERS[i]}" is missing`;
    if (lines.filter((l) => l.trim() === BANNERS[i]).length > 1) return `the banner "${BANNERS[i]}" appears twice`;
  }
  if (!(at[0] < at[1] && at[1] < at[2])) return 'the three banners are not in the order supplied, yours, tests';
  return {
    head: lines.slice(0, at[0]).join('\n'),
    supplied: lines.slice(at[0], at[1]).join('\n'),
    yours: lines.slice(at[1], at[2]).join('\n'),
    tests: lines.slice(at[2]).join('\n'),
  };
}

const REGION = /^\s*\/\/\s*region\s+[\w-]+\s*$/;
const ENDREGION = /^\s*\/\/\s*endregion\s*$/;

/** True for a `// region name` or `// endregion` line. */
export const isRegionMarker = (line: string): boolean => REGION.test(line) || ENDREGION.test(line);

/** The file with its region marker lines taken out, as the reader would have typed it. */
export function stripRegions(src: string): string {
  return lf(src).split('\n').filter((l) => !isRegionMarker(l)).join('\n');
}

const STAGE_LINE = /^(\s*static\s+final\s+int\s+STAGE\s*=\s*)(\d+)(\s*;\s*)$/m;

/** The value of the file's `static final int STAGE = n;` line, or undefined when there is none. */
export function stageOf(src: string): number | undefined {
  const m = STAGE_LINE.exec(lf(src));
  return m ? Number(m[2]) : undefined;
}

/** The file with its STAGE line set to `n`. */
export function withStage(src: string, n: number): string {
  return lf(src).replace(STAGE_LINE, (_m, a: string, _b: string, c: string) => `${a}${n}${c}`);
}

/** The tests section with its STAGE line blanked, for comparing files that differ only there. */
export function testsWithoutStage(tests: string): string {
  return lf(tests).replace(STAGE_LINE, (_m, a: string, _b: string, c: string) => `${a}#${c}`);
}

/** How many stages the harness runs at most: the `if (STAGE >= k)` lines in `main`. */
export function stagesInTests(src: string): number {
  let top = 0;
  for (const m of lf(src).matchAll(/if\s*\(\s*STAGE\s*>=\s*(\d+)\s*\)/g)) top = Math.max(top, Number(m[1]));
  return top;
}

/** A path of a Java file in a page folder: which page, and the starter or which stage. */
export function javaPath(path: string): { id: string; stage: number | 'starter' } | undefined {
  const m = /(?:^|\/)([a-z0-9-]+)\/(?:starter|solution\/s(\d+))\/Solution\.java$/.exec(path);
  if (!m) return undefined;
  return { id: m[1], stage: m[2] === undefined ? 'starter' : Number(m[2]) };
}

/**
 * Whether a trace cell is words that may wrap (a message, a sentence) rather than a short value kept on one line
 * (a number, a state, a call). Longer than 22 characters with a space in it wraps; a long value with no space stays whole.
 * Inline marks (`code`, **bold**, links) are not counted.
 */
export function proseCell(text: string): boolean {
  const t = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').trim();
  return t.length > 22 && /\s/.test(t);
}
