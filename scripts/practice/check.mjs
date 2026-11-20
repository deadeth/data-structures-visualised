// node scripts/practice/check.mjs [id]
//
// Compiles and runs every Java file of the pairing practice pages on the local JDK (Java 21): each page folder
// under src/practice/ that has a starter, and the development fixture under src/practice/__fixtures__/.
// Not part of `npm test`: the site's build and CI have no reason to need a JDK. Run it after changing any Java.
//
// For each file it copies Solution.java to a temporary directory, runs `javac -Xlint:all Solution.java`, then
// `java Solution` with a 10-second limit, and checks:
//   - the compiler prints no warnings (the JVM's "Picked up JAVA_TOOL_OPTIONS" notice is not a warning);
//   - the starter has STAGE = 1, runs to the end without crashing, prints at least one FAIL and a "Stage 1:" line;
//   - stage n has STAGE = n, prints no FAIL, "Stage k: t/t passed" for every k from 1 to n, and "ALL PASSED";
//   - the last stage file with STAGE raised to the top stage its tests hold passes everything.
// Prints one line per file and exits 1 on any failure.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../src/practice/', import.meta.url).pathname;
const only = process.argv[2];

/** Page folders: src/practice/<id>/ and src/practice/__fixtures__/<id>/, each with a starter. */
function folders() {
  const out = [];
  const scan = (dir, label) => {
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('__')) continue;
      if (existsSync(join(dir, d.name, 'starter', 'Solution.java'))) out.push({ id: d.name, dir: join(dir, d.name), label: `${label}${d.name}` });
    }
  };
  scan(root, '');
  scan(join(root, '__fixtures__'), '__fixtures__/');
  return out.filter((f) => !only || f.id === only);
}

const STAGE_LINE = /^(\s*static\s+final\s+int\s+STAGE\s*=\s*)(\d+)(\s*;\s*)$/m;
const stageOf = (src) => {
  const m = STAGE_LINE.exec(src);
  return m ? Number(m[2]) : undefined;
};
const withStage = (src, n) => src.replace(STAGE_LINE, (_m, a, _b, c) => `${a}${n}${c}`);
const topStage = (src) => Math.max(0, ...[...src.matchAll(/if\s*\(\s*STAGE\s*>=\s*(\d+)\s*\)/g)].map((m) => Number(m[1])));
const quiet = (text) => text.split('\n').filter((l) => l.trim() && !/^Picked up (JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)/.test(l)).join('\n');

/** Compile and run one source; returns the program's output or a reason it could not run. */
function run(source) {
  const dir = mkdtempSync(join(tmpdir(), 'practice-'));
  try {
    writeFileSync(join(dir, 'Solution.java'), source);
    const c = spawnSync('javac', ['-Xlint:all', 'Solution.java'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    if (c.error) return { error: `javac could not start: ${c.error.message}` };
    const said = quiet(`${c.stdout}\n${c.stderr}`);
    if (c.status !== 0) return { error: `does not compile:\n${said}` };
    if (said) return { error: `compiler warnings:\n${said}` };
    const r = spawnSync('java', ['Solution'], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    if (r.error?.code === 'ETIMEDOUT' || r.signal) return { error: 'did not finish within 10 seconds' };
    if (r.error) return { error: `java could not start: ${r.error.message}` };
    const err = quiet(r.stderr);
    if (r.status !== 0 || err) return { error: `crashed (exit ${r.status}):\n${err}` };
    return { out: r.stdout.replace(/\r\n/g, '\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Faults in a run that should pass stages 1 to n. */
function passing(out, n) {
  const faults = [];
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  if (fails.length) faults.push(`${fails.length} FAIL: ${fails.slice(0, 3).join(' | ')}`);
  for (let k = 1; k <= n; k++) {
    const m = new RegExp(`^Stage ${k}: (\\d+)/(\\d+) passed$`, 'm').exec(out);
    if (!m) faults.push(`no "Stage ${k}: t/t passed" line`);
    else if (m[1] !== m[2] || m[2] === '0') faults.push(`Stage ${k}: ${m[1]}/${m[2]} passed`);
  }
  if (!/^ALL PASSED$/m.test(out)) faults.push('no "ALL PASSED" line');
  return faults;
}

const summary = (out) => out.split('\n').filter((l) => /^Stage \d+:|^ALL PASSED$|FAILED$/.test(l)).join(', ');

let bad = 0;
const report = (label, file, faults, out) => {
  if (faults.length) bad++;
  console.log(`${faults.length ? 'FAIL' : 'ok  '} ${label}/${file}${faults.length ? `: ${faults.join('; ')}` : out ? `: ${summary(out)}` : ''}`);
};

const list = folders();
if (!list.length) {
  console.log(only ? `No page folder "${only}" with a starter.` : 'No page folders with a starter.');
  process.exit(1);
}
for (const f of list) {
  const starterSrc = readFileSync(join(f.dir, 'starter', 'Solution.java'), 'utf8');
  {
    const faults = [];
    if (stageOf(starterSrc) !== 1) faults.push(`STAGE is ${stageOf(starterSrc) ?? 'missing'}, should be 1`);
    const r = run(starterSrc);
    if (r.error) faults.push(r.error);
    else {
      if (!/^FAIL /m.test(r.out)) faults.push('prints no FAIL');
      if (!/^Stage 1: \d+\/\d+ passed$/m.test(r.out)) faults.push('prints no "Stage 1:" line');
      if (!/^(ALL PASSED|\d+ FAILED)$/m.test(r.out)) faults.push('does not run to the end (no "ALL PASSED" or "n FAILED" line)');
    }
    report(f.label, 'starter', faults, r.out);
  }
  const solDir = join(f.dir, 'solution');
  const stages = existsSync(solDir)
    ? readdirSync(solDir).map((d) => /^s(\d+)$/.exec(d)).filter((m) => m && existsSync(join(solDir, m[0], 'Solution.java'))).map((m) => Number(m[1])).sort((a, b) => a - b)
    : [];
  for (const n of stages) {
    const src = readFileSync(join(solDir, `s${n}`, 'Solution.java'), 'utf8');
    const faults = [];
    if (stageOf(src) !== n) faults.push(`STAGE is ${stageOf(src) ?? 'missing'}, should be ${n}`);
    const r = run(src);
    if (r.error) faults.push(r.error);
    else faults.push(...passing(r.out, n));
    report(f.label, `s${n}`, faults, r.out);
  }
  if (stages.length) {
    const last = stages[stages.length - 1];
    const src = readFileSync(join(solDir, `s${last}`, 'Solution.java'), 'utf8');
    const top = topStage(src);
    const faults = [];
    if (!top) faults.push('main has no "if (STAGE >= k)" lines');
    const r = run(withStage(src, top || last));
    if (r.error) faults.push(r.error);
    else faults.push(...passing(r.out, top || last));
    report(f.label, `s${last} with STAGE = ${top}`, faults, r.out);
  }
}
process.exit(bad ? 1 : 0);
