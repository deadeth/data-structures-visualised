import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
for (const r of ['#/d/web-crawler', '#/s/bloom-filter', '#/']) {
  const page = await browser.newPage();
  await page.goto(base + r, { waitUntil: 'networkidle0' });
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await new Promise((x) => setTimeout(x, 400));
  console.log(r, await page.evaluate(() => [location.hash, document.activeElement?.id, document.querySelector('h1')?.textContent]));
  await page.close();
}
await browser.close(); await server.close();
