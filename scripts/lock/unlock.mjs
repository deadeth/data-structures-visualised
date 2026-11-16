// Restore private/ from locked/source.bin. Usage, from the repo root:
//   LOCK_PASSWORD='…' node scripts/lock/unlock.mjs [--force]
// A file in private/ that differs from the sealed copy and was changed after locked/source.bin was
// written is left alone (and named), unless --force is given. See README.md beside this file.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const priv = join(root, 'private');
const source = join(root, 'locked/source.bin');
const force = process.argv.includes('--force');
const password = process.env.LOCK_PASSWORD;
if (!password) {
  console.error('Set LOCK_PASSWORD to the password the source was sealed with.');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error('No locked/source.bin to restore from.');
  process.exit(1);
}

const { open } = (await runnerImport(join(root, 'src/locked/crypto.ts'), { configFile: false, logLevel: 'error', root })).module;
let files;
try {
  files = JSON.parse(await open(JSON.parse(readFileSync(source, 'utf8')), password));
} catch {
  console.error('Could not open locked/source.bin: wrong password, or a damaged file.');
  process.exit(1);
}

const sealedAt = statSync(source).mtimeMs;
const kept = [];
let wrote = 0;
for (const [rel, text] of Object.entries(files)) {
  const clean = normalize(rel);
  if (isAbsolute(clean) || clean.startsWith('..')) throw new Error(`Refusing a path outside private/: ${rel}`);
  const out = join(priv, clean);
  if (existsSync(out)) {
    if (readFileSync(out, 'utf8') === text) continue;
    if (!force && statSync(out).mtimeMs > sealedAt) {
      kept.push(rel);
      continue;
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  wrote++;
}
console.log(`private/: ${wrote} file(s) written, ${Object.keys(files).length - wrote - kept.length} already up to date.`);
if (kept.length) {
  console.log(`Left alone, changed since locked/source.bin was written (use --force to overwrite):\n  ${kept.join('\n  ')}`);
  process.exitCode = 2;
}
