/* tools/check.mjs - the gate.
 *   node tools/check.mjs [url] [outdir]
 * Boots the app, drives every scenario, and fails on any console or page
 * error. Writes a screenshot set for review.
 */
import { launch, TMP, URL } from './pw.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2] || URL;
const out = process.argv[3] || `${TMP}/check`;
mkdirSync(out, { recursive: true });
const errs = [];
const notes = [];
// The stamp must be current, or a returning visitor gets last week's modules.
{
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['tools/stamp.mjs', '--check'], { stdio: 'inherit' });
}
const browser = await launch();

async function open(w, h, mobile) {
  const page = await browser.newPage({
    viewport: { width: w, height: h }, deviceScaleFactor: 1,
    isMobile: !!mobile, hasTouch: !!mobile
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector('#startBtn')?.click());
  await page.waitForTimeout(2500);
  return page;
}
const readout = (page) => page.evaluate(() => {
  const s = window.__sim;
  const f = (p) => `${p.state} lvl${(p.level * 100) | 0}% T${(p.Tclad - 273) | 0}C`
    + ` dmg${(p.coreDamage * 100) | 0}% rel${(p.releasedBq / 1e15).toFixed(2)}PBq`;
  return `t=${Math.round(s.t)}s | A: ${f(s.active)} | B: ${f(s.passive)}`;
});

const page = await open(1600, 950);
await page.screenshot({ path: `${out}/00-site.png`, timeout: 120000 });
notes.push('00-site.png  idle');
await page.evaluate(() => document.querySelector('[data-view=plant]').click());
await page.waitForTimeout(3000);
for (const f of ['both', 'active', 'passive']) {
  await page.evaluate((x) => document.querySelector(`[data-focus=${x}]`).click(), f);
  // Software rendering is slow enough that the camera move and the caption
  // layout need several seconds of wall clock to settle.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${out}/00-${f}.png`, timeout: 120000 });
  notes.push(`00-${f}.png  idle`);
}
await page.evaluate(() => document.querySelector('[data-focus=both]').click());
await page.waitForTimeout(2500);
const RUNS = [['tsunami', 26], ['sbo', 22], ['loca', 20], ['tmi', 20],
  ['chernobyl', 14], ['uhs', 16], ['quake', 20], ['fire', 16], ['total', 24]];
for (const [id, secs] of RUNS) {
  // Software rendering runs at about a frame a second, so the clock is driven
  // directly rather than by how many frames the box managed to draw.
  await page.evaluate(([x, target]) => {
    const s = window.__sim;
    s.run(x); s.speedIdx = 4;
    for (let i = 0; i < target / 45; i++) s.update(0.05);
  }, [id, secs * 700]);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/${id}.png`, timeout: 120000 });
  notes.push(`${id}.png  ${await readout(page)}`);
}
await page.close();

const phone = await open(390, 844, true);
await phone.waitForTimeout(3000);
await phone.screenshot({ path: `${out}/phone.png`, timeout: 120000 });
notes.push('phone.png');
await phone.evaluate(() => document.querySelector('[data-view=plant]').click());
await phone.waitForTimeout(4000);
await phone.screenshot({ path: `${out}/phone-inside.png`, timeout: 120000 });
notes.push('phone-inside.png');
await phone.evaluate(() => document.querySelector('[data-focus=active]').click());
await phone.waitForTimeout(4000);
await phone.screenshot({ path: `${out}/phone-active.png`, timeout: 120000 });
notes.push('phone-active.png');
await phone.evaluate(() => document.getElementById('btnLeft').click());
await phone.waitForTimeout(800);
await phone.screenshot({ path: `${out}/phone-panel.png`, timeout: 120000 });
notes.push('phone-panel.png');
await phone.close();

await browser.close();
writeFileSync(`${out}/INDEX.txt`, notes.join('\n') + '\n');
console.log(notes.join('\n'));
if (errs.length) { console.log('\nERRORS:\n' + [...new Set(errs)].join('\n')); process.exitCode = 1; }
else console.log('\nno console or page errors');
