// Checks the tour narration in a browser: node scripts/look/audio-look.mjs [main|small-first|both] [--phone] [--still]
// Plays the web crawler's tour with audio on and asserts, from the page, which clip plays and when the step moves on;
// checks that a wrong manifest hash plays nothing and that no sound starts without a gesture under Chrome's default
// autoplay policy; screenshots the tour controls with the Audio button off and on into .shots/audio-*.png.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const which = process.argv[2] ?? 'both';
const phone = process.argv.includes('--phone');
/** With reduced motion: nothing moves, and the narration must work the same. */
const still = process.argv.includes('--still');
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const chrome = (extra = []) => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', ...(still ? ['--force-prefers-reduced-motion'] : []), ...extra] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const size = phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900, deviceScaleFactor: 1 };
const tag = phone ? '390' : '1440';

/** What the page is doing: the step on show and the audio element's state. */
const state = (page) =>
  page.evaluate(() => {
    const a = document.querySelector('audio.hld-audio-el');
    const c = document.querySelector('.hld-count-long')?.textContent ?? '';
    return { step: Number(c.match(/Step (\d+)/)?.[1] ?? 0), src: a?.getAttribute('src') ?? '', paused: a ? a.paused : true, t: a?.currentTime ?? 0, dur: a?.duration ?? 0, pressed: document.querySelector('.hld-audio')?.getAttribute('aria-pressed') };
  });
const click = (page, sel) => page.$eval(sel, (b) => b.scrollIntoView({ block: 'center' })).then(() => page.click(sel));

async function mechanics(story) {
  const route = story === 'main' ? '#/d/web-crawler' : `#/d/web-crawler/s/${story}`;
  const dir = story === 'main' ? 'main' : story;
  const browser = await chrome(['--autoplay-policy=no-user-gesture-required']);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport(size);
  await page.evaluateOnNewDocument(() => localStorage.removeItem('dsv.audio'));
  await page.goto(`${base}${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  let s = await state(page);
  check(s.pressed === 'false', `${story}: Audio button shown, off by default`);
  await page.$eval('.hld-transport', (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await (await page.$('.hld-transport')).screenshot({ path: `.shots/audio-${story}-controls-off-${tag}.png` });
  await click(page, '.hld-audio');
  s = await state(page);
  check(s.pressed === 'true' && s.paused, `${story}: turned on off the tour, no sound yet`);
  check(await page.evaluate(() => localStorage.getItem('dsv.audio') === 'on'), `${story}: remembered in localStorage`);
  await click(page, '.hld-play');
  await sleep(1500);
  s = await state(page);
  check(s.step === 1 && s.src.endsWith(`audio/web-crawler/${dir}/1.mp3`) && !s.paused, `${story}: Play plays step 1's clip (${s.src}, paused=${s.paused})`);
  await (await page.$('.hld-transport')).screenshot({ path: `.shots/audio-${story}-controls-on-${tag}.png` });
  // The dwell for a step is 3.5 to 11 seconds; the clips are much longer. Past the dwell, the step must not have moved.
  await sleep(13000);
  s = await state(page);
  check(s.step === 1 && !s.paused && s.t > 10, `${story}: after the dwell, still on step 1 while its clip plays (t=${s.t.toFixed(1)} of ${s.dur.toFixed(1)})`);
  await click(page, '.hld-play');
  await sleep(500);
  const t0 = (await state(page)).t;
  await sleep(1000);
  s = await state(page);
  check(s.paused && Math.abs(s.t - t0) < 0.05, `${story}: Pause pauses the clip`);
  await click(page, '.hld-play');
  await sleep(1000);
  s = await state(page);
  check(!s.paused && s.t > t0 && s.step === 1, `${story}: Play resumes the clip where it was (${t0.toFixed(1)} to ${s.t.toFixed(1)})`);
  // Near the end: the step moves on once the clip ends, after a short gap.
  await page.evaluate(() => {
    const a = document.querySelector('audio.hld-audio-el');
    a.currentTime = a.duration - 1;
  });
  await sleep(700);
  s = await state(page);
  check(s.step === 1, `${story}: not moved on before the clip ends`);
  // The step moves on when both its dwell (which starts once the token's trip ends) and its clip are over, then 400 ms.
  const ends = await page.evaluate(() => new Promise((r) => document.querySelector('audio.hld-audio-el').addEventListener('ended', () => r(performance.now()), { once: true })));
  let moved = 0;
  for (let k = 0; k < 120 && !moved; k++) {
    await sleep(250);
    if ((await state(page)).step === 2) moved = await page.evaluate(() => performance.now());
  }
  s = await state(page);
  check(moved && moved - ends >= 400, `${story}: moved on ${moved ? ((moved - ends) / 1000).toFixed(1) : '(never)'} s after the clip ended (at least 0.4 s; longer when the dwell was still running)`);
  check(s.step === 2 && s.src.endsWith(`/${dir}/2.mp3`) && !s.paused, `${story}: step 2's clip plays (${s.src})`);
  // Previous, then Next: each switches the clip and pauses the tour.
  await click(page, 'button[aria-label="Previous step"]');
  await sleep(800);
  s = await state(page);
  check(s.step === 1 && s.src.endsWith(`/${dir}/1.mp3`) && !s.paused && s.t < 3, `${story}: Previous plays step 1's clip from the start`);
  await click(page, 'button[aria-label="Next step"]');
  await sleep(800);
  s = await state(page);
  check(s.step === 2 && s.src.endsWith(`/${dir}/2.mp3`) && !s.paused, `${story}: Next switches to step 2's clip`);
  // Audio off mid-clip: it stops.
  await click(page, '.hld-audio');
  await sleep(500);
  s = await state(page);
  check(s.pressed === 'false' && s.paused, `${story}: turning audio off stops the clip`);
  // Off, the tour runs on its dwell: play, and step 2 moves on by itself.
  await click(page, '.hld-play');
  await sleep(14000);
  s = await state(page);
  check(s.step >= 3 && s.paused, `${story}: with audio off the tour advances on its dwell alone (now step ${s.step})`);
  // Leaving the tour stops sound.
  await click(page, '.hld-audio');
  await sleep(800);
  s = await state(page);
  check(!s.paused, `${story}: turning audio on during the tour reads the step on show`);
  await click(page, '.hld-quiet');
  await sleep(500);
  s = await state(page);
  check(s.paused, `${story}: leaving the tour stops the clip`);
  check(errors.length === 0, `${story}: no page errors ${errors.slice(0, 2).join(' | ')}`);
  await browser.close();
}

async function wrongHash() {
  const browser = await chrome(['--autoplay-policy=no-user-gesture-required']);
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (!req.url().includes('narration-manifest.ts')) return req.continue();
    const res = await fetch(req.url());
    const body = (await res.text()).replace(/"[0-9a-f]{8}"/, '"deadbeef"');
    req.respond({ status: 200, contentType: 'text/javascript', body });
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('dsv.audio', 'on'));
  await page.goto(`${base}#/d/web-crawler`, { waitUntil: 'networkidle0' });
  await click(page, '.hld-play');
  await sleep(1500);
  let s = await state(page);
  check(s.step === 1 && (s.paused || !s.src), `wrong hash on step 1: no clip plays (src=${s.src || 'none'})`);
  await click(page, 'button[aria-label="Next step"]');
  await sleep(1000);
  s = await state(page);
  check(s.step === 2 && !s.paused && s.src.endsWith('/main/2.mp3'), 'step 2, whose hash is right, still plays');
  await browser.close();
}

async function noGesture() {
  const browser = await chrome();
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.evaluateOnNewDocument(() => localStorage.setItem('dsv.audio', 'on'));
  await page.goto(`${base}#/d/web-crawler/t/1`, { waitUntil: 'networkidle0' });
  await sleep(2500);
  let s = await state(page);
  check(s.step === 1 && s.pressed === 'true' && s.paused && !s.src, `default autoplay policy, step address with audio remembered on: no sound (src=${s.src || 'none'})`);
  await click(page, '.hld-play');
  await sleep(1500);
  s = await state(page);
  check(!s.paused && s.src.endsWith('/main/1.mp3'), 'then Play (a gesture) starts step 1\'s clip');
  await browser.close();
}

async function noAudioPages() {
  const browser = await chrome();
  const page = await browser.newPage();
  await page.setViewport(size);
  await page.goto(`${base}#/d/ledger`, { waitUntil: 'networkidle0' });
  check(!(await page.$('.hld-audio')) && !(await page.$('audio')), 'ledger: no Audio button, no audio element');
  await browser.close();
}

if (which === 'main' || which === 'both') await mechanics('main');
if (which === 'small-first' || which === 'both') await mechanics('small-first');
if (which === 'main' || which === 'both') {
  await wrongHash();
  await noGesture();
  await noAudioPages();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await server.close();
process.exit(failures ? 1 : 0);
