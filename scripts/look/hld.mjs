import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const [w = '1440', hgt = '900'] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +hgt, deviceScaleFactor: +w < 600 ? 2 : 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${base}#/d/web-crawler`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await page.waitForSelector('.hld-svg');
const snap = async (n, full = false) => { await new Promise((r) => setTimeout(r, 250)); await page.screenshot({ path: `.shots/hld-${n}-${w}.png`, fullPage: full }); };
await snap('rest');
const next = async () => page.evaluate(() => document.querySelector('.hld-icon[aria-label="Next step"]').click());
for (let i = 1; i <= 13; i++) { await next(); if ([1, 5, 9, 11, 13].includes(i)) await snap(`step${i}`); }
await page.evaluate(() => document.querySelector('.hld-node[aria-label^="URL frontier"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await snap('frontier');
await snap('page', true);
const small = await page.evaluate(() => { const s = document.querySelector('.hld-svg'); const k = s.getBoundingClientRect().width / 1120; let min = 99; s.querySelectorAll('text').forEach((t) => { const f = parseFloat(getComputedStyle(t).fontSize) * k; if (t.textContent && f < min) min = f; }); return { scale: k, minText: min, overflowX: document.documentElement.scrollWidth > innerWidth }; });
console.log(JSON.stringify(small));
await browser.close(); await server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
