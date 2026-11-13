import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const [id] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
for (const [w, h, route, name, full] of [[1440, 900, '/rehearse', 'rehearse', false], [1440, 900, '/crib', 'crib', true], [1440, 900, '/q/1', 'push', false], [390, 844, '/rehearse', 'rehearse-phone', false]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#/d/${id}${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `.shots/ex-${id}-${name}.png`, fullPage: full });
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
