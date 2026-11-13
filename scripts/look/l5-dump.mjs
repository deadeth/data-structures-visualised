import { createServer } from 'vite';
import fs from 'fs';
const server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'error', appType: 'custom' });
const m = await server.ssrLoadModule('/src/designs/ledger.ts');
const d = Object.values(m).find((v) => v && v.flows);
const out = [];
for (const f of d.flows) for (const e of f.examples ?? []) out.push({ flow: f.id, title: e.title, lang: e.lang, code: e.code });
fs.writeFileSync('/tmp/pgtest/l5/blocks.json', JSON.stringify(out, null, 1));
// long lines
for (const f of d.flows) for (const e of f.examples ?? []) { const ls = e.code.split('\n'); const long = ls.filter((l) => l.length > 72); if (long.length || ls.length > 26) console.log(f.id, '|', e.title, '| lines', ls.length, long.map((l) => l.length)); }
await server.close();
