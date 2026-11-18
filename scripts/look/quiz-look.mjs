// node scripts/look/quiz-look.mjs <out dir> [design id]: a design's test (#/d/<id>/test) at 1440x900 and 390x844, full page:
// an unanswered question with an option picked, a right answer, a wrong answer, the later kinds (many, number) when the quiz
// has them, and the score with "Start again" asking to confirm. Also the design page's header with its "Test yourself" link.
// It answers the first five questions as: right, wrong, then the third and fourth however their kind allows, then wrong.
// Prints page errors and sideways scroll. Exits 1 on any page error.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const out = process.argv[2] ?? '.shots/quiz';
const id = process.argv[3] ?? 'web-crawler';
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null, fs: { strict: false } }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let errors = 0;
for (const [w, hgt] of [[1440, 900], [390, 844]]) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    errors++;
    console.log(`${w}: page error: ${e.message}`);
  });
  await page.setViewport({ width: w, height: hgt });
  await page.goto(`${base}#/d/${id}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await pause(500);
  await page.screenshot({ path: `${out}/${w}-design-header.png` });
  await page.goto(`${base}#/d/${id}/test`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await pause(300);
  const shot = async (name) => {
    await pause(150);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (sideways) console.log(`${w}: ${name}: page scrolls sideways`);
    await page.screenshot({ path: `${out}/${w}-${name}.png`, fullPage: true });
  };
  /** The script does not know which option is right: it tries each until the verdict is the one wanted. */
  const kind = () => page.evaluate(() => (document.querySelector('.dq-num') ? 'number' : document.querySelector('.dq-opt input[type=checkbox]') ? 'many' : 'one'));
  const answerChoice = async (want) => {
    // Pick an option, submit, read the verdict; if it is not what was wanted, clear the answer and try the next option.
    const n = await page.$$eval('.dq-opt input', (xs) => xs.length);
    const key = `dsv.quiz.${id}`;
    const qid = await page.evaluate(() => document.querySelector('.dq-opt input').name.slice(3));
    for (let i = 0; i < n; i++) {
      await (await page.$$('.dq-opt label'))[i].click();
      await page.click('.dq-submit');
      await pause(100);
      const v = await page.$eval('.dq-verdict', (e) => e.className);
      if (v.includes(want === 'right' ? 'is-right' : 'is-wrong')) return;
      // Not the wanted verdict: forget the answer and draw the question again from the strip.
      await page.evaluate((k, q) => {
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        delete s[q];
        localStorage.setItem(k, JSON.stringify(s));
      }, key, qid);
      const at = await page.$eval('.dq-cell[aria-current]', (e) => [...e.closest('ol').querySelectorAll('.dq-cell')].indexOf(e));
      await page.reload({ waitUntil: 'networkidle0' });
      await (await page.$$('.dq-cell'))[at].click();
      await pause(100);
    }
  };
  const next = async () => {
    await page.click('.dq-next');
    await pause(100);
  };

  // 1: unanswered, one option picked, then answered right.
  const k1 = await kind();
  await shot(`q1-${k1}-unanswered`);
  if (k1 !== 'number') {
    await (await page.$$('.dq-opt label'))[0].click();
    await shot(`q1-${k1}-selected`);
    await answerChoice('right');
    await shot(`q1-${k1}-right`);
  }
  await next();
  // 2: answered wrong.
  const k2 = await kind();
  await shot(`q2-${k2}-unanswered`);
  if (k2 !== 'number') {
    await answerChoice('wrong');
    await shot(`q2-${k2}-wrong`);
  }
  await next();
  // 3 and 4: whatever kind they are; a many gets one option (partly right or wrong), a number gets the right answer rounded.
  for (const n of [3, 4]) {
    const k = await kind();
    await shot(`q${n}-${k}-unanswered`);
    if (k === 'number') {
      await page.type('.dq-num', '12');
      await page.keyboard.press('Enter');
    } else {
      await (await page.$$('.dq-opt label'))[0].click();
      await page.keyboard.press('Enter');
    }
    await pause(100);
    await shot(`q${n}-${k}-answered`);
    await next();
  }
  // 5: wrong, then the score.
  if (await page.$('.dq-opt')) await answerChoice('wrong');
  await page.evaluate(() => document.querySelector('.dq-strip-end button').click());
  await shot('score');
  await page.click('.dq-again');
  await shot('score-confirm');
  await page.close();
}
await browser.close();
await server.close();
process.exit(errors ? 1 : 0);
