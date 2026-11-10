// Screenshot a page so you can check your work without a browser window.
//
//   npm run shot -- <structure-id>     rest state, plus the middle and last frame of every tour step
//   npm run shot -- home | compare     those pages
//   npm run shot -- <id> --mobile      same, at phone width
//
// Images land in .shots/. Console errors from the page are printed and make the script exit 1.
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'home';
const mobile = args.includes('--mobile');
const suffix = mobile ? '-mobile' : '';

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'],
});
const page = await browser.newPage();
await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2 } : { width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

mkdirSync('.shots', { recursive: true });
const snap = async (name, fullPage = false) => {
  await new Promise((r) => setTimeout(r, 150));
  const path = `.shots/${name}${suffix}.png`;
  await page.screenshot({ path, fullPage });
  console.log(path);
};

const route = target === 'home' ? '/' : target === 'compare' ? '/compare' : `/s/${target}`;
await page.goto(`${base}#${route}`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);

if (target === 'home' || target === 'compare') {
  await new Promise((r) => setTimeout(r, 1200));
  await snap(target, true);
} else {
  await page.waitForFunction(() => window.__dsv, { timeout: 8000 });
  await snap(`${target}-0-rest`);
  await snap(`${target}-0-page`, true);
  const tour = await page.evaluate(() => window.__dsv.tour);
  let n = 1;
  for (const [op, ...opArgs] of tour) {
    const frames = await page.evaluate((o, a) => window.__dsv.run(o, a), op, opArgs);
    const label = `${target}-${n}-${op}`;
    console.log(`${label}: ${frames} frames`);
    if (frames > 2) {
      await page.evaluate((i) => window.__dsv.seek(i), Math.floor(frames / 2));
      await snap(`${label}-mid`);
    }
    await page.evaluate((i) => window.__dsv.seek(i), frames - 1);
    await snap(`${label}-end`);
    n++;
  }
}

await browser.close();
await server.close();
if (errors.length) {
  console.error('\nPage errors:\n' + errors.join('\n'));
  process.exit(1);
}
