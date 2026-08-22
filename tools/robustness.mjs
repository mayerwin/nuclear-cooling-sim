/* tools/robustness.mjs - hammer the UI and look for anything that breaks.
 * Rapid scenario switches, view switches, resizes, resets, extreme viewports,
 * and a check that no simulation number has gone NaN or infinite. */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const errs = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector('#startBtn').click());

const sane = async (where) => {
  const bad = await page.evaluate(() => {
    const out = [];
    const check = (name, v) => { if (typeof v === 'number' && !isFinite(v)) out.push(name); };
    const s = window.__sim;
    check('sim.t', s.t); check('cam.zoom', s.cam.zoom); check('cam.x', s.cam.x);
    check('cutCam.zoom', s.cutCam.zoom); check('gloom', s.gloom);
    for (const p of s.plants) {
      for (const k of ['t', 'water', 'Tclad', 'Tcore', 'pRPV', 'level', 'h2', 'pCtmt',
        'Tctmt', 'coreDamage', 'meltFrac', 'releasedBq', 'releaseRate', 'coolingMargin',
        'irwst', 'pccwst', 'battery', 'zrLeft']) check(`${p.mode}.${k}`, p[k]);
      const c = p.consequences();
      for (const k in c) check(`${p.mode}.cons.${k}`, c[k]);
    }
    for (const q of s.fx.p) { check('fx.x', q.x); check('fx.z', q.z); check('fx.r', q.r); }
    return out;
  });
  if (bad.length) errs.push(`[${where}] non-finite: ${[...new Set(bad)].join(', ')}`);
};

// 1. rapid scenario switching
const ids = await page.evaluate(() => [...document.querySelectorAll('.scn')].map((_, i) => i));
for (let round = 0; round < 2; round++) {
  for (const i of ids) {
    await page.evaluate(k => document.querySelectorAll('.scn')[k].click(), i);
    await page.waitForTimeout(160);
  }
}
await sane('rapid scenario switching');

// 2. rapid view switching mid-accident
await page.evaluate(() => { window.__sim.run('tsunami'); window.__sim.speedIdx = 4; });
await page.waitForTimeout(6000);
for (let i = 0; i < 10; i++) {
  await page.click('#viewCut'); await page.waitForTimeout(120);
  await page.click('#viewSite'); await page.waitForTimeout(120);
}
await sane('rapid view switching');

// 3. resize storm, including degenerate shapes
for (const vp of [{ width: 320, height: 480 }, { width: 1920, height: 1080 },
{ width: 500, height: 300 }, { width: 380, height: 900 }, { width: 2400, height: 700 },
{ width: 1500, height: 900 }]) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(320);
  await sane(`resize ${vp.width}x${vp.height}`);
}

// 4. reset and toggles
await page.click('#btnReset'); await page.waitForTimeout(400);
await page.click('#tgSabotage'); await page.click('#tgZones'); await page.click('#tgExplain');
await page.waitForTimeout(300);
await page.click('#tgSabotage'); await page.click('#tgZones'); await page.click('#tgExplain');
await sane('reset + toggles');

// 5. every speed setting
for (let i = 0; i < 6; i++) {
  await page.evaluate(k => document.querySelectorAll('#speeds button')[k].click(), i);
  await page.waitForTimeout(400);
}
await sane('speed settings');

// 6. let a long run play out and confirm the particle pool stays bounded
await page.evaluate(() => {
  const s = window.__sim; s.run('total'); s.speedIdx = 4;
});
await page.waitForTimeout(30000);
const parts = await page.evaluate(() => window.__sim.fx.p.length);
if (parts > 1500) errs.push(`particle pool unbounded: ${parts}`);
await sane('long run');

// 7. reset must fully restore, and the clock must not run without an event
await page.click('#btnReset'); await page.waitForTimeout(600);
const after = await page.evaluate(() => {
  const s = window.__sim;
  return {
    t: Math.round(s.t), states: s.plants.map(p => p.state),
    dmg: s.plants.map(p => p.coreDamage), rel: s.plants.map(p => p.releasedBq),
    contam: s.world.contam.reduce((a, b) => a + b, 0),
    booms: s.plants.map(p => p.explosions)
  };
});
if (after.t !== 0 || after.dmg.some(d => d > 0) || after.rel.some(r => r > 0)
  || after.contam > 0.001 || after.booms.some(b => b > 0)) {
  errs.push('reset did not fully restore: ' + JSON.stringify(after));
}

console.log(`particles after long run: ${parts}`);
await browser.close();
if (errs.length) { console.log('FAILURES:\n' + [...new Set(errs)].join('\n')); process.exitCode = 1; }
else console.log('robustness: all checks passed');
