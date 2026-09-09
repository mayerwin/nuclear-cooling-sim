// Usage: EXPR='window.__units[0].legCw.T1' node tools/eval.mjs
// Boots the app into the plant view and prints the value of EXPR as JSON, so
// a number in the running model can be read instead of guessed at.
import { launch, URL } from './pw.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelector('#startBtn')?.click());
await page.evaluate(() => document.querySelector('[data-view=plant]').click());
await page.evaluate(() => document.querySelector('#helpOk')?.click());
await page.waitForTimeout(Number(process.env.SETTLE || 5000));
const v = await page.evaluate((src) => { try { return JSON.parse(JSON.stringify(eval(src))); } catch (e) { return 'ERR ' + e.message; } }, process.env.EXPR || 'null');
console.log(JSON.stringify(v), errs.length ? 'ERRORS ' + errs.join(' | ') : '');
await browser.close();
