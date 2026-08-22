/* tools/review.mjs - produce a labelled screenshot set for critical review.
 *   node tools/review.mjs [url] [outdir]
 * Exits non-zero on any console/page error. LOOK AT THE SCREENSHOTS:
 * occlusion, popping, label collisions and plates on empty ground raise nothing.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const out = process.argv[3] || '/tmp/review';
mkdirSync(out, { recursive: true });

const errs = [];
const notes = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});

async function open(viewport, dpr, mobile) {
  const page = await browser.newPage({
    viewport, deviceScaleFactor: dpr, isMobile: !!mobile, hasTouch: !!mobile
  });
  page.on('console', m => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const b = document.querySelector('#startBtn'); if (b) b.click(); });
  return page;
}
const state = (page) => page.evaluate(() => {
  const s = window.__sim, a = s.active, b = s.passive;
  const f = p => `${p.state} lvl${(p.level * 100) | 0}% T${(p.Tclad - 273) | 0}C dmg${(p.coreDamage * 100) | 0}% H2 ${(p.h2 + p.h2Building) | 0}kg pC${p.pCtmt.toFixed(2)} rel${(p.releasedBq / 1e15).toFixed(2)}PBq INES${p.ines()} boom${p.explosions}`;
  return `t=${Math.round(s.t)}s view=${s.view} | A: ${f(a)} | B: ${f(b)}`;
});
async function snap(page, name, label) {
  await page.screenshot({ path: `${out}/${name}.png` });
  notes.push(`${name}.png  ${label}  ${await state(page)}`);
}

// ---------- 1. desktop site, idle ----------
{
  const page = await open({ width: 1600, height: 950 }, 1);
  await page.waitForTimeout(1200);
  await snap(page, '01-site-overview', 'site, idle, default framing');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(s.world.sites.active.x + 7, s.world.sites.active.y + 7, 1.7); });
  await page.waitForTimeout(800);
  await snap(page, '02-site-active-close', 'active station close up');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(s.world.sites.passive.x + 7, s.world.sites.passive.y + 7, 1.7); });
  await page.waitForTimeout(800);
  await snap(page, '03-site-passive-close', 'passive station close up');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(33, 39, 1.5); });
  await page.waitForTimeout(800);
  await snap(page, '04-site-town', 'the town and farmland');
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(12, 12, 1.0); });
  await page.waitForTimeout(800);
  await snap(page, '05-site-coast', 'the coastline and intakes');
  // hold still for 3 s: anything that pops or shimmers shows up between these two
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(24, 24, 0.9); });
  await page.waitForTimeout(600);
  await snap(page, '06-site-hold-a', 'static camera, frame A');
  await page.waitForTimeout(2500);
  await snap(page, '07-site-hold-b', 'static camera, frame B (compare with A: nothing may appear or vanish)');
  await page.close();
}

// ---------- 2. desktop cutaway, idle ----------
{
  const page = await open({ width: 1600, height: 950 }, 1);
  await page.click('#viewCut');
  await page.waitForTimeout(1400);
  await snap(page, '08-cut-both', 'cutaway, both sections, normal operation');
  await page.evaluate(() => { const s = window.__sim; s.cutFocus = 'active'; s.fitCut(true); });
  await page.waitForTimeout(900);
  await snap(page, '09-cut-active', 'cutaway, active section only');
  await page.evaluate(() => { const s = window.__sim; s.cutFocus = 'passive'; s.fitCut(true); });
  await page.waitForTimeout(900);
  await snap(page, '10-cut-passive', 'cutaway, passive section only');
  await page.close();
}

// ---------- 3. tsunami, both views, three stages ----------
{
  const page = await open({ width: 1600, height: 950 }, 1);
  await page.evaluate(() => { window.__sim.run('tsunami'); });
  await page.waitForTimeout(7000);
  await snap(page, '11-tsunami-wave', 'the wave sweeping the site');
  await page.evaluate(() => { window.__sim.speedIdx = 4; });
  await page.waitForTimeout(33000);
  await snap(page, '12-tsunami-uncovering', 'core uncovering on the active unit');
  await page.click('#viewCut');
  await page.waitForTimeout(1200);
  await snap(page, '13-tsunami-cut-mid', 'cutaway during the same moment');
  await page.waitForTimeout(28000);
  await snap(page, '14-tsunami-cut-late', 'cutaway after core damage');
  await page.click('#viewSite');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.overview(); });
  await page.waitForTimeout(1500);
  await snap(page, '15-tsunami-site-late', 'site after the release: plume, contamination, zones');
  await page.close();
}

// ---------- 4. other scenarios in cutaway ----------
for (const [id, secs, n] of [['loca', 22, '16-loca-cut'], ['tmi', 26, '17-tmi-cut'], ['chernobyl', 12, '18-chernobyl-cut']]) {
  const page = await open({ width: 1600, height: 950 }, 1);
  await page.click('#viewCut');
  await page.evaluate(s => { window.__sim.run(s); window.__sim.speedIdx = 4; }, id);
  await page.waitForTimeout(secs * 1000);
  await snap(page, n, `${id} in the cutaway`);
  await page.close();
}

// ---------- 5. mobile ----------
{
  const page = await open({ width: 390, height: 844 }, 2, true);
  await page.waitForTimeout(1400);
  await snap(page, '19-mobile-site', 'phone, site view');
  await page.click('#viewCut');
  await page.waitForTimeout(1400);
  await snap(page, '20-mobile-cut', 'phone, cutaway');
  await page.evaluate(() => document.querySelector('#mobileTabs button[data-open=right]').click());
  await page.waitForTimeout(700);
  await snap(page, '21-mobile-telemetry', 'phone, telemetry sheet open');
  await page.close();
}

// ---------- 6. retina desktop: label placement must not drift ----------
{
  const page = await open({ width: 1400, height: 900 }, 2);
  await page.evaluate(() => { const s = window.__sim; s.cine = null; s.cam.snap(s.world.sites.active.x + 7, s.world.sites.active.y + 7, 1.5); });
  await page.waitForTimeout(1000);
  await snap(page, '22-retina-site', 'dpr 2: label plates must sit on their anchors');
  await page.click('#viewCut');
  await page.waitForTimeout(1200);
  await snap(page, '23-retina-cut', 'dpr 2 cutaway');
  await page.close();
}

// ---------- 7. the falsification toggle ----------
{
  const page = await open({ width: 1600, height: 950 }, 1);
  await page.click('#tgSabotage');
  await page.click('#viewCut');
  await page.evaluate(() => { window.__sim.run('sbo'); window.__sim.speedIdx = 4; });
  await page.waitForTimeout(40000);
  await snap(page, '24-sabotage-cut', 'passive systems disabled: BOTH units must fail');
  await page.close();
}

await browser.close();
writeFileSync(`${out}/INDEX.txt`, notes.join('\n') + '\n');
console.log(notes.join('\n'));
if (errs.length) { console.log('\nERRORS:\n' + [...new Set(errs)].join('\n')); process.exitCode = 1; }
else console.log('\nno console or page errors');
