/* tools/captions.mjs - the caption that runs off its own box.
 *
 * The cutaway's wording changes with the plant's state, and no reviewer ever
 * sees every state, so a caption two words too long survives review and then
 * shows up on a phone. Canvas text is shrunk to fit at draw time; this drives
 * the model through every combination of the flags the captions read from and
 * fails if anything had to be shrunk past legibility.
 *
 *   node tools/captions.mjs [url]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});
const errs = [];
for (const [w, h, name] of [[1600, 950, 'desktop'], [390, 844, 'phone']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('#startBtn').click());
  await page.click('#viewCut');
  await page.waitForTimeout(900);

  const bad = await page.evaluate(async () => {
    const sim = window.__sim, mod = window.__cutaway;
    const out = [];
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    for (const rcp of [0, 1]) for (const rcic of [0, 1]) for (const aux of [0, 1]) {
      for (const grid of [0, 1]) for (const sink of ['turbine', 'pool', 'shell', 'none']) {
        for (const pumpsOk of [0, 1]) {
          for (const p of sim.plants) {
            Object.assign(p.sys, { rcp, rcic, aux, grid, sink, diesel: 0, natCirc: 0.3,
              cmt: sink === 'pool' ? 1 : 0, gravity: 0, accum: 0, battery: 0.5 });
            p.pumpsOk = !!pumpsOk;
          }
          await frame();
          for (const s of mod.overflowReport()) out.push(s);
        }
      }
    }
    return [...new Set(out)];
  });
  console.log(bad.length ? `FAIL (${name})\n` + bad.join('\n')
    : `PASS  every caption fits its box (${name})`);
  if (bad.length) errs.push('overflow');
  await page.close();
}
if (errs.length) console.log(errs.join('\n'));
await browser.close();
process.exit(errs.length ? 1 : 0);
