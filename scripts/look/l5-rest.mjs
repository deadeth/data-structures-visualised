import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const hashes = process.argv.slice(2);
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const errors = [];
for (const hsh of hashes) for (const [w, h] of [[1440, 900]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${base}${hsh}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((x) => setTimeout(x, 1200));
  const el = await page.$('svg.hld-svg, .hld-stage svg, svg');
  const name = hsh.replace(/[^a-z0-9]+/gi, '_');
  const st = await page.$('.hld-stage') ;
  if (st) await st.screenshot({ path: `.shots/l5-${name}.png` }); else await page.screenshot({ path: `.shots/l5-${name}.png` });
  await page.close();
}
console.log('errors', errors);
await browser.close(); await server.close();
