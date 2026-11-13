import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const [id = 'b-plus-tree', op = 'insert', arg = '50', w = '1440', hgt = '900'] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +hgt, deviceScaleFactor: +w < 600 ? 2 : 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.evaluateOnNewDocument(() => { localStorage.setItem('dsv.side', 'code'); if (window.__lang) localStorage.setItem('dsv.code.lang', window.__lang); });
await page.goto(`${base}#/s/${id}`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => window.__dsv);
await page.screenshot({ path: `.shots/code-${id}-rest-${w}.png` });
const frames = await page.evaluate((o, a) => window.__dsv.run(o, a), op, arg.split(',').map((x) => (isNaN(+x) ? x : +x)));
for (const f of [0, Math.floor(frames / 2), frames - 2, frames - 1]) {
  await page.evaluate((i) => window.__dsv.seek(i), f);
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: `.shots/code-${id}-${op}-${f}-${w}.png` });
}
// Java too
await page.evaluate(() => [...document.querySelectorAll('.code-lang')].find((b) => b.textContent === 'Java').click());
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: `.shots/code-${id}-${op}-java-${w}.png` });
console.log(frames, 'frames');
await browser.close(); await server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
