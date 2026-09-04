// ---------------------------------------------------------------------------
// main.js - boot, input and the frame loop.
//
// Two views of one simulation: the island from above on a 2-D canvas, and the
// inside of the buildings in 3-D. Only one is on screen at a time.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Sim } from './sim.js?v=f7bec3ea79';
import { Renderer } from './site/renderer.js?v=f7bec3ea79';
import { unproject } from './site/iso.js?v=f7bec3ea79';
import { Stage } from './view/stage.js?v=f7bec3ea79';
import { Unit, CUT_AZ } from './view/unit.js?v=f7bec3ea79';
import { Labels } from './view/labels.js?v=f7bec3ea79';
import { UI } from './ui.js?v=f7bec3ea79';
import { initPhysics } from './machines.js?v=f7bec3ea79';
import { state } from './view/state.js?v=f7bec3ea79';
import { AutoQ } from './view/autoq.js?v=f7bec3ea79';
import { clamp } from './util.js?v=f7bec3ea79';

const SPAN = 29;
const siteCanvas = document.getElementById('site');
const host = document.getElementById('scene');
const labelHost = document.getElementById('labels');

try { await initPhysics(); } catch (e) { console.warn(e); }
const sim = new Sim(siteCanvas);
const renderer = new Renderer(siteCanvas, sim.world);

// A device with no WebGL2 cannot draw the inside view at all. The site view
// is plain canvas and always works, so the app degrades to that instead of
// dying on a black screen with a dead button.
const GL_OK = (() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); }
  catch (e) { return false; }
})();
let stage = null, units = [], labels = null, autoq = null;
if (!GL_OK) {
  const btn = document.querySelector('[data-view=plant]');
  btn.disabled = true;
  btn.title = 'This device has no WebGL2, so the inside view cannot be drawn.';
}

// NOTHING EXPENSIVE HAPPENS UNTIL SOMEONE ASKS FOR IT.
//
// Baking the terrain, building the ocean, compiling a WebGL scene of five
// hundred meshes and then running a frame loop over it are all things a tab
// sitting behind a welcome card has no business doing. A page that is open but
// not being used should cost nothing, so all of it waits here until the card
// is dismissed, and the frame loop does not start until the same moment.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  sim.world.bakeTerrain();
  sim.world.bakeOverlay();
  renderer.buildOcean();
  if (GL_OK) {
    stage = new Stage(host, labelHost);
    // The stations stand along the camera's screen-right axis for the CUT_AZ
    // heading, so in the side-by-side view both sit at the same depth and draw
    // the same size. Offsetting along plain world x put one behind the other.
    const RIGHT = { x: Math.sin(CUT_AZ), z: -Math.cos(CUT_AZ) };
    units = sim.plants.map((p, i) => new Unit(p, stage,
      (i === 0 ? -SPAN : SPAN) * RIGHT.x, (i === 0 ? -SPAN : SPAN) * RIGHT.z));
    for (const u of units) stage.scene.add(u.root);
    // A reset puts the plant back as built, wounds included.
    sim.onReset = () => { for (const u of units) u.reset(); };
    labels = new Labels(stage, units);
    stage.buildFlood(units.map((u) => [u.worldX, u.worldZ]));
    stage.buildSea(CUT_AZ);
    window.__units = units;
    window.__stage = stage;
    window.__labels = labels;
    // The first-run tuner: measures the real frame rate the first time the
    // inside view is drawn and takes options off until it is good enough.
    // A driven browser (the proof and gate tools, on a software renderer)
    // would have everything stripped off it, so the tuner stands down under
    // automation unless ?tune=1 asks for it, and ?tune=0 stands it down
    // anywhere.
    autoq = new AutoQ(stage, { target: 30 });
    const tune = new URLSearchParams(location.search).get('tune');
    autoq.enabled = tune === '1' || (tune !== '0' && !navigator.webdriver);
    if (tune !== '1') autoq.applySaved();
    window.__autoq = autoq;
    ui.bindStage(stage, autoq);
  }
  resize();
  sim.overview();
  last = performance.now();
  requestAnimationFrame(frame);
}
window.__boot = boot;

// How big the page actually is RIGHT NOW. On a phone this is not
// window.innerHeight and it is not what `position:fixed; inset:0` gives you:
// the address bar slides in and out, the visual viewport changes under the
// layout viewport, and no resize event need fire for it. A canvas sized to a
// stale height is stretched or squashed by the browser to fit its box, which
// is what makes the island look wrong the moment you move around on a handset.
function viewport() {
  const vv = window.visualViewport;
  return {
    w: Math.max(1, Math.round(vv ? vv.width : window.innerWidth)),
    h: Math.max(1, Math.round(vv ? vv.height : window.innerHeight))
  };
}
let applied = { w: 0, h: 0, dpr: 0 };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = viewport();
  applied = { w, h, dpr };
  // Every full-screen layer takes its height from here, so the canvas, the
  // WebGL host and the label layer can never disagree about how tall the page
  // is.
  document.documentElement.style.setProperty('--appH', h + 'px');
  // On a phone the 3-D view is the band between the toolbar and the log, not
  // the whole page. Both stations stand in a row eighty metres wide, so fitting
  // them across a portrait screen leaves two thirds of it empty grass and the
  // plant the size of a stamp. Give the view the space that is actually free
  // and the same fit fills it.
  const narrow = w < 700;
  const barH = document.getElementById('bar').getBoundingClientRect().height;
  const feedH = document.getElementById('feed').getBoundingClientRect().height;
  const sceneH = narrow ? Math.max(220, h - barH - feedH - 26) : h;
  document.documentElement.style.setProperty('--sceneTop', (narrow ? barH : 0) + 'px');
  document.documentElement.style.setProperty('--sceneH', sceneH + 'px');
  siteCanvas.width = Math.round(w * dpr);
  siteCanvas.height = Math.round(h * dpr);
  siteCanvas.style.width = w + 'px';
  siteCanvas.style.height = h + 'px';
  sim.cam.resize(siteCanvas.width, siteCanvas.height);
  renderer.topInset = narrow ? barH : 0;
  if (sim.view === 'site') sim.overview();
  if (stage) stage.resize(w, sceneH);
  if (labels) labels.invalidate();
  // Snapped, not eased. A resize is not something the viewer is watching
  // happen, and turning a phone from landscape back to portrait left the
  // camera drifting towards a framing it had not reached by the time anyone
  // looked at it.
  if (sim.focus) setFocus(sim.focus, true);
}
addEventListener('resize', resize);
addEventListener('orientationchange', resize);
if (window.visualViewport) {
  visualViewport.addEventListener('resize', resize);
  visualViewport.addEventListener('scroll', resize);
}
// And a belt-and-braces check once a frame, because the address bar can finish
// moving without telling anyone.
function syncSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = viewport();
  if (w !== applied.w || h !== applied.h || dpr !== applied.dpr) resize();
}

let firstFocus = true;

// How much of the window is actually free: the two panels sit over the scene,
// so framing to the full width puts the reactors underneath them.
function usable() {
  const w = window.innerWidth;
  const l = document.getElementById('left').getBoundingClientRect();
  const r = document.getElementById('right').getBoundingClientRect();
  const wide = w > 980;
  const free = wide ? Math.max(320, r.left - l.right - 24) : w - 24;
  const top = document.getElementById('bar').getBoundingClientRect().height;
  const bot = document.getElementById('feed').getBoundingClientRect().height;
  // On a phone the scene canvas is already only the free band, so all of it is
  // usable; taking the chrome off twice would frame it smaller again.
  if (!wide && w < 700) return { usableW: 0.98, usableH: 0.96 };
  const h = window.innerHeight;
  return {
    usableW: Math.min(1, free / w),
    usableH: Math.min(1, Math.max(0.4, (h - top - bot - 40) / h))
  };
}

function setFocus(f, snap) {
  if (!stage) return;
  sim.focus = f;
  const u = usable();
  // A phone is tall and narrow. Framing a wide row of buildings on it leaves
  // the plant in a thin band with sky above and grass below, so the camera
  // climbs and the frame closes in until the building fills the screen.
  const narrow = window.innerWidth < 700;
  // Only the station that is being looked at is drawn. Its neighbour standing
  // half in frame is scenery competing with the subject.
  units.forEach((x, i) => { x.root.visible = f === 'both' || (f === 'active') === (i === 0); });
  // The station is laid out in one plane and the frame is given in that plane's
  // own coordinates, so it means the same thing whichever way the model is
  // turned. The camera looks square on to it: what you get is an elevation.
  // The eight world corners of the frame, kept as points. Collapsed into a
  // world-axis box they measured a volume much larger than the station, because
  // the station is turned to face the cut.
  // On a phone the frame is drawn tighter round the machinery: the vent stack
  // stands eleven metres out to the left and thirty into the sky, and framing
  // for it on a portrait screen shrank the plant by a fifth to make room for
  // an empty corner.
  const X0F = narrow ? -13 : -23, X1F = narrow ? 32 : 34, Y1F = narrow ? 33 : 37;
  const corners = (u, x0, x1, y0, y1, zz) => {
    u.root.updateWorldMatrix(true, false);
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push(new THREE.Vector3(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? zz : -zz)
        .applyMatrix4(u.root.matrixWorld));
    }
    return out;
  };
  if (f === 'both') {
    stage.framePoints(
      [...corners(units[0], X0F, X1F, -4, Y1F, 12),
        ...corners(units[1], X0F, X1F, -4, Y1F, 12)],
      { azimuth: CUT_AZ, elev: narrow ? 0.24 : 0.22, snap: firstFocus || snap,
        fill: narrow ? 1.06 : 0.92, ...u });
  } else {
    stage.framePoints(corners(units[f === 'active' ? 0 : 1], X0F, X1F, -4, Y1F, 12),
      { azimuth: CUT_AZ, elev: narrow ? 0.2 : 0.18, snap: firstFocus || snap,
        fill: narrow ? 1.1 : 0.88, ...u });
  }
  firstFocus = false;
  labels.setFocus(f);
}
const ui = new UI(sim, {
  stage,
  focus: setFocus,
  // Resize on the way in: the scene host is display:none until this moment, so
  // until it is shown there is nothing to measure.
  view: (v) => { sim.setView(GL_OK ? v : 'site'); resize(); }
});
setFocus('both');
resize();

// ---- panning and zooming the island ----
// Every pointer down is tracked, not just the first. One finger drags. Two
// fingers drag by their midpoint and zoom by the distance between them, which
// is the only way to zoom the island on a phone: there is no wheel there. The
// old handler kept a single origin, so a second finger landing overwrote it
// and the map jumped to the far corner of the world.
const ptrs = new Map();
let gesture = null;

function anchor() {
  const pts = [...ptrs.values()];
  if (!pts.length) { gesture = null; return; }
  let cx = 0, cy = 0;
  for (const q of pts) { cx += q.x; cy += q.y; }
  cx /= pts.length; cy /= pts.length;
  const spread = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  gesture = { cx, cy, spread, camX: sim.cam.x, camY: sim.cam.y, zoom: sim.cam.zoom };
}

siteCanvas.addEventListener('pointerdown', (e) => {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Capture can be refused for a pointer the browser has already finished
  // with, and an exception here used to abandon the gesture half-built.
  try { siteCanvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  anchor();
});
siteCanvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p || !gesture) return;
  p.x = e.clientX; p.y = e.clientY;
  sim.cine = null;
  const pts = [...ptrs.values()];
  if (pts.length > 1) {
    const spread = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (gesture.spread > 12 && spread > 12) {
      sim.cam.targetZoom = sim.cam.zoom =
        clamp(gesture.zoom * (spread / gesture.spread), 0.32, 3.2);
    }
  }
  let cx = 0, cy = 0;
  for (const q of pts) { cx += q.x; cy += q.y; }
  cx /= pts.length; cy /= pts.length;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const d = unproject((cx - gesture.cx) * dpr / sim.cam.zoom,
    (cy - gesture.cy) * dpr / sim.cam.zoom);
  sim.cam.snap(clamp(gesture.camX - d.x, -10, 62), clamp(gesture.camY - d.y, -10, 62));
});
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
  siteCanvas.addEventListener(t, (e) => { ptrs.delete(e.pointerId); anchor(); });
}
siteCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  sim.cine = null;
  sim.cam.targetZoom = clamp(sim.cam.targetZoom * (e.deltaY > 0 ? 0.88 : 1.14), 0.32, 3.2);
}, { passive: false });

// On a phone the panels are drawers rather than columns, so they need a way in.
for (const [btn, panel] of [['btnLeft', 'left'], ['btnRight', 'right']]) {
  const b = document.getElementById(btn), el = document.getElementById(panel);
  b.addEventListener('click', () => {
    const open = !el.classList.contains('show');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
    document.querySelectorAll('.icon.mob').forEach((i) => i.classList.remove('on'));
    if (open) { el.classList.add('show'); b.classList.add('on'); }
  });
}

// ---- breaking pipes ----
// Click any pipe in the inside view and it ruptures, and the rupture is
// physics: the model loses whatever that pipe was doing, and the picture
// follows the model. This is the test bench the whole app exists for.
if (stage) {
  const caster = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let downAt = null;
  stage.renderer.domElement.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  stage.renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6 || sim.view !== 'plant') return;
    // From the canvas's own box, not the window's: on a phone the two are not
    // the same rectangle and every tap landed on the wrong pipe.
    const r = stage.renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1);
    caster.setFromCamera(ptr, stage.camera);
    const targets = [];
    for (const u of units) {
      if (!u.root.visible) continue;
      for (const q of u.pipes) {
        if (!q.kindBreak || q.broken) continue;
        q.casing.userData.pick = { u, q };
        targets.push(q.casing);
      }
    }
    const hits = caster.intersectObjects(targets, false);
    if (!hits.length) return;
    const { u, q } = hits[0].object.userData.pick;
    u.rupture(q, hits[0].point);
  });
}

// ---- moving the view ----
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if ('wasd'.includes(k)) { keys.add(k); e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

// WASD on the island as well as inside the buildings. It only ever moved the
// 3-D camera, so on the site view the keys did nothing at all. Same meaning in
// both places: A and D slide the view sideways, W and S move it up and down.
function nudgeSite(dt) {
  let sx = 0, sy = 0;
  if (keys.has('a')) sx -= 1;
  if (keys.has('d')) sx += 1;
  if (keys.has('w')) sy -= 1;
  if (keys.has('s')) sy += 1;
  if (!sx && !sy) return;
  // 700 crossed a third of the island in a second and hit the clamp; this is
  // about a screen every two seconds at any zoom, measured.
  const px = 320 * dt / sim.cam.zoom;
  const d = unproject(sx * px, sy * px);
  sim.cine = null;
  sim.cam.snap(clamp(sim.cam.x + d.x, -10, 62), clamp(sim.cam.y + d.y, -10, 62));
}

document.getElementById('btnView').addEventListener('click', () => {
  if (sim.view === 'site') { sim.overview(); return; }
  firstFocus = true;
  setFocus(sim.focus || 'both');
});

// How deep the water on the yard is, from what the plant says got past the
// wall. One place, so the frame loop and the inspection tools agree.
function floodDepthNow() {
  return Math.max(...sim.plants.map((p) => clamp((p.flooded - 5.7) * 0.9, 0, 7.6)));
}
window.__floodDepth = floodDepthNow;

let last = performance.now(), acc = 0;
function frame(now) {
  if (!booted) return;
  const dt = Math.min((now - last) / 1000, 0.06);
  last = now;
  syncSize();
  sim.update(dt);
  if (sim.view === 'plant' && stage) {
    for (const u of units) if (u.root.visible) u.update(state(u.plant), dt);
    // The wave clears the seawall by this much, and what gets past it stands
    // on the site: that is what drowns the diesels in the basement.
    // The flood sheet stands on the sea (-2.6), so what gets past the wall
    // has to climb that far before it is on the yard at all. A fourteen-metre
    // wave over a 5.7 m wall puts about five metres of water on the deck:
    // enough to drown the emergency tank and the pump beside it, which is the
    // whole point of the Fukushima story, and which at 0.42 it never reached.
    stage.setFlood(floodDepthNow(), dt);
    stage.nudge(keys, dt);
    stage.update(dt);
    labels.update();
    stage.render();
    autoq.tick();
  } else {
    nudgeSite(dt);
    renderer.draw(sim);
  }
  ui.tick(dt);
  acc += dt;
  if (acc > 0.22) { ui.update(); acc = 0; }
  requestAnimationFrame(frame);
}

sim.announce('Both units at 100% power. Grid connected, all systems normal.', 'ok');
window.__sim = sim;
window.__renderer = renderer;
window.__CUT_AZ = CUT_AZ;
// Handy for the inspection tools: pick a pixel and name what is under it.
window.__THREE = THREE;
