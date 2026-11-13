import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
for (const [w, h] of [[1440, 900], [1366, 768]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${server.resolvedUrls.local[0]}#/d/web-crawler/t/6`, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 1500));
  console.log(w, h, await page.evaluate(() => { const s = document.querySelector('.hld').getBoundingClientRect(); return { stageHeight: Math.round(s.height), stageBottom: Math.round(s.bottom), viewport: innerHeight }; }));
  await page.close();
}
await browser.close(); await server.close();
