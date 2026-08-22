/* tools/shots.mjs - take a labelled set of framed screenshots for review.
 *   node tools/shots.mjs <url> <outdir> [scenario] [--views a,b,c]
 * Fails loudly on console/page errors: a canvas app fails silently otherwise. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const outdir = process.argv[3] || '/tmp/shots';
const scenario = process.argv[4] || 'none';
mkdirSync(outdir, { recursive: true });

const errs = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});

async function session(name, viewport, dpr, fn) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr });
  page.on('console', m => { if (m.type() === 'error') errs.push(`[${name}] console: ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const b = document.querySelector('#startBtn'); if (b) b.click(); });
  await fn(page);
  await page.close();
}

const shot = (page, file) => page.screenshot({ path: `${outdir}/${file}` });

await session('desktop', { width: 1600, height: 950 }, 1, async (page) => {
  if (scenario !== 'none') await page.evaluate(s => window.__sim.run(s), scenario);
  await page.waitForTimeout(1500);
  await shot(page, '01-overview.png');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(s.world.sites.active.x + 7, s.world.sites.active.y + 7, 1.7); });
  await page.waitForTimeout(900);
  await shot(page, '02-active-close.png');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(s.world.sites.passive.x + 7, s.world.sites.passive.y + 7, 1.7); });
  await page.waitForTimeout(900);
  await shot(page, '03-passive-close.png');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(34, 40, 1.4); });
  await page.waitForTimeout(900);
  await shot(page, '04-town.png');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.overview(); });
  await page.waitForTimeout(1200);
  await shot(page, '05-overview-again.png');
});

await session('mobile', { width: 390, height: 844 }, 2, async (page) => {
  if (scenario !== 'none') await page.evaluate(s => window.__sim.run(s), scenario);
  await page.waitForTimeout(1600);
  await shot(page, '06-mobile.png');
});

await browser.close();
if (errs.length) { console.log('ERRORS:\n' + [...new Set(errs)].join('\n')); process.exitCode = 1; }
else console.log('no console/page errors');
