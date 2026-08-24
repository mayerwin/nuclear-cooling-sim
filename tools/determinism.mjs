/* tools/determinism.mjs - regression check for the "trees appear and disappear"
 * class of bug.
 *
 * Freeze the clock, the animation time and the camera, then render two frames
 * 2.5 s apart and diff them. Anything that changes is rendering
 * non-determinism: a Math.random() in a draw call, an unstable sort, or an
 * object flipping between a cached layer and a live list. The expected result
 * is exactly zero differing subpixels.
 *
 *   node tools/determinism.mjs [url]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(900);
await page.evaluate(() => { const b = document.querySelector('#startBtn'); if (b) b.click(); });

const grab = () => page.evaluate(() => {
  const c = document.getElementById('stage');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
  return out;
});

const shot = async () => (await page.screenshot({ type: 'png' }));

let bad = 0;
async function check(label, setup, usePage) {
  await page.evaluate(setup);
  await page.waitForTimeout(900);
  const a = usePage ? await shot() : await grab();
  await page.waitForTimeout(2600);
  const b = usePage ? await shot() : await grab();
  if (usePage) {
    const same = a.length === b.length && a.equals(b);
    if (!same) bad++;
    console.log(`${same ? 'PASS' : 'FAIL'}  ${label}: frames ${same ? 'identical' : 'differ'}`);
    return;
  }
  let diff = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 8) { diff++; if (d > max) max = d; }
  }
  const ok = diff === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${diff} subpixels differ (max ${max})`);
}

await check('site view, fully frozen', () => {
  const s = window.__sim;
  s.speedIdx = 0; s.cine = null;
  s.cam.snap(24, 24, 0.9);
  s.fx.clear(); s.fx.p.length = 0;
  s.views.forEach(v => { v.emit = () => { }; });
  s.update = () => { };
});
await page.click('#viewSite');
await page.click('#viewCut');
await check('cutaway view, fully frozen', () => {
  const s = window.__sim;
  s.speedIdx = 0; s.fitCut();
  setTimeout(() => { s.update = () => { }; }, 400);
}, true);

await browser.close();
if (bad) { console.log(`\n${bad} check(s) failed`); process.exitCode = 1; }
else console.log('\nrendering is deterministic');
