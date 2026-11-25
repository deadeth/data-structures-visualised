// node scripts/look/practice-look.mjs <out dir> [practice id]
// Pairing practice pages at 1440x900 and 390x844, full page: the guide (#/p) and the fixture guide, then one page (the fixture in
// development by default) with practice mode off, with it on, and with practice mode off, one follow-up open and
// the first part's whole-file disclosure open. Then, as pictures of one section each: the first core stage, a stretch
// stage closed and with its "Show the code and the run" open, and the variant closed and open. Also the first view with
// the clock running and the bar in place part-way down the page; then the page's tutorial (#/p/<id>/guide), if it has
// one, full page and after a jump from its contents list. Prints page errors, whether the page scrolls sideways, code blocks and tables that
// scroll inside their frame, and the smallest text found. Exits 1 on any page error or sideways scroll.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? '.shots/practice';
const id = process.argv[3] ?? 'fixture-practice';
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

/** Facts about the page as drawn. */
const measure = (page) =>
  page.evaluate(() => {
    let smallest = Infinity;
    let where = '';
    const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || !el.getClientRects().length || el.closest('[hidden], .visually-hidden')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < smallest) {
        smallest = size;
        where = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}: "${n.textContent.trim().slice(0, 30)}"`;
      }
    }
    const scrolling = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).length;
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent,
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      codeScrolling: `${scrolling('.pp-pre')} of ${document.querySelectorAll('.pp-pre').length}`,
      tracesScrolling: scrolling('.pp-trace-wrap'),
      sketches: [...document.querySelectorAll('.pp-sketch-pre')].filter((e) => e.getClientRects().length).map((e) => `${parseFloat(getComputedStyle(e).fontSize)}px${e.scrollWidth > e.clientWidth + 1 ? ' scrolls' : ''}`).join(', ') || 'none shown',
      smallest: `${smallest}px (${where})`,
      bar: Math.round(document.querySelector('.pp-bar')?.getBoundingClientRect().height ?? 0),
    };
  });

for (const [w, hgt] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 1 });
  const shot = async (name, full = true) => {
    await pause(250);
    const info = await measure(page);
    if (info.pageScrolls) failed++;
    const file = `${out}/${w}-${name}.png`;
    await page.screenshot({ path: file, fullPage: full });
    console.log(`${w} ${name}: ${file}`);
    console.log('   ', JSON.stringify(info));
  };
  const open = async (route) => {
    await page.goto(`${base}#/${route}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await pause(300);
  };

  await open('p');
  await page.evaluate(() => {
    localStorage.removeItem('dsv.practice.hide');
    sessionStorage.clear();
  });
  await shot('guide');
  // In development, a guide with every block kind.
  await open('p/fixture-guide');
  await shot('guide-fixture');

  await open(`p/${id}`);
  await shot('page-off');

  await page.click('#pp-hide');
  await shot('page-on');
  // One reveal opened in practice mode.
  await page.click('.pp-part .pp-reveal');
  await shot('page-on-one-shown');
  await page.click('#pp-hide');

  await page.click('.pp-fu > summary');
  await page.click('.pp-whole > summary');
  await shot('page-open');

  // One section at a time: a core stage, then a stretch stage and the variant, closed and open.
  const shotEl = async (name, sel) => {
    const el = await page.$(sel);
    if (!el) return console.log(`${w} ${name}: no ${sel}`);
    await pause(250);
    const info = await measure(page);
    if (info.pageScrolls) failed++;
    const file = `${out}/${w}-${name}.png`;
    await el.screenshot({ path: file });
    console.log(`${w} ${name}: ${file}`);
    console.log('   ', JSON.stringify(info));
  };
  await shotEl('core-stage', '.pp-part.is-core');
  for (const kind of ['stretch', 'variant']) {
    const sel = `.pp-part.is-${kind}`;
    await shotEl(`${kind}-closed`, sel);
    if (await page.$(`${sel} .pp-more > summary`)) {
      await page.click(`${sel} .pp-more > summary`);
      await shotEl(`${kind}-open`, sel);
    }
  }

  // The clock running, then the first view part-way down with the bar stuck to the top.
  await page.evaluate(() => [...document.querySelectorAll('.pp-clock button')].find((b) => /Start/.test(b.textContent)).click());
  await pause(2200);
  await shot('clock-top', false);
  const part = await page.$eval('.pp-part:nth-of-type(2)', (e) => e.id.replace(/^pp-part-/, '')).catch(() => null);
  if (part) {
    await page.evaluate((h) => (location.hash = h), `#/p/${id}/${part}`);
    await pause(400);
    const where = await page.evaluate(() => {
      const h2 = document.querySelector('.pp-part:nth-of-type(2) h2').getBoundingClientRect();
      const bar = document.querySelector('.pp-bar').getBoundingClientRect();
      return { h2Top: Math.round(h2.top), barBottom: Math.round(bar.bottom), focused: document.activeElement?.tagName, clock: document.querySelector('.pp-time')?.textContent };
    });
    const strip = await page.evaluate(() => Math.round(document.querySelector('.pp-mini').getBoundingClientRect().bottom));
    const cover = Math.max(where.barBottom, strip);
    console.log(`   part address: ${JSON.stringify({ ...where, stripBottom: strip })}${where.h2Top < cover ? '  <- heading under the bar' : ''}`);
    await shot('part-view', false);
  }
  // A reload keeps the clock.
  await page.reload({ waitUntil: 'networkidle0' });
  await pause(400);
  console.log(`   after reload the clock reads ${await page.$eval('.pp-time', (e) => e.textContent)}`);

  // The tutorial (#/p/<id>/guide), when the page links one: full page, then a jump from its contents list.
  await open(`p/${id}`);
  if (await page.$('.pp-tut-link')) {
    await open(`p/${id}/guide`);
    await shot('tutorial');
    const codes = await page.evaluate(() => [...document.querySelectorAll('.pp-g .pp-pre')].map((e) => `${e.classList.contains('java') ? 'java' : 'bare'}${e.scrollWidth > e.clientWidth + 1 ? ' scrolls' : ''}`).join(', '));
    const h1s = await page.$$eval('h1', (l) => l.length);
    console.log(`   tutorial: ${h1s} h1; code blocks: ${codes}`);
    const links = await page.$$('.pp-g-toc a');
    if (links.length > 1) {
      await links[links.length - 1].click();
      await pause(400);
      const jump = await page.evaluate(() => {
        const n = location.hash.split('/').pop();
        const h2 = document.getElementById(`pp-g-h-${n}`);
        return { hash: location.hash, headingTop: Math.round(h2?.getBoundingClientRect().top ?? -1), focused: document.activeElement?.id, h1: document.querySelector('h1')?.textContent };
      });
      console.log(`   contents jump: ${JSON.stringify(jump)}`);
      await shot('tutorial-jump', false);
    }
  } else console.log(`   ${id} has no tutorial`);
  await open(`p/${id === 'fixture-practice' ? 'no-such-page' : 'fixture-practice-nope'}/guide`);
  console.log(`   tutorial of an unknown page: ${await page.$eval('h1', (e) => e.textContent)} | ${await page.title()}`);

  await open('p/no-such-page');
  console.log(`   unknown id: ${await page.$eval('h1', (e) => e.textContent)} | ${await page.title()}`);
  if (errors.length) {
    failed++;
    console.log(`   page errors: ${errors.slice(0, 5).join(' | ')}`);
  }
  await page.close();
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
