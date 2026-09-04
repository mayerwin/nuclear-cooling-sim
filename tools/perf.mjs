// Usage: node tools/perf.mjs   (PW_* as for the other tools; Q=?tune=0 etc. appends to the URL)
// Frame cost of the inside view at the tool's viewport: calls, triangles and
// the mean of 120 frames after settling.
import { launch, URL } from './pw.mjs';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL + (process.env.Q || ''), { waitUntil: 'load' });
await page.waitForTimeout(5000);
await page.evaluate(() => document.querySelector('#startBtn')?.click());
await page.evaluate(() => document.querySelector('[data-view=plant]').click());
await page.evaluate(() => document.querySelector('#helpOk')?.click());
await page.waitForTimeout(8000);
const r = await page.evaluate(() => new Promise((res) => {
  const st = window.__stage; const ts = []; let cmin = 1e9, cmax = 0, tmin = 1e9, tmax = 0;
  let last = performance.now();
  function tick() { const n = performance.now(); ts.push(n - last); last = n;
    const s = st.stats(); cmin = Math.min(cmin, s.calls); cmax = Math.max(cmax, s.calls); tmin = Math.min(tmin, s.tris); tmax = Math.max(tmax, s.tris);
    if (ts.length < 150) requestAnimationFrame(tick); else {
      const a = ts.slice(30); a.sort((x, y) => x - y);
      res({ mean: a.reduce((s, v) => s + v, 0) / a.length, median: a[a.length >> 1], p90: a[Math.floor(a.length * 0.9)],
        calls: [cmin, cmax], tris: [tmin, tmax], px: st.stats().px, gfx: localStorage.getItem('ncs.gfx') });
    } }
  requestAnimationFrame(tick);
}));
console.log(JSON.stringify(r), errs.length ? 'ERRORS ' + errs.join(' | ') : '');
await browser.close();
