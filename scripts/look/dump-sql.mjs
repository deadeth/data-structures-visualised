import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'error', appType: 'custom' });
const m = await server.ssrLoadModule('/src/designs/ledger.ts');
const d = Object.values(m).find((v) => v && v.flows);
for (const f of d.flows) for (const e of f.examples ?? []) if (e.lang === 'sql') console.log(`\n-- ##### ${f.id} :: ${e.title}\n${e.code}\n-- note: ${e.note ?? ''}`);
await server.close();
