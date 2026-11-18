// node scripts/look/sheet-look.mjs <out dir>: the web crawler cheat sheet as a reviewer sees it: screenshots at 1920, 1440 and 390 (first view and full page), the clock running at 1440 and 390, the text in reading order and the printed PDF.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
// Types new numbers into the sheet's fields as a reader would, screenshots the first view, then resets them.
async function numbersChanged(page, w) {
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [label, text] of [['Pages a month', '5bn'], ['Size of a page in KB', '200']]) {
    const f = await page.$(`input[aria-label="${label}"]`);
    await f.click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${out}/screen-${w}-numbers-changed.png` });
  console.log(`${w} changed:`, await page.evaluate(() => [...document.querySelectorAll('.dx-sheet-figs > div')].slice(0, 4).map((d) => d.innerText.replace(/\s+/g, ' ')).join(' | ')));
  await page.click('.dx-sheet-reset');
  console.log(`${w} after reset, reset hidden:`, await page.evaluate(() => document.querySelector('.dx-sheet-reset').hidden), '| kept:', await page.evaluate(() => sessionStorage.getItem('dsv.sheet.web-crawler.live')));
}
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
for (const [w, hgt] of [[1920, 1080], [1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: hgt });
  await page.goto(`${base}#/d/web-crawler/crib`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `${out}/screen-${w}-first-view.png` });
  await page.screenshot({ path: `${out}/screen-${w}-full.png`, fullPage: true });
  if (w === 1440) {
    // With the clock started 20 minutes ago: the stretch it marks.
    await page.evaluate(() => sessionStorage.setItem('dsv.sheet.web-crawler', String(Date.now() - 20 * 60 * 1000)));
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1300));
    await page.evaluate(() => document.querySelector('.dx-sheet-hour li.now')?.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: `${out}/screen-1440-clock-at-20-minutes.png` });
    console.log('now:', await page.evaluate(() => [...document.querySelectorAll('.dx-sheet-hour li.now h3')].map((e) => e.textContent).join('|')), '| timer:', await page.evaluate(() => document.querySelector('.dx-sheet-elapsed')?.textContent));
    await page.evaluate(() => sessionStorage.removeItem('dsv.sheet.web-crawler'));
    await numbersChanged(page, w);
  }
  if (w === 390) {
    await page.evaluate(() => sessionStorage.setItem('dsv.sheet.web-crawler', String(Date.now() - 35 * 60 * 1000)));
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1300));
    await page.evaluate(() => document.querySelector('.dx-sheet-hour li.now')?.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: `${out}/screen-390-clock-at-35-minutes.png` });
    await page.evaluate(() => sessionStorage.removeItem('dsv.sheet.web-crawler'));
    await numbersChanged(page, w);
  }
  if (w === 1920) {
    // innerText leaves out what a field holds: each field reads as its value, as on paper.
    writeFileSync(`${out}/text.txt`, await page.evaluate(() => {
      const fields = [...document.querySelectorAll('.dx-sheet input.dx-sheet-in')];
      const spans = fields.map((f) => { const sp = document.createElement('span'); sp.textContent = f.value; f.replaceWith(sp); return [f, sp]; });
      const text = document.querySelector('.dx-sheet')?.innerText ?? '';
      for (const [f, sp] of spans) sp.replaceWith(f);
      return text;
    }));
    await page.pdf({ path: `${out}/sheet.pdf`, format: 'A4', printBackground: true });
  }
  if (w === 1920) {
    // Two minutes in, not scrolled: what a second monitor shows as the interview starts.
    await page.evaluate(() => sessionStorage.setItem('dsv.sheet.web-crawler', String(Date.now() - 2 * 60 * 1000)));
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1300));
    await page.screenshot({ path: `${out}/screen-1920-clock-at-2-minutes.png` });
    await page.evaluate(() => sessionStorage.removeItem('dsv.sheet.web-crawler'));
  }
  await page.close();
}
await browser.close(); await server.close();
