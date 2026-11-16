import { describe, expect, it } from 'vitest';

/**
 * The production build must hold nothing readable from the locked pages: only their sealed file.
 * Builds the site into a scratch folder and searches every built file but the sealed ones.
 * With private/ present (on the owner's machine) it also checks every long run of words in the
 * private files that is not also in the public source; without it (CI), a fixed list.
 */

// The repo has no Node type definitions, so the Node modules used here are typed by hand.
const node = async <T>(m: string): Promise<T> => (await import(/* @vite-ignore */ `node:${m}`)) as T;
interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  readdirSync(p: string, o: { recursive: true }): string[];
  statSync(p: string): { isFile(): boolean };
  mkdtempSync(p: string): string;
  rmSync(p: string, o: { recursive: true; force: true }): void;
}

// The company name is spelled in pieces so that this file does not contain it.
const COMPANY = new RegExp(`\\b${['W', 'i', 's', 'e'].join('')}\\b`, 'i');
/** Field and state names found only in the locked pages. */
const PHRASES = ['transfer_contribution', 'incoming_payment_waiting', 'funds_converted', 'outgoing_payment_sent', 'usd_per_unit', 'bounced_back'];

/** Every string inside a value, however deep. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

describe('the built site', () => {
  it('holds nothing readable from the locked pages', { timeout: 240_000 }, async () => {
    const fs = await node<Fs>('fs');
    const { execFileSync } = await node<{ execFileSync(cmd: string, args: string[], o: object): void }>('child_process');
    const { tmpdir } = await node<{ tmpdir(): string }>('os');
    const root = new URL('../../', import.meta.url).pathname;
    const out = fs.mkdtempSync(`${tmpdir()}/dsv-bundle-`);
    try {
      execFileSync('node', [`${root}node_modules/vite/bin/vite.js`, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'pipe' });
      const files = fs.readdirSync(out, { recursive: true }).filter((f) => !/\.(bin|woff2?|png|jpe?g|svg|ico)$/.test(f) && fs.statSync(`${out}/${f}`).isFile());
      expect(files.some((f) => f.endsWith('.js'))).toBe(true);
      expect(fs.existsSync(`${out}/locked/a1.bin`)).toBe(true);
      const built = files.map((f) => ({ f, text: fs.readFileSync(`${out}/${f}`, 'utf8') }));

      const found: string[] = [];
      for (const { f, text } of built) {
        const m = COMPANY.exec(text);
        if (m) found.push(`${f}: the company name at ${m.index}: …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`);
        for (const p of PHRASES) if (text.includes(p)) found.push(`${f}: "${p}"`);
      }

      // On a machine with the private files: every run of 24 or more plain characters from them that the public source does not also hold.
      const priv = `${root}private`;
      if (fs.existsSync(priv)) {
        const src = fs.readdirSync(`${root}src`, { recursive: true }).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(`${root}src/${f}`, 'utf8')).join('\n');
        const mods = await Promise.all(
          ['designs/money-moved-dashboard.ts', 'designs/extras/money-moved-dashboard.ts', 'reading/walkthroughs/money-moved-dashboard.ts'].map((p) => import(/* @vite-ignore */ `${priv}/${p}`)),
        );
        const runs = new Set(strings(mods).flatMap((s) => s.split(/[^A-Za-z0-9 ]+/).map((r) => r.trim()).filter((r) => r.length >= 24 && !src.includes(r))));
        expect(runs.size).toBeGreaterThan(100);
        for (const { f, text } of built) for (const r of runs) if (text.includes(r)) found.push(`${f}: "${r}"`);
      }
      expect(found, found.slice(0, 20).join('\n')).toEqual([]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
