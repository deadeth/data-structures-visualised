// Shots of one tour step with Code on at several widths, for my own review.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const [id = 'b-plus-tree', step = '1'] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
for (const [w, hgt, m] of [[1440, 900, 0], [1280, 800, 0], [1024, 768, 0], [390, 844, 1]]) {
  const page = await browser.newPage();
  page.on('console', (x) => x.type() === 'error' && errors.push(x.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 1, isMobile: !!m, hasTouch: !!m });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('dsv.code', 'on'); localStorage.setItem('dsv.code.lang', 'python'); });
  await page.goto(`${base}#/s/${id}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__dsv, { timeout: 8000 });
  const tour = await page.evaluate(() => window.__dsv.tour);
  const [op, ...a] = tour[Number(step)];
  const frames = await page.evaluate((o, x) => window.__dsv.run(o, x), op, a);
  await page.evaluate((i) => window.__dsv.seek(i), Math.floor(frames * 0.6));
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `.shots/r4-${id}-${w}.png` });
  await page.close();
}
console.log('errors', errors);
await browser.close(); await server.close();
