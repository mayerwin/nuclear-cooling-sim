/* tools/look.mjs - a close look at one thing.
 *   node tools/look.mjs <shot> [scenario] [seconds]
 * Parks the camera on a named target and screenshots it big, so the fluids can
 * actually be judged rather than guessed at.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const shot = process.argv[2] || 'loop';
const scen = process.argv[3] || '';
const secs = Number(process.argv[4] || 6);
const out = '/tmp/look';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'load' });
await page.waitForTimeout(5000);
await page.evaluate(() => document.querySelector('#startBtn')?.click());
await page.evaluate(() => document.querySelector('[data-view=plant]').click());
await page.waitForTimeout(1500);
// Software rendering runs at about a frame a second, so the clock is driven
// directly rather than by how many frames the box managed to draw: `secs` is
// how many minutes of plant time to reach.
if (scen) {
  await page.evaluate(([x, target]) => {
    const s = window.__sim;
    s.run(x); s.speedIdx = 4;
    for (let i = 0; i < target / 45; i++) s.update(0.05);
  }, [scen, secs * 60]);
  await page.waitForTimeout(2500);
}

const A = -38, B = 38;   // where the two units stand, matching main.js
const CAMS = {
  loop:   { t: [A + 0, 11, 0], d: 40, a: 1.16, e: 0.10 },
  pump:   { t: [A - 3.6, 10, 0], d: 22, a: 1.16, e: 0.10 },
  rpv:    { t: [A + 4.5, 11, 0], d: 30, a: 1.16, e: 0.08 },
  sg:     { t: [A - 8.5, 20, 0], d: 44, a: 1.16, e: 0.10 },
  steam:  { t: [A + 12, 22, 0], d: 44, a: 1.16, e: 0.10 },
  turbine:{ t: [A + 22, 6, 0], d: 40, a: 1.16, e: 0.14 },
  power:  { t: [A + 40, 8, 0], d: 30, a: 1.16, e: 0.12 },
  yard:   { t: [A - 22, 8, 0], d: 40, a: 1.16, e: 0.14 },
  unit:   { t: [A + 11, 16, 0], d: 96, a: 1.16, e: 0.16 },
  pool:   { t: [B + 4.5, 22, 0], d: 34, a: 1.16, e: 0.14 },
  prhr:   { t: [B + 2, 16, 0], d: 52, a: 1.16, e: 0.14 },
  passive:{ t: [B + 11, 16, 0], d: 96, a: 1.16, e: 0.16 },
  breach: { t: [A + 2, 14, 0], d: 56, a: 1.16, e: 0.12 },
  head:   { t: [A - 7.5, 12.5, 0], d: 22, a: 1.16, e: 0.10 },
  dome:   { t: [A - 8.5, 26, 0], d: 26, a: 1.16, e: 0.10 }
};

// The three shots the app itself frames: no camera override, just the button.
const FOCUS = { focusA: 'active', focusB: 'passive', focusAB: 'both' };
if (FOCUS[shot]) {
  await page.evaluate((f) => document.querySelector(`[data-focus=${f}]`).click(), FOCUS[shot]);
  await page.waitForTimeout(4000);
}
const c = CAMS[shot] || CAMS.loop;
if (!FOCUS[shot]) await page.evaluate((c) => {
  const s = window.__stage;
  s.want = null;
  s.controls.minDistance = 0.5;   // the app clamps to 40; a close look needs closer
  s.controls.target.set(c.t[0], c.t[1], c.t[2]);
  const dir = [Math.cos(c.a) * Math.cos(c.e), Math.sin(c.e), Math.sin(c.a) * Math.cos(c.e)];
  s.camera.position.set(c.t[0] + dir[0] * c.d, c.t[1] + dir[1] * c.d, c.t[2] + dir[2] * c.d);
  s.controls.update();
}, c);
if (process.env.NOBLOOM) await page.evaluate(() => { window.__stage.bloom.enabled = false; });
// Software rendering: a close, busy frame can take many seconds, and a
// screenshot taken before the first one lands comes back empty.
await page.waitForTimeout(Number(process.env.SETTLE || 9000));
await page.screenshot({ path: `${out}/${shot}${scen ? '-' + scen : ''}.png`, timeout: 180000 });
if (errs.length) console.log(errs.slice(0, 6).join('\n'));
console.log(`${out}/${shot}${scen ? '-' + scen : ''}.png`);
await browser.close();
