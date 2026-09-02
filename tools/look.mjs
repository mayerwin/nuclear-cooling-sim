/* tools/look.mjs - a close look at one thing.
 *   node tools/look.mjs <shot> [scenario] [seconds]
 * Parks the camera on a named target and screenshots it big, so the fluids can
 * actually be judged rather than guessed at.
 */
import { launch, TMP, URL } from './pw.mjs';
import { mkdirSync } from 'node:fs';

const shot = process.argv[2] || 'loop';
const scen = process.argv[3] || '';
const secs = Number(process.argv[4] || 6);
const out = `${TMP}/look`;
mkdirSync(out, { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(5000);
await page.evaluate(() => document.querySelector('#startBtn')?.click());
await page.evaluate(() => document.querySelector('[data-view=plant]').click());
// The help card covers the middle of the frame, which is where the thing
// being looked at usually is.
await page.evaluate(() => document.querySelector('#helpOk')?.click());
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
  // The flood sheet rises in wall time; a tool that just drove the clock
  // forward by an hour puts it where the plant says it is.
  await page.evaluate(() => {
    if (window.__floodDepth && window.__stage) window.__stage.setFlood(window.__floodDepth(), 10);
  });
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
  turbine:{ u: 0, t: [22.6, 6.8, 0], d: 31 },
  cond:   { u: 0, t: [23.9, 3.0, 0], d: 26, e: 0.16 },
  sump:   { u: 0, t: [23.9, 2.2, 0], d: 14, e: 0.42 },
  pool2:  { u: 0, t: [23.9, 2.0, 0], d: 13, e: 0.85 },
  bay:    { u: 0, t: [25, 0, -10], d: 30, e: 0.3 },
  power:  { u: 0, t: [25, 11, 0], d: 18 },
  unit:   { u: 0, t: [2, 15, 0], d: 84 },
  pool:   { u: 1, t: [4.5, 22, 0], d: 30 },
  prhr:   { u: 1, t: [2, 16, 0], d: 50 },
  passive:{ u: 1, t: [2, 15, 0], d: 84 },
  breach: { u: 0, t: [2, 14, 0], d: 54 },
  // the breached wall from outside, with sky above it for the smoke
  breachsky: { u: 0, t: [-9, 26, -3], d: 130, e: 0.14, az: Math.PI * 0.86 }
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
// REFRACT=1 turns real refraction on, so the settings panel's expensive path
// can be looked at and kept honest.
if (process.env.REFRACT) await page.evaluate(() => { window.__stage.setQuality('refraction', true); });
if (process.env.NOBLOOM) await page.evaluate(() => { window.__stage.bloom.enabled = false; });
// Software rendering: a close, busy frame can take many seconds, and a
// screenshot taken before the first one lands comes back empty.
await page.waitForTimeout(Number(process.env.SETTLE || 9000));
// PICK=x,y (fractions of the viewport) reports what is actually under that
// point, so a shape in a screenshot can be named instead of guessed at.
if (process.env.PICK) {
  const [px, py] = process.env.PICK.split(',').map(Number);
  const hits = await page.evaluate(([px, py]) => {
    const s = window.__stage, T = window.__THREE;
    const rc = new T.Raycaster();
    // Against the canvas, not the page: the scene sits under a toolbar and
    // over a ticker, so page fractions and clip coordinates are not the same.
    const r = s.renderer.domElement.getBoundingClientRect();
    const cx = (px * window.innerWidth - r.left) / r.width;
    const cy = (py * window.innerHeight - r.top) / r.height;
    rc.setFromCamera(new T.Vector2(cx * 2 - 1, -(cy * 2 - 1)), s.camera);
    // Only what is actually drawn there: a hit behind a clipping plane, or on a
    // material too faint to see, is not what is in the picture.
    const kept = rc.intersectObjects(s.scene.children, true).filter((h) => {
      const m = h.object.material;
      if (!m || m.opacity < 0.25 || m.visible === false) return false;
      // Three keeps the side of a clipping plane with a NEGATIVE signed
      // distance, and discards the positive side.
      const pls = m.clippingPlanes || [];
      if (pls.length) {
        const cut = pls.map((pl) => pl.distanceToPoint(h.point) > 0);
        if (m.clipIntersection ? cut.every(Boolean) : cut.some(Boolean)) return false;
      }
      return true;
    });
    return kept.slice(0, 6).map((h) => {
      const o = h.object, g = o.geometry;
      g.computeBoundingBox();
      const sz = g.boundingBox.getSize(new T.Vector3());
      return [g.type, o.name || '(unnamed)', +h.distance.toFixed(1),
        [+o.position.x.toFixed(1), +o.position.y.toFixed(1), +o.position.z.toFixed(1)],
        [+sz.x.toFixed(1), +sz.y.toFixed(1), +sz.z.toFixed(1)],
        o.material.type, o.material.color && '#' + o.material.color.getHexString(),
        'side' + o.material.side];
    });
  }, [px, py]);
  for (const h of hits) console.log(JSON.stringify(h));
}
await page.screenshot({ path: `${out}/${shot}${scen ? '-' + scen : ''}.png`, timeout: 180000 });
if (errs.length) console.log(errs.slice(0, 6).join('\n'));
console.log(`${out}/${shot}${scen ? '-' + scen : ''}.png`);
await browser.close();
