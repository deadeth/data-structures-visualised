import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const errors = [];
for (const [w, h] of [[2560, 1300], [1920, 1080], [1440, 900]]) for (const r of process.argv.slice(2)) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}#${r}`, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 1000));
  if (r.startsWith('/s/')) {
    await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Code')?.click(); });
    await new Promise((x) => setTimeout(x, 400));
    await page.evaluate(() => { [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === 'Play the tour')?.click(); });
    await new Promise((x) => setTimeout(x, 2500));
    await page.keyboard.press('Space');
  }
  await new Promise((x) => setTimeout(x, 800));
  await page.screenshot({ path: `.shots/wide-${r.replace(/[^a-z0-9]+/gi, '_')}-${w}.png` });
  console.log(w, r, JSON.stringify(await page.evaluate(() => ({ main: Math.round(document.querySelector('main').getBoundingClientRect().width), stage: Math.round(document.querySelector('.stage, .hld')?.getBoundingClientRect().width ?? 0), scrollX: document.documentElement.scrollWidth > innerWidth }))));
  await page.close();
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); await server.close();
