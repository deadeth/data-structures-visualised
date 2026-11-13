import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-gpu', ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : [])] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('requestfailed', (r) => errs.push('FAILED ' + r.url().slice(-60)));
await page.setViewport({ width: 1920, height: 1080 });
for (const id of ['merge-sort', 'binary-search', 'quicksort', 'insertion-sort', 'merge-lists', 'quickselect']) {
  try {
    await page.goto(`https://deadeth.github.io/data-structures-visualised/#/s/${id}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise((x) => setTimeout(x, 1500));
    const before = await page.evaluate(() => ({ h1: document.querySelector('h1')?.textContent, codeBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Code') }));
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Code'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });
    await new Promise((x) => setTimeout(x, 800));
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^(Sort|Find|Merge two|K-th|Insert next)/.test(b.textContent.trim()))?.click()); await new Promise((x) => setTimeout(x, 1500)); if (id === 'quicksort') await page.screenshot({ path: '.shots/live-quicksort.png' });
    const after = await page.evaluate(() => ({ lit: document.querySelectorAll('.code-panel .live, .code-panel .on, .code-panel [class*="live"]').length, lines: document.querySelectorAll('.code-panel pre, .code-panel code, .code-line').length, text: (document.querySelector('.code-panel')?.textContent ?? '').slice(0, 80) }));
    console.log(id, JSON.stringify(before), JSON.stringify(after));
  } catch (e) { console.log(id, 'ERR', String(e).slice(0, 120)); }
}
console.log('errors', errs.slice(0, 5));
await browser.close();
