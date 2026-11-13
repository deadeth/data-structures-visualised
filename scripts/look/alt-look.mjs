import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const routes = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
let n = 0;
for (const r of routes) for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#/d/${r}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((x) => setTimeout(x, 1200));
  const el = await page.$('.hld-alt-block');
  const name = `.shots/alt-${r.replace(/\//g, '_')}-${w}.png`;
  if (el) { await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await new Promise((x) => setTimeout(x, 300)); await el.screenshot({ path: name }); }
  else await page.screenshot({ path: name });
  const over = await page.evaluate(() => [...document.querySelectorAll('.hld-alts li')].filter((l) => l.scrollWidth > l.clientWidth + 1).length);
  console.log(name, el ? 'block' : 'NO BLOCK', 'overflowing items', over);
  await page.close(); n++;
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
