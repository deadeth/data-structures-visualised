import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
const shots = [
  ['web-crawler', 1440, 900, '', 'rest'], ['web-crawler', 1440, 900, '/t/6', 't6'], ['web-crawler', 1440, 900, '/t/13', 't13'], ['web-crawler', 1440, 900, '/t/14', 't14'], ['web-crawler', 390, 844, '/t/14', 'p14'], ['web-crawler', 390, 844, '/t/7', 'p7'], ['web-crawler', 1440, 900, '/f/cross', 'cross'],
  ['web-crawler', 390, 844, '/t/6', 'p6'], ['web-crawler', 390, 844, '/t/12', 'p12'], ['web-crawler', 390, 844, '/t/13', 'p13'], ['web-crawler', 320, 640, '/t/6', 's6'],
  ['web-crawler', 768, 1024, '', 'tab'], ['web-crawler', 1440, 900, '/t/9', 't9'], ['web-crawler', 1366, 768, '/t/11', 'w1366t11'], ['web-crawler', 390, 844, '/t/9', 'p9'], ['web-crawler', 1920, 1080, '', 'w1920'], ['web-crawler', 1024, 768, '', 'w1024'], ['web-crawler', 844, 390, '/t/12', 'land12'], ['web-crawler', 1440, 900, '/c/frontier', 'frontier'], ['ledger', 1440, 900, '', 'rest'], ['ledger', 390, 844, '/t/5', 'p5'], ['fraud-alerts', 1440, 900, '/t/6', 't6'], ['card-processing', 1440, 900, '', 'rest'], ['card-processing', 390, 844, '/t/6', 'p6'],
];
for (const [id, w, h, route, name] of shots) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(id + name + String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(id + name + m.text()));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#/d/${id}${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `.shots/b5-${id}-${name}.png` });
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
