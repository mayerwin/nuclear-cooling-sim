/* tools/captions.mjs - the caption that runs off its own box.
 *
 * The cutaway's wording changes with the plant's state, and no reviewer ever
 * sees every state, so a caption two words too long survives review and then
 * shows up on a phone. This drives the model through every combination of the
 * flags the captions read from, renders each one, and measures the text
 * against the box it sits in.
 *
 *   node tools/captions.mjs [url]
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelector('#startBtn').click());
await page.click('#viewCut');
await page.click('[data-cut="both"]');
await page.waitForTimeout(900);

const bad = await page.evaluate(() => {
  const st = window.__sim.cutStage;
  const out = [];
  const check = () => {
    st.fitCaptions();
    for (const c of st.circuits) for (const cell of c.cells) {
      if (!cell.isElement()) continue;
      const v = st.paper.findViewByModel(cell); if (!v) continue;
      const box = cell.size().width;
      for (const n of v.el.querySelectorAll('text')) {
        if (!n.textContent.trim()) continue;
        const w = n.getBBox().width;
        if (w > box - 6) out.push(`${cell.get('type')}  "${n.textContent}"  ${w.toFixed(0)} > ${box}`);
      }
    }
  };
  const P = window.__sim.plants;
  for (const rcp of [0, 1]) for (const rcic of [0, 1]) for (const aux of [0, 1])
    for (const grid of [0, 1]) for (const sink of ['turbine', 'pool', 'shell', 'none'])
      for (const pumpsOk of [0, 1]) {
        for (const pl of P) {
          Object.assign(pl.sys, { rcp, rcic, aux, grid, sink, diesel: 0, natCirc: 0.3,
            cmt: sink === 'pool' ? 1 : 0, gravity: 0, accum: 0 });
          pl.pumpsOk = !!pumpsOk;
        }
        st.update(1); check();
      }
  return [...new Set(out)];
});

console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'PASS  every caption fits its box');
if (errs.length) console.log(errs.join('\n'));
await browser.close();
process.exit(bad.length || errs.length ? 1 : 0);
