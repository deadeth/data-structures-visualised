import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
for (const [w, h, route, name, sel] of [[1440, 900, '#/', 'home', null], [1440, 900, '#/s/bloom-filter', 'bloom', null], [700, 900, '#/d/web-crawler', 'table700', 'table'], [1440, 900, '#/d/web-crawler/g/simhash', 'gloss', null]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(base + route, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 1200));
  if (sel) await page.evaluate(() => { const t = [...document.querySelectorAll('.table-wrap')][2]; t?.scrollIntoView({ block: 'start' }); });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `.shots/b11-${name}.png` });
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
