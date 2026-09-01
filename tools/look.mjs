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

// Given in UNIT-LOCAL coordinates and transformed in the page, so they stay
// correct however the units are placed or turned.
const CAMS = {
  loop:   { u: 0, t: [0, 11, 0], d: 40 },
  pump:   { u: 0, t: [-3.6, 10, 0], d: 20 },
  rpv:    { u: 0, t: [4.5, 11, 0], d: 28 },
  sg:     { u: 0, t: [-8.5, 20, 0], d: 40 },
  head:   { u: 0, t: [-8.5, 13, 0], d: 20 },
  dome:   { u: 0, t: [-8.5, 26, 0], d: 24 },
  outside:{ u: 0, t: [-6, 18, 0], d: 92, e: 0.18 },
  back:   { u: 0, t: [0, 16, 0], d: 96, e: 0.2, az: Math.PI },
  side:   { u: 0, t: [0, 16, 0], d: 88, e: 0.2, az: Math.PI * 0.62 },
  tank:   { u: 0, t: [-9, 3, 0], d: 26 },
  steam:  { u: 0, t: [8, 24, 0], d: 44 },
  turbine:{ u: 0, t: [21, 7, 0], d: 26 },
  cond:   { u: 0, t: [20.5, 3.0, 0], d: 40, e: 0.16 },
  sump:   { u: 0, t: [19.6, 2.2, 0], d: 17, e: 0.42 },
  bay:    { u: 0, t: [25, 0, -10], d: 30, e: 0.3 },
  power:  { u: 0, t: [25, 11, 0], d: 18 },
  unit:   { u: 0, t: [2, 15, 0], d: 84 },
  pool:   { u: 1, t: [4.5, 22, 0], d: 30 },
  prhr:   { u: 1, t: [2, 16, 0], d: 50 },
  passive:{ u: 1, t: [2, 15, 0], d: 84 },
  breach: { u: 0, t: [2, 14, 0], d: 54 }
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
  const u = window.__units[c.u || 0];
  u.root.updateWorldMatrix(true, false);
  const V = s.controls.target.constructor;
  const tgt = u.root.localToWorld(new V(c.t[0], c.t[1], c.t[2]));
  const az = (window.__CUT_AZ + (c.az || 0)), e = c.e == null ? 0.14 : c.e;
  s.want = null;
  s.controls.minDistance = 0.5;   // the app clamps to 40; a close look needs closer
  s.controls.target.copy(tgt);
  s.camera.position.set(
    tgt.x + Math.cos(az) * Math.cos(e) * c.d,
    tgt.y + Math.sin(e) * c.d,
    tgt.z + Math.sin(az) * Math.cos(e) * c.d);
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
