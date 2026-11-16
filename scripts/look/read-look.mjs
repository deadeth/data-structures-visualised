// Reading pages at 1440x900 and 390x844, full page, into .shots/read-<route>-<width>.png.
// Usage: node scripts/look/read-look.mjs c/caching d/ledger/read [...]
// Also prints, per size: page errors, whether the page scrolls sideways, figures that scroll sideways,
// the smallest drawn text in any figure (px on screen), and words in a figure that overlap other words.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const routes = process.argv.slice(2).map((r) => r.replace(/^#?\/?/, ''));
if (!routes.length) {
  console.log('usage: node scripts/look/read-look.mjs <route> [<route>...]   e.g. c/caching d/ledger/read');
  process.exit(1);
}
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });
let failed = 0;
for (const [w, hgt] of [[1440, 900], [390, 844]]) for (const route of routes) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 1 });
  await page.goto(`${base}#/${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((x) => setTimeout(x, 800));
  const info = await page.evaluate(() => {
    const figs = [...document.querySelectorAll('.rd-figure')];
    let smallest = Infinity;
    const scrolls = [];
    const overlaps = [];
    figs.forEach((f, i) => {
      const svg = f.querySelector('svg');
      const box = f.querySelector('.rd-figure-scroll');
      if (box.scrollWidth > box.clientWidth + 1) scrolls.push(i + 1);
      const vb = svg.viewBox.baseVal;
      const k = svg.getBoundingClientRect().width / vb.width;
      const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim());
      for (const t of texts) smallest = Math.min(smallest, parseFloat(getComputedStyle(t).fontSize) * k);
      const rs = texts.map((t) => t.getBoundingClientRect());
      for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
        const x = Math.min(rs[a].right, rs[b].right) - Math.max(rs[a].left, rs[b].left);
        const y = Math.min(rs[a].bottom, rs[b].bottom) - Math.max(rs[a].top, rs[b].top);
        if (x > 2 && y > 0.35 * Math.min(rs[a].height, rs[b].height)) overlaps.push(`fig ${i + 1}: "${texts[a].textContent}" / "${texts[b].textContent}"`);
      }
    });
    const wideTables = [...document.querySelectorAll('.rd-table-wrap')].filter((t) => t.scrollWidth > t.clientWidth + 1).length;
    return {
      title: document.querySelector('h1')?.textContent,
      height: document.documentElement.scrollHeight,
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      figures: figs.length,
      figuresScrolling: scrolls,
      smallestText: Number.isFinite(smallest) ? Math.round(smallest * 10) / 10 : null,
      tablesScrolling: wideTables,
      overlaps,
    };
  });
  const file = `.shots/read-${route.replace(/[^a-z0-9]+/gi, '-')}-${w}.png`;
  await page.screenshot({ path: file, fullPage: true });
  if (errors.length) failed++;
  console.log(`${route} at ${w}: ${file}`);
  console.log('  ', JSON.stringify({ ...info, errors: errors.slice(0, 3) }));
  await page.close();
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
