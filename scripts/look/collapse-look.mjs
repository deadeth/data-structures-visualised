import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const errors = [];
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#/d/card-processing/t/3`, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 1500));
  const m = () => page.evaluate(() => { const d = document.querySelector('.hld-detail, [class*="detail"]'); const e = document.querySelector('.hld-explain'); const h3 = [...document.querySelectorAll('h3')].find((x) => x === document.activeElement) ?? document.activeElement; const head = document.querySelector('.hld-head'); return { scrollY: Math.round(scrollY), explainH: Math.round(e.getBoundingClientRect().height), explainTop: Math.round(e.getBoundingClientRect().top), focusTag: h3?.tagName, focusText: h3?.textContent?.slice(0, 30), focusTop: Math.round(h3?.getBoundingClientRect().top ?? -1), headBottom: Math.round(head?.getBoundingClientRect().bottom ?? -1), btn: document.querySelector('.hld-explain-toggle')?.textContent, expanded: document.querySelector('.hld-explain-toggle')?.getAttribute('aria-expanded') }; });
  const clickBox = async () => { await page.evaluate(() => scrollTo(0, 0)); await new Promise((x) => setTimeout(x, 300)); const g = await page.$('svg [data-id], svg .hld-node, svg g[role="button"]'); await g.click(); await new Promise((x) => setTimeout(x, 1500)); };
  console.log(w, 'open, before', JSON.stringify(await m()));
  await clickBox();
  console.log(w, 'open, box clicked', JSON.stringify(await m()));
  await page.screenshot({ path: `.shots/collapse-open-clicked-${w}.png` });
  await page.evaluate(() => document.querySelector('.hld-explain-toggle').click());
  await clickBox(); await clickBox();
  console.log(w, 'shut, box clicked', JSON.stringify(await m()));
  await page.screenshot({ path: `.shots/collapse-shut-clicked-${w}.png` });
  const el = await page.$('.hld-explain'); await el.screenshot({ path: `.shots/collapse-shut-panel-${w}.png` });
  // next step keeps it shut; "Explain this step" opens it
  await page.keyboard.press('ArrowRight'); await new Promise((x) => setTimeout(x, 1200));
  console.log(w, 'next step', JSON.stringify(await m()));
  await page.evaluate(() => document.querySelector('.hld-explain-link')?.click()); await new Promise((x) => setTimeout(x, 1200));
  console.log(w, 'explain link', JSON.stringify(await m()));
  await page.evaluate(() => localStorage.clear());
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
