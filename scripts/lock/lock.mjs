// Seal the private pages with a password. Usage, from the repo root:
//   LOCK_PASSWORD='…' node scripts/lock/lock.mjs
// Reads private/ (git-ignored) and writes, replacing what was there:
//   public/<blob> for each entry of src/locked/manifest.ts: the designs, extras and walkthroughs the site opens;
//   locked/source.bin: every file under private/, so `unlock.mjs` can restore them on any clone.
// Both use a fresh salt and IV on every run. See README.md beside this file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const priv = join(root, 'private');
const password = process.env.LOCK_PASSWORD;
if (!password) {
  console.error('Set LOCK_PASSWORD to the password to seal with.');
  process.exit(1);
}
if (!existsSync(priv)) {
  console.error('No private/ folder. Restore it first: LOCK_PASSWORD=… node scripts/lock/unlock.mjs');
  process.exit(1);
}

const load = async (file) => (await runnerImport(file, { configFile: false, logLevel: 'error', root })).module;
const { seal, open } = await load(join(root, 'src/locked/crypto.ts'));
const { LOCKED } = await load(join(root, 'src/locked/manifest.ts'));

/** Fails on anything JSON would drop or change, so the browser gets exactly what the module held. */
function plainData(v, at) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${at}: ${v} does not survive JSON`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => plainData(x, `${at}[${i}]`));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const [k, x] of Object.entries(v)) if (x !== undefined) plainData(x, `${at}.${k}`);
    return;
  }
  throw new Error(`${at}: a ${typeof v} (${v?.constructor?.name}) does not survive JSON`);
}

const entriesFile = join(priv, 'designs/entries.ts');
const entries = existsSync(entriesFile) ? (await load(entriesFile)).entries : [];

for (const e of LOCKED) {
  const payload = { designs: [], extras: {}, walkthroughs: {}, entries: [] };
  for (const id of e.ids) {
    const dm = await load(join(priv, 'designs', `${id}.ts`));
    const design = Object.values(dm).find((x) => x && typeof x === 'object' && x.id === id && Array.isArray(x.tour));
    if (!design) throw new Error(`private/designs/${id}.ts exports no design with id "${id}"`);
    payload.designs.push(design);
    const exFile = join(priv, 'designs/extras', `${id}.ts`);
    if (existsSync(exFile)) {
      const xm = await load(exFile);
      payload.extras[id] = xm.extras ?? xm.default;
    }
    const wFile = join(priv, 'reading/walkthroughs', `${id}.ts`);
    if (existsSync(wFile)) payload.walkthroughs[id] = (await load(wFile)).default;
    const meta = entries.find((x) => x.id === id);
    if (meta) payload.entries.push(meta);
    else console.warn(`No entry for "${id}" in private/designs/entries.ts: the sidebar will show the design's own name.`);
  }
  plainData(payload, 'payload');
  const text = JSON.stringify(payload);
  const sealed = await seal(text, password);
  if ((await open(sealed, password)) !== text) throw new Error('Round trip failed');
  const out = join(root, 'public', e.blob);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(sealed));
  console.log(`${relative(root, out)}: ${e.ids.join(', ')} (${payload.designs.length} design, ${Object.keys(payload.extras).length} extras, ${Object.keys(payload.walkthroughs).length} walkthrough; ${Math.round(text.length / 1024)} KB of JSON)`);
}

// The source, so the private files can be restored on another clone.
const files = {};
const walk = (dir) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (d.isFile()) files[relative(priv, p).split(sep).join('/')] = readFileSync(p, 'utf8');
  }
};
walk(priv);
const text = JSON.stringify(files);
const sealed = await seal(text, password);
if ((await open(sealed, password)) !== text) throw new Error('Round trip failed');
mkdirSync(join(root, 'locked'), { recursive: true });
writeFileSync(join(root, 'locked/source.bin'), JSON.stringify(sealed));
console.log(`locked/source.bin: ${Object.keys(files).length} files (${Object.keys(files).sort().join(', ')})`);
