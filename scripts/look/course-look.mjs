// The course page at 1440x900 and 390x844, full page, into .shots/course-<route>-<state>-<width>.png.
// Usage: node scripts/look/course-look.mjs [module id] [--fresh]
// Shoots #/course, #/course/<module> (the first module by default) and the home page's course card, twice:
// with no progress, and with progress set in localStorage before load (a few items, a checkpoint and a rating ticked).
// --fresh shoots only the first. Prints page errors, sideways scroll and the progress bars' values.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const wanted = args.find((a) => !a.startsWith('--'));
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', '--force-prefers-reduced-motion'] });

// Read the course's ids from the page itself, so the script follows whatever course.ts holds.
const probe = await browser.newPage();
await probe.goto(`${base}#/course`, { waitUntil: 'networkidle0' });
const ids = await probe.evaluate(async () => {
  const m = await import('/src/course/index.ts');
  const c = await m.loadCourse();
  return c ? c.modules.map((x) => ({ id: x.id, items: x.items.map((i) => i.id), checkpoints: x.checkpoint.length })) : null;
});
await probe.close();
if (!ids) console.log('No course loaded: the page will say it is being written.');
const mod = wanted ?? ids?.[0]?.id ?? 'none';

/** Some progress: most of module 1, one item of module 2, one checkpoint and a rating. */
function progress() {
  if (!ids) return null;
  const stamp = (d) => `2026-11-${String(d).padStart(2, '0')}T09:30:00.000Z`;
  const items = {};
  const [m1, m2] = ids;
  m1.items.slice(0, Math.max(1, m1.items.length - 2)).forEach((i, k) => (items[`${m1.id}/${i}`] = { done: true, at: stamp(10 + k) }));
  if (m2) items[`${m2.id}/${m2.items[0]}`] = { done: true, at: stamp(15) };
  items['renamed-module/old-item'] = { done: true, at: stamp(1) };
  return { items, checkpoints: { [`${m1.id}/0`]: { done: true, at: stamp(14) } }, confidence: { [m1.id]: { level: 'shaky', at: stamp(14) } } };
}

const states = fresh ? [['fresh', null]] : [['fresh', null], ['ticked', progress()]];
let failed = 0;
for (const [state, data] of states) for (const [w, hgt] of [[1440, 900], [390, 844]]) for (const route of ['course', `course/${mod}`, '']) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.evaluateOnNewDocument((d) => {
    localStorage.removeItem('dsv.course');
    if (d) localStorage.setItem('dsv.course', JSON.stringify(d));
  }, data);
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 1 });
  await page.goto(`${base}#/${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((x) => setTimeout(x, 600));
  const info = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent,
    pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    bars: [...document.querySelectorAll('[role=progressbar]')].slice(0, 4).map((b) => b.getAttribute('aria-valuetext')),
    checkboxes: document.querySelectorAll('main input[type=checkbox]').length,
    checked: document.querySelectorAll('main input[type=checkbox]:checked').length,
    unlabelled: [...document.querySelectorAll('main input')].filter((i) => !i.labels?.length && !i.getAttribute('aria-label')).length,
  }));
  const name = route ? route.replace(/[^a-z0-9]+/gi, '-') : 'home';
  const file = `.shots/course-${name}-${state}-${w}.png`;
  // The home page: just its course card.
  if (!route) {
    const card = await page.$('.home-course');
    if (card) await card.screenshot({ path: file });
  } else await page.screenshot({ path: file, fullPage: true });
  if (errors.length || info.pageScrolls) failed++;
  console.log(`${route || 'home'} ${state} at ${w}: ${file}`);
  console.log('  ', JSON.stringify({ ...info, errors: errors.slice(0, 3) }));
  await page.close();
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
