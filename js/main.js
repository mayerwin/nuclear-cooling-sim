// ---------------------------------------------------------------------------
// main.js - boot, input and the frame loop.
//
// Two views of one simulation: the island from above on a 2-D canvas, and the
// inside of the buildings in 3-D. Only one is on screen at a time.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Sim } from './sim.js';
import { Renderer } from './site/renderer.js';
import { unproject } from './site/iso.js';
import { Stage } from './view/stage.js';
import { Unit } from './view/unit.js';
import { Labels } from './view/labels.js';
import { UI } from './ui.js';
import { initPhysics } from './machines.js';
import { state } from './view/state.js';
import { clamp } from './util.js';

const siteCanvas = document.getElementById('site');
const host = document.getElementById('scene');
const labelHost = document.getElementById('labels');

await initPhysics();
const sim = new Sim(siteCanvas);
sim.world.bakeTerrain();
sim.world.bakeOverlay();
const renderer = new Renderer(siteCanvas, sim.world);
renderer.buildOcean();

const stage = new Stage(host, labelHost);
const SPAN = 43;
const units = sim.plants.map((p, i) => new Unit(p, stage, i === 0 ? -SPAN : SPAN));
for (const u of units) stage.scene.add(u.root);
const labels = new Labels(stage, units);

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  siteCanvas.width = Math.floor(window.innerWidth * dpr);
  siteCanvas.height = Math.floor(window.innerHeight * dpr);
  siteCanvas.style.width = window.innerWidth + 'px';
  siteCanvas.style.height = window.innerHeight + 'px';
  sim.cam.resize(siteCanvas.width, siteCanvas.height);
  if (sim.view === 'site') sim.overview();
  stage.resize();
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
  sim.focus = f;
  const u = usable();
  if (f === 'both') {
    stage.frame(units.map((x) => x.root),
      { azimuth: 1.30, elev: 0.28, snap: firstFocus, fill: 0.94, ...u });
  } else {
    // On one station the frame is the reactor building and the turbine hall.
    // Framing the whole site puts the interesting part in the middle distance.
    const x = units[f === 'active' ? 0 : 1].worldX;
    stage.frameBox(new THREE.Box3(
      new THREE.Vector3(x - 20, -2, -19), new THREE.Vector3(x + 40, 36, 19)),
    { azimuth: 1.02, elev: 0.24, snap: firstFocus, fill: 0.96, ...u });
  }
  firstFocus = false;
  labels.setFocus(f);
}
const ui = new UI(sim, { focus: setFocus, view: (v) => sim.setView(v) });
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

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.06);
  last = now;
  sim.update(dt);
  if (sim.view === 'plant') {
    for (const u of units) u.update(state(u.plant), dt);
    labels.update();
    stage.update(dt);
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
