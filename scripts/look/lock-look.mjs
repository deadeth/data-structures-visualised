// A locked page before and after unlocking, at 1440x900 and 390x844, into .shots/lock-<n>-<width>.png.
// Usage: LOCK_PASSWORD=… node scripts/look/lock-look.mjs [route]   (route defaults to d/money-moved-dashboard)
// Tries a wrong password first, then the right one; prints the sidebar's design names and any page errors.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const route = (process.argv[2] ?? 'd/money-moved-dashboard').replace(/^#?\/?/, '');
const password = process.env.LOCK_PASSWORD;
if (!password) {
  console.log('Set LOCK_PASSWORD.');
  process.exit(1);
}
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
const tag = route.replace(/[^a-z0-9]+/g, '-');
const designs = (page) => page.evaluate(() => [...document.querySelectorAll('.nav-group')].find((g) => g.querySelector('.nav-label')?.textContent === 'System designs')?.querySelectorAll('a').length && [...[...document.querySelectorAll('.nav-group')].find((g) => g.querySelector('.nav-label')?.textContent === 'System designs').querySelectorAll('a')].map((a) => `${a.textContent}${a.getAttribute('aria-current') ? ' (current)' : ''}`));
for (const [w, hgt] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 1 });
  await page.goto(`${base}#/${route}`, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 600));
  console.log(`${w} before:`, await page.evaluate(() => document.querySelector('main h1')?.textContent), '| sidebar:', (await designs(page)).join(', '));
  await page.screenshot({ path: `.shots/lock-${tag}-1-before-${w}.png` });
  await page.type('#lock-password', 'not-the-password');
  await page.click('.lock-form button');
  await page.waitForFunction(() => document.querySelector('.lock-error')?.textContent, { timeout: 15000 });
  console.log(`${w} wrong:`, await page.evaluate(() => document.querySelector('.lock-error').textContent));
  await page.screenshot({ path: `.shots/lock-${tag}-2-wrong-${w}.png` });
  await page.$eval('#lock-password', (i) => (i.value = ''));
  await page.type('#lock-password', password);
  await page.click('.lock-form button');
  await page.waitForFunction(() => !document.querySelector('.lock-form'), { timeout: 15000 });
  await new Promise((x) => setTimeout(x, 1500));
  console.log(`${w} after:`, await page.evaluate(() => document.querySelector('main h1')?.textContent), '| sidebar:', (await designs(page)).join(', '));
  await page.screenshot({ path: `.shots/lock-${tag}-3-after-${w}.png` });
  // A reload in the same tab opens quietly from sessionStorage.
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 1500));
  console.log(`${w} reload:`, await page.evaluate(() => (document.querySelector('.lock-form') ? 'form shown' : document.querySelector('main h1')?.textContent)));
  // Search finds it now.
  await page.goto(`${base}#/search/transfer`, { waitUntil: 'networkidle0' });
  await new Promise((x) => setTimeout(x, 1500));
  console.log(`${w} search after unlock:`, await page.evaluate(() => document.querySelectorAll('.search-results a[href*="money-moved"]').length), 'results link to it');
  console.log(`${w} errors:`, errors);
  await page.close();
}
// A fresh tab: search and home hold nothing locked.
const page = await browser.newPage();
await page.goto(`${base}#/search/transfer`, { waitUntil: 'networkidle0' });
await new Promise((x) => setTimeout(x, 1500));
console.log('fresh search:', await page.evaluate(() => document.querySelectorAll('.search-results a[href*="money-moved"]').length), 'results link to it');
await page.goto(`${base}#/`, { waitUntil: 'networkidle0' });
await new Promise((x) => setTimeout(x, 800));
console.log('fresh home:', await page.evaluate(() => [...document.querySelectorAll('main a[href*="money-moved"]')].map((a) => a.textContent)));
await browser.close();
await server.close();
