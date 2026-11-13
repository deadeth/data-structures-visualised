import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
for (const r of ['#/d/web-crawler/g/SimHash', '#/d/web-crawler/g/simhash', '#/d/web-crawler/g/Nope!', '#/d/web-crawler/c/Fetcher', '#/nowhere']) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(base + r, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 900));
  console.log(r, await page.evaluate(() => [location.hash, document.querySelector('h1')?.textContent, document.activeElement?.tagName + '.' + (document.activeElement?.className || ''), document.querySelector('.hld-missing')?.textContent?.slice(0, 50)]), errs.length);
  await page.close();
}
await browser.close(); await server.close();
