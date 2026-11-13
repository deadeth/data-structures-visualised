import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const [id, ...steps] = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
for (const [w, h] of [[1440, 900], [390, 844]]) for (const n of steps) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#/d/${id}/t/${n}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((x) => setTimeout(x, 1500));
  await page.screenshot({ path: `.shots/step-${id}-${n}-top-${w}.png` });
  const info = await page.evaluate(() => ({ readout: Math.round(document.querySelector('.hld-readout')?.getBoundingClientRect().height ?? 0), head: Math.round(document.querySelector('.hld-head')?.getBoundingClientRect().height ?? 0), pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth, panel: !!document.querySelector('.hld-explain:not([hidden])') }));
  const el = await page.$('.hld-explain:not([hidden])');
  if (el) { await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await new Promise((x) => setTimeout(x, 300)); await el.screenshot({ path: `.shots/step-${id}-${n}-panel-${w}.png` }); }
  console.log(`step ${n} at ${w}`, JSON.stringify(info));
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
