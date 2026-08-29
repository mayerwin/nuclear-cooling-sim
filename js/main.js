// ---------------------------------------------------------------------------
// main.js - boot, input and the frame loop.
//
// Two views of one simulation: the island from above on a 2-D canvas, and the
// inside of the buildings in 3-D. Only one is on screen at a time.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Sim } from './sim.js?v=cbd6bb0a1b';
import { Renderer } from './site/renderer.js?v=cbd6bb0a1b';
import { unproject } from './site/iso.js?v=cbd6bb0a1b';
import { Stage } from './view/stage.js?v=cbd6bb0a1b';
import { Unit, CUT_AZ } from './view/unit.js?v=cbd6bb0a1b';
import { Labels } from './view/labels.js?v=cbd6bb0a1b';
import { UI } from './ui.js?v=cbd6bb0a1b';
import { initPhysics } from './machines.js?v=cbd6bb0a1b';
import { state } from './view/state.js?v=cbd6bb0a1b';
import { clamp } from './util.js?v=cbd6bb0a1b';

const SPAN = 29;
const siteCanvas = document.getElementById('site');
const host = document.getElementById('scene');
const labelHost = document.getElementById('labels');

try { await initPhysics(); } catch (e) { console.warn(e); }
const sim = new Sim(siteCanvas);
sim.world.bakeTerrain();
sim.world.bakeOverlay();
const renderer = new Renderer(siteCanvas, sim.world);
renderer.buildOcean();

// A device with no WebGL2 cannot draw the inside view at all. The site view
// is plain canvas and always works, so the app degrades to that instead of
// dying on a black screen with a dead button.
const GL_OK = (() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); }
  catch (e) { return false; }
})();
let stage = null, units = [], labels = null;
if (GL_OK) {
  stage = new Stage(host, labelHost);
  // The stations stand along the camera's screen-right axis for the CUT_AZ
  // heading, so in the side-by-side view both sit at the same depth and draw
  // the same size. Offsetting along plain world x put one behind the other.
  const RIGHT = { x: Math.sin(CUT_AZ), z: -Math.cos(CUT_AZ) };
  units = sim.plants.map((p, i) => new Unit(p, stage,
    (i === 0 ? -SPAN : SPAN) * RIGHT.x, (i === 0 ? -SPAN : SPAN) * RIGHT.z));
  for (const u of units) stage.scene.add(u.root);
  labels = new Labels(stage, units);
  stage.buildFlood(units.map((u) => [u.worldX, u.worldZ]));
  stage.buildSea(CUT_AZ);
} else {
  const b = document.querySelector('[data-view=plant]');
  b.disabled = true;
  b.title = 'This device has no WebGL2, so the inside view cannot be drawn.';
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  siteCanvas.width = Math.floor(window.innerWidth * dpr);
  siteCanvas.height = Math.floor(window.innerHeight * dpr);
  siteCanvas.style.width = window.innerWidth + 'px';
  siteCanvas.style.height = window.innerHeight + 'px';
  sim.cam.resize(siteCanvas.width, siteCanvas.height);
  if (sim.view === 'site') sim.overview();
  if (stage) stage.resize();
  if (sim.focus) setFocus(sim.focus);
}
addEventListener('resize', resize);

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
  return {
    usableW: Math.min(1, free / w),
    usableH: Math.min(1, Math.max(0.4, (window.innerHeight - top - bot - 40) / window.innerHeight))
  };
}

function setFocus(f) {
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
  const box = (u, x0, x1, y0, y1, zz) => {
    u.root.updateWorldMatrix(true, false);
    const b = new THREE.Box3(), v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? zz : -zz)
        .applyMatrix4(u.root.matrixWorld);
      b.expandByPoint(v);
    }
    return b;
  };
  if (f === 'both') {
    const b = box(units[0], -23, 34, -4, 37, 12);
    b.union(box(units[1], -23, 34, -4, 37, 12));
    stage.frameBox(b,
      { azimuth: CUT_AZ, elev: narrow ? 0.5 : 0.22, snap: firstFocus, fill: 0.92, ...u });
  } else {
    stage.frameBox(box(units[f === 'active' ? 0 : 1], -23, 34, -4, 37, 12),
      { azimuth: CUT_AZ, elev: narrow ? 0.42 : 0.18, snap: firstFocus, fill: 0.88, ...u });
  }
  firstFocus = false;
  labels.setFocus(f);
}
const ui = new UI(sim, { focus: setFocus, view: (v) => sim.setView(GL_OK ? v : 'site') });
setFocus('both');
resize();

// ---- panning and zooming the island ----
let drag = null;
siteCanvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: sim.cam.x, cy: sim.cam.y };
  siteCanvas.setPointerCapture(e.pointerId);
});
siteCanvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const d = unproject((e.clientX - drag.x) * dpr / sim.cam.zoom,
    (e.clientY - drag.y) * dpr / sim.cam.zoom);
  sim.cine = null;
  sim.cam.snap(clamp(drag.cx - d.x, -10, 62), clamp(drag.cy - d.y, -10, 62));
});
siteCanvas.addEventListener('pointerup', () => { drag = null; });
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
    ptr.set((e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1);
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

document.getElementById('btnView').addEventListener('click', () => {
  firstFocus = true;
  setFocus(sim.focus || 'both');
});

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.06);
  last = now;
  sim.update(dt);
  if (sim.view === 'plant' && stage) {
    for (const u of units) if (u.root.visible) u.update(state(u.plant), dt);
    // The wave clears the seawall by this much, and what gets past it stands
    // on the site: that is what drowns the diesels in the basement.
    stage.setFlood(Math.max(...sim.plants.map(
      (p) => clamp((p.flooded - 5.7) * 0.42, 0, 4.6))), dt);
    stage.nudge(keys, dt);
    stage.update(dt);
    labels.update();
    stage.render();
  } else {
    renderer.draw(sim);
  }
  acc += dt;
  if (acc > 0.22) { ui.update(); acc = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

sim.announce('Both units at 100% power. Grid connected, all systems normal.', 'ok');
window.__sim = sim;
window.__units = units;
window.__stage = stage;
window.__CUT_AZ = CUT_AZ;
window.__labels = labels;
